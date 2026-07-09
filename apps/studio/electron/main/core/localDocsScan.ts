/**
 * 授权目录文档扫描（main 侧）——知识库页「全部文件」的数据源。
 *
 * 扫描目录清单 = 预设（系统「下载」+「桌面」，`app.getPath` 动态解析、可停用）
 * + 用户自定义目录（经系统文件夹选择器添加，持久化在 userData/kb-config.json，
 * 见 KbConfig.localDocsExtraDirs / localDocsDisabledPresets）。「授权」两条路：
 *  - 预设目录是 macOS TCC 授权单元：首次 readdir 自动触发系统授权弹窗，拒绝
 *    则该目录落进 `deniedDirs` 交 UI 提示，绝不让整个扫描 reject；
 *  - 自定义目录经 OS 原生选择器选中——「用户主动选中」本身就是系统层的授权
 *    动作（user-selected access），选完即可读。
 *
 * 设计取舍：
 *  - 只返回元数据（名称/路径/大小/mtime/来源），不读文件内容——打开走
 *    SHELL_OPEN_PATH 交系统应用，渲染层磁盘触达面不因这条通道扩大。
 *  - 迭代式 BFS + 三重上限（深度 / 命中数 / 访问 dirent 数）：下载目录可能
 *    藏着整个 node_modules 或解压出来的仓库，无上限递归会把 main 拖死。
 *    上限触顶时结果依然可用（truncated 旗标），宁可少列不可卡死。
 *  - stat 只对命中白名单的文件做（readdir withFileTypes 免费给出 isFile/
 *    isDirectory），全目录逐文件 stat 是白花的盘 IO。
 *  - 30s TTL 模块级缓存，键含目录清单签名——增删/开关目录后签名变化即自然
 *    失效，不需要显式 invalidate；「刷新」按钮传 force 绕过。
 */

import { app } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  LocalDocEntry,
  LocalDocsDir,
  LocalDocsPreset,
  LocalDocsScanResult
} from '../../shared/ipc-channels'
import { getKbConfig, patchKbConfig } from './kbIndexStore'

/** 文档扩展名白名单——与前端筛选弹层「按格式」的选项一一对应。 */
export const LOCAL_DOC_EXTS = [
  'doc',
  'docx',
  'txt',
  'md',
  'pdf',
  'xlsx',
  'xls',
  'csv',
  'ppt',
  'pptx',
  'html'
] as const

/** 图片扩展名白名单（「图片识别」域的扫描目标）。 */
export const LOCAL_IMAGE_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'heic',
  'svg'
] as const

const DOC_EXT_SET = new Set<string>(LOCAL_DOC_EXTS)
const IMAGE_EXT_SET = new Set<string>(LOCAL_IMAGE_EXTS)

/** 扫描目标种类：docs=「全部文件」页+文档归类；images=「图片识别」归类。 */
export type LocalScanKind = 'docs' | 'images'

/** 根目录记 0；2 = 最多下钻两层子目录（root/a/b/file）。下载/桌面上的文档
 *  绝大多数在前两层，更深的基本是解压出来的工程目录，钻进去只捞噪音。 */
const MAX_DEPTH = 2
/** 返回给渲染层的条数上限（参考产品同为 1000）。 */
const MAX_RESULTS = 1000
/** 排序前的命中收集上限——过此即置 truncated，防病态目录撑爆内存。 */
const MAX_MATCHES = 8000
/** 访问 dirent 总数上限（含目录/非命中文件），bound 整个 walk 的工作量。 */
const MAX_VISITED = 40000

/** 永不下钻的目录名（大小写不敏感）。dot 目录另有统一规则。 */
const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__', 'bower_components'])

/** 每个扫描种类各一份缓存（docs / images 的清单互不相干）。 */
const caches = new Map<LocalScanKind, { at: number; sig: string; result: LocalDocsScanResult }>()
const CACHE_TTL_MS = 30_000

/* ───────────────────────── 目录清单管理 ───────────────────────── */

/** 预设目录定义顺序即展示顺序。label 中文与全项目 UI 语言一致。 */
const PRESETS: ReadonlyArray<{ key: LocalDocsPreset; label: string }> = [
  { key: 'downloads', label: '下载' },
  { key: 'desktop', label: '桌面' }
]

/**
 * 读当前扫描目录全量清单（含停用的预设）。每次现算不缓存——app.getPath 是
 * 内存查表级开销，而配置文件可能被另一条 IPC（setKbRoot 等）改写。
 */
export function listLocalDocsDirs(): LocalDocsDir[] {
  const cfg = getKbConfig()
  const disabled = new Set(cfg.localDocsDisabledPresets)
  const dirs: LocalDocsDir[] = PRESETS.map(({ key, label }) => ({
    path: app.getPath(key),
    label,
    preset: key,
    enabled: !disabled.has(key)
  }))
  for (const p of cfg.localDocsExtraDirs) {
    // 用户手选了「下载/桌面」本体 → 已在预设行，不重复列（选择器侧也会走
    // setLocalDocsDir(path, true) 的预设分支重新启用它，见下）。
    if (dirs.some((d) => d.path === p)) continue
    dirs.push({ path: p, label: basename(p) || p, preset: null, enabled: true })
  }
  return dirs
}

/**
 * 设置某目录是否参与扫描并持久化。预设目录 = 开关 disabledPresets；自定义
 * 目录 enabled:false = 从 extraDirs 移除、enabled:true = 幂等加入（选择器
 * 添加走的就是这条）。返回更新后的全量清单。
 */
