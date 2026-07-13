/**
 * Session store — a thin read-side wrapper over `@anthropic-ai/claude-agent-sdk`'s
 * session helpers. Fusion-code's CLI writes every turn to
 * `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`; here we let the
 * SDK do the reading and convert the result into shapes the renderer
 * already understands (`ThreadSummary` for the sidebar, `ThreadMessageLike`
 * for Thread view restoration).
 *
 * 统一会话管理（2026-07-07）后列表不再绑定单一工作区：入口是
 * `listAllSessions(workspaceDirs)`（已知工作区集合来自 workspaceRegistry），
 * 单会话操作（load/delete）按 UUID 走 SDK 的全局定位，rename/search 在
 * 集合内逐目录探测。磁盘仍是唯一事实源 —— 本模块不新增任何状态。
 *
 * One narrow exception to "read-only": `renameSession` appends a single
 * `{"type":"custom-title", ...}` line to the existing jsonl. Fusion-code's
 * own `/rename` slash command writes the exact same line, and the SDK's
 * listSessions reader greps for `customTitle` regardless of who wrote it,
 * so this stays compatible with upstream behavior. Append-only means we
 * never race fusion-code's writes to the active turn.
 */
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import {
  deleteSession as sdkDeleteSession,
  getSessionInfo,
  getSessionMessages,
  listSessions as sdkListSessions,
  type SDKSessionInfo,
  type SessionMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { ThreadMessageLike } from '@assistant-ui/react'

import type { ThreadSummary, WorkflowTask } from '../../shared/types'

const TAG = '[sessionStore]'

// Mirrors the SDK's project-dir name cap (sdk.mjs: `_J`). Names whose
// sanitized form exceeds this get truncated and suffixed with a hash —
// we handle that case with a prefix scan in `findSessionJsonl` below.
const PROJECT_NAME_MAX_LEN = 200

/**
 * Unified session list across every known workspace, newest first.
 *
 * 统一会话管理的读侧入口：对每个已知工作区（workspaceRegistry 的
 * 集合，默认工作区置顶）各跑一次 per-dir 扫描后合并排序。刻意不用
 * SDK 的「不传 dir 全局扫」——`~/.claude/projects/` 下混着大量不属于
 * 本应用的会话（官方 Claude app、tmp 目录、CLI 仓库），按注册表并集
 * 扫描天然过滤噪音（理由详见 workspaceRegistry 头注释）。
 *
 * 去重按 sessionId：同一会话的 jsonl 只存在于一个 projects 目录，
 * 理论上不会重复；唯一的重叠来源是嵌套工作区 + 长名截断 hash 的
 * prefix 扫描误伤，first-wins（dirs 有序，默认工作区优先）足够。
 */
export async function listAllSessions(
  workspaceDirs: readonly string[]
): Promise<ThreadSummary[]> {
  // 注册表约定 dirs[0] = 默认工作区（桌面）；非默认工作区的行才带
  // workspaceLabel（渲染层的徽标开关，见 ThreadSummary 注释）。
  const perDir = await Promise.all(
    workspaceDirs.map((dir, i) =>
      listWorkspaceSessions(dir, { isDefault: i === 0 })
    )
  )
  const seen = new Set<string>()
  const out: ThreadSummary[] = []
  for (const threads of perDir) {
    for (const t of threads) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * List all sessions for ONE workspace, newest first. Wraps the SDK's
 * `listSessions({ dir })` and maps `SDKSessionInfo` → `ThreadSummary`
 * (stamping `workspacePath` so the renderer knows the row's home).
 *
 * Returns an empty array on:
 *   - no fusion-code transcripts under that workspace yet
 *   - SDK read error (logged; the sidebar should not crash on a bad file)
 */
async function listWorkspaceSessions(
  workspaceDir: string,
  opts: { isDefault: boolean }
): Promise<ThreadSummary[]> {
  try {
    const rawInfos = await sdkListSessions({
      dir: workspaceDir,
      // Stay single-branch: avoid surfacing every worktree's session as
      // a separate row when the user only wanted the current one.
      // Can flip true once we have a worktree selector.
      includeWorktrees: false
    })
    // slug 撞车过滤（2026-07-07）：sanitize 把所有非 alnum 字符变 '-'，
    // 中文目录名整个变成横杠——`/Desktop/方案配图` 和 `/Desktop/方案分类`
    // 共享同一个 `~/.claude/projects/-Users-…-Desktop-----/`。按 transcript
    // 里记录的 cwd 甄别邻居，但**只在同 slug 时滤**：迁移来的会话
    // （moveSessionToWorkspace 只搬文件，不重写历史 entry 的 cwd 字段）
    // cwd 记录还是旧工作区，sanitize 后与本目录不同 slug——物理位置即
    // 归属，必须保留，否则迁移完的会话直接从列表消失。cwd 缺失（异常/
    // 极早期 transcript）时也保留——宁可偶尔多显示一行，不静默丢会话。
    const slugOf = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-')
    const infos = rawInfos.filter((i) => {
      if (!i.cwd || i.cwd === workspaceDir) return true
      return slugOf(i.cwd) !== slugOf(workspaceDir)
    })
    // 排序键换成「最后一条真实对话的时间」，不能用 SDK 的 lastModified
    // （= 文件 mtime）：切会话的 background warmup 会让 fusion-code 以
    // --resume 起来，CLI 恢复时往 jsonl 追加 bookkeeping 行（last-prompt /
    // mode / permission-mode / ai-title），mtime 被顶成"刚刚"——于是只是
    // 被翻过一眼的会话就跳到列表顶部，浏览时排序乱跳（2026-07-03 实测：
    // 翻列表两分钟内 7 个文件 mtime 全变当前时间，而其中一个的最后真实
    // 对话停在前一天）。bookkeeping 行都不带 timestamp 字段，所以按
    // 「最后一条带 timestamp 的 user/assistant 记录」取时间天然免疫。
    const dirs = await candidateProjectDirs(workspaceDir)
    const threads = await Promise.all(
      infos.map(async (info) => {
        const summary = toThreadSummary(info, workspaceDir, opts.isDefault)
        const ts = await lastConversationTime(
          info.sessionId,
          info.lastModified,
          dirs
        )
        // null = 尾部扫不到对话记录（如刚建还没发言的会话）——保留
        // mtime 兜底，新会话仍按创建时间排。
        if (ts !== null) summary.updatedAt = ts
        return summary
      })
    )
    pruneLastActivityCache(dirs, infos.map((i) => i.sessionId))
    return threads.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (err) {
    console.warn(`${TAG} listWorkspaceSessions failed for ${workspaceDir}:`, err)
    return []
  }
}

/* ─────────── 排序时间：最后真实对话，而非文件 mtime ─────────── */

/**
 * 尾部倒扫的窗口大小。要罩住「最后一条对话之后 CLI 追加的全部
 * bookkeeping 行 + 对话记录本身」——单条 assistant 记录（含工具结果）
 * 通常几 KB～几十 KB，256KB 给足余量；极端情况（尾部一条超巨
 * tool_result 撑爆窗口）退化为 mtime 兜底，只是那一个会话排序略偏，
 * 不值得为它读整个文件。
 */
const ACTIVITY_TAIL_BYTES = 256 * 1024

/**
 * mtime 键控的「最后真实对话时间」缓存。listSessions 每次刷新（切换、
 * 改名、turn 结束都会触发）都要对全部会话取该时间，逐次读尾部会把
 * main 的 IO 放大 N 倍；transcript 是 append-only 的，mtime 不变 ⇒ 尾部
 * 不变 ⇒ 缓存永远有效（同 transcriptCache 的不变式）。bookkeeping 追加
 * 会改 mtime → miss 一次 → 重扫得到同一个时间 → 排序依旧稳定。
 * `ts: null` 表示"文件在但尾部没有对话记录"，也缓存（避免每次都白扫）。
 */
const lastActivityCache = new Map<string, { mtimeMs: number; ts: number | null }>()

/**
 * Resolve a session's last-conversation timestamp (ms), trying each
 * candidate project dir until the jsonl is found. `null` = file found but
 * no timestamped user/assistant record in the tail window; callers keep
 * their mtime fallback in that case.
 */
async function lastConversationTime(
  sessionId: string,
  mtimeMs: number,
  dirs: readonly string[]
): Promise<number | null> {
  for (const dir of dirs) {
    const path = join(dir, `${sessionId}.jsonl`)
    const cached = lastActivityCache.get(path)
    if (cached && cached.mtimeMs === mtimeMs) return cached.ts
    const ts = await readLastConversationTs(path)
    if (ts === undefined) continue // 该 dir 下没有这个文件，试下一个
    lastActivityCache.set(path, { mtimeMs, ts })
    return ts
  }
  return null
}

/**
 * 读文件尾部 ACTIVITY_TAIL_BYTES，从最后一行往前找第一条
 * `type: user|assistant` 且带可解析 `timestamp` 的记录。
 * 返回值三态：number = 找到；null = 文件在但窗口内没有对话记录；
 * undefined = 文件打不开（不存在/无权限），调用方换下一个候选目录。
 * 窗口的第一行可能被截断——JSON.parse 失败即跳过，倒扫顺序保证
 * 截断行永远是最后才碰到的那一条，不影响结果。
 */
async function readLastConversationTs(
  path: string
): Promise<number | null | undefined> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return undefined
  }
  try {
    const { size } = await fh.stat()
    if (size === 0) return null
    const len = Math.min(size, ACTIVITY_TAIL_BYTES)
    const buf = Buffer.allocUnsafe(len)
    await fh.read(buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(entry)) continue
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      if (typeof entry.timestamp !== 'string') continue
      const ms = Date.parse(entry.timestamp)
      if (!Number.isNaN(ms)) return ms
    }
    return null
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

/**
 * 丢掉已删除会话的缓存条目（模式同 transcriptCache 的 prune：只清
 * 本 workspace 目录下、且不在当前会话集合里的 key，别的 workspace
 * 的条目不动）。缓存量级 = 会话文件数（几十），prune 是卫生习惯而
 * 非内存压力。
 */
function pruneLastActivityCache(
  dirs: readonly string[],
  liveIds: readonly string[]
): void {
  const live = new Set<string>()
  for (const dir of dirs) {
    for (const id of liveIds) live.add(join(dir, `${id}.jsonl`))
  }
  for (const path of lastActivityCache.keys()) {
    if (live.has(path)) continue
    if (dirs.some((dir) => path.startsWith(dir + sep))) {
      lastActivityCache.delete(path)
    }
  }
}

/**
 * Load a single session's full message history, mapped into the
 * assistant-ui ThreadMessageLike shape the chat store already consumes.
 *
 * No workspace param: sessionId is a UUID, so the SDK's omit-dir mode
 * (searches every project dir for `<id>.jsonl`) is unambiguous — and it
 * frees the caller from knowing which workspace a row belongs to.
 *
 * Returns `[]` on error or unknown session so the UI can fall back on a
 * blank thread rather than crash.
 */
export async function loadSession(
  sessionId: string
): Promise<ThreadMessageLike[]> {
  try {
    const raws = await getSessionMessages(sessionId)
    return convertSdkMessages(raws)
  } catch (err) {
    console.warn(`${TAG} loadSession ${sessionId} failed:`, err)
    return []
  }
}

/**
 * Rename a session by appending a `custom-title` line to its jsonl.
 *
 * The SDK's listSessions reads `customTitle` (and `aiTitle`) by grepping
 * the file text, with the LAST occurrence winning, so multiple renames
 * just keep working. Fusion-code's own `/rename` slash command writes
 * the exact same shape, so we stay compatible with the upstream format.
 *
 * Takes the known-workspaces set (not a single dir) and probes each in
 * order until the jsonl turns up — the unified sidebar mixes rows from
 * every workspace, so the caller no longer knows which one owns the id.
 * Throws when no workspace has the file.
 * The caller is expected to broadcast `sessionListChanged` after a
 * successful rename so the sidebar re-pulls the title.
 */
export async function renameSession(
  sessionId: string,
  customTitle: string,
  workspaceDirs: readonly string[]
): Promise<void> {
  for (const dir of workspaceDirs) {
    const filePath = await findSessionJsonl(dir, sessionId)
    if (!filePath) continue
    const line =
      JSON.stringify({ type: 'custom-title', customTitle, sessionId }) + '\n'
    await appendFile(filePath, line, 'utf8')
    return
  }
  throw new Error(`Session jsonl not found for ${sessionId}`)
}

/* ─────────────────── Content search ─────────────────── */

// Caps for searchSessionContent. Generous for a chat workspace (tens of
// sessions, MB-scale transcripts) while bounding the worst case — a
// pathological workspace can't stall the IPC or ship megabytes of hits.
const SEARCH_MAX_SESSIONS = 30 // sessions returned per query
const SEARCH_MAX_FILE_BYTES = 32 * 1024 * 1024 // skip absurdly large transcripts
const SEARCH_SNIPPET_BEFORE = 16 // chars of context before the hit
const SEARCH_SNIPPET_AFTER = 40 // chars after (incl. the hit itself)

/** One searchable message extracted from a transcript. `lower` is the
 *  pre-computed lowercase copy so per-query matching allocates nothing. */
interface SearchableText {
  who: 'user' | 'assistant'
  text: string
  lower: string
}

/**
 * mtime-keyed extraction cache. Reading + JSON-parsing every jsonl on every
 * debounced keystroke pinned the MAIN process for hundreds of ms (all IPC —
 * chat streaming included — queues behind it: the whole app visibly froze
 * while typing in the search box). Transcripts are append-only, so a file's
 * extracted text is valid until its mtime changes; after the first pass a
 * query is a pure in-memory substring scan. Entries for deleted sessions
 * are pruned at the end of each search.
 */
const transcriptCache = new Map<
  string,
  { mtimeMs: number; texts: SearchableText[] }
>()

/** Let the event loop breathe between per-file extractions — the parse of
 *  one multi-MB file is tolerable (~tens of ms); an uninterrupted run over
 *  a whole workspace is what froze the app. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Extract the HUMAN-VISIBLE texts of one transcript (mirrors what
 * convertSdkMessages would render):
 *   - user messages whose content is a plain string NOT starting with '<'
 *     (excludes slash-command XML skeletons and <task-notification> spam)
 *   - text blocks inside user/assistant content arrays (tool_use inputs and
 *     tool_result dumps are deliberately NOT searched — hitting a grep's raw
 *     output would drown real conversation hits)
 */
async function extractSearchableTexts(path: string): Promise<SearchableText[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const out: SearchableText[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry)) continue
    const type = entry.type
    if (type !== 'user' && type !== 'assistant') continue
    const who = type as 'user' | 'assistant'
    const content = isRecord(entry.message) ? entry.message.content : undefined

    if (typeof content === 'string') {
      // Plain-string user turns starting with '<' are CLI bookkeeping
      // (command XML / task-notification), not something the human said.
      if (who === 'user' && content.trimStart().startsWith('<')) continue
      out.push({ who, text: content, lower: content.toLowerCase() })
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          out.push({ who, text: block.text, lower: block.text.toLowerCase() })
        }
      }
    }
  }
  return out
}

