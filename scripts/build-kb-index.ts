import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { scanKb } from './kb-index/scan.ts'
import { convertFile } from './kb-index/convert.ts'
import { buildVectors } from './kb-index/embed.ts'
import type { KbIndex, KbIndexFile } from '../apps/studio/electron/shared/kbIndex.ts'

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
    // 旧 index 只是增量加速缓存——解析失败（上次构建写到一半被 Ctrl-C/断电）不该让整个
    // 重建炸掉：警告后当作没有旧索引，退回全量重建即可自愈。
    try {
      const prev = JSON.parse(readFileSync(indexPath, 'utf8')) as KbIndex
      for (const f of prev.files) prevByPath.set(f.sourcePath, f)
    } catch (err) {
      console.warn('[build-kb-index] 旧 index.json 解析失败（上次构建被中断？），退回全量重建：', err)
      prevByPath.clear()
    }
  }

  const entries = scanKb(kbRoot)
  const files: KbIndexFile[] = []
  let converted = 0, skipped = 0, failed = 0

  for (const e of entries) {
    const st = statSync(e.sourcePath)
    const prev = prevByPath.get(e.sourcePath)
    // 忠实镜像源码树：<outDir>/<相对源路径含扩展名>.md。给【完整文件名】追加 .md
    // （方案.docx → 方案.docx.md），而非用去扩展名的 title——否则同目录 方案.docx 与
    // 方案.pdf 都落到 方案.md 互相覆盖、深层子目录同名文件也会 flatten 撞车（数据丢失）。
    // 产品目录仍是 <outDir>/<产品线>/<产品>，文件可嵌在其下，AI 递归 Grep 不受影响。
    const mirrorPath = `${join(outDir, e.relPath)}.md`
    // 增量跳过的前提里追加 `prev.mirrorPath === mirrorPath`：修复前的旧索引按老布局
    // （<title>.md）算出的路径与新算法不同，强制 fall through 重转，把可能曾互相覆盖
    // 的镜像迁移到唯一新路径自愈——否则纯增量构建会一直信任旧条目、碰撞不自愈。
    // 快路径：mtime 未变且上次成功且路径一致且镜像还在 → 信任旧 sha1，跳过读文件
    // （避免 3GB 语料每次全量算 sha1）。
    if (
      prev && prev.ok && prev.mtimeMs === st.mtimeMs &&
      prev.mirrorPath === mirrorPath && existsSync(prev.mirrorPath)
    ) {
      files.push(prev); skipped++; continue
    }
    // mtime 变了（或无 prev）：算 sha1 做内容级判断（兼顾"touch 但内容没改"的情形）
    const sha1 = sha1OfFile(e.sourcePath)
    if (
      prev && prev.sha1 === sha1 && prev.ok &&
      prev.mirrorPath === mirrorPath && existsSync(prev.mirrorPath)
    ) {
      files.push(prev); skipped++; continue
    }
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

  const index: KbIndex = { version: 2, kbRoot, builtAtMs, files }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
  console.log(`\n转换完成：${files.length} 文件，失败 ${failed}。index.json → ${indexPath}`)
  // 向量化（fingerprint 绑 builtAtMs，与 index 同源）。失败不吞——整库可重建。
  await buildVectors(files, outDir, builtAtMs)
}

main().catch((e) => { console.error(e); process.exit(1) })
