import { dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

/**
 * Supported export formats for a proposal document.
 *
 * MVP implements only `'md'` (raw markdown, written directly to disk).
 * To add Word or PDF support later, extend this union and add a matching
 * arm to the switch below — the IPC surface (`format` field on the
 * payload) and the preload signature are already parameterised on this
 * type, so no IPC changes are needed.
 */
export type ExportFormat = 'md' // 进阶加 'docx' | 'pdf'

/**
 * Show the OS native save dialog and, if the user confirms, write the
 * proposal document to disk in the requested format.
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
  format: ExportFormat
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
      // ExportFormat variant is added without a handler here.
      const _exhaustive: never = format
      throw new Error(`Unsupported export format: ${String(_exhaustive)}`)
    }
  }

  return { path: r.filePath }
}