/**
 * Full-text search across a workspace's session transcripts.
 *
 * Hot path is memory-only: per-file extraction results live in
 * `transcriptCache` (see above) keyed by mtime, so a query only pays file
 * IO/parse for transcripts that changed since the last search. An EMPTY
 * query returns `[]` but still warms the cache — the search dialog fires
 * one on open so the first real keystroke doesn't foot the whole
 * extraction bill.
 *
 * Returns one entry per matching session: an excerpt around the FIRST hit
 * (windowed server-side so a hit inside a huge message doesn't ship whole)
 * plus the total hit count. Order follows file mtime, newest first, so the
 * dialog's result order roughly matches the sidebar's.
 */
export async function searchSessionContent(
  workspaceDirs: readonly string[],
  query: string
): Promise<
  Array<{
    sessionId: string
    snippet: string
    who: 'user' | 'assistant'
    hitCount: number
  }>
> {
  const q = query.trim().toLowerCase()

  // Collect candidate files (sessionId + mtime), newest first. The scan
  // set is the union of every known workspace's project dirs — the
  // unified sidebar searches across all of them in one pass. Caps below
  // (SEARCH_MAX_SESSIONS / SEARCH_MAX_FILE_BYTES) are global, not
  // per-workspace, so a bigger union cannot blow up the IPC payload.
  const projectDirs: string[] = []
  for (const workspaceDir of workspaceDirs) {
    for (const dir of await candidateProjectDirs(workspaceDir)) {
      if (!projectDirs.includes(dir)) projectDirs.push(dir)
    }
  }
  const files: Array<{ sessionId: string; path: string; mtime: number }> = []
  for (const dir of projectDirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      try {
        const s = await stat(path)
        if (!s.isFile() || s.size > SEARCH_MAX_FILE_BYTES) continue
        files.push({ sessionId: name.slice(0, -6), path, mtime: s.mtimeMs })
      } catch {
        // Vanished mid-scan (deleted session) — skip.
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)

  const out: Array<{
    sessionId: string
    snippet: string
    who: 'user' | 'assistant'
    hitCount: number
  }> = []

  for (const f of files) {
    if (q && out.length >= SEARCH_MAX_SESSIONS) break

    let cached = transcriptCache.get(f.path)
    if (!cached || cached.mtimeMs !== f.mtime) {
      cached = { mtimeMs: f.mtime, texts: await extractSearchableTexts(f.path) }
      transcriptCache.set(f.path, cached)
      await yieldToEventLoop()
    }
    if (!q) continue // warm-only pass

    let hitCount = 0
    let first: { snippet: string; who: 'user' | 'assistant' } | null = null
    for (const t of cached.texts) {
      const idx = t.lower.indexOf(q)
      if (idx < 0) continue
      hitCount++
      if (!first) {
        const start = Math.max(0, idx - SEARCH_SNIPPET_BEFORE)
        const end = Math.min(t.text.length, idx + q.length + SEARCH_SNIPPET_AFTER)
        first = {
          who: t.who,
          snippet:
            (start > 0 ? '…' : '') +
            t.text.slice(start, end).replace(/\s+/g, ' ') +
            (end < t.text.length ? '…' : '')
        }
      }
    }

    if (first && hitCount > 0) {
      out.push({
        sessionId: f.sessionId,
        snippet: first.snippet,
        who: first.who,
        hitCount
      })
    }
  }

  // Prune cache entries whose files vanished (deleted sessions) so the
  // cache tracks the workspace instead of growing without bound. Scoped to
  // THIS workspace's project dirs — the cache is module-global and other
  // tabs' workspaces keep their entries.
  const live = new Set(files.map((f) => f.path))
  for (const path of transcriptCache.keys()) {
    if (live.has(path)) continue
    if (projectDirs.some((dir) => path.startsWith(dir + sep))) {
      transcriptCache.delete(path)
    }
  }

  return out
}

/**
 * Delete a session permanently. Wraps the SDK's `deleteSession`, which
 * removes both `<sessionId>.jsonl` and the `<sessionId>/` subagent-
 * transcript directory from the projects dir — the same two artifacts a
 * session leaves on disk. Throws when the session isn't found (surfaced
 * to the renderer so its confirm UI can report instead of silently
 * "succeeding" on a stale row).
 *
 * IRREVERSIBLE. Callers must ensure any live runtime for this session is
 * closed first (see the SHELL_SESSION_DELETE handler) — a fusion-code
 * child appending to an unlinked file would silently resurrect nothing
 * but still hold the fd open.
 *
 * No workspace param — same omit-dir global lookup rationale as
 * loadSession: the UUID is unambiguous across project dirs.
 */
export async function deleteSessionFromDisk(sessionId: string): Promise<void> {
  await sdkDeleteSession(sessionId)
}

/**
 * 把一个会话的磁盘工件迁移到另一个工作区（「已有记录的会话改工作目录」，
 * 2026-07-07 实测验证后放开）。
 *
 * 为什么是移文件而不是别的：CLI 的 `--resume <id>` 只在 sanitize(cwd)
 * 对应的 `~/.claude/projects/<slug>/` 里找 transcript（2026-07-07 用
 * claude 2.1.202 实测：跨 cwd resume 报 "No conversation found"；把
 * jsonl 移进新 cwd 的 slug 目录后 resume 完全正常、历史无损、新 turn
 * 继续 append 同一文件）。SDK 没有官方迁移 API，但它的读侧
 * （listSessions/getSessionInfo）全是按目录扫文件，移动后自动归属新
 * 工作区 —— 文件系统就是数据库。
 *
 * 迁移的工件与 `deleteSession` 删除的一致：`<id>.jsonl` + 同名子代理
 * transcript 目录 `<id>/`（可能不存在）。其余按 sessionId 关联的状态
 * （file-history、todos）不含 cwd 维度，无需搬动。
 *
 * 调用方（engine.setSessionWorkspace）必须先把该会话的 live runtime
 * 彻底 teardown —— 正在写 transcript 的子进程手里握着旧路径的 fd，
 * rename 底下的文件会让后续行为不可预测（同 delete 的顺序约束）。
 *
 * 同 workspace 重复迁移是 no-op。找不到源 transcript 抛错（调用方在
 * 迁移前已确认 transcript 存在，走到这说明竞态删除，报错比假成功好）。
 */
export async function moveSessionToWorkspace(
  sessionId: string,
  sourceWorkspaceDirs: readonly string[],
  targetWorkspaceDir: string
): Promise<void> {
  let srcJsonl: string | null = null
  for (const dir of sourceWorkspaceDirs) {
    srcJsonl = await findSessionJsonl(dir, sessionId)
    if (srcJsonl) break
  }
  // 已知工作区都没有 → 全局兜底扫一遍 ~/.claude/projects。会话可能
  // "走丢"在未注册目录里（历史版本的迁移把文件搬去了后来被移出注册表
  // 的工作区、或外部 CLI 建的），这条兜底让「再改一次工作目录」成为
  // 把孤儿会话捞回来的自愈动作，而不是对着 not found 干瞪眼。
  srcJsonl ??= await findSessionJsonlGlobal(sessionId)
  if (!srcJsonl) {
    throw new Error(`Session transcript not found for ${sessionId}`)
  }

  // 目标 slug 目录。≤200 字符直接按 sanitize 规则拼（与
  // candidateProjectDirs 同源）；超长名会被 SDK 截断 + hash 后缀，而
  // hash 算法是 SDK 内部实现 —— 只有目标工作区已经有过会话（目录已
  // 存在，prefix 扫描可命中）才能拿到正确目录，否则明确拒绝，不赌。
  const projectsDir = join(homedir(), '.claude', 'projects')
  const sanitized = targetWorkspaceDir.replace(/[^a-zA-Z0-9]/g, '-')
  let destDir: string | null = null
  if (sanitized.length <= PROJECT_NAME_MAX_LEN) {
    destDir = join(projectsDir, sanitized)
  } else {
    destDir = (await candidateProjectDirs(targetWorkspaceDir))[0] ?? null
  }
  if (!destDir) {
    throw new Error(
      `Cannot derive project dir for over-long workspace path: ${targetWorkspaceDir}`
    )
  }

  if (dirname(srcJsonl) === destDir) return // 已在目标工作区 — no-op

  await mkdir(destDir, { recursive: true })
  await rename(srcJsonl, join(destDir, `${sessionId}.jsonl`))
  // 子代理 transcript 目录跟着走；不存在（从没 spawn 过子代理）是常态。
  try {
    await rename(join(dirname(srcJsonl), sessionId), join(destDir, sessionId))
  } catch {
    // ENOENT 等 —— 主 jsonl 已迁移成功，子目录缺失不构成失败。
  }
}

/**
 * 定位一个会话归属的工作区（resolveRuntimeCwd 的 resume 解析用）。
 *
 * 判定次序：**物理位置优先** —— 遍历已知工作区，看谁的 projects slug
 * 目录里真有 `<id>.jsonl`。不能信 `getSessionInfo().cwd`：那是 transcript
 * 历史 entry 里记录的 cwd，迁移（moveSessionToWorkspace 只搬文件不重写
 * 历史）之后它还是旧值——按它解析会 spawn 回旧目录，resume 在旧 slug
 * 里找不到刚搬走的文件，历史"凭空消失"。
 *
 * 撞 slug 时（多个已知工作区 sanitize 后同目录，中文名常见）物理位置
 * 无法消歧，才用 transcript 记录的 cwd 挑一个；仍然不中就取第一个命中
 * （错也只错在归属展示，文件找得到、resume 不断链）。
 *
 * 返回 null = 已知工作区里都没有这个会话的文件（外部 CLI 在未注册目录
 * 建的会话）——调用方 fallback 到 getSessionInfo().cwd。
 */
export async function resolveSessionWorkspace(
  sessionId: string,
  workspaceDirs: readonly string[]
): Promise<string | null> {
  const hits: string[] = []
  for (const dir of workspaceDirs) {
    if ((await findSessionJsonl(dir, sessionId)) !== null) hits.push(dir)
  }
  if (hits.length === 0) return null
  if (hits.length === 1) return hits[0]
  try {
    const info = await getSessionInfo(sessionId)
    if (info?.cwd && hits.includes(info.cwd)) return info.cwd
  } catch {
    // 消歧失败就退到第一个命中。
  }
  return hits[0]
}

/**
 * Does a resumable transcript exist on disk for this session?
 *
 * Both CLI backends (bundled fusion-code / system Claude Code) read the
 * same `~/.claude/projects/<slug>/<id>.jsonl` (HOME is identical), so
 * file existence is the authoritative "can `--resume <id>` succeed"
 * check regardless of which backend is active. Used by the engine's
 * backend-switch path to avoid handing `--resume` a session that has no
 * transcript in the target backend — the CLI would otherwise abort with
 * "No conversation found with session ID" (2026-07-05). Reuses the same
 * slug/prefix rules as findSessionJsonl so the two can't drift.
 *
 * A brand-new session that spawned but never took a turn has NO jsonl
 * yet (the file is created on the first `system init` write), so this
 * correctly returns false for the "新对话 → switch backend" case.
 */
export async function sessionTranscriptExists(
  workspaceDir: string,
  sessionId: string
): Promise<boolean> {
  return (await findSessionJsonl(workspaceDir, sessionId)) !== null
}

/**
 * Locate the on-disk jsonl for a sessionId under a given workspace.
 *
 * The SDK derives the project dir name by replacing every non-alnum
 * char with `-`. For names ≤ 200 chars that's the whole story; longer
 * names get truncated to 200 and suffixed with a hash, so for those we
 * fall back to a prefix scan of `~/.claude/projects`.
 *
 * Returns `null` when no matching file exists (caller decides how loud
 * that is — rename treats it as an error, future "delete session" might
 * treat it as a no-op).
 */
async function findSessionJsonl(
  workspaceDir: string,
  sessionId: string
): Promise<string | null> {
  for (const dir of await candidateProjectDirs(workspaceDir)) {
    const candidate = join(dir, `${sessionId}.jsonl`)
    if (await fileExists(candidate)) return candidate
  }
  return null
}

/**
 * All plausible `~/.claude/projects/<name>` dirs for a workspace, most
 * likely first. The SDK derives the dir name by replacing every non-alnum
 * char with `-`; names over 200 chars get truncated + hash-suffixed, and a
 * workspace opened under a sibling worktree can land in a different
 * long-name dir — hence the prefix scan after the direct match. Shared by
 * findSessionJsonl (single-file lookup) and searchSessionContent (whole-
 * project scan) so the two can't drift on the sanitize rules.
 */
async function candidateProjectDirs(workspaceDir: string): Promise<string[]> {
  const projectsDir = join(homedir(), '.claude', 'projects')
  const sanitized = workspaceDir.replace(/[^a-zA-Z0-9]/g, '-')
  const out: string[] = []

  if (sanitized.length <= PROJECT_NAME_MAX_LEN) {
    const direct = join(projectsDir, sanitized)
    try {
      if ((await stat(direct)).isDirectory()) out.push(direct)
    } catch {
      // No direct dir — fall through to the prefix scan.
    }
  }

  const prefix = sanitized.slice(0, PROJECT_NAME_MAX_LEN)
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // Either an exact short-name match or a "<prefix>-<hash>" long-name match.
      if (e.name !== sanitized && !e.name.startsWith(`${prefix}-`)) continue
      const dir = join(projectsDir, e.name)
      if (!out.includes(dir)) out.push(dir)
    }
  } catch (err) {
    console.warn(`${TAG} candidateProjectDirs scan failed:`, err)
  }
  return out
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * 全局扫 `~/.claude/projects/` 找 `<id>.jsonl`。moveSessionToWorkspace
 * 的源查找兜底（见调用处注释）。一次 readdir + 每目录一次 stat，
 * 百级目录量级下可忽略；只在已知工作区全部 miss 时才走到。
 */
