/**
 * Known-workspaces registry — the set of workspace directories whose
 * sessions the unified sidebar lists.
 *
 * 为什么是「注册表并集」而不是 SDK 的全局 listSessions()：
 * `~/.claude/projects/` 下混着大量不属于本应用的会话目录（官方 Claude
 * app 以 bundle 内 cwd 跑出的会话、/private/tmp 下的一次性目录、CLI
 * 直接用的仓库……）。全局扫会把这些垃圾行全部捞进侧边栏。改成「只扫
 * 用户在本应用里用过的工作区」天然过滤噪音，且与 sessionStore「磁盘
 * 即真相」的哲学兼容——注册表只记录目录集合，不记录会话本身，永远
 * 不会和 jsonl 漂移。
 *
 * 持久化：`userData/workspaces.json`，只存用户显式选过的目录；默认
 * 工作区（桌面）不落盘，每次运行时动态解析后置顶——桌面路径可能随
 * OS 配置变化（OneDrive 重定向、本地化），落盘反而会钉死陈旧值。
 *
 * 已被删除/移动的工作区目录刻意 **不** 从列表剔除：它名下的会话
 * transcript 还在 `~/.claude/projects/` 里，仍要在侧边栏可见、可读。
 * 目录是否存在只在「往里面发消息」时才校验（engine 侧）。
 */
import { statSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'

const TAG = '[workspaceRegistry]'
const FILE_NAME = 'workspaces.json'

/** 防御上限：正常用户个位数工作区，超出说明有东西在滥用 add。 */
const MAX_WORKSPACES = 50

/**
 * Resolve the default workspace directory used on every new tab/engine.
 * (Moved verbatim from engine.ts when the registry was introduced —
 * the default workspace is now also the registry's implicit first entry.)
 *
 * Product contract (since the "drop a folder to start" gate was removed):
 * the app opens straight into the user's desktop folder so there's never
 * a picker page on cold start. We resolve it via Electron's
 * `app.getPath('desktop')` — never by concatenating the home dir with a
 * literal folder name — because getPath is the only cross-platform-correct
 * source: on Windows the desktop folder can be OneDrive-redirected or
 * localized, and getPath consults the OS shell folder registry to return
 * the real path. macOS returns the expected location under the home dir.
 *
 * Fallback: if the Desktop path can't be resolved or isn't a real
 * directory (locked-down enterprise profiles, exotic shell folder
 * redirection, a transient FS error), we silently fall back to the user
 * home (`app.getPath('home')`) so the engine still binds a valid cwd and
 * the user never sees a blank window. We deliberately do NOT fall back to
 * `process.cwd()` — in a packaged .app that points inside the bundle,
 * which is read-only and wrong.
 *
 * Must be called after `app.whenReady()` (getPath throws before ready).
 */
export function resolveDefaultWorkspace(): string {
  const tryDir = (p: string | undefined): string | null => {
    if (!p) return null
    try {
      return statSync(p).isDirectory() ? p : null
    } catch {
      return null
    }
  }

  let desktop: string | undefined
  try {
    desktop = app.getPath('desktop')
  } catch {
    desktop = undefined
  }
  const desktopDir = tryDir(desktop)
  if (desktopDir) return desktopDir

  // Desktop unusable — fall back to the user home. getPath('home') is
  // about as reliable as it gets; if even this throws we let it
  // propagate, since an engine with no valid cwd can't function anyway.
  return app.getPath('home')
}

/**
 * 持久化条目的内存缓存（不含默认工作区）。main 是注册表的唯一写手，
 * 所以首次读盘后缓存永远有效；写路径同步更新缓存再落盘。
 */
let persistedCache: string[] | null = null

function registryPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/** 磁盘格式：`{ version: 1, workspaces: string[] }`。 */
function parseRegistryFile(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { workspaces?: unknown }).workspaces)
  ) {
    return []
  }
  return (parsed as { workspaces: unknown[] }).workspaces
    .filter((p): p is string => typeof p === 'string' && isAbsolute(p))
    .slice(0, MAX_WORKSPACES)
}

async function loadPersisted(): Promise<string[]> {
  if (persistedCache) return persistedCache
  try {
    const raw = await readFile(registryPath(), 'utf8')
    persistedCache = parseRegistryFile(raw)
  } catch {
    // 文件不存在（首启）或损坏 —— 都当空列表。损坏时不删文件，
    // 下次成功 add 会原子覆盖。
    persistedCache = []
  }
  return persistedCache
}

async function persist(): Promise<void> {
  const payload = JSON.stringify(
    { version: 1, workspaces: persistedCache ?? [] },
    null,
    2
  )
  // 写临时文件再 rename，避免写一半崩溃留下截断 JSON 毒化下次启动。
  const target = registryPath()
  const tmp = `${target}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, target)
}

/**
 * All known workspaces, default (Desktop) first, most-recently-added
 * next. 这是 session 读侧（list/rename/search）的扫描集合。
 */
export async function listKnownWorkspaces(): Promise<string[]> {
  const out = [resolveDefaultWorkspace()]
  for (const p of await loadPersisted()) {
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/**
 * Record a user-picked workspace so its sessions appear in the unified
 * list from now on. Re-adding an existing entry promotes it to the top
 * (recency order for the composer's workspace dropdown). 校验目录存在
 * ——add 只发生在用户刚从 OS 选择框选完的路径上，不存在说明调用方
 * 传错了，宁可抛出也不写脏数据。
 */
export async function addKnownWorkspace(path: string): Promise<void> {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`${TAG} workspace path must be absolute (got "${path}")`)
  }
  let stat
  try {
    stat = statSync(path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${TAG} workspace path does not exist: ${msg}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`${TAG} workspace path is not a directory: ${path}`)
  }

  // 默认工作区永远隐式在列表顶部，不落盘（见文件头注释）。
  if (path === resolveDefaultWorkspace()) return

  const persisted = await loadPersisted()
  persistedCache = [path, ...persisted.filter((p) => p !== path)].slice(
    0,
    MAX_WORKSPACES
  )
  await persist()
}
