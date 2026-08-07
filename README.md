<div align="center">

# 📐 Paseo Web LaTeX Renderer

**将 Paseo Web 中未渲染的 LaTeX 标记转换为原生 MathML,复制时还原原始 LaTeX 源码**

**Render unrendered LaTeX markup in [Paseo Web](https://app.paseo.sh/) as native MathML — copy formulas back as LaTeX source**

[![Version](https://img.shields.io/badge/version-2.2.1-blue)](./paseo-web-latex-renderer.user.js)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-required-brightgreen)](https://www.tampermonkey.net/)
[![KaTeX](https://img.shields.io/badge/KaTeX-0.16.21-orange)](https://katex.org/)
[![Output](https://img.shields.io/badge/output-native%20MathML-yellowgreen)](./paseo-web-latex-renderer.user.js)

</div>

> [!NOTE]
> **适用场景:** Paseo 的回答、笔记和工作区页面中直接显示 `$...$`、`$$...$$` 等原始公式标记时。
> **When to use:** Raw formula delimiters such as `$...$` and `$$...$$` appear in Paseo responses, notes, or workspace pages instead of being rendered.

---

## 📑 目录 / Contents

- [✨ 功能特性 / Features](#features)
- [🚀 安装 / Installation](#installation)
- [📖 使用方式 / Usage](#usage)
- [🧭 Tampermonkey 菜单 / Menu](#menu)

---

<a id="features"></a>
## ✨ 功能特性 / Features

| 中文 | English |
| --- | --- |
| 支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]` 四种常见 LaTeX 定界符 | Supports the common `$...$`, `$$...$$`, `\(...\)`, `\[...\]` LaTeX delimiters |
| 使用浏览器原生 MathML 输出,避免 Paseo Shadow DOM 缺失 KaTeX CSS 造成的重复或错误排版 | Uses browser-native MathML to avoid duplicate or broken KaTeX HTML output when Paseo's Shadow DOM does not inherit KaTeX CSS |
| 支持 Paseo 的动态页面更新、开放 Shadow DOM 和同源 iframe | Handles Paseo's dynamic updates, open Shadow DOM, and same-origin iframes |
| 识别被页面拆分到多个 DOM 文本节点中的公式 | Detects formulas split across multiple DOM text nodes |
| 针对被 Paseo/Markdown 预处理的独立显示公式,尝试从组件源码恢复原始 LaTeX | Attempts to recover standalone display formulas that Paseo or Markdown has already preprocessed |
| 复制渲染公式时,恢复原始 `$...$` 或 `$$...$$` 源码 | Copies rendered formulas back as their original `$...$` or `$$...$$` source |
| 对 `1.56%`、`\ &\` 位运算 AND 等生成式写法做仅渲染层面的兼容处理,复制仍保留原始内容 | Rendering-only compatibility fixes for common generated text, such as `1.56%` and `\ &\` bitwise AND; copied text remains unchanged |
| 提供诊断与手动重扫菜单项 | Includes diagnostic and manual-rescan menu commands |

<a id="installation"></a>
## 🚀 安装 / Installation



| 步骤 | 中文 | English |
| :--: | --- | --- |
| **1** | 安装并启用 Tampermonkey | Install and enable Tampermonkey |
| **2** | 在 Edge 扩展详情中,将 Tampermonkey 的“站点访问权限”设为“在所有网站上”,或至少允许 `https://app.paseo.sh/*` | In the Edge extension details, set Tampermonkey site access to **On all sites**, or at minimum allow `https://app.paseo.sh/*` |
| **3** | 打开 [paseo-web-latex-renderer.user.js](./paseo-web-latex-renderer.user.js),点击 **Raw** 由 Tampermonkey 安装;也可以新建脚本并粘贴全部内容 | Open [paseo-web-latex-renderer.user.js](./paseo-web-latex-renderer.user.js), click **Raw**, and let Tampermonkey install it; or create a new userscript and paste the entire file |
| **4** | 保存后刷新 Paseo 页面,首次安装或更新后建议 `Ctrl+F5` 强制刷新 | Refresh the Paseo page; use `Ctrl+F5` after the first installation or an update |

脚本匹配以下 Paseo 地址,以覆盖内嵌阅读视图 / The userscript matches the following Paseo URLs:

```text
https://app.paseo.sh/*
https://*.paseo.sh/*
https://paseo.sh/*
```

<a id="usage"></a>
## 📖 使用方式 / Usage

页面中的原始公式会被自动渲染,例如 / Raw formulas on the page are rendered automatically:

```latex
$$\mathcal{T}[v_{ij}, m_j] \approx \left(\frac{\hat{x}_i - x_i}{x_i}\right)^2$$

Inline math: $v_{ij} = x_i \cdot SF$
```

> [!TIP]
> **中文:** 选中包含渲染公式的文本并复制,粘贴后的公式会恢复为原始 LaTeX 定界符和源码,而不是视觉字符或 MathML。
>
> **English:** Select text containing a rendered formula and copy it. The pasted formula is restored as its original LaTeX delimiter and source, rather than visual characters or MathML.

<a id="menu"></a>
## 🧭 Tampermonkey 菜单 / Tampermonkey Menu

| Command | 中文 | English |
| --- | --- | --- |
| `Paseo LaTeX: Diagnose` | 查看 KaTeX 加载状态、监听到的 DOM 根节点数、公式渲染数量和最近错误 | Shows KaTeX status, observed DOM roots, render counts, and the latest error |
| `Paseo LaTeX: Rescan` | 手动重新扫描当前页面,适用于延迟加载或局部更新后仍有原始公式的情况 | Rescans the current page after delayed loading or partial page updates |