export async function findSessionJsonlGlobal(
  sessionId: string
): Promise<string | null> {
  const projectsDir = join(homedir(), '.claude', 'projects')
  let entries
  try {
    entries = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const candidate = join(projectsDir, e.name, `${sessionId}.jsonl`)
    if (await fileExists(candidate)) return candidate
  }
  return null
}

/* ─────────────────── Mapping helpers ─────────────────── */

function toThreadSummary(
  info: SDKSessionInfo,
  workspaceDir: string,
  isDefaultWorkspace: boolean
): ThreadSummary {
  return {
    id: info.sessionId,
    title: info.customTitle ?? info.summary ?? info.firstPrompt ?? 'New chat',
    updatedAt: info.lastModified,
    firstPrompt: info.firstPrompt,
    turnCount: 0,
    // 归属工作区 = 被扫描的目录本身（jsonl 落在 sanitize(cwd) 目录下，
    // 所以扫描 dir 就是会话的 cwd），不取 info.cwd —— 那是 optional 的。
    workspacePath: workspaceDir,
    // 徽标开关：默认工作区（桌面）的行不打标，避免满屏重复徽标。
    ...(isDefaultWorkspace ? {} : { workspaceLabel: basename(workspaceDir) })
  }
}

/**
 * Convert a raw SDK SessionMessage[] stream (read verbatim from the
 * JSONL transcript) into the assistant-ui ThreadMessageLike[] shape the
 * chat store stores.
 *
 * Key mapping rules (kept in sync with renderer's chat.ts content-part
 * definitions):
 *
 *   Anthropic ContentBlock   →  assistant-ui ContentPart
 *   ──────────────────────────────────────────────────────────
 *   { type: 'text' }              { type: 'text', text }
 *   { type: 'image' }             { type: 'image', image: dataUrl }
 *   { type: 'tool_use' }          { type: 'tool-call', toolCallId, toolName, args, argsComplete }
 *   { type: 'tool_result' }       merged into the matching tool-call's `result` field
 *
 * tool_use / tool_result appear on DIFFERENT jsonl entries:
 *   - tool_use lives on an assistant message's content
 *   - tool_result lives on the FOLLOWING user message's content (the
 *     CLI auto-generates that user entry when the tool finishes running)
 *
 * That means a single-pass conversion can't populate `result` because the
 * tool_result hasn't been seen yet when we hit the tool_use. So we scan
 * twice:
 *
 *   Pass 1: walk every user message's content blocks, collect all
 *           tool_result blocks into a Map<toolUseId, result>.
 *   Pass 2: walk every message in order. For user messages, emit a
 *           ThreadMessageLike only when the content has at least one
 *           text / image part (a pure-tool_result user turn is an
 *           implementation detail, not something to show to the user).
 *           For assistant messages, map content blocks and fill in
 *           tool_result from the map built in pass 1.
 */
