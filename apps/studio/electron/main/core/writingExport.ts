import { writeFile } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'

import { markdownToDocxBuffer } from './proposalDocx'
import { sanitizeBaseName } from './writingExportPure'
import type { ProposalStyleConfig } from '../../shared/proposalStyle'
import type { MermaidImage } from '../../shared/ipc-channels'

/**
 * 写作的导出出口。**不复用 exportProposal**：那个函数的保存对话框默认文件名写死成
 * 「方案草稿.docx」，写作复用会让用户在保存框里看到「方案草稿」，且日志里显示成方案导出、
 * 误导排查。真正的重逻辑（markdownToDocxBuffer）是共用的，这里只是自己管保存框与默认名。
 *
 * 用户取消保存框时回 `{ path: null }`，不是错误——沿用 PROPOSAL_EXPORT 的语义。
 *
 * 不做接地闸门（collectUngroundedImagePaths）：那是方案文档「图与文同源」的安全底线，写作
 * 工作区没有 KB 检索/引用配图这一套，稿子里的图都是用户自己的文件，不适用该校验。
 *
 * `assetBaseDir`：正文里 `../images/x.png` 这类相对图路径的解析基准目录（节文件所在目录），
 * 由 renderer 侧算好传入（project 模式是 `<projectDir>/drafts`，single 模式留空——见
 * WritingDocPanel.tsx 里 writingAssetBaseDir 的头注释）。缺省时 markdownToDocxBuffer 的图片
 * 分支跳过解析，img.url 原样交给 readFileSync，找不到就降级文字占位，不会抛错中断导出。
 *
 * `mermaidImages`（2026-08-04 code review 补）：此前恒为 undefined，Word 导出的 mermaid 块
 * 永远降级成灰字「[图示]」，而 PDF 导出（PROPOSAL_RENDER 通道）已经传了预渲图——同一份稿子
 * 两条导出链不一致。与 ProposalDocPanel 导出 docx 时的写法对齐（renderer 先
 * renderMermaidImageMap 预渲成 PNG 再传入），main 侧只管透传给 markdownToDocxBuffer。
 */
export async function exportWritingDocx(
  win: BrowserWindow,
  markdown: string,
  style: ProposalStyleConfig,
  defaultBaseName: string,
  assetBaseDir?: string,
  mermaidImages?: Record<string, MermaidImage>
): Promise<{ path: string | null }> {
  const r = await dialog.showSaveDialog(win, {
    filters: [{ name: 'Word', extensions: ['docx'] }],
    defaultPath: `${sanitizeBaseName(defaultBaseName)}.docx`
  })
  if (r.canceled || !r.filePath) return { path: null }
  // 末位 false = 关掉「章节装饰」（标题自动编号 + 每章另起一页）：那是方案文档的体裁约定，
  // 写作体裁套上去会双重编号、把短文案拆成一堆半空页。见 markdownToDocxBuffer 同名参数注释。
  const buf = await markdownToDocxBuffer(
    markdown,
    style,
    undefined,
    mermaidImages,
    assetBaseDir,
    false
  )
  await writeFile(r.filePath, buf)
  return { path: r.filePath }
}

/**
 * PDF：字节由渲染层出（renderer 用 renderProposalPdfHtml → PROPOSAL_RENDER_PDF 拿到 printToPDF
 * 字节），main 只管保存框与写盘——与 exportWritingDocx 分成两条通道是因为生成方不同，硬塞进一个
 * 通道会让 payload 出现互斥字段。
 */
export async function saveWritingPdf(
  win: BrowserWindow,
  bytes: Uint8Array,
  defaultBaseName: string
): Promise<{ path: string | null }> {
  const r = await dialog.showSaveDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: `${sanitizeBaseName(defaultBaseName)}.pdf`
  })
  if (r.canceled || !r.filePath) return { path: null }
  await writeFile(r.filePath, bytes)
  return { path: r.filePath }
}
