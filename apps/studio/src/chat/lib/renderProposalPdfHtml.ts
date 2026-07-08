import { renderAsync } from 'docx-preview'
import type { ProposalStyleConfig } from '@desktop-shared/proposalStyle'
import { MARGIN_TWIPS, defaultProposalStyle } from '@desktop-shared/proposalStyle'
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

// 品牌页眉横幅【占满版心宽度】（width:100%），logo 更大、橙色分隔线贯穿全宽，视觉更像正式页眉。
// 横幅高度由「版心宽 ÷ 横幅宽高比」自动决定，无需固定值。A4 宽 8.27in；横幅原图 1247×144，宽高比
// ≈ 8.66。据此算出页眉实际高度，用于 @page 顶部留白的联动（顶部留白 + 页眉 ≈ Word 页边距）。
const A4_WIDTH_IN = 8.27
const BANNER_RATIO = 1247 / 144 // 横幅宽高比 ≈ 8.66

// 图与表尽量不跨页（与 proposalDocx 的 cantSplit/keepNext 对齐——docx-preview 不渲染那两个属性，
// 故 PDF 侧用 break-inside 复刻同等观感）：表格【行】不被从中间劈开、图片不被切两半、含图的段落整体
// 不断开。:has() 由 Chromium 打印引擎（printToPDF）支持；img 规则单独留作兜底。两条渲染路径共用。
const BREAK_INSIDE_CSS = `
.${PDF_DOCX_CLASS} table tr { break-inside: avoid !important; }
.${PDF_DOCX_CLASS} img { break-inside: avoid !important; }
.${PDF_DOCX_CLASS} p:has(img) { break-inside: avoid !important; break-after: avoid !important; }`

// 【无品牌 / 兜底】打印复位 CSS：@page margin:0，每个 A4 section 干净映射一页 PDF（docx-preview 自带
// min-height=整页 + break-after 分页）。brand 关时（docx 无页眉、不做下面的 thead 重构）走这条，保持
// 历史行为不变。放在 <head>，docx-preview 自注 <style> 在 <body> 级联更靠后，故关键属性 !important 反压。
function buildPlainResetCss(): string {
  return `
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.${DOCX_WRAPPER} { background: #fff !important; padding: 0 !important; margin: 0 !important; }
.${DOCX_WRAPPER} > section.${PDF_DOCX_CLASS} { box-shadow: none !important; margin: 0 !important; break-after: page; }
.${DOCX_WRAPPER} > section.${PDF_DOCX_CLASS}:last-child { break-after: auto; }
${BREAK_INSIDE_CSS}
`
}