export function convertSdkMessages(
  raws: readonly SessionMessage[]
): ThreadMessageLike[] {
  const resultByToolUseId = new Map<string, unknown>()
  // Workflow/Task completion records, keyed by the spawning Workflow
  // tool-call's id. On a live run these subtasks arrive as `task_update`
  // events and the renderer merges them onto the card; on history replay
  // there are no such events, so we reconstruct them here from the
  // `<task-notification>` user message the workflow injected at
  // completion — otherwise the deliverable vanishes after a reload.
  const tasksByToolUseId = new Map<string, WorkflowTask[]>()

  for (const raw of raws) {
    if (raw.type !== 'user') continue
    const blocks = extractContentBlocks(raw.message)
    if (blocks) {
      for (const block of blocks) {
        if (!isRecord(block)) continue
        if (block.type !== 'tool_result') continue
        const toolUseId = block.tool_use_id
        if (typeof toolUseId !== 'string') continue
        resultByToolUseId.set(
          toolUseId,
          normalizeToolResultContent(block.content)
        )
      }
    }
    // The completion notification is a plain-text user message, not a
    // block array, so it isn't in `blocks` above — pull it off the raw
    // string content separately.
    collectTaskNotification(raw.message, tasksByToolUseId)
  }

  const out: ThreadMessageLike[] = []

  for (const raw of raws) {
    if (raw.type === 'system') continue

    if (raw.type === 'user') {
      const parts = convertUserContent(raw.message)
      if (parts.length === 0) continue
      out.push({
        id: raw.uuid,
        role: 'user',
        content: parts as unknown as ThreadMessageLike['content']
      })
      continue
    }

    if (raw.type === 'assistant') {
      const parts = convertAssistantContent(
        raw.message,
        resultByToolUseId,
        tasksByToolUseId
      )
      if (parts.length === 0) continue
      out.push({
        id: raw.uuid,
        role: 'assistant',
        content: parts as unknown as ThreadMessageLike['content']
      })
    }
  }

  return out
}

