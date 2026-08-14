<div align="center">

# Paseo Web LaTeX Renderer

**将 Paseo Web 中未渲染的 LaTeX 公式显示为 MathML，并支持复制回原始 LaTeX**

**Render raw LaTeX formulas in Paseo Web as MathML and copy them back as original LaTeX**

[![Version](https://img.shields.io/badge/version-2.3.4-blue)](./paseo-web-latex-renderer.user.js)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-required-brightgreen)](https://www.tampermonkey.net/)
[![KaTeX](https://img.shields.io/badge/KaTeX-0.16.21-orange)](https://katex.org/)

</div>

> 适用于 Paseo 页面直接显示行内或显示 LaTeX 源码，而没有正常排版为公式的情况。  
> Use this script when Paseo shows raw LaTeX source instead of rendered formulas.

## 功能 / Features

| 中文 | English |
| --- | --- |
| 支持常见的行内与显示 LaTeX 公式写法 | Supports common inline and display LaTeX delimiters |
| 自动区分句内公式与独立显示公式 | Automatically distinguishes inline and standalone display formulas |
| 检测带 \tag 或 \tag* 的公式，并按显示公式处理 | Detects equations using \tag or \tag* and handles them as display math |
| 处理被 Paseo 拆分到多个文本节点或页面块中的公式 | Handles formulas split across multiple text nodes or page blocks |
| 支持动态加载内容、开放 Shadow DOM 与同源 iframe | Supports dynamic content, open Shadow DOM, and same-origin iframes |
| 复制公式或包含公式的文字时，恢复原始 LaTeX 源码 | Restores original LaTeX when copying formulas or surrounding text |
| 针对长对话优化，优先保持页面流畅 | Optimized for long conversations to keep pages responsive |
| 提供诊断与手动重新扫描菜单 | Includes diagnostic and manual rescan menu commands |

## 安装 / Installation

1. 安装并启用 [Tampermonkey](https://www.tampermonkey.net/)。
2. 在 Edge 或 Chrome 扩展设置中，允许 Tampermonkey 访问 Paseo 网站。
3. 打开 [paseo-web-latex-renderer.user.js](./paseo-web-latex-renderer.user.js)，点击 Raw 后由 Tampermonkey 安装；也可以新建脚本并粘贴全部内容。
4. 保存后刷新 Paseo 页面。首次安装或升级后，建议按 Ctrl+F5 强制刷新。

1. Install and enable [Tampermonkey](https://www.tampermonkey.net/).
2. Allow Tampermonkey to access Paseo in your Edge or Chrome extension settings.
3. Open [paseo-web-latex-renderer.user.js](./paseo-web-latex-renderer.user.js), click Raw, and install it with Tampermonkey. You can also create a new userscript and paste in the full source.
4. Refresh Paseo after saving. Use Ctrl+F5 after first installation or an update.

The script matches:

    https://app.paseo.sh/*
    https://*.paseo.sh/*
    https://paseo.sh/*

## 使用 / Usage

打开 Paseo 页面后，原始公式会自动渲染。例如：

    Inline: $v_{ij} = x_i \cdot SF$

    $$\mathcal{T}[v_{ij}, m_j] \approx \left(\frac{\hat{x}_i - x_i}{x_i}\right)^2$$

句内的双美元公式会保持在正文行内；单独成行的公式会以显示公式排版。带 \tag{16} 的公式会按编号公式处理。

Raw formulas render automatically after the page opens. Sentence-embedded double-dollar formulas stay inline, while standalone formulas use display layout. Equations with \tag{16} are handled as numbered display equations.

选中并复制公式或包含公式的文字，粘贴时会得到原始 LaTeX，而不是 MathML 或视觉字符。

Select and copy a formula, or text containing one, to paste the original LaTeX instead of MathML or visual characters.

## 长对话 / Long Conversations

在很长的对话中，远离当前屏幕的原始公式可能会暂时保留为 LaTeX 源码。滚动接近该区域后会继续渲染；也可以使用手动重新扫描。

On very long conversations, off-screen formulas may temporarily remain as raw LaTeX. They render when you scroll near them, or after a manual rescan.

## Tampermonkey 菜单 / Menu

| Command | 中文 | English |
| --- | --- | --- |
| Paseo LaTeX: Diagnose | 查看 KaTeX 状态、已渲染公式数量和最近错误 | Shows KaTeX status, rendered formula count, and recent errors |
| Paseo LaTeX: Rescan | 重新扫描当前页面，用于延迟加载或遗漏的公式 | Rescans the current page for delayed or missed formulas |

## 常见问题 / Troubleshooting

| 现象 | 处理方式 |
| --- | --- |
| 页面没有公式渲染 | 检查脚本已启用且 Tampermonkey 有 Paseo 站点权限，然后按 Ctrl+F5 |
| 仍有少量原始公式 | 滚动到该区域，或运行 Paseo LaTeX: Rescan |
| 公式显示红色 | 公式可能使用了 KaTeX 不支持的语法；请附上可公开的最小示例提交 Issue |
| 复制结果不是 LaTeX | 更新到最新版本，选中公式后使用 Ctrl+C 复制 |

| Symptom | Suggested action |
| --- | --- |
| No formulas render | Confirm that the script is enabled and has Paseo site access, then press Ctrl+F5 |
| Some raw formulas remain | Scroll near the formula or run Paseo LaTeX: Rescan |
| A formula is red | The syntax may not be supported by KaTeX; include a shareable minimal example in an Issue |
| Copy does not return LaTeX | Update to the latest version, select the formula, and copy with Ctrl+C |

## 兼容性与限制 / Compatibility and Limitations

- 推荐使用最新版 Microsoft Edge 或 Google Chrome。
- 代码块、输入框和正在编辑的内容不会被处理。
- 关闭模式的 Shadow DOM、无法访问的跨域 iframe，以及图片或 Canvas 中的公式无法处理。
- KaTeX 不是完整 TeX 引擎，少数宏或环境可能不受支持。

- Recent Microsoft Edge and Google Chrome are recommended.
- Code blocks, inputs, and editable content are intentionally skipped.
- Closed Shadow DOM, inaccessible cross-origin iframes, and formulas rendered as images or Canvas cannot be processed.
- KaTeX is not a complete TeX engine; some macros or environments may not be supported.

## 隐私 / Privacy

脚本不会上传 Paseo 页面内容，也不需要 API Key。它只会从 jsDelivr 加载 KaTeX 的公开资源。

The script does not upload Paseo page content and does not require an API key. It only loads public KaTeX resources from jsDelivr.
