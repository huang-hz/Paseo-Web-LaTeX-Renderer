// ==UserScript==
// @name         Paseo Web LaTeX Renderer
// @namespace    local.paseo.latex
// @version      2.3.4
// @description  Render LaTeX in Paseo and copy formulas as source LaTeX.
// @match        https://app.paseo.sh/*
// @match        https://*.paseo.sh/*
// @match        https://paseo.sh/*
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js
// @resource     katexCSS https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  "use strict";

  const KATEX_BASE = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/";
  const katexApi =
    typeof katex !== "undefined" && typeof katex.render === "function"
      ? katex
      : null;

  const state = {
    katexLoaded: Boolean(katexApi),
    roots: 0,
    rendered: 0,
    crossNodeRendered: 0,
    sourceBlockRendered: 0,
    deferredTargets: 0,
    errors: 0,
    lastError: ""
  };

  const IGNORE_SELECTOR = [
    "pre",
    "code",
    "textarea",
    "input",
    "button",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']",
    "script",
    "style",
    "noscript",
    "[data-paseo-latex-source-block]",
    "[data-paseo-latex]"
  ].join(",");

  // The React-source recovery path is intentionally more conservative than
  // ordinary text scanning. It must never replace a code sample or editor.
  const SOURCE_BLOCK_SKIP_SELECTOR = [
    "pre",
    "code",
    "textarea",
    "input",
    "button",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']",
    "script",
    "style",
    "noscript"
  ].join(",");

  const BLOCK_TAGS = new Set([
    "P", "LI", "DIV", "TD", "TH", "BLOCKQUOTE", "FIGCAPTION"
  ]);
  const ASSISTANT_MESSAGE_SELECTOR = "[data-testid='assistant-message']";
  // React Fiber recovery is an edge-case compatibility path. It is expensive
  // on long conversations, so normal DOM-based math rendering is the default.
  const ENABLE_REACT_SOURCE_RECOVERY = false;
  const EAGER_RENDER_CANDIDATE_LIMIT = 250;
  const DEFERRED_RENDER_BATCH_SIZE = 100;
  const MAX_CROSS_NODE_BLOCK_ANCESTORS = 8;
  const LAZY_RENDER_ROOT_MARGIN = "1200px 0px";
  const sourceHiddenDisplays = new WeakMap();
  const rawLatexSourceElements = new WeakSet();
  const ownedNodes = new WeakSet();
  const lazyObservedTargets = new WeakSet();
  const readyLazyTargets = new WeakSet();
  const transientOwnedNodes = new Set();
  let transientOwnershipTimer = null;
  let lazyObserver = null;

  function addStyle(css) {
    try {
      if (typeof GM_addStyle === "function") {
        GM_addStyle(css);
        return;
      }
    } catch (_) {
      // Fall through to a page style element.
    }

    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).append(style);
  }

  function addFallbackCss() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${KATEX_BASE}katex.min.css`;
    (document.head || document.documentElement).append(link);
  }

  function loadKatexCss() {
    try {
      const css = typeof GM_getResourceText === "function"
        ? GM_getResourceText("katexCSS")
        : "";

      if (!css) {
        addFallbackCss();
      } else {
        const fixedCss = css.replace(/url\(([^)]+)\)/g, (full, value) => {
          const url = value.trim().replace(/^['"]|['"]$/g, "");
          if (!url || /^(?:data:|https?:|\/)/i.test(url)) return full;
          return `url("${KATEX_BASE}${url.replace(/^\.\//, "")}")`;
        });

        addStyle(fixedCss);
      }
    } catch (error) {
      state.lastError = `KaTeX CSS failed to load: ${error.message || error}`;
      addFallbackCss();
    }

    addStyle(`
      .paseo-latex {
        font-size: 1.10em;
      }

      .paseo-latex--display {
        display: block;
        margin: 0.65em 0;
        font-size: 1.22em;
        overflow-x: auto;
        overflow-y: hidden;
      }

      .paseo-latex--display > .katex-display {
        margin: 0;
      }

    `);
  }

  function showDiagnostic() {
    const lines = [
      `KaTeX: ${state.katexLoaded ? "loaded" : "not loaded"}`,
      `Observed roots: ${state.roots}`,
      `Rendered formulas: ${state.rendered}`,
      `Cross-node formulas: ${state.crossNodeRendered}`,
      `Source-block formulas: ${state.sourceBlockRendered}`,
      `Deferred formula regions: ${state.deferredTargets}`,
      `Render errors: ${state.errors}`
    ];

    if (state.lastError) lines.push(`Last error: ${state.lastError}`);
    alert(lines.join("\n"));
  }

  function isEscaped(text, index) {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
      slashCount++;
    }
    return slashCount % 2 === 1;
  }

  function findClosing(text, delimiter, from) {
    for (let i = from; i <= text.length - delimiter.length; i++) {
      if (text.startsWith(delimiter, i) && !isEscaped(text, i)) return i;
    }
    return -1;
  }

  function isStandaloneDoubleDollar(text, start, end) {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nextLineBreak = text.indexOf("\n", end);
    const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;

    return !text.slice(lineStart, start).trim() &&
      !text.slice(end, lineEnd).trim();
  }

  function hasEquationTag(latex) {
    return /\\tag\*?\s*\{/.test(latex);
  }

  function looksLikeInlineMath(latex) {
    const value = latex.trim();
    if (!value) return false;
    if (/^\d+(?:[.,]\d+)?$/.test(value)) return false;

    return /^[A-Za-z]{1,3}$/.test(value) ||
      /[\\^_{}=+\-*/<>|]/.test(value);
  }

  function normalizeLatex(latex) {
    // Generated Paseo content commonly writes 1.56% instead of 1.56\\%.
    return latex
      .replace(/(\d+(?:\.\d+)?)%(?![A-Za-z])/g, "$1\\%")
      // \ &\ is a common textual spelling of a bitwise AND. A bare & is
      // invalid outside an alignment environment, so make it a math operator.
      .replace(/\\\s*&\\\s*/g, " \\mathbin{\\&} ");
  }

  function findMathRanges(text) {
    const matches = [];
    let i = 0;

    function add(end, latexStart, latexEnd, display) {
      matches.push({
        start: i,
        end,
        raw: text.slice(i, end),
        latex: normalizeLatex(text.slice(latexStart, latexEnd).trim()),
        display
      });
      i = end;
    }

    while (i < text.length) {
      if (isEscaped(text, i)) {
        i++;
        continue;
      }

      if (text.startsWith("$$", i)) {
        const close = findClosing(text, "$$", i + 2);
        const latex = close === -1 ? "" : text.slice(i + 2, close);
        if (close !== -1 && latex.trim()) {
          add(
            close + 2,
            i + 2,
            close,
            hasEquationTag(latex) ||
              isStandaloneDoubleDollar(text, i, close + 2)
          );
          continue;
        }
      }

      if (text.startsWith("\\[", i)) {
        const close = findClosing(text, "\\]", i + 2);
        if (close !== -1 && text.slice(i + 2, close).trim()) {
          add(close + 2, i + 2, close, true);
          continue;
        }
      }

      if (text.startsWith("\\(", i)) {
        const close = findClosing(text, "\\)", i + 2);
        const latex = close === -1 ? "" : text.slice(i + 2, close);
        if (close !== -1 && looksLikeInlineMath(latex)) {
          add(close + 2, i + 2, close, hasEquationTag(latex));
          continue;
        }
      }

      if (text[i] === "$" && text[i + 1] !== "$") {
        const close = findClosing(text, "$", i + 1);
        const latex = close === -1 ? "" : text.slice(i + 1, close);
        if (close !== -1 && looksLikeInlineMath(latex)) {
          add(close + 1, i + 1, close, hasEquationTag(latex));
          continue;
        }
      }

      i++;
    }

    return matches;
  }

  function formulaOnlyMatch(source) {
    if (typeof source !== "string" || !source) return null;

    const matches = findMathRanges(source);
    if (matches.length !== 1 || !matches[0].display) return null;

    const match = matches[0];
    if (source.slice(0, match.start).trim()) return null;
    if (source.slice(match.end).trim()) return null;
    return match;
  }

  function getReactFiber(element) {
    if (!element || element.nodeType !== 1) return null;

    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$") ||
      name.startsWith("__reactInternalInstance$")
    );

    return key ? element[key] : null;
  }

  function findSourceFormula(element) {
    let fiber = getReactFiber(element);

    // React keeps the unparsed Markdown on nearby component fibers. Reading it
    // avoids information already consumed by Markdown, such as a standalone
    // '=' becoming a Setext heading underline.
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (!props || typeof props !== "object") continue;

      for (const name of ["block", "text", "message"]) {
        const source = props[name];
        const match = formulaOnlyMatch(source);
        if (match) return { source, match };
      }
    }

    return null;
  }

  function isRawLatexSourceElement(element) {
    if (!element || element.nodeType !== 1) return false;

    if (rawLatexSourceElements.has(element)) return true;

    // Do not read element.textContent here. On a long conversation that
    // creates a complete string copy of every ancestor subtree per text node.
    let first = element.firstChild;
    while (first && first.nodeType !== 3) first = first.firstChild;
    const source = (first?.nodeValue || "").trimStart();
    const isSource = /^\{\s*\\(?:color|textcolor)\s*\{[^}\r\n]+\}/.test(source);
    if (isSource) rawLatexSourceElements.add(element);
    return isSource;
  }

  function isRawLatexSourceContext(element) {
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      if (isRawLatexSourceElement(current)) return true;
    }
    return false;
  }

  function shouldIgnore(textNode) {
    const parent = textNode.parentElement;
    return !parent ||
      Boolean(parent.closest(IGNORE_SELECTOR)) ||
      isRawLatexSourceContext(parent);
  }

  function markOwned(node) {
    ownedNodes.add(node);
    return node;
  }

  function markTransientlyOwned(node) {
    transientOwnedNodes.add(node);

    if (transientOwnershipTimer === null) {
      transientOwnershipTimer = setTimeout(() => {
        transientOwnershipTimer = null;
        transientOwnedNodes.clear();
      }, 0);
    }

    return node;
  }

  function isOwnedNode(node) {
    if (!node || ownedNodes.has(node) || transientOwnedNodes.has(node)) {
      return Boolean(node);
    }
    const element = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(element?.closest?.("[data-paseo-latex]"));
  }

  function createFormula(
    doc,
    match,
    fromCrossNodeScan,
    fromSourceBlockScan = false
  ) {
    const host = markOwned(doc.createElement("span"));
    host.className = match.display
      ? "paseo-latex paseo-latex--display"
      : "paseo-latex";
    host.dataset.paseoLatex = match.raw;
    host.setAttribute("aria-label", match.raw);
    host.style.fontSize = match.display ? "1.22em" : "1.10em";

    if (match.display) {
      host.style.display = "block";
      host.style.margin = "0.65em 0";
      host.style.overflowX = "auto";
      host.style.overflowY = "hidden";
    }

    try {
      katexApi.render(match.latex, host, {
        displayMode: match.display,
        // Paseo's Shadow DOM does not inherit KaTeX's HTML stylesheet.
        // Edge renders MathML natively, and copy is handled below.
        output: "mathml",
        throwOnError: false,
        strict: "ignore",
        trust: false
      });
      state.rendered++;
      if (fromCrossNodeScan) state.crossNodeRendered++;
      if (fromSourceBlockScan) state.sourceBlockRendered++;
    } catch (error) {
      state.errors++;
      state.lastError = error.message || String(error);
      host.textContent = match.raw;
    }

    return host;
  }

  function sourceFormulaElement(block) {
    return [...block.children].find((child) =>
      child.hasAttribute("data-paseo-latex-source-formula")
    ) || null;
  }

  function hideSourceBlockChildren(block, formula) {
    for (const child of block.children) {
      if (child === formula) continue;

      if (!sourceHiddenDisplays.has(child)) {
        sourceHiddenDisplays.set(child, {
          value: child.style.getPropertyValue("display"),
          priority: child.style.getPropertyPriority("display")
        });
      }

      child.style.setProperty("display", "none", "important");
    }
  }

  function restoreSourceBlockChildren(block) {
    for (const child of block.children) {
      const previous = sourceHiddenDisplays.get(child);
      if (!previous) continue;

      if (previous.value) {
        child.style.setProperty("display", previous.value, previous.priority);
      } else {
        child.style.removeProperty("display");
      }
      sourceHiddenDisplays.delete(child);
    }
  }

  function restoreSourceBlock(block) {
    if (!block.hasAttribute("data-paseo-latex-source-block")) return;

    restoreSourceBlockChildren(block);
    sourceFormulaElement(block)?.remove();
    block.removeAttribute("data-paseo-latex-source-block");
  }

  function shouldSkipSourceBlock(block) {
    return !block || Boolean(
      block.closest(SOURCE_BLOCK_SKIP_SELECTOR) ||
      block.querySelector(SOURCE_BLOCK_SKIP_SELECTOR)
    ) || isRawLatexSourceContext(block);
  }

  function renderSourceBlock(block) {
    if (shouldSkipSourceBlock(block)) {
      restoreSourceBlock(block);
      return;
    }

    const sourceFormula = findSourceFormula(block);
    if (!sourceFormula) {
      restoreSourceBlock(block);
      return;
    }

    const existing = sourceFormulaElement(block);
    if (existing?.dataset.paseoLatex === sourceFormula.match.raw) {
      block.setAttribute("data-paseo-latex-source-block", "");
      hideSourceBlockChildren(block, existing);
      return;
    }

    existing?.remove();

    const formula = createFormula(
      block.ownerDocument,
      sourceFormula.match,
      false,
      true
    );
    formula.classList.add("paseo-latex--source-block");
    formula.setAttribute("data-paseo-latex-source-formula", "");
    block.setAttribute("data-paseo-latex-source-block", "");
    block.append(formula);
    hideSourceBlockChildren(block, formula);
  }

  function collectAssistantMessages(root) {
    const messages = new Set();
    const element = root.nodeType === 3 ? root.parentElement : root;
    const closest = element?.closest?.(ASSISTANT_MESSAGE_SELECTOR);

    if (closest) messages.add(closest);
    if (element?.matches?.(ASSISTANT_MESSAGE_SELECTOR)) messages.add(element);
    root.querySelectorAll?.(ASSISTANT_MESSAGE_SELECTOR)
      .forEach((message) => messages.add(message));

    return messages;
  }

  function scanSourceFormulaBlocks(root) {
    for (const message of collectAssistantMessages(root)) {
      let blocks = [...message.children].filter((child) =>
        !child.hasAttribute("data-paseo-latex-source-formula")
      );

      if (!blocks.length) blocks = [message];
      blocks.forEach(renderSourceBlock);
    }
  }

  function renderTextNode(textNode) {
    if (!textNode.parentElement || shouldIgnore(textNode)) return;

    const source = textNode.nodeValue;
    if (!source || !/[$\\]/.test(source)) return;

    const matches = findMathRanges(source);
    if (!matches.length) return;

    const doc = textNode.ownerDocument;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;

    for (const match of matches) {
      if (cursor < match.start) {
        fragment.append(markTransientlyOwned(
          doc.createTextNode(source.slice(cursor, match.start))
        ));
      }
      fragment.append(createFormula(doc, match, false));
      cursor = match.end;
    }

    if (cursor < source.length) {
      fragment.append(markTransientlyOwned(
        doc.createTextNode(source.slice(cursor))
      ));
    }

    textNode.replaceWith(fragment);
  }

  function collectTextNodes(root) {
    const doc = root.ownerDocument || root;
    const nodeFilter = doc.defaultView?.NodeFilter || NodeFilter;
    const walker = doc.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldIgnore(node)
          ? nodeFilter.FILTER_REJECT
          : nodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function boundaryAt(nodes, position) {
    let offset = 0;

    for (const node of nodes) {
      const end = offset + node.nodeValue.length;
      if (position <= end) return { node, offset: position - offset };
      offset = end;
    }

    return null;
  }

  function isFormulaBlock(element) {
    if (
      !BLOCK_TAGS.has(element.tagName) ||
      element.closest(IGNORE_SELECTOR) ||
      isRawLatexSourceContext(element)
    ) {
      return false;
    }

    return true;
  }

  function closestFormulaBlock(element) {
    for (
      let current = element;
      current && current.nodeType === 1;
      current = current.parentElement
    ) {
      if (isFormulaBlock(current)) return current;
    }
    return null;
  }

  function collectCrossNodeBlocks(element) {
    const blocks = [];
    const message = element?.closest?.(ASSISTANT_MESSAGE_SELECTOR) || null;

    for (
      let current = element;
      current && current.nodeType === 1;
      current = current.parentElement
    ) {
      if (isFormulaBlock(current)) {
        blocks.push(current);
        if (blocks.length >= MAX_CROSS_NODE_BLOCK_ANCESTORS) break;
      }

      // Do not let a split delimiter combine text from separate messages.
      if (current === message) break;
    }

    return blocks;
  }

  function renderCrossNodeMath(block) {
    const nodes = collectTextNodes(block);
    if (nodes.length < 2) return;

    const source = nodes.map((node) => node.nodeValue).join("");
    if (!/[$\\]/.test(source)) return;

    const matches = findMathRanges(source)
      .map((match) => ({
        match,
        start: boundaryAt(nodes, match.start),
        end: boundaryAt(nodes, match.end)
      }))
      .filter(({ start, end }) => start && end && start.node !== end.node);

    for (const item of matches.reverse()) {
      if (!item.start.node.isConnected || !item.end.node.isConnected) continue;

      try {
        const range = block.ownerDocument.createRange();
        range.setStart(item.start.node, item.start.offset);
        range.setEnd(item.end.node, item.end.offset);
        range.deleteContents();
        range.insertNode(createFormula(block.ownerDocument, item.match, true));
      } catch (error) {
        state.errors++;
        state.lastError = error.message || String(error);
      }
    }
  }

  function collectCandidateTextNodes(root) {
    if (!root || isOwnedNode(root)) return [];

    const candidates = [];
    const addCandidate = (node) => {
      if (
        node?.isConnected &&
        !isOwnedNode(node) &&
        !shouldIgnore(node) &&
        /[$\\]/.test(node.nodeValue)
      ) {
        candidates.push(node);
      }
    };

    if (root.nodeType === 3) {
      addCandidate(root);
      return candidates;
    }

    const doc = root.ownerDocument || root;
    const nodeFilter = doc.defaultView?.NodeFilter || NodeFilter;
    let walker;

    try {
      walker = doc.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return isOwnedNode(node) || shouldIgnore(node) || !/[$\\]/.test(node.nodeValue)
            ? nodeFilter.FILTER_REJECT
            : nodeFilter.FILTER_ACCEPT;
        }
      });
    } catch (_) {
      return candidates;
    }

    while (walker.nextNode()) candidates.push(walker.currentNode);
    return candidates;
  }

  function scan(root) {
    if (!katexApi || !root || isOwnedNode(root)) return;

    if (ENABLE_REACT_SOURCE_RECOVERY) scanSourceFormulaBlocks(root);

    // Only inspect blocks adjacent to a potential delimiter. The previous
    // implementation queried every div/p/li in the document after each DOM
    // mutation, which becomes prohibitively expensive on long conversations.
    const candidates = collectCandidateTextNodes(root);
    const wasDeferred = root.nodeType !== 3 && readyLazyTargets.has(root);
    if (wasDeferred) readyLazyTargets.delete(root);

    if (
      candidates.length > EAGER_RENDER_CANDIDATE_LIMIT &&
      !wasDeferred &&
      deferCandidates(candidates)
    ) {
      return;
    }

    const renderCandidates = wasDeferred &&
      candidates.length > DEFERRED_RENDER_BATCH_SIZE
      ? candidates.slice(0, DEFERRED_RENDER_BATCH_SIZE)
      : candidates;
    const blocks = new Set();

    renderCandidates.forEach((node) => {
      collectCrossNodeBlocks(node.parentElement).forEach((block) => {
        blocks.add(block);
      });
    });
    blocks.forEach(renderCrossNodeMath);

    renderCandidates.forEach((node) => {
      if (node.isConnected && !isOwnedNode(node)) renderTextNode(node);
    });

    if (wasDeferred && renderCandidates.length < candidates.length) {
      readyLazyTargets.add(root);
      schedule(root);
    }
  }

  function closestFormula(node) {
    for (
      let current = node?.nodeType === 1 ? node : node?.parentNode;
      current;
      current = current.parentNode
    ) {
      if (
        current.nodeType === 1 &&
        current.hasAttribute("data-paseo-latex")
      ) {
        return current;
      }
    }
    return null;
  }

  function fragmentToText(fragment) {
    const blockTags = new Set([
      "P", "DIV", "LI", "UL", "OL", "SECTION", "ARTICLE",
      "H1", "H2", "H3", "H4", "H5", "H6", "TR"
    ]);

    let output = "";
    const newline = () => {
      if (output && !output.endsWith("\n")) output += "\n";
    };

    function walk(node) {
      if (node.nodeType === 3) {
        output += node.nodeValue;
        return;
      }

      if (node.nodeType !== 1) {
        node.childNodes.forEach(walk);
        return;
      }

      if (node.hasAttribute("data-paseo-latex")) {
        output += node.getAttribute("data-paseo-latex");
        return;
      }

      if (node.tagName === "BR") {
        newline();
        return;
      }

      const isBlock = blockTags.has(node.tagName);
      if (isBlock) newline();
      node.childNodes.forEach(walk);
      if (isBlock) newline();
    }

    fragment.childNodes.forEach(walk);
    return output.replace(/\n{3,}/g, "\n\n").trim();
  }

  function rewriteCopy(event, ownerRoot) {
    if (!event.clipboardData) return;

    const ownerDocument = ownerRoot.ownerDocument || ownerRoot;
    const rootSelection = ownerRoot.getSelection?.();
    const selection = rootSelection?.rangeCount
      ? rootSelection
      : ownerDocument.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0).cloneRange();
    const startFormula = closestFormula(range.startContainer);
    const endFormula = closestFormula(range.endContainer);

    if (startFormula) range.setStartBefore(startFormula);
    if (endFormula) range.setEndAfter(endFormula);

    const fragment = range.cloneContents();
    if (!fragment.querySelector("[data-paseo-latex]")) return;

    const plainText = fragmentToText(fragment);
    if (!plainText) return;

    event.clipboardData.setData("text/plain", plainText);
    // Paseo also listens for copy events. Keep its later handler from
    // replacing the source LaTeX with the visual MathML representation.
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  const watchedRoots = new WeakSet();
  const watchedDocuments = new WeakSet();
  const watchedFrames = new WeakSet();
  const copyBoundRoots = new WeakSet();
  const queuedRoots = new Set();
  const SCAN_DEBOUNCE_MS = 50;
  let flushTimer = null;

  function normalizedScanRoot(node) {
    if (!node || isOwnedNode(node)) return null;
    if (node.nodeType === 3) return node.parentElement;

    return node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11
      ? node
      : null;
  }

  function containsNode(root, node) {
    if (root === node) return true;
    try {
      return Boolean(root?.contains?.(node));
    } catch (_) {
      return false;
    }
  }

  function schedule(node) {
    const root = normalizedScanRoot(node);
    if (!root) return;

    for (const queuedRoot of queuedRoots) {
      if (containsNode(queuedRoot, root)) return;
    }

    for (const queuedRoot of queuedRoots) {
      if (containsNode(root, queuedRoot)) queuedRoots.delete(queuedRoot);
    }
    queuedRoots.add(root);

    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const roots = [...queuedRoots];
      queuedRoots.clear();
      roots.forEach(scan);
    }, SCAN_DEBOUNCE_MS);
  }

  function lazyTargetFor(node) {
    const element = node.parentElement;
    return element?.closest?.(ASSISTANT_MESSAGE_SELECTOR) ||
      closestFormulaBlock(element) ||
      element ||
      null;
  }

  function getLazyObserver() {
    if (lazyObserver || typeof IntersectionObserver !== "function") {
      return lazyObserver;
    }

    lazyObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.target.isConnected) {
          lazyObserver.unobserve(entry.target);
          lazyObservedTargets.delete(entry.target);
          state.deferredTargets = Math.max(0, state.deferredTargets - 1);
          continue;
        }
        if (!entry.isIntersecting) continue;

        lazyObserver.unobserve(entry.target);
        lazyObservedTargets.delete(entry.target);
        readyLazyTargets.add(entry.target);
        state.deferredTargets = Math.max(0, state.deferredTargets - 1);
        schedule(entry.target);
      }
    }, { rootMargin: LAZY_RENDER_ROOT_MARGIN });

    return lazyObserver;
  }

  function deferCandidates(candidates) {
    // A top-level observer cannot observe nodes from a same-origin iframe.
    // Render those normally rather than risking a failed or stuck observation.
    if (candidates.some((node) => node.ownerDocument !== document)) return false;

    const observer = getLazyObserver();
    if (!observer) return false;

    const targets = new Set();
    candidates.forEach((node) => {
      const target = lazyTargetFor(node);
      if (target?.isConnected) targets.add(target);
    });
    if (!targets.size) return false;

    for (const target of targets) {
      if (readyLazyTargets.has(target) || lazyObservedTargets.has(target)) {
        continue;
      }

      try {
        observer.observe(target);
        lazyObservedTargets.add(target);
        state.deferredTargets++;
      } catch (_) {
        return false;
      }
    }

    return true;
  }

  function inspectElement(element) {
    if (element.shadowRoot) watchRoot(element.shadowRoot);
    if (element.tagName === "IFRAME") watchFrame(element);
  }

  function discover(root, includeExistingShadowRoots = false) {
    if (!root || root.nodeType === 3) return;
    if (root.nodeType === 1) inspectElement(root);
    root.querySelectorAll?.("iframe").forEach(watchFrame);

    if (includeExistingShadowRoots) {
      root.querySelectorAll?.("*").forEach((element) => {
        if (element.shadowRoot) watchRoot(element.shadowRoot);
      });
    }
  }

  function onMutations(records) {
    for (const record of records) {
      if (record.type === "characterData") {
        if (!isOwnedNode(record.target)) schedule(record.target);
        continue;
      }

      record.addedNodes.forEach((node) => {
        if (isOwnedNode(node)) return;
        if (node.nodeType === 1) discover(node, false);
        schedule(node);
      });
    }
  }

  const observer = new MutationObserver(onMutations);

  function watchCopy(root) {
    if (!root || copyBoundRoots.has(root)) return;
    copyBoundRoots.add(root);
    root.addEventListener?.("copy", (event) => rewriteCopy(event, root), true);
  }

  function watchRoot(root) {
    if (!root || watchedRoots.has(root)) return;

    watchedRoots.add(root);
    state.roots++;
    watchCopy(root);

    try {
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (_) {
      return;
    }

    discover(root, true);
    schedule(root);
  }

  function watchDocument(doc) {
    if (!doc || watchedDocuments.has(doc)) return;

    watchedDocuments.add(doc);
    watchCopy(doc);
    watchRoot(doc);
  }

  function watchFrame(frame) {
    if (watchedFrames.has(frame)) return;
    watchedFrames.add(frame);

    const inspectFrame = () => {
      try {
        if (frame.contentDocument) watchDocument(frame.contentDocument);
      } catch (_) {
        // A cross-origin frame is handled by the @match rules when possible.
      }
    };

    frame.addEventListener("load", inspectFrame, { passive: true });
    inspectFrame();
  }

  function rescanRoot(root, seenRoots) {
    if (!root || seenRoots.has(root)) return;
    seenRoots.add(root);

    discover(root, true);
    schedule(root);

    root.querySelectorAll?.("*").forEach((element) => {
      if (element.shadowRoot) rescanRoot(element.shadowRoot, seenRoots);
      if (element.tagName !== "IFRAME") return;

      try {
        if (element.contentDocument) {
          watchDocument(element.contentDocument);
          rescanRoot(element.contentDocument, seenRoots);
        }
      } catch (_) {
        // Cross-origin frames are outside this document's access boundary.
      }
    });
  }

  function rescanAll() {
    rescanRoot(document, new WeakSet());
  }

  try {
    GM_registerMenuCommand("Paseo LaTeX: Diagnose", showDiagnostic);
    GM_registerMenuCommand("Paseo LaTeX: Rescan", rescanAll);
  } catch (_) {
    // Menu commands are optional.
  }

  if (!katexApi) {
    state.lastError = "KaTeX did not load. Check access to the @require CDN.";
    console.error("[Paseo LaTeX]", state.lastError);
    return;
  }

  const originalAttachShadow = Element.prototype.attachShadow;
  if (originalAttachShadow) {
    Element.prototype.attachShadow = function (options) {
      const root = originalAttachShadow.call(this, options);
      if (options && options.mode === "open") watchRoot(root);
      return root;
    };
  }

  watchDocument(document);
})();