/**
 * If `message` is a workflow's `<task-notification>` completion record,
 * parse it into a `WorkflowTask` and stash it under its spawning
 * tool-use id. Mirrors engine.ts `parseTaskNotification` so live and
 * replayed cards look identical. No-op for anything else.
 */
function collectTaskNotification(
  message: unknown,
  into: Map<string, WorkflowTask[]>
): void {
  const content = isRecord(message) ? message.content : undefined
  if (typeof content !== 'string') return
  if (!content.includes('<task-notification>')) return

  const tag = (name: string): string | undefined => {
    const m = content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
    return m ? m[1].trim() : undefined
  }
  const taskId = tag('task-id')
  const toolUseId = tag('tool-use-id')
  if (!taskId || !toolUseId) return

  const rawStatus = tag('status')
  const status: WorkflowTask['status'] =
    rawStatus === 'completed'
      ? 'completed'
      : rawStatus === 'stopped'
        ? 'stopped'
        : 'failed'

  const rawResult = tag('result')
  let result = rawResult
  if (rawResult) {
    try {
      const parsed = JSON.parse(rawResult)
      if (isRecord(parsed) && typeof parsed.summary === 'string') {
        result = parsed.summary
      }
    } catch {
      // keep raw
    }
  }

  const task: WorkflowTask = {
    taskId,
    status,
    summary: tag('summary'),
    result,
    outputFile: tag('output-file')
  }
  const list = into.get(toolUseId) ?? []
  list.push(task)
  into.set(toolUseId, list)
}

