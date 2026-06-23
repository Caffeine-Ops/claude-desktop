import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { ScanEntry } from './scan.ts'

export interface ConvertResult {
  markdown: string
  assets: string[]
  ok: boolean
  error?: string
}

function tryMarkitdown(src: string, assetsDir: string): { md: string; assets: string[] } {
  // markitdown 把文档转 markdown 到 stdout；--keep-data-uris 关闭，改用 -o 落盘可控
  mkdirSync(assetsDir, { recursive: true })
  const md = execFileSync('markitdown', [src], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  // markitdown 当前版本不单独导图；内嵌图以 data-uri 形式留在 md 里，
  // 由 Task 3 统一抽取落盘。这里 assets 先返回空。
  return { md, assets: [] }
}

function tryLibreOffice(src: string, tmpDir: string): string {
  mkdirSync(tmpDir, { recursive: true })
  execFileSync('soffice', [
    '--headless', '--convert-to', 'txt:Text', '--outdir', tmpDir, src
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const base = basename(src).replace(/\.[^.]+$/, '.txt')
  const out = join(tmpDir, base)
  return existsSync(out) ? readFileSync(out, 'utf8') : ''
}

export async function convertFile(entry: ScanEntry, outDir: string): Promise<ConvertResult> {
  const assetsDir = join(outDir, 'assets', `${entry.productLine}__${entry.product}__${entry.title}`)
  if (entry.ext === '.txt') {
    return { markdown: readFileSync(entry.sourcePath, 'utf8'), assets: [], ok: true }
  }
  try {
    const { md, assets } = tryMarkitdown(entry.sourcePath, assetsDir)
    if (md.trim().length > 0) return { markdown: md, assets, ok: true }
    throw new Error('markitdown 输出为空')
  } catch (e) {
    try {
      const txt = tryLibreOffice(entry.sourcePath, join(outDir, '.tmp'))
      if (txt.trim().length > 0) return { markdown: txt, assets: [], ok: true }
      return { markdown: '', assets: [], ok: false, error: 'markitdown+soffice 均失败/空' }
    } catch (e2) {
      return { markdown: '', assets: [], ok: false, error: String(e2) }
    }
  }
}
