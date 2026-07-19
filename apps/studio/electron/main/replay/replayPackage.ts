/**
 * 录像包（.claudereplay = zip）的读写与资产管线。
 *
 * 导出侧：collectAssets 从编译好的 timeline 里收集导出机上的图片资产
 * （结构化来源 + 文本启发式扫描，最终一律 fs.stat 验证收口——正则误匹配
 * 的「路径」stat 不到就丢弃，无害），writeReplayPackage 落 zip。
 *
 * 导入侧：openReplayPackage 解包资产到 userData/replay-cache/<内容sha1>/，
 * 然后对 timeline 原始文本做 originalPath → 解包路径 的整体重写。重写用
 * 【JSON 转义形态】的字符串做 needle/replacement——路径含 `"`/`\` 时在
 * JSON 文本里是转义过的，直接拿裸路径 replaceAll 会漏配或错配；转义形态
 * 天然对齐（中文/空格在 JSON 里原样，安全）。重写发生在 parse 之前的纯
 * 文本上，UI 轨 path 与 ImageEditMeta 里的同一路径一次全覆盖，之后按路径
 * 读盘的消费组件（ImageEditPanel/ImageGenCard）零改动可用。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import AdmZip from 'adm-zip'

import {
  REPLAY_FORMAT_VERSION,
  type ReplayAsset,
  type ReplayConfirmSnapshot,
  type ReplayItem,
  type ReplayManifest,
  type ReplaySlideEntry,
  type ReplayTimeline
} from '../../shared/replayTypes'

/** confirm_ui/confirm_wait.py 的 log_result_snapshot 打的标记（同名常量见
 *  compileReplay.ts；两处独立持有是因为一个在「表演节奏」职责里只需要
 *  判定命中+取最终选择，一个在「快照收集」职责里需要取完整 JSON——两者
 *  都是纯字符串前缀判定，没有共享的必要）。 */
const CONFIRM_RESULT_MARKER = '[[confirm-result]]'

const TAG = '[replayPackage]'

/** 与 IMAGE_FILE_READ 同上限：超过的资产跳过（回放时该卡显示读取失败，
 *  与今天打开原图已删除的旧会话行为一致）。 */
const MAX_ASSET_BYTES = 30 * 1024 * 1024

/** 文本里的绝对路径 + 图片扩展名。非贪婪到最近的扩展名，误匹配靠 stat
 *  收口；字符集排除引号/反引号/换行/【反斜杠】。反斜杠是关键：本 regex
 *  跑在已 stringify 的 timeline 文本上，换行/引号在里面是 `\n`/`\"` 转义
 *  序列（字面反斜杠开头）——不排除 `\` 时一个从 `https://…` 起步的匹配
 *  会跨越几 KB 的工具日志直到某个 .png，把区间里的真实路径整段吞掉
 *  （2026-07-13 实测：ppt-master 生图进度日志被一口吞，svg 资产 0 收集）。
 *  POSIX 路径不含反斜杠，排除它让匹配撞到任何转义序列立即停。
 *  （代价：Windows 形态的 `C:\...` 路径收不到——win 导出机资产收集需要
 *  另做，见 TODO。）
 *  svg 也收——PPT 会话（ppt-master）的幻灯片是 svg_output/*.svg，回放的
 *  静态幻灯片面板（ReplaySlidesPanel）从资产里读它们。svg 内部对外链
 *  图片的引用不做递归收集（成品图多为内嵌，边角引用缺失可接受）。 */
