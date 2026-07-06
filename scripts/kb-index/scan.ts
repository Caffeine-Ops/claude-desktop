import { readdirSync, statSync } from 'node:fs'
import { join, extname, basename, relative, sep } from 'node:path'

export interface ScanEntry {
  sourcePath: string
  // 源文件相对 kbRoot 的路径（含扩展名，OS 分隔符）。镜像/资产目录用它作唯一键：
  // 文件系统保证同目录内文件名唯一、不同目录相对路径必不同，所以以 relPath 派生的
  // 镜像名绝不冲突——根治「同名不同扩展（方案.docx / 方案.pdf）」与「深层子目录同名」
  // 都 flatten 到同一 <title>.md 而静默互相覆盖的数据丢失。
  relPath: string
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
    const relPath = relative(kbRoot, sourcePath)
    const rel = relPath.split(sep)
    const productLine = rel[0] ?? ''
    const product = rel.length > 2 ? rel[1] : ''
    out.push({
      sourcePath,
      relPath,
      productLine,
      product,
      title: basename(sourcePath, ext),
      ext
    })
  }
  return out
}
