import { renderAsync } from 'docx-preview'
import type { ProposalStyleConfig } from '@shared/proposalStyle'
import type { MermaidImage } from '@shared/ipc-channels'

// 离屏渲染用的唯一页面类名。docx-preview 据此生成 `section.<class>` 选择器；本串只服务 PDF 导出
// （一次性、即用即弃），与常驻预览的每实例 useId 类名不冲突，固定值即可。
const PDF_DOCX_CLASS = 'docx-pdf'

// 打印复位 CSS：去掉 docx-preview 预览态的灰底/页阴影/页间距，让每个 A4 section 干净映射一页 PDF。
// 放在 <head>，而 docx-preview 自注的 <style> 在 <body>（随 stage.innerHTML 序列化）、级联更靠后会
// 压过同特异性规则，故这里关键属性都用 !important 反压。@page A4 + margin 0 + main 侧 preferCSSPageSize
// 让「一页 docx = 一页 PDF」；break-after:page 兜底强制每个 section 另起一页（末页除外）。
const PRINT_RESET_CSS = `
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.docx-wrapper { background: #fff !important; padding: 0 !important; }
.docx-wrapper > section.${PDF_DOCX_CLASS} {
  box-shadow: none !important;
  margin: 0 auto !important;
  break-after: page;
}
.docx-wrapper > section.${PDF_DOCX_CLASS}:last-child { break-after: auto; }
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
    useBase64URL: true,
    className: PDF_DOCX_CLASS
  })
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<style>${PRINT_RESET_CSS}</style></head><body>` +
    stage.innerHTML +
    '</body></html>'
  )
}
