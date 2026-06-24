import { dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import type { ProposalExportFormat } from '../../shared/ipc-channels'
import { markdownToDocxBuffer } from './proposalDocx'

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
 *                   and the write adapter. Currently only `'md'` is wired;
 *                   future formats would convert `markdown` here before
 *                   writing (e.g. via pandoc / docx-builder).
 * @returns `{ path: string }` with the absolute path written on success, or
 *          `{ path: null }` when the user cancelled the save dialog.
 */
export async function exportProposal(
  win: BrowserWindow,
  markdown: string,
  format: ProposalExportFormat
): Promise<{ path: string | null }> {
  const filters =
    format === 'docx'
      ? [{ name: 'Word', extensions: ['docx'] }]
      : [{ name: 'Markdown', extensions: ['md'] }]

  const r = await dialog.showSaveDialog(win, {
    filters,
    defaultPath: format === 'docx' ? '方案草稿.docx' : '方案草稿.md'
  })

  if (r.canceled || !r.filePath) return { path: null }

  switch (format) {
    case 'md':
      writeFileSync(r.filePath, markdown, 'utf8')
      break
    case 'docx': {
      // markdown → 真 .docx（逐 mdast 节点构造，见 proposalDocx.ts）。
      const buf = await markdownToDocxBuffer(markdown)
      writeFileSync(r.filePath, buf)
      break
    }
    default: {
      const _exhaustive: never = format
      throw new Error(`Unsupported export format: ${String(_exhaustive)}`)
    }
  }

  return { path: r.filePath }
}
