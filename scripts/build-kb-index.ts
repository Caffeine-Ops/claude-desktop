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
  const builtAtMs = Number(arg('now')) // 必填：调用方传时间戳；脚本不调 Date.now，缺失直接抛异常而非静默写 0（1970）

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
    const prev = prevByPath.get(e.sourcePath)
    // 快路径：mtime 未变且上次成功且镜像还在 → 信任旧 sha1，跳过读文件（避免 3GB 语料每次全量算 sha1）
    if (prev && prev.ok && prev.mtimeMs === st.mtimeMs && existsSync(prev.mirrorPath)) {
      files.push(prev); skipped++; continue
    }
    // mtime 变了（或无 prev）：算 sha1 做内容级判断（兼顾"touch 但内容没改"的情形）
    const sha1 = sha1OfFile(e.sourcePath)
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
