import { readdirSync, statSync } from 'node:fs'
import { join, extname, basename, relative, sep } from 'node:path'

export interface ScanEntry {
  sourcePath: string
  productLine: string
  product: string
  title: string
  ext: string
}

const ALLOWED = new Set(['.docx', '.docm', '.pptx', '.xlsx', '.xls', '.pdf', '.txt'])

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store' || name.startsWith('~$')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
}

export function scanKb(kbRoot: string): ScanEntry[] {
  const files: string[] = []
  walk(kbRoot, files)
  const out: ScanEntry[] = []
  for (const sourcePath of files) {
    const ext = extname(sourcePath).toLowerCase()
    if (!ALLOWED.has(ext)) continue
    // 相对 kbRoot 的路径段：第一段=产品线，第二段（若存在）=产品
    const rel = relative(kbRoot, sourcePath).split(sep)
    const productLine = rel[0] ?? ''
    const product = rel.length > 2 ? rel[1] : ''
    out.push({
      sourcePath,
      productLine,
      product,
      title: basename(sourcePath, ext),
      ext
    })
  }
  return out
}