/* ─────────────────── content mapping ─────────────────── */

type ContentPart = { type: string; [key: string]: unknown }

/**
 * True for `user` messages that are fusion-code housekeeping injections
 * rather than human input — currently the `<task-notification>` block a
 * backgrounded task/workflow posts on completion. These belong on the
 * spawning tool card, not in the transcript as a user bubble. Matched on
 * the leading tag (trimmed) so we don't accidentally hide a real message
 * that merely mentions the word elsewhere.
 */
function isInjectedAgentMessage(text: string): boolean {
  return text.trimStart().startsWith('<task-notification>')
}

/**
 * Slash-command turns are stored in the JSONL with an XML skeleton, not as
 * the friendly text the human typed. The CLI writes three flavours:
 *
 *   1. The invocation itself —
 *        <command-message>name</command-message>
 *        <command-name>/name</command-name>
 *        <command-args>the actual user input</command-args>
 *      (`<command-message>` and `<command-args>` are optional). Without
 *      cleanup the renderer paints the raw tags into a user bubble, which
 *      is exactly the "format looks wrong" report. We rebuild the human
 *      intent as `/name args` so the bubble reads like what was typed.
 *
 *   2. Local-command bookkeeping — a `<local-command-caveat>` preamble and
 *      a `<local-command-stdout>` result (e.g. the line `/clear` prints).
 *      Neither is human input; collapse the whole message to empty so the
 *      caller drops the turn entirely.
 *
 * Anything without these tags is returned unchanged. We deliberately do
 * the matching here (main side, on replay) rather than in the renderer so
 * the chat store never holds the raw skeleton.
 */
