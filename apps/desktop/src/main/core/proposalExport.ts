import { dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import type { ProposalExportFormat } from '../../shared/ipc-channels'
import type { ProposalStyleConfig } from '../../shared/proposalStyle'
import { markdownToDocxBuffer } from './proposalDocx'
import { collectUngroundedImagePaths } from './proposalVerify'

/**
 * 各导出格式的元数据：保存对话框的文件类型过滤器 + 默认文件名。
 *
 * 用 `Record<ProposalExportFormat, …>` 按格式查表，取代散落在 filters/defaultPath 的
 * if/else——加新格式（如 `'pdf'`）时若漏填这里，TS 在缺 key 处编译报错，与下方 switch
 * 的 `never` 守卫对齐，杜绝「filters/defaultPath 静默回退到 .md」的失配（评审 C2）。
 */
const FORMAT_META: Record<
  ProposalExportFormat,
  { filter: { name: string; extensions: string[] }; defaultPath: string }
> = {
  md: { filter: { name: 'Markdown', extensions: ['md'] }, defaultPath: '方案草稿.md' },
  docx: { filter: { name: 'Word', extensions: ['docx'] }, defaultPath: '方案草稿.docx' }
}

/**
 * 单一真相源派生的运行时白名单 / 类型守卫：keys 来自 FORMAT_META（其类型是
 * `Record<ProposalExportFormat, …>`，故 keys 恒等于联合全体）。IPC 入口用它挡掉
 * 非法 format——加新格式只改 FORMAT_META 一处，guard 自动跟随，无需手维护第二份列表。
 */
const PROPOSAL_EXPORT_FORMATS = Object.keys(FORMAT_META) as ProposalExportFormat[]

export function isProposalExportFormat(v: unknown): v is ProposalExportFormat {
  return typeof v === 'string' && (PROPOSAL_EXPORT_FORMATS as string[]).includes(v)
}

/**
 * Show the OS native save dialog and, if the user confirms, write the
 * proposal document to disk in the requested format.
 *
 * Uses `ProposalExportFormat` from shared/ipc-channels (the single source of
 * truth for this union) instead of a local duplicate — the two were identical
 * (`'md'`) but maintaining them separately risked drift when new formats land.
 *
 * @param win      - The BrowserWindow to anchor the dialog to (modal on macOS).
 * @param markdown - The raw markdown string from the renderer's doc store.
 * @param format   - Target format; drives both the dialog file-type filter
 *                   and the write adapter. `'md'` writes the markdown verbatim;
 *                   `'docx'` runs it through `markdownToDocxBuffer` (mdast→docx,
 *                   see proposalDocx.ts) and writes the binary buffer. We build
 *                   docx by walking mdast nodes rather than shelling out to
 *                   pandoc or going markdown→html→docx: no external runtime
 *                   dependency, and full control over headings / lists / tables
 *                   / bold-italic so the output matches the final Word product.
 * @param style    - Selected Word style template (fonts/sizes/indent/…). Only
 *                   used for `'docx'`; `'md'` is plain text. Undefined falls back
 *                   to the default template (经典正式) inside markdownToDocxBuffer.
 * @returns `{ path: string }` with the absolute path written on success, or
 *          `{ path: null }` when the user cancelled the save dialog.
 */
export async function exportProposal(
  win: BrowserWindow,
  markdown: string,
  format: ProposalExportFormat,
  style?: ProposalStyleConfig
): Promise<{ path: string | null }> {
  const meta = FORMAT_META[format]
  const r = await dialog.showSaveDialog(win, {
    filters: [meta.filter],
    defaultPath: meta.defaultPath
  })

  if (r.canceled || !r.filePath) return { path: null }

  switch (format) {
    case 'md':
      writeFileSync(r.filePath, markdown, 'utf8')
      break
    case 'docx': {
      // markdown → 真 .docx（逐 mdast 节点构造，见 proposalDocx.ts），按选中模板排版。
      // 接地闸门：先算未接地图全集，传给嵌图器把 ungrounded 图降级为占位——交付的 Word 里
      // 绝不出现「不属本节所引文件」的挪用/无关图（评审 AL3）。索引不可用 → 空集、不挡。
      const ungrounded = collectUngroundedImagePaths(markdown)
      const buf = await markdownToDocxBuffer(markdown, style, ungrounded)
      writeFileSync(r.filePath, buf)
      break
    }
    default: {
      // TypeScript 穷尽性守卫：若给 ProposalExportFormat 加新格式却漏改此 switch 分支，
      // 编译期当场报错 `never` 类型检查，避免运行期才发现的漏处理。
      const _exhaustive: never = format
      throw new Error(`Unsupported export format: ${String(_exhaustive)}`)
    }
  }

  return { path: r.filePath }
}
