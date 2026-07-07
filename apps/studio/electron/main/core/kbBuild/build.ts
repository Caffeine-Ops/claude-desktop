import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { scanKb } from './scan'
import { convertFile } from './convert'
import { buildVectors } from './embed'
import type { KbIndex, KbIndexFile } from '../../../shared/kbIndex'

export interface BuildProgress { phase: 'convert' | 'vectors'; done: number; total: number }
export interface BuildVectorsOpt { localModelPath?: string }
export interface BuildOptions {
  kbRoot: string
  outDir: string
  now: number
  vectors: BuildVectorsOpt | false
  onProgress?: (p: BuildProgress) => void
  log?: (line: string) => void
}

function sha1OfFile(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

/**
 * 全库增量构建（原 scripts/build-kb-index.ts 主体）。增量三前提与镜像唯一键
 * 的注释原样保留在对应代码行。vectors:false 时跳过向量化——旧 vectors 的
 * fingerprint 与新 builtAtMs 不符，embedWorker 会报 stale 降级 BM25，不会读到
 * 幽灵行；模型就绪后下一轮构建自动补齐。
 */
export async function buildKbIndex(opts: BuildOptions): Promise<KbIndex> {
  const { kbRoot, outDir, now } = opts
  const prevByPath = new Map<string, KbIndexFile>()
  const indexPath = join(outDir, 'index.json')
  if (existsSync(indexPath)) {
    // 旧 index 只是增量加速缓存——解析失败（上次构建写到一半被 Ctrl-C/断电）不该让整个
    // 重建炸掉：警告后当作没有旧索引，退回全量重建即可自愈。
    try {
      const prev = JSON.parse(readFileSync(indexPath, 'utf8')) as KbIndex
      for (const f of prev.files) prevByPath.set(f.sourcePath, f)
    } catch (err) {
      // 不能静默吞：cron/运维靠这条 warn 看到「索引损坏」信号（f6159e39 的 F6 修复）；
      // 同时经 opts.log 转发给 app 侧调用方。语义仍是退全量——prevByPath 保持空即可。
      console.warn('[build-kb-index] 旧 index.json 解析失败（上次构建被中断？），退回全量重建：', err)
      opts.log?.(`旧 index.json 解析失败（上次构建被中断？），退回全量重建：${String(err)}`)
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
    if (prev && prev.ok && prev.mtimeMs === st.mtimeMs && prev.mirrorPath === mirrorPath && existsSync(prev.mirrorPath)) {
      files.push(prev); skipped++; continue
    }
    // mtime 变了（或无 prev）：算 sha1 做内容级判断（兼顾"touch 但内容没改"的情形）
    const sha1 = sha1OfFile(e.sourcePath)
    if (prev && prev.sha1 === sha1 && prev.ok && prev.mirrorPath === mirrorPath && existsSync(prev.mirrorPath)) {
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
      assets: r.assets, ok: r.ok, error: r.error,
      // v3：重转不改「首次入库时间」；只有全新路径（或同路径覆盖后 prev 被内容判失效
      // 仍存在——此时保留 prev 值即「同路径覆盖刷新时间」交给 kbStore 删旧条目实现）取 now
      importedAtMs: prev?.importedAtMs ?? now,
      sizeBytes: st.size
    })
    opts.onProgress?.({ phase: 'convert', done: converted + skipped + failed, total: entries.length })
  }

  const index: KbIndex = { version: 3, kbRoot, builtAtMs: now, files }
  mkdirSync(outDir, { recursive: true })
  // tmp+rename：构建中途被杀不能留半截 index.json（读取端虽防御，但坏文件会
  // 让下一轮增量退化全量）。点开头 tmp 名同时保证 manifest walk 永远收不进它。
  const tmp = join(outDir, '.index.json.tmp')
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8')
  renameSync(tmp, indexPath)
  opts.log?.(`转换完成：${files.length} 文件，失败 ${failed}。index.json → ${indexPath}`)

  if (opts.vectors !== false) {
    opts.onProgress?.({ phase: 'vectors', done: 0, total: 1 })
    await buildVectors(files, outDir, now, opts.vectors.localModelPath)
    opts.onProgress?.({ phase: 'vectors', done: 1, total: 1 })
  }
  return index
}