function cleanUserCommandText(text: string): string {
  const trimmed = text.trimStart()

  // Pure CLI bookkeeping — not something the human said. Drop it.
  if (
    trimmed.startsWith('<local-command-stdout>') ||
    trimmed.startsWith('<local-command-caveat>')
  ) {
    return ''
  }

  // Not a slash-command skeleton → leave it exactly as-is.
  if (!trimmed.startsWith('<command-')) return text

  const tag = (name: string): string | undefined => {
    const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
    return m ? m[1].trim() : undefined
  }

  // `<command-name>` already includes the leading slash (and any plugin
  // prefix like `claude-desktop:ppt-master`). Fall back to the bare
  // `<command-message>` label if the name tag is somehow missing.
  const name = tag('command-name') ?? tag('command-message')
  if (!name) return text

  const args = tag('command-args')
  return args ? `${name} ${args}` : name
}

function convertUserContent(message: unknown): ContentPart[] {
  const parts: ContentPart[] = []

  // User "content" can be either a bare string (text-only turn) or an
  // array of content blocks (mixed text/image/tool_result).
  const raw = isRecord(message) ? message.content : undefined
  if (typeof raw === 'string') {
    // A backgrounded task/workflow's completion is injected into the
    // agent loop as a `user` message whose content is a
    // `<task-notification>…</task-notification>` block — it is NOT
    // something the human typed. The live path routes it into the
    // spawning tool card (engine `tryEmitTaskUpdate`); on history replay
    // we must drop it here too, otherwise the raw XML resurfaces as a
    // blue user bubble. Returning no parts makes the caller skip it.
    if (isInjectedAgentMessage(raw)) return parts
    // Rewrite slash-command XML skeletons into `/name args` (and drop pure
    // local-command bookkeeping) before they reach the bubble.
    const cleaned = cleanUserCommandText(raw)
    if (cleaned.length > 0) parts.push({ type: 'text', text: cleaned })
    return parts
  }
  if (!Array.isArray(raw)) return parts

  for (const block of raw) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (isInjectedAgentMessage(block.text)) continue
      const cleaned = cleanUserCommandText(block.text)
      if (cleaned.length > 0) parts.push({ type: 'text', text: cleaned })
      continue
    }
    if (block.type === 'image') {
      const dataUrl = toImageDataUrl(block.source)
      if (dataUrl) parts.push({ type: 'image', image: dataUrl })
      continue
    }
    // tool_result blocks stay out of the user message — they get
    // merged into the prior assistant's tool-call in pass 2.
  }

  return parts
}