// 【品牌页眉】打印复位 CSS，配合下方「把封面之外的 sections 包进 <table>、页眉放 <thead>」的 DOM 重构。
//
// 【症结】docx-preview 只把页眉贴在每个「分页盒子」（按 docx 显式分页符切出的 section）顶部【一次】，
// 盒子内靠 CSS 溢出的续页不重复它 → 长章节/长目录续页丢页眉（Word 原生 header 每物理页重复，故只有走
// docx-preview 的这条 PDF/预览路径有此症，直出的 .docx 本身正常）。
//
// 【为何不用 position:fixed】试过：Chromium printToPDF 下 fixed 相对「页边距内的内容区」定位、且负 top
// 渲染错乱（跑页底），页眉无法进上方页边距区，只能压在正文首行同一条带上（右对齐仅不遮左侧，右侧长首行
// 仍被叠）；且 fixed 页眉 + docx-preview 硬设的 section min-height 会互相顶溢、每页后挤出空白纸。
//
// 【thead 正解】HTML <thead>（display:table-header-group）在打印时【每物理页自动重复】，且表体内容永远
// 排在它下方、绝不重叠——页眉线以上无任何文字。故把目录+正文包进一个 <table>、页眉放 thead。
//
// 【封面排除】封面（第一个 section）留在 table 之外、单独 break-after:page，故封面无 thead 页眉、维持
// 自带大 logo。
//
// 【页边距】@page 左/右/下 = 页边距 marginIn；顶部扣掉页眉实际高（marginIn − headerH），使「顶部
// 页边距 + thead 页眉」≈ 正文顶与 Word 页边距对齐。headerH 由版心宽（A4 − 左右页边距）÷ 横幅宽高比算出。
//
// 【无空白页 + 每章一页】docx-preview 把每章渲成独立 section（无 <br>/page-break 元素），原靠 section 的
// 整页 min-height 撑成「每章一页」；但整页 min-height 叠加 @page margin 会溢出、每页后挤出空白纸。故归零
// min-height，再用 break-after:page 补回每章分页——min-height 已为 0，不会双重撑空白（详见下方规则注释）。
function buildBrandedHeaderCss(marginIn: number): string {
  const contentWidthIn = A4_WIDTH_IN - marginIn * 2 // 版心宽 = 页宽 − 左右页边距
  const headerHIn = contentWidthIn / BANNER_RATIO // 横幅占满版心宽时的实际高度
  const topIn = Math.max(0, marginIn - headerHIn)
  return `
@page { size: A4; margin: ${topIn}in ${marginIn}in ${marginIn}in ${marginIn}in; }
html, body { margin: 0; padding: 0; background: #fff; }
.${DOCX_WRAPPER} { background: #fff !important; padding: 0 !important; margin: 0 !important; }
/* 【后代选择器，不能用 > 直接子】重构后目录/正文 section 已被搬进 table，不再是 wrapper 直接子。
   必须用后代选择器才能命中它们，清掉 docx-preview 给 section 硬设的 display:flex（会把内容竖向撑开、
   正文下移）、padding-top:96px（=1in，正文再下移一整寸）、min-height:整页（撑页导致空白纸）。曾因写成
   「大于号 + section」的直接子选择器只命中封面、table 内 section 全保留原样 → 每章顶部凭空多出空白。 */
.${DOCX_WRAPPER} section.${PDF_DOCX_CLASS} {
  box-shadow: none !important; margin: 0 !important; padding: 0 !important;
  min-height: 0 !important; height: auto !important; display: block !important;
}
/* 封面：留在 table 外、单独成页；页边距改用固定内边距（上一条已把它的 padding 清零，这里补回）。 */
.${DOCX_WRAPPER} > section.${PDF_DOCX_CLASS}.pdf-cover-page { padding: ${marginIn}in !important; break-after: page; }
/* 章节分页：docx-preview 把每章渲成一个独立 section（无 <br>/page-break，原靠 section 的整页 min-height
   撑成每章一页）。上面把 min-height 归零后，改用 break-after:page 让每章 section 后另起一页——min-height
   已为 0，不会像「整页 min-height + break-after」那样双重撑出空白纸。 */
table.pdf-body-table tbody section.${PDF_DOCX_CLASS} { break-after: page; }
table.pdf-body-table tbody section.${PDF_DOCX_CLASS}:last-child { break-after: auto; }
/* 正文表：thead 每物理页重复做页眉，tbody 装目录+正文，正文永远排在页眉下方、不重叠。 */
table.pdf-body-table { width: 100%; border-collapse: collapse; }
table.pdf-body-table thead { display: table-header-group; }
table.pdf-body-table thead .pdf-header-band { text-align: center; padding: 0 0 6pt 0; }
/* 横幅占满版心宽（width:100%），高度按比例自适应——logo 更大、橙线贯穿全宽。 */
table.pdf-body-table thead .pdf-header-band img { width: 100%; height: auto; }
table.pdf-body-table > tbody > tr > td { padding: 0; }
/* 隐藏 docx-preview 每盒子只贴一次的 inline 页眉，改由 thead 每物理页重复。 */
section.${PDF_DOCX_CLASS} > header { display: none !important; }
/* 隐藏页脚：thead 重构后，docx-preview 的 footer 会落在表体内容流里（不再贴每页底部）——位置已失效，
   且它会把最后一章的零头顶到新的一页、挤出末尾空白纸。故一并隐藏（页码功能在此方案下本就无法正确
   每页显示；如需每页页码是另一独立能力）。 */
section.${PDF_DOCX_CLASS} > footer { display: none !important; }
${BREAK_INSIDE_CSS}
`
}

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
    // 避免节间 30px 间隙累积把内容挤出多余页（与上面 buildPrintResetCss 注释互见）。
    hideWrapperOnPrint: true
  })

  // 品牌页眉「每页重复」：复用 docx-preview 刚渲出的横幅图（第一个带页眉的 section 里的 <img>，
  // useBase64URL 已让它是自包含 data URL，与 Word 内嵌同一张，无需在 renderer 二次引入 base64）。
  // brand 关时 docx 无页眉、抓不到图 → bannerSrc 为空 → 不做重构、走 plain CSS，历史行为不变。
  const headerImg = stage.querySelector(`section.${PDF_DOCX_CLASS} > header img`)
  const bannerSrc = headerImg instanceof HTMLImageElement ? headerImg.src : ''

  let css: string
  if (bannerSrc) {
    // 【DOM 重构】封面（第一个 section）留在 wrapper 里、单独成页（不挂页眉）；其余 sections（目录+正文）
    // 搬进一个 <table>，页眉横幅放 <thead>——thead 在打印时每物理页自动重复、正文永远排在其下方，故
    // 「页眉线以上无任何文字」。详见 buildBrandedHeaderCss 头注释。
    const wrapper = stage.querySelector(`.${DOCX_WRAPPER}`)
    if (wrapper) {
      const sections = Array.from(wrapper.querySelectorAll(`:scope > section.${PDF_DOCX_CLASS}`))
      const cover = sections[0]
      if (cover) cover.classList.add('pdf-cover-page')
      const rest = sections.slice(1)
      if (rest.length) {
        const table = document.createElement('table')
        table.className = 'pdf-body-table'
        const thead = document.createElement('thead')
        const headTr = document.createElement('tr')
        const headTd = document.createElement('td')
        const band = document.createElement('div')
        band.className = 'pdf-header-band'
        const bandImg = document.createElement('img')
        bandImg.src = bannerSrc
        band.appendChild(bandImg)
        headTd.appendChild(band)
        headTr.appendChild(headTd)
        thead.appendChild(headTr)
        const tbody = document.createElement('tbody')
        const bodyTr = document.createElement('tr')
        const bodyTd = document.createElement('td')
        // 把目录+正文 section 逐个搬进 tbody 的单元格（appendChild 会自动从 wrapper 移走）。
        rest.forEach((s) => bodyTd.appendChild(s))
        bodyTr.appendChild(bodyTd)
        tbody.appendChild(bodyTr)
        table.appendChild(thead)
        table.appendChild(tbody)
        wrapper.appendChild(table)
      }
    }
    // 页边距（marginIn）：左/右/下用足额，顶部扣页眉高，让「顶部留白 + thead 页眉」≈ Word 页边距。
    const marginIn = MARGIN_TWIPS[(style ?? defaultProposalStyle()).margin] / 1440 // 1440 twips = 1 英寸
    css = buildBrandedHeaderCss(marginIn)
  } else {
    css = buildPlainResetCss()
  }

  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<style>${css}</style></head><body>` +
    stage.innerHTML +
    '</body></html>'
  )
}