export function setLocalDocsDir(path: string, enabled: boolean): LocalDocsDir[] {
  const cfg = getKbConfig()
  const preset = PRESETS.find((p) => app.getPath(p.key) === path)
  if (preset) {
    const set = new Set(cfg.localDocsDisabledPresets)
    if (enabled) set.delete(preset.key)
    else set.add(preset.key)
    patchKbConfig({ localDocsDisabledPresets: [...set] })
  } else if (!enabled) {
    patchKbConfig({
      localDocsExtraDirs: cfg.localDocsExtraDirs.filter((p) => p !== path)
    })
  } else if (!cfg.localDocsExtraDirs.includes(path)) {
    patchKbConfig({ localDocsExtraDirs: [...cfg.localDocsExtraDirs, path] })
  }
  // 缓存无需显式失效：scan 的缓存键含清单签名，清单一变自然 miss。
  return listLocalDocsDirs()
}

/* ───────────────────────── 扫描 ───────────────────────── */

/** mac 上双击会当应用打开的 bundle 目录（.app 等）伪装成目录，跳过不钻。 */
function isBundleDir(name: string): boolean {
  return /\.(app|photoslibrary|framework|bundle|xcodeproj)$/i.test(name)
}

async function walkRoot(
  root: string,
  extSet: ReadonlySet<string>,
  sink: LocalDocEntry[],
  budget: { visited: number; matched: number }
): Promise<'ok' | 'denied'> {
  // 队列元素带深度的迭代 BFS——递归深目录会炸栈且难以在中途统一预算判断。
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let rootReadable = false

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 根目录读失败 = TCC 拒绝/目录不存在/已被删除 → 整个目录标 denied；
      // 子目录读失败（EACCES/被删的竞态）只丢那一层，扫描继续。
      if (dir === root) return 'denied'
      continue
    }
    if (dir === root) rootReadable = true

    for (const ent of entries) {
      if (budget.visited >= MAX_VISITED || budget.matched >= MAX_MATCHES) {
        return rootReadable ? 'ok' : 'denied'
      }
      budget.visited += 1
      const name = ent.name
      // 隐藏文件/目录、Office 锁文件（~$xxx.xlsx）一律不进结果也不下钻。
      if (name.startsWith('.') || name.startsWith('~$')) continue

      if (ent.isDirectory()) {
        if (depth >= MAX_DEPTH) continue
        if (SKIP_DIR_NAMES.has(name.toLowerCase()) || isBundleDir(name)) continue
        queue.push({ dir: join(dir, name), depth: depth + 1 })
        continue
      }
      if (!ent.isFile()) continue

      const dot = name.lastIndexOf('.')
      if (dot <= 0) continue
      const ext = name.slice(dot + 1).toLowerCase()
      if (!extSet.has(ext)) continue

      const absPath = join(dir, name)
      try {
        const st = await stat(absPath)
        // readdir 后 stat 有 TOCTOU 窗口（下载目录文件来去频繁），失败静默丢。
        if (!st.isFile()) continue
        budget.matched += 1
        sink.push({
          name,
          absPath,
          ext,
          size: st.size,
          mtimeMs: st.mtimeMs,
          source: root
        })
      } catch {
        continue
      }
    }
  }
  return 'ok'
}

/**
 * 扫描已启用的授权目录，带 TTL 缓存。永不 reject——失败时 ok:false + error 文案。
 * `kind` 决定扩展名白名单（docs=文档 / images=图片），缓存按 kind 分池。
 */
export async function scanLocalDocs(
  force: boolean,
  kind: LocalScanKind = 'docs'
): Promise<LocalDocsScanResult> {
  const now = Date.now()
  const enabledDirs = listLocalDocsDirs().filter((d) => d.enabled)
  // 缓存键 = 启用目录的路径序列：增删/开关目录后签名变化自然失效。
  const sig = enabledDirs.map((d) => d.path).join('\n')
  const cache = caches.get(kind)
  if (!force && cache && cache.sig === sig && now - cache.at < CACHE_TTL_MS) {
    return cache.result
  }

  try {
    const files: LocalDocEntry[] = []
    const deniedDirs: string[] = []
    const budget = { visited: 0, matched: 0 }
    const extSet = kind === 'images' ? IMAGE_EXT_SET : DOC_EXT_SET
    // 顺序扫（不并发）：全部目录共享同一份预算计数，且顺序 IO 对 SSD 上几千
    // 个 dirent 足够快，不值得为并发引入预算竞态。
    for (const dir of enabledDirs) {
      const outcome = await walkRoot(dir.path, extSet, files, budget)
      if (outcome === 'denied') deniedDirs.push(dir.path)
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const total = files.length
    const result: LocalDocsScanResult = {
      ok: true,
      files: files.slice(0, MAX_RESULTS),
      total,
      // 两种截断都要如实上报：结果条数截断，或 walk 预算触顶（此时 total
      // 本身就不完整，同样不能让 UI 当成「已列全」）。
      truncated:
        total > MAX_RESULTS || budget.matched >= MAX_MATCHES || budget.visited >= MAX_VISITED,
      dirs: enabledDirs,
      deniedDirs,
      scannedAt: now
    }
    caches.set(kind, { at: now, sig, result })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 失败不进缓存——下一次调用重试而不是把错误钉 30s。
    return {
      ok: false,
      files: [],
      total: 0,
      truncated: false,
      dirs: enabledDirs,
      deniedDirs: [],
      scannedAt: now,
      error: `扫描失败：${msg}`
    }
  }
}