function convertAssistantContent(
  message: unknown,
  resultByToolUseId: Map<string, unknown>,
  tasksByToolUseId: Map<string, WorkflowTask[]>
): ContentPart[] {
  const parts: ContentPart[] = []
  const raw = isRecord(message) ? message.content : undefined
  if (typeof raw === 'string') {
    if (raw.length > 0) parts.push({ type: 'text', text: raw })
    return parts
  }
  if (!Array.isArray(raw)) return parts

  for (const block of raw) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    // Extended-thinking block → the renderer's `reasoning` part
    // (ReasoningCard: collapsed "思考过程 · N 字" row, click to expand).
    // Previously dropped on the floor, so RESTORED sessions lost the
    // chain-of-thought that the live session showed. redacted_thinking
    // (no readable text) still falls through and is skipped.
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      if (block.thinking.length > 0) {
        parts.push({ type: 'reasoning', text: block.thinking })
      }
      continue
    }
    if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : 'tool'
      if (!id) continue
      const part: ContentPart = {
        type: 'tool-call',
        toolCallId: id,
        toolName: name,
        args: block.input ?? {},
        argsComplete: true
      }
      const result = resultByToolUseId.get(id)
      if (result !== undefined) part.result = result
      // Re-attach any workflow subtasks reconstructed from completion
      // notifications so the replayed card shows them just like live.
      const tasks = tasksByToolUseId.get(id)
      if (tasks && tasks.length > 0) part.tasks = tasks
      parts.push(part)
      continue
    }
    if (block.type === 'image') {
      const dataUrl = toImageDataUrl(block.source)
      if (dataUrl) parts.push({ type: 'image', image: dataUrl })
    }
  }

  return parts
}

/**
 * Pull the `content` array off an SDK message, handling both the plain
 * Anthropic shape (`{ role, content }`) and the SDK's occasional
 * `{ message: { role, content } }` nesting.
 */
function extractContentBlocks(message: unknown): readonly unknown[] | null {
  if (!isRecord(message)) return null
  const content = message.content ?? (isRecord(message.message) ? message.message.content : undefined)
  if (Array.isArray(content)) return content
  return null
}

/**
 * tool_result.content can be a plain string, a ContentBlock array (with
 * text / image parts), or occasionally a single object. Normalize to a
 * stringifiable value the renderer's ToolCallCard can show.
 */
function normalizeToolResultContent(content: unknown): unknown {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // Join text parts; drop images (the card renders text-only results).
    const texts: string[] = []
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      }
    }
    if (texts.length > 0) return texts.join('\n')
    return content
  }
  return content
}

/**
 * Convert an Anthropic image source (`{ type: 'base64', media_type, data }`)
 * to a `data:` URL the renderer uses verbatim. Returns null on any shape
 * mismatch so the caller can simply drop the block.
 */
function toImageDataUrl(source: unknown): string | null {
  if (!isRecord(source)) return null
  if (source.type !== 'base64') return null
  const mediaType = source.media_type
  const data = source.data
  if (typeof mediaType !== 'string' || typeof data !== 'string') return null
  return `data:${mediaType};base64,${data}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
