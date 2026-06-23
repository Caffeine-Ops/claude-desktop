import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { scanKb } from './kb-index/scan.ts'
import { convertFile } from './kb-index/convert.ts'
import type { KbIndex, KbIndexFile } from '../apps/desktop/src/shared/kbIndex.ts'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`缺少参数 --${name}`)
}

function sha1OfFile(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

async function main(): Promise<void> {
  const kbRoot = arg('kb')
  const outDir = arg('out')
  const builtAtMs = Number(arg('now', String(0))) // 调用方传时间戳；脚本不调 Date.now

  const prevByPath = new Map<string, KbIndexFile>()
  const indexPath = join(outDir, 'index.json')
  if (existsSync(indexPath)) {
    const prev = JSON.parse(readFileSync(indexPath, 'utf8')) as KbIndex
    for (const f of prev.files) prevByPath.set(f.sourcePath, f)
  }

  const entries = scanKb(kbRoot)
  const files: KbIndexFile[] = []
  let converted = 0, skipped = 0, failed = 0

  for (const e of entries) {
    const st = statSync(e.sourcePath)
    const sha1 = sha1OfFile(e.sourcePath)
    const prev = prevByPath.get(e.sourcePath)
    if (prev && prev.sha1 === sha1 && prev.ok && existsSync(prev.mirrorPath)) {
      files.push(prev); skipped++; continue
    }
    const mirrorPath = join(outDir, e.productLine, e.product, `${e.title}.md`)
    const r = await convertFile(e, outDir)
    if (r.ok) {
      mkdirSync(dirname(mirrorPath), { recursive: true })
      writeFileSync(mirrorPath, r.markdown, 'utf8')
      converted++
    } else { failed++ }
    files.push({
      sourcePath: e.sourcePath, mirrorPath, productLine: e.productLine,
      product: e.product, title: e.title, mtimeMs: st.mtimeMs, sha1,
      assets: r.assets, ok: r.ok, error: r.error
    })
    process.stdout.write(`\r转换 ${converted} 跳过 ${skipped} 失败 ${failed} / ${entries.length}`)
  }

  const index: KbIndex = { version: 1, kbRoot, builtAtMs, files }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
  console.log(`\n完成：${files.length} 文件，失败 ${failed}。index.json → ${indexPath}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
