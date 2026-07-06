import { BrowserWindow, dialog } from 'electron'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 导出 PDF（P2-2）—— Chromium printToPDF 路线。
 *
 * 为什么不在 main 直接 docx→PDF：main 进程没有 DOM，跑不了 docx-preview。所以 renderer 先用
 * docx-preview 把【与预览同一份 docx buffer】渲成自包含 HTML（样式内联、图 base64、@page A4 复位
 * CSS），main 这里只负责：弹保存框 → 隐藏 BrowserWindow 加载该 HTML → webContents.printToPDF 打成
 * A4 PDF → 落盘。好处：开箱即用、零外部依赖（不像 LibreOffice 要用户装软件）、中文字体由 Chromium
 * 处理不缺字、且 PDF 与预览同源逐像素一致。
 *
 * 隐藏窗口而非复用前台 webContents：printToPDF 打印整个 document，前台页含整套 app UI，没法只截纸张；
 * 隔离一个只装纸张 HTML 的离屏窗口才能得到「只含方案」的干净 PDF。show:false 全程不打扰用户。
 *
 * @returns `{ path }` 落盘绝对路径；用户取消保存框 → `{ path: null }`。
 */
export async function exportProposalPdf(
  win: BrowserWindow,
  html: string,
  defaultPath = '方案草稿.pdf'
): Promise<{ path: string | null }> {
  const r = await dialog.showSaveDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath
  })
  if (r.canceled || !r.filePath) return { path: null }

  // 用临时 .html 文件 + loadFile，而非 data: URL：大文档把所有配图 base64 内联后 HTML 可达数 MB，
  // data: URL 在此体量下不稳（长度限制/解析慢）；落临时文件再 loadFile 稳定，打印后连目录一并清掉。
  const dir = mkdtempSync(join(tmpdir(), 'proposal-pdf-'))
  const htmlPath = join(dir, 'doc.html')
  writeFileSync(htmlPath, html, 'utf8')

  // 离屏窗口只渲染静态自包含 HTML：不挂 preload、关 node/sandbox 收紧，最小化副作用与攻击面。
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  try {
    await pdfWin.loadFile(htmlPath)
    // 等字体就绪再打印：中文字体异步加载，未就绪时首帧会用 fallback 字体量错行高/分页。
    // document.fonts 在 Chromium 必有；保险起见三元兜底，拿不到就直接放行。
    await pdfWin.webContents.executeJavaScript(
      'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'
    )
    // preferCSSPageSize：让 Chromium 用 HTML 里的 @page size（A4）而非这里的 pageSize 兜底，
    // 与 docx-preview 渲出的 A4 页面尺寸对齐，保证一页 docx = 一页 PDF（margins 全 0，页内已含版心）。
    const pdf = await pdfWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: true
    })
    writeFileSync(r.filePath, pdf)
    return { path: r.filePath }
  } finally {
    if (!pdfWin.isDestroyed()) pdfWin.destroy()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败无害，系统会自行回收 tmp */
    }
  }
}
