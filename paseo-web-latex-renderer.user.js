// ==UserScript==
// @name         Paseo Web LaTeX Renderer
// @namespace    local.paseo.latex
// @version      2.2.1
// @description  Render LaTeX in Paseo Web and copy formulas as source LaTeX.
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

  const BLOCK_TAGS = new Set([
    "P", "LI", "DIV", "TD", "TH", "BLOCKQUOTE", "FIGCAPTION"
  ]);
  const BLOCK_SELECTOR = "p, li, div, td, th, blockquote, figcaption";
  const ASSISTANT_MESSAGE_SELECTOR = "[data-testid='assistant-message']";
  const sourceHiddenDisplays = new WeakMap();

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
      .replace(/(\d(?:\.\d+)?)%(?=\s|$)/g, "$1\\%")
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
        if (close !== -1 && text.slice(i + 2, close).trim()) {
          add(close + 2, i + 2, close, true);
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
          add(close + 2, i + 2, close, false);
          continue;
        }
      }

      if (text[i] === "$" && text[i + 1] !== "$") {
        const close = findClosing(text, "$", i + 1);
        const latex = close === -1 ? "" : text.slice(i + 1, close);
        if (close !== -1 && looksLikeInlineMath(latex)) {
          add(close + 1, i + 1, close, false);
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

  function shouldIgnore(textNode) {
    const parent = textNode.parentElement;
    return !parent || Boolean(parent.closest(IGNORE_SELECTOR));
  }

  function createFormula(
    doc,
    match,
    fromCrossNodeScan,
    fromSourceBlockScan = false
  ) {
    const host = doc.createElement("span");
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

  function renderSourceBlock(block) {
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
        fragment.append(doc.createTextNode(source.slice(cursor, match.start)));
      }
      fragment.append(createFormula(doc, match, false));
      cursor = match.end;
    }

    if (cursor < source.length) {
      fragment.append(doc.createTextNode(source.slice(cursor)));
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

  function isLeafBlock(element) {
    if (!BLOCK_TAGS.has(element.tagName) || element.closest(IGNORE_SELECTOR)) {
      return false;
    }

    return ![...element.children].some((child) => BLOCK_TAGS.has(child.tagName));
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

  function scanCrossNodeBlocks(root) {
    if (!root || root.nodeType === 3) return;

    const blocks = [];
    if (root.nodeType === 1 && isLeafBlock(root)) blocks.push(root);
    if (root.querySelectorAll) {
      root.querySelectorAll(BLOCK_SELECTOR).forEach((element) => {
        if (isLeafBlock(element)) blocks.push(element);
      });
    }

    blocks.forEach(renderCrossNodeMath);
  }

  function scanSingleTextNodes(root) {
    if (!root) return;

    if (root.nodeType === 3) {
      renderTextNode(root);
      return;
    }

    const doc = root.ownerDocument || root;
    const nodeFilter = doc.defaultView?.NodeFilter || NodeFilter;
    let walker;

    try {
      walker = doc.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (shouldIgnore(node)) return nodeFilter.FILTER_REJECT;
          return /[$\\]/.test(node.nodeValue)
            ? nodeFilter.FILTER_ACCEPT
            : nodeFilter.FILTER_REJECT;
        }
      });
    } catch (_) {
      return;
    }

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(renderTextNode);
  }

  function scan(root) {
    if (!katexApi) return;
    scanSourceFormulaBlocks(root);
    scanCrossNodeBlocks(root);
    scanSingleTextNodes(root);
  }

  function closestFormula(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest?.("[data-paseo-latex]") || null;
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

  function rewriteCopy(event, ownerDocument) {
    if (!event.clipboardData) return;

    const selection = ownerDocument.getSelection();
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
    event.preventDefault();
  }

  const watchedRoots = new WeakSet();
  const watchedDocuments = new WeakSet();
  const watchedFrames = new WeakSet();
  const rootList = new Set();
  const queuedNodes = new Set();
  let flushScheduled = false;

  const defer = typeof queueMicrotask === "function"
    ? queueMicrotask
    : (callback) => Promise.resolve().then(callback);

  function schedule(node) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 3)) return;
    queuedNodes.add(node);

    if (flushScheduled) return;
    flushScheduled = true;

    defer(() => {
      flushScheduled = false;
      const nodes = [...queuedNodes];
      queuedNodes.clear();
      nodes.forEach(scan);
    });
  }

  function inspectElement(element) {
    if (element.shadowRoot) watchRoot(element.shadowRoot);
    if (element.tagName === "IFRAME") watchFrame(element);
  }

  function discover(root) {
    if (!root) return;
    if (root.nodeType === 1) inspectElement(root);
    if (root.querySelectorAll) root.querySelectorAll("*").forEach(inspectElement);
  }

  function onMutations(records) {
    for (const record of records) {
      if (record.type === "characterData") {
        schedule(record.target);
        continue;
      }

      record.addedNodes.forEach((node) => {
        if (node.nodeType === 1) discover(node);
        schedule(node);
      });
    }
  }

  const observer = new MutationObserver(onMutations);

  function watchRoot(root) {
    if (!root || watchedRoots.has(root)) return;

    watchedRoots.add(root);
    rootList.add(root);
    state.roots++;

    try {
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (_) {
      return;
    }

    scan(root);
    discover(root);
  }

  function watchDocument(doc) {
    if (!doc || watchedDocuments.has(doc)) return;

    watchedDocuments.add(doc);
    doc.addEventListener("copy", (event) => rewriteCopy(event, doc), true);
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

  function rescanAll() {
    rootList.forEach((root) => {
      discover(root);
      scan(root);
    });
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
  setTimeout(rescanAll, 500);
  setTimeout(rescanAll, 2000);
})();
