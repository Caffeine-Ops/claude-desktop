import { renderAsync } from 'docx-preview'
import type { ProposalStyleConfig } from '@desktop-shared/proposalStyle'
import type { MermaidImage } from '@desktop-shared/ipc-channels'

// 离屏渲染用的唯一页面类名。docx-preview 据此生成 `section.<class>` 选择器；本串只服务 PDF 导出
// （一次性、即用即弃），与常驻预览的每实例 useId 类名不冲突，固定值即可。
const PDF_DOCX_CLASS = 'docx-pdf'

// docx-preview 的外层 wrapper 类名是 `<className>-wrapper`（renderWrapper），className 我们传了
// 'docx-pdf'，故 wrapper 实际是 `docx-pdf-wrapper`——【不是】裸用 docx-preview 默认时的 `docx-wrapper`。
// 历史 bug：复位 CSS 选择器写死成 `.docx-wrapper`，与真实 wrapper 类名对不上、整段复位【一条都没命中】，
// 于是 docx-preview 自注的 `section{margin-bottom:30px}`/`box-shadow`、和本应生效的 `break-after:page`
// 全失灵——节间多出 30px 间隙累积溢页（目录多一页、尾部零头空白页）。务必用类名常量拼选择器，别再写死。
const DOCX_WRAPPER = `${PDF_DOCX_CLASS}-wrapper`

// 打印复位 CSS：让每个 A4 section 干净映射一页 PDF。两道保险叠加：
//  1) renderAsync 传 hideWrapperOnPrint —— docx-preview 把灰底/页阴影/section margin-bottom:30px 收进
//     `@media not print`，打印时天然消失（治本，不必再靠下面的 !important 硬压那 30px）；
//  2) 这里再显式归零 wrapper padding/margin、section box-shadow/margin，并 break-after:page 强制每个
//     section 另起一页（末页除外）——双保险，且选择器现已对齐真实 wrapper 类名。
// 放在 <head>，docx-preview 自注 <style> 在 <body>（随 stage.innerHTML 序列化）、级联更靠后压过同特异性
// 规则，故关键属性用 !important 反压。@page A4 + margin 0 + main 侧 preferCSSPageSize 让「一页 docx = 一页 PDF」。
const PRINT_RESET_CSS = `
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.${DOCX_WRAPPER} { background: #fff !important; padding: 0 !important; margin: 0 !important; }
.${DOCX_WRAPPER} > section.${PDF_DOCX_CLASS} {
  box-shadow: none !important;
  margin: 0 !important;
  break-after: page;
}
.${DOCX_WRAPPER} > section.${PDF_DOCX_CLASS}:last-child { break-after: auto; }
/* 图与表尽量不跨页（与 proposalDocx 的 cantSplit/keepNext 对齐——docx-preview 不渲染那两个属性，
   故 PDF 侧用 break-inside 复刻同等观感）：
    - 表格【行】不被页边界从中间劈开（整行下推到下一页）；
    - 图片不被切成两半；
    - 含图的段落整体不断开，且尽量与紧随的图说同页（break-after:avoid）。
   :has() 由 Chromium 打印引擎（printToPDF）支持；img 规则单独留作兜底。 */
.${PDF_DOCX_CLASS} table tr { break-inside: avoid !important; }
.${PDF_DOCX_CLASS} img { break-inside: avoid !important; }
.${PDF_DOCX_CLASS} p:has(img) { break-inside: avoid !important; break-after: avoid !important; }
`

/**
 * 把方案 markdown 渲成【自包含】HTML 文档串，交给 main 的 printToPDF（P2-2）。
 *
 * 与预览同源：走同一条 `renderProposal` IPC 拿 docx bytes、同一个 docx-preview 渲染，故导出的 PDF
 * 与预览/Word 逐像素一致。两处关键差异专为「脱离 renderer 进程后仍可独立打印」：
 *  - `useBase64URL: true` —— 配图渲成 data URL 内联进 HTML，main 隐藏窗口没有 blob:/kbasset:// 来源
 *    也能显图；
 *  - 注入打印复位 CSS —— 见上。
 *
 * docx-preview 的分页按 docx XML 结构切、不量 DOM，故离屏 detached 容器渲染与挂在页面上等价
 * （沿用 ProposalPreview 同款离屏渲染）。样式节点（第 3 参省略 → 回退注入第 2 参容器）随
 * `stage.innerHTML` 一起被序列化，无需单独搬运。
 */
export async function renderProposalPdfHtml(
  markdown: string,
  style: ProposalStyleConfig | undefined,
  mermaidImages: Record<string, MermaidImage> | undefined
): Promise<string> {
  const { bytes } = await window.chatApi.renderProposal({ markdown, style, mermaidImages })
  const blob = new Blob([new Uint8Array(bytes)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  })
  const stage = document.createElement('div')
  await renderAsync(blob, stage, undefined, {
    inWrapper: true,
    breakPages: true,
    ignoreWidth: false,
    ignoreHeight: false,
    // 品牌横幅 logo（P2-1）+ 页码在 header/footer，PDF 必须渲染它们才与导出/预览一致。
    renderHeaders: true,
    renderFooters: true,
    useBase64URL: true,
    className: PDF_DOCX_CLASS,
    // 把 docx-preview 的灰底/页阴影/section margin-bottom:30px 关进 `@media not print`——打印时消失，
    // 避免节间 30px 间隙累积把内容挤出多余页（与上面 PRINT_RESET_CSS 注释互见）。
    hideWrapperOnPrint: true
  })
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<style>${PRINT_RESET_CSS}</style></head><body>` +
    stage.innerHTML +
    '</body></html>'
  )
}
