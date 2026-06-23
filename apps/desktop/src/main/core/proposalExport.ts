import { dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import type { ProposalExportFormat } from '../../shared/ipc-channels'

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
    format === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : []

  const r = await dialog.showSaveDialog(win, {
    filters,
    defaultPath: '方案草稿.md'
  })

  if (r.canceled || !r.filePath) return { path: null }

  // MVP：md 直接落盘。进阶按 format 走不同 adapter（markdown→docx/pdf）。
  switch (format) {
    case 'md':
      writeFileSync(r.filePath, markdown, 'utf8')
      break
    // future: case 'docx': await convertToDocx(r.filePath, markdown); break
    // future: case 'pdf':  await convertToPdf(r.filePath, markdown);  break
    default: {
      // TypeScript exhaustiveness guard — compile-time error if a new
      // ProposalExportFormat variant is added without a handler here.
      const _exhaustive: never = format
      throw new Error(`Unsupported export format: ${String(_exhaustive)}`)
    }
  }

  return { path: r.filePath }
}