const IMAGE_PATH_RE = /\/(?:[^\n"'`\\]+?)\.(?:png|jpe?g|webp|gif|bmp|svg)/gi

export interface CollectedAssets {
  assets: ReplayAsset[]
  /** rel → 文件字节。写 zip 用。 */
  files: Map<string, Buffer>
  /** 存在但超大小上限而被跳过的路径（导出完成提示里列出）。 */
  skipped: string[]
}

/**
 * 从 timeline JSON 文本收集图片资产。输入是【序列化后】的 timeline——
 * 结构化字段（imageEdit.open.path、ImageEditMeta.path/fusion）和 tool
 * args/result 里的裸路径都在同一段文本里，一趟正则全覆盖，不必对 items
 * 再做一次结构遍历。
 */
export async function collectAssets(timelineJson: string): Promise<CollectedAssets> {
  const candidates = new Set<string>()
  for (const m of timelineJson.matchAll(IMAGE_PATH_RE)) {
    // JSON 文本里的转义形态还原成真实路径（\" → " 等）；解不开的碎片跳过。
    try {
      candidates.add(JSON.parse(`"${m[0]}"`) as string)
    } catch {
      /* 截断的转义序列等 → 忽略 */
    }
  }

  const assets: ReplayAsset[] = []
  const files = new Map<string, Buffer>()
  const skipped: string[] = []
  const usedIds = new Set<string>()

  for (const path of candidates) {
    let size: number
    try {
      const s = await stat(path)
      if (!s.isFile()) continue
      size = s.size
    } catch {
      continue // 不存在 → 正则误匹配或文件已删，保留原路径不打包
    }
    if (size > MAX_ASSET_BYTES) {
      skipped.push(path)
      continue
    }
    const buf = readFileSync(path)
    let id = createHash('sha1').update(buf).digest('hex').slice(0, 8)
    // 8 位 hex 在几十个资产的量级下几乎不可能撞；真撞（不同内容同前缀）
    // 时线性加后缀，保证 rel 唯一。相同内容的重复路径共享同一文件即可。
    while (usedIds.has(id) && !files.has(`assets/${id}${extOf(path)}`)) id = `${id}x`
    usedIds.add(id)
    const rel = `assets/${id}${extOf(path)}`
    if (!files.has(rel)) files.set(rel, buf)
    assets.push({ id, rel, originalPath: path, bytes: size })
  }

  return { assets, files, skipped }
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i === -1 ? '' : path.slice(i).toLowerCase()
}

/**
 * 扫编译好的 timeline items（不是序列化文本——tool 块的 toolUseId/result
 * 已经是结构化字段，直接读比再拿正则从字符串里抠更直接）找 Bash 工具调用
 * 里 confirm_ui/confirm_wait.py 打的 `[[confirm-result]]{...}` 日志行，落定为
 * manifest.meta.confirmSnapshots。见 ReplayConfirmSnapshot 的字段注释：
 * 为什么快照必须在导出时从日志里落定，不能留到播放时去读项目目录。
 */
export function collectConfirmSnapshots(items: readonly ReplayItem[]): ReplayConfirmSnapshot[] {
  const out: ReplayConfirmSnapshot[] = []
  for (const item of items) {
    if (item.track !== 'chat' || item.op !== 'tool') continue
    if (item.toolName !== 'Bash') continue
    const result = item.result
    const text = typeof result === 'string' ? result : ''
    if (!text.includes(CONFIRM_RESULT_MARKER)) continue
    for (const line of text.split('\n')) {
      const idx = line.indexOf(CONFIRM_RESULT_MARKER)
      if (idx === -1) continue
      const jsonStr = line.slice(idx + CONFIRM_RESULT_MARKER.length).trim()
      try {
        const data = JSON.parse(jsonStr) as unknown
        if (
          !data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          ((data as { stage?: unknown }).stage !== 'tier1' &&
            (data as { stage?: unknown }).stage !== 'final')
        ) {
          continue
        }
        const d = data as {
          stage: 'tier1' | 'final'
          result?: unknown
          recommendations?: unknown
          catalogs?: unknown
        }
        if (!d.result || typeof d.result !== 'object' || Array.isArray(d.result)) continue
        const asRecordOrNull = (v: unknown): Record<string, unknown> | null =>
          v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
        out.push({
          toolUseId: item.toolUseId,
          stage: d.stage,
          result: d.result as Record<string, unknown>,
          recommendations: asRecordOrNull(d.recommendations),
          catalogs: asRecordOrNull(d.catalogs)
        })
      } catch {
        /* 这一行不是合法 JSON——继续找下一行，容忍日志里混了别的输出。 */
      }
    }
  }
  return out
}

/**
 * slides 会话导出：从已收集的资产落定【权威】幻灯片清单，写进
 * manifest.meta.slides。播放端不能自己从消息扫（会把模板参考图当页数、
 * 重写后按哈希排序——见 ReplayMeta.slides 注释），所以在导出机上一次定准：
 *
 * 1. 幻灯片目录 = 收集到的 svg 里【svg 数最多的那个目录】。启发式依据：
 *    deck 页集中在一个 svg_output/ 目录（十几张），消息里混入的其他 svg
 *    （ppt-master 模板 charts/、零星图标）分散且量少。不硬编码目录名——
 *    ppt-master 之外的 svg 工作流也适用。少于 2 张不视为 deck，返回空。
 * 2. readdir 该目录取【此刻磁盘上的最终页集合】：会话中途删除/改名的
 *    中间页不在盘上，天然排除；按文件名数字序（01_cover…13_closing）。
 * 3. 盘上有但资产还没收到的页（罕见：路径从未完整出现在消息文本里）
 *    就地补收进 assets/files，保证清单里每页都在包内。
 *
 * 直接 mutate 传入的 collected（与 collectAssets 的产物同一批写 zip）。
 */
export async function deriveSlides(
  collected: CollectedAssets
): Promise<ReplaySlideEntry[] | undefined> {
  const byDir = new Map<string, ReplayAsset[]>()
  for (const a of collected.assets) {
    if (!a.rel.endsWith('.svg')) continue
    const dir = dirname(a.originalPath)
    const list = byDir.get(dir) ?? []
    list.push(a)
    byDir.set(dir, list)
  }
  let slidesDir: string | null = null
  let best = 1 // 至少 2 张才算 deck
  for (const [dir, list] of byDir) {
    if (list.length > best) {
      best = list.length
      slidesDir = dir
    }
  }
  if (!slidesDir) return undefined

  let names: string[]
  try {
    names = (await readdir(slidesDir)).filter((n) => /\.svg$/i.test(n))
  } catch (err) {
    console.warn(`${TAG} readdir slides dir failed:`, err)
    return undefined
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const byOriginal = new Map(collected.assets.map((a) => [a.originalPath, a]))
  const entries: ReplaySlideEntry[] = []
  for (const name of names) {
    const full = join(slidesDir, name)
    let asset = byOriginal.get(full)
    if (!asset) {
      // 补收（同 collectAssets 的单文件流程，超上限的页跳过并记入 skipped）。
      let size: number
      try {
        const s = await stat(full)
        if (!s.isFile()) continue
        size = s.size
      } catch {
        continue
      }
      if (size > MAX_ASSET_BYTES) {
        collected.skipped.push(full)
        continue
      }
      const buf = readFileSync(full)
      const id = createHash('sha1').update(buf).digest('hex').slice(0, 8)
      const rel = `assets/${id}.svg`
      if (!collected.files.has(rel)) collected.files.set(rel, buf)
      asset = { id, rel, originalPath: full, bytes: size }
      collected.assets.push(asset)
    }
    entries.push({ rel: asset.rel, title: name.replace(/\.svg$/i, '') })
  }
  return entries.length > 0 ? entries : undefined
}

export async function writeReplayPackage(
  outPath: string,
  manifest: ReplayManifest,
  timelineJson: string,
  files: ReadonlyMap<string, Buffer>
): Promise<void> {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  zip.addFile('timeline.json', Buffer.from(timelineJson, 'utf8'))
  for (const [rel, buf] of files) zip.addFile(rel, buf)
  await zip.writeZipPromise(outPath)
}

export type OpenReplayResult =
  | { ok: true; manifest: ReplayManifest; timeline: ReplayTimeline }
  | { ok: false; error: string }

/**
 * 读包 → 校验版本 → 解包资产到 replay-cache →（内存中）重写 timeline
 * 路径 → parse 返回。同一个包（内容 sha1 相同）二次打开跳过解包。
 */
export async function openReplayPackage(zipPath: string): Promise<OpenReplayResult> {
  let zipBuf: Buffer
  try {
    zipBuf = readFileSync(zipPath)
  } catch (err) {
    return { ok: false, error: `无法读取录像文件：${msg(err)}` }
  }

  let zip: AdmZip
  let manifest: ReplayManifest
  let timelineText: string
  try {
    zip = new AdmZip(zipBuf)
    manifest = JSON.parse(
      zip.getEntry('manifest.json')?.getData().toString('utf8') ?? ''
    ) as ReplayManifest
    timelineText = zip.getEntry('timeline.json')?.getData().toString('utf8') ?? ''
  } catch (err) {
    return { ok: false, error: `不是有效的录像包：${msg(err)}` }
  }
  if (!timelineText || !manifest || typeof manifest !== 'object') {
    return { ok: false, error: '不是有效的录像包（缺 manifest/timeline）。' }
  }
  if (manifest.version !== REPLAY_FORMAT_VERSION) {
    return {
      ok: false,
      error: `录像格式版本不兼容（文件 v${String(manifest.version)}，当前支持 v${REPLAY_FORMAT_VERSION}）。请用相近版本的应用重新导出。`
    }
  }

  // 解包资产。cache key = zip 内容 sha1（同包重开免解包、改包必然换目录）。
  const cacheKey = createHash('sha1').update(zipBuf).digest('hex').slice(0, 16)
  const cacheDir = join(replayCacheRoot(), cacheKey)
  const extracted = new Map<string, string>() // originalPath → 解包后绝对路径
  try {
    let dirExists = false
    try {
      dirExists = (await stat(cacheDir)).isDirectory()
    } catch {
      /* ENOENT → 需要解包 */
    }
    if (!dirExists) {
      await mkdir(join(cacheDir, 'assets'), { recursive: true })
      for (const a of manifest.assets ?? []) {
        const data = zip.getEntry(a.rel)?.getData()
        if (!data) continue
        await writeFile(join(cacheDir, a.rel), data)
      }
    }
    for (const a of manifest.assets ?? []) {
      extracted.set(a.originalPath, join(cacheDir, a.rel))
    }
  } catch (err) {
    return { ok: false, error: `解包录像资产失败：${msg(err)}` }
  }

  // 路径重写（JSON 转义形态，见头注释）。
  for (const [orig, now] of extracted) {
    const needle = JSON.stringify(orig).slice(1, -1)
    const replacement = JSON.stringify(now).slice(1, -1)
    timelineText = timelineText.replaceAll(needle, replacement)
  }

  // 幻灯片清单注入解包后绝对路径（包内只有 rel）。与上面 timeline 重写
  // 同源（join(cacheDir, rel)），所以播放端拿清单 path 与重写后消息文本做
  // 字符串相等匹配即可判定「这页已经播出来了」。
  if (manifest.meta.slides) {
    for (const s of manifest.meta.slides) {
      s.path = join(cacheDir, s.rel)
    }
  }

  try {
    const timeline = JSON.parse(timelineText) as ReplayTimeline
    if (!Array.isArray(timeline.items)) {
      return { ok: false, error: '录像时间线损坏（items 缺失）。' }
    }
    return { ok: true, manifest, timeline }
  } catch (err) {
    return { ok: false, error: `录像时间线解析失败：${msg(err)}` }
  }
}

function replayCacheRoot(): string {
  return join(app.getPath('userData'), 'replay-cache')
}

/**
 * 后台清理超过 maxAgeDays 未修改的解包目录（mtime——解包一次后目录不再被
 * 写，重开同包会跳过解包也不 touch；14 天足够覆盖一轮演示周期，被清掉的
 * 包重开时自动重新解包，无功能损失）。启动后调用，失败静默。
 */
export async function cleanReplayCache(maxAgeDays = 14): Promise<void> {
  const root = replayCacheRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return // 目录不存在 = 从没打开过录像
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
    try {
      if (statSync(dir).mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true })
      }
    } catch (err) {
      console.warn(`${TAG} clean ${dir} failed:`, err)
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
