import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { app, type WebContents } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { inspect } from 'node:util'

import {
  query,
  type PermissionMode,
  type PermissionResult,
  type Query
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ContentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam
} from '@anthropic-ai/sdk/resources'

import {
  IPC_CHANNELS,
  type ChatEventPayload,
  type ChatImagePayload,
  type LogEventPayload,
  type UiPermissionMode
} from '../../shared/ipc-channels'
import type {
  ChatEvent,
  LogEvent,
  McpServerInfo,
  PermissionRequest,
  SessionMeta
} from '../../shared/types'
import { THINKING_TOKEN_BUDGET } from '../../shared/thinking'
import { bumpUnread } from '../tray'
import { AsyncMessageQueue } from './asyncMessageQueue'
import { getAppSettings, type CliBackend } from './appSettings'
import {
  detectSystemClaude,
  detectSystemClaudeSync,
  resolveBundledCliPath,
  resolveBundledPythonHome,
  resolveJsRuntimeBin,
  resolveSystemClaudeJsEntry
} from './cliDetect'
import { resolveBundledSkillsPluginDir } from './skillsDir'
import { envJsonInjectedKeys } from '../bootstrap/loadEnv'
import {
  loadExternalMcpServers,
  type SdkExternalMcpServers
} from './externalMcp'
import { invalidateFileSuggestions } from './fileSuggestions'
import { kbOutDir } from './kbIndexStore'
import { PermissionBroker } from './permissionBroker'
import { deriveScope } from './permissionScope'
import { buildProposalAppend, type ProposalProductScope } from './proposalPrompt'
import { renderRetrievedBlock } from './proposalRetrieve'
import { kbSemanticSearch, warmEmbedWorker } from './kbSemanticSearch'
import { buildProposalProductScopes } from './proposalScopes'
import { seedSkillsFromDisk } from './seedSkills'

/**
 * Resolve the default workspace directory used on every new tab/engine.
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
 * The only caller is the ChatEngine constructor, and engines are only
 * created from `newTab()`, which runs well after whenReady — so this is
 * always safe in practice.
 */
/**
 * Build the child env for the SYSTEM claude backend.
 *
 * env.json is the BUNDLED fusion-code backend's config — it points that
 * CLI at the csdn proxy (ANTHROPIC base URL / auth / default model aliases,
 * plus the OPENAI and GEMINI keys for media). The user's own `claude`
 * install must NOT inherit any of it: system claude should run on the
 * user's ~/.claude login + default Anthropic models, not be hijacked onto
 * csdn / gpt-5.4.
 *
 * So: pass through the parent/shell env but DROP every key that loadEnv
 * injected from env.json. We strip the whole env.json key set (not a
 * hand-maintained gateway allowlist that could miss the OPENAI / GEMINI /
 * future keys). PATH, HOME, etc. survive (they came from the shell, not
 * env.json), so the child still launches. A key the user exported in their
 * OWN shell also survives — `envJsonInjectedKeys()` only holds keys loadEnv
 * actually set, and loadEnv skips keys already present in the shell,
 * cleanly separating "env.json leak" from "deliberate user config".
 */
/**
 * env.json-injected keys that are SAFE to keep even under the system backend,
 * because they configure SKILL subprocesses (image generation, transcription),
 * NOT the claude model the user logs into. The reason systemBackendEnv strips
 * env.json at all is to stop vanilla claude from being hijacked onto the csdn
 * gateway + gpt-5.4 — that hijack is driven exclusively by the ANTHROPIC_*
 * keys (BASE_URL / AUTH_TOKEN / *_MODEL). The OPENAI_* / GEMINI_* keys never
 * touch claude's model routing; they're read only by skills like gpt-image-2
 * (scripts/shared.js → OPENAI_API_KEY / OPENAI_BASE_URL). So allow-listing
 * them back lets `/gpt-image-2` reach Mode A under system claude too, without
 * weakening the anti-hijack guarantee. Deliberately does NOT include any
 * ANTHROPIC_* key.
 */
const SKILL_PASSTHROUGH_KEYS: ReadonlySet<string> = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_IMAGE_MODEL',
  'OPENAI_TRANSCRIBE_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_TRANSCRIBE_MODEL',
  'ENABLE_GARDEN_IMAGEGEN',
  // ppt-master web image search (scripts/image_search.py → PIXABAY_API_KEY).
  // A stock-photo API key, not a model-routing credential — same rationale as
  // the OPENAI_/GEMINI_ keys above, safe under the system backend.
  'PIXABAY_API_KEY'
])

function systemBackendEnv(): Record<string, string> {
  const injected = envJsonInjectedKeys()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Strip env.json-injected keys so system claude isn't hijacked onto the
    // csdn gateway — EXCEPT skill-only keys (image/transcribe creds), which
    // never affect claude's model routing and are needed by skill scripts.
    if (injected.has(key) && !SKILL_PASSTHROUGH_KEYS.has(key)) continue
    env[key] = value
  }
  return env
}

function resolveDefaultWorkspace(): string {
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

// NOTE: there used to be a `SWITCH_READY_TIMEOUT_MS = 30_000` here,
// used by the now-removed `waitForSessionReady` helper. That helper
// blocked on `runtime.readyPromise` — which is only resolved after
// fusion-code's first `system init`, yielded inside submitMessage
// after a user prompt is pushed. Blocking before push always hit the
// timeout for no real reason. The SDK's queue is buffered, so send()
// can safely push userMsgs while the cli is still spawning, and the
// consumer drains them once stdin is alive. Both the timeout constant
// and the helper have been deleted — readyPromise stays around as a
// "first system-init has landed" observation flag used by the
// `send:begin` log event and the pump/finally bookkeeping.

/**
 * util.inspect options for SDK message dumps in the pump log.
 *
 *   depth: null           → expand every nested object (stream_event
 *                           deltas are two levels deep, result.usage
 *                           is nested too)
 *   maxStringLength: 2000 → truncate individual strings (e.g. a giant
 *                           text_delta) to keep the terminal usable
 *   compact: 3            → use the "smart" compact layout up to 3
 *                           breakpoints before switching to multi-line
 *   breakLength: 120      → wrap at ~terminal width
 *
 * Tuned for "give me everything that isn't actively user-hostile". If
 * you need zero truncation (e.g. diffing two runs), set
 * `maxStringLength: Infinity` temporarily.
 */
const SDK_INSPECT_OPTS = {
  depth: null,
  colors: false,
  maxStringLength: 2000,
  compact: 3 as const,
  breakLength: 120
}

/**
 * Session-level state kept in the main process for each logical chat.
 *
 * Milestone B (long-lived SDK session): a single `query({ prompt: iter })`
 * call stays alive for the whole chat. User messages are pushed into
 * `queue` and the SDK consumes them one turn at a time. `runPump()`
 * drains the assistant-side stream in parallel and fans SDK messages
 * out to ChatEvents for the renderer.
 *
 * The first `send()` pays the ~8s fusion-code cold-start. Every turn
 * after that only pays the API round-trip.
 *
 * Invariants:
 *  - `handle`, `queue`, and `pumpPromise` are created together by
 *    `openSession()` and torn down together in the pump's `finally`.
 *  - `active` may be non-null while `handle === null` only briefly:
 *    during the synchronous tail of `send()` before the auth check
 *    fails and clears it. Otherwise `active !== null` implies the
 *    pump is running.
 */
interface SessionRuntime {
  /** Historical messages — reserved for future session persistence. */
  messages: unknown[]
  /** The turn currently awaiting an assistant response, or null. */
  active: ActiveTurn | null
  /** User-message queue feeding the SDK's streaming prompt. */
  queue: AsyncMessageQueue<unknown> | null
  /** Long-lived SDK Query handle for the whole session. */
  handle: Query | null
  /** Promise of the background pump task; resolves when the SDK stream ends. */
  pumpPromise: Promise<void> | null
  /**
   * Resolves on the first `system init` SDK message for this session —
   * i.e. the exact moment fusion-code is ready to accept a user turn.
   * Rejects if the pump exits before init was seen (cli spawn failure).
   *
   * `switchToSession()` awaits this so UI `sessionLoading` covers the
   * whole ~8s cli cold-start rather than just the sync spawn window.
   */
  readyPromise: Promise<void> | null
  readyResolve: (() => void) | null
  readyReject: ((err: Error) => void) | null
  readySettled: boolean
  /**
   * Per-runtime equivalent of the old class-level `pendingResume`.
   * Multi-runtime means two concurrent warmups may each need different
   * resume semantics, so resolve it from the runtime the lazy spawn is
   * operating on rather than a single class field.
   */
  pendingResume: boolean
  /**
   * True once `send()` has pushed at least one real user turn into the
   * queue. Used as the "worth keeping alive in the background" signal
   * for warmup-cancel in `switchToSession`: a runtime that was only
   * eagerly warmed but never actually sent to can be safely torn down
   * when the user switches away.
   */
  openedViaSend: boolean
  /**
   * True if the live child was spawned while proposal-writing mode was
   * active — i.e. its `systemPrompt.append` carries the proposal discipline
   * + mirror dir. Lets `send()` detect a WARM child that was spawned
   * WITHOUT proposal mode (the background warmup fires before the user picks
   * a product) and, for that turn only, inject the same grounding into the
   * user message instead (the append can't be hot-updated and re-spawning
   * is fragile). Without this flag the common "boot → first thread → pick
   * product → send" path silently sends on a non-proposal child and the AI
   * never receives the mirror path / cite-source discipline.
   */
  spawnedWithProposal: boolean
  /**
   * 本 runtime 的方案写作意图。由 send() 在每次发送时按 sessionId 写到 THIS
   * runtime（不是 engine 全局字段），openSession 在 spawn 烘焙 systemPrompt.append /
   * additionalDirectories 时从 `runtime` 读取，handleCanUseTool 据它决定是否对镜像
   * 目录的读放行。
   *
   * 为什么必须 per-runtime 而非 per-engine：一个 engine 多 runtime。
   * switchToSession 的后台 warmup 会对「另一个」会话 fire-and-forget 跑
   * ensureSessionReady → openSession；若意图存在 engine 全局字段上，warmup 会读到
   * 上一次 send（可能是别的会话）写的值，把方案纪律/镜像可读目录烘焙进一个用户从未
   * 置于方案模式的会话——跨会话泄漏。挂在 runtime 上，spawn 永远消费与它配对的那份
   * 意图，免疫交错与 warmup 抢读。新建 runtime 默认 false（普通会话）。
   */
  proposalMode: boolean
  proposalProducts: readonly { productLine: string; product: string }[]
  /**
   * 「这个活进程当前被 grounding 过的产品集签名」——记录最近一次把方案产品清单送达
   * AI 时所用的产品集（无论经 spawn 烘焙进 systemPrompt.append，还是经 send 注入进
   * 用户消息）。空串表示尚未 grounding 过任何产品集。
   *
   * 为什么需要它：systemPrompt.append 在 spawn 那一刻烘焙、之后不可热更新（不变量）。
   * 用户在 ProposalDocPanel 增删产品 chip 后，烘焙进 systemPrompt 的产品清单就过时了，
   * 但活进程不会重 spawn。send() 比对「当前产品集签名 ≠ 已 grounding 的签名」即可发现
   * 过时，于是把最新产品清单注入【本轮消息】覆盖旧的（读取始终由 isKbMirrorRead 放行
   * 整库，故只需补 prompt 里「该读哪些文件」这层）。注入后更新本字段，使产品集稳定的
   * 会话只在 chip 变动后注入一次、不每轮重注入（评审发现 2）。
   */
  proposalGroundedKey: string
}

interface ActiveTurn {
  requestId: number
  messageId: string
  toolNameByUseId: Map<string, string>
  sawTextDelta: boolean
  sawTextContent: boolean
  /** SDK messages counted for this turn (used for log throttling). */
  sdkMessageCount: number
  /**
   * Per-content-block tracker populated by `handleStreamEvent` when the
   * SDK fans out `content_block_start` + `input_json_delta` events for
   * a tool_use block. `handleAssistantMessage` checks this map before
   * emitting a finalizing `tool_use` event — if the id is already here,
   * the streamed start/delta path has covered it and we only need to
   * emit `tool_use_end` (not the full-input `tool_use`) to avoid
   * double-rendering. Keyed by toolUseId, not block index, because the
   * renderer pairs tool-use with tool-result by toolUseId.
   */
  streamedToolUseIds: Set<string>
  /**
   * Active index → toolUseId lookup for the duration of a single block.
   * `content_block_start` gives us (index, id); `content_block_delta`
   * only gives us `index`, so we need this map to route delta fragments
   * back to the right toolUseId. Cleared on `content_block_stop`.
   */
  toolUseIdByBlockIndex: Map<number, string>
  /**
   * Set of content-block indices that opened as `thinking` blocks.
   * Anthropic's API streams extended-thinking text via
   * `content_block_delta` with `delta.type === 'thinking_delta'`, but
   * the delta event only carries the index — we need this set to know
   * whether a given index is a thinking block (vs a tool_use/text
   * block) when routing deltas. Index is added on
   * `content_block_start.thinking` and removed on
   * `content_block_stop`. We don't track per-block message IDs because
   * the renderer accumulates all thinking deltas into a single
   * `reasoning` part on the active turn's assistant message.
   */
  thinkingBlockIndices: Set<number>
}

/**
 * Optional hooks the tabRegistry injects into each engine. `shouldBumpOnTurnEnd`
 * gates the tray unread-badge bump so it only fires when the user
 * genuinely isn't looking at this tab — i.e. the shell window is
 * unfocused OR this tab isn't the currently active one. Without this
 * hook the engine falls back to `webContents.isFocused()`, which is
 * meaningless for a WebContentsView embedded under a shell window.
 */
export interface ChatEngineOptions {
  shouldBumpOnTurnEnd?: () => boolean
}

export class ChatEngine extends EventEmitter {
  /**
   * The WebContents this engine is bound to. In the multi-tab model
   * each tab is a `WebContentsView` with its own webContents, and the
   * engine ships all IPC events (chat, log, session, permission) to
   * this one. Two tabs with two engines can each run their own
   * workspace in full isolation.
   */
  private readonly webContents: WebContents

  private readonly opts: ChatEngineOptions

  /**
   * Per-engine PermissionBroker. Was a module-level singleton before the
   * per-window refactor; now each window has its own so a permission
   * request in window A never leaks to window B's PermissionDialog.
   * Exposed as `public` so the IPC layer can call `respond()` after
   * resolving the target engine from the sender webContents.
   */
  public readonly permissionBroker: PermissionBroker

  private sessions = new Map<string, SessionRuntime>()
  private nextRequestId = 1
  /**
   * Most recent SessionMeta captured from the fusion-code child's
   * `system init` SDK message. Populated lazily on the first turn
   * the user sends; before then it's empty arrays + undefined model.
   * Read by the renderer through `getSessionMeta()` IPC to power
   * client-side slash-command dialogs (`/skill`, `/mcp`).
   */
  private sessionMeta: SessionMeta = {
    skills: [],
    mcpServers: [],
    slashCommands: []
  }

  /**
   * True once fusion-code's authoritative `system init` has landed at
   * least once. Until then, `sessionMeta` holds a disk-scanned seed (so
   * the `/` popover and SkillsDialog aren't empty on first open). Used
   * to avoid overwriting real data with stale seed if setWorkspace
   * races a fast first-turn.
   */
  private systemInitSeen = false

  /**
   * True once we've kicked off a disk seed (success or not), so the lazy
   * trigger in `getSessionMeta()` fires at most once. The original seed was
   * only wired to `setWorkspace()`, but a tab that resumes an existing
   * session never calls setWorkspace — so its `/` popover stayed empty until
   * the first turn. getSessionMeta is the one call the renderer always makes
   * when the composer mounts, so seeding from there covers the resume path.
   */
  private seedAttempted = false

  /**
   * Workspace directory — the cwd passed to `query()` for every session
   * this engine spawns. This is the *only* source of truth for the cwd.
   *
   * Defaulted to the OS Desktop (see `resolveDefaultWorkspace`) at
   * construction time rather than left null: the old "drop a folder to
   * start" gate has been removed, so the app opens straight into a usable
   * workspace with no picker page. Because this is non-null from birth,
   * `getWorkspace()` always returns a path, the renderer's cold-start
   * branch never fires, and `send()` / `getWorkingDirectory()` never hit
   * their null guards (kept as defense-in-depth only).
   *
   * Typed `string | null` purely to preserve the existing null guards
   * downstream; in practice it is always a string after the constructor.
   *
   * Not persisted across process restarts by design — every launch
   * re-resolves the Desktop. Wire a `userData` file if a sticky
   * last-used folder turns out to be wanted.
   */
  private workspaceDir: string | null = resolveDefaultWorkspace()

  /**
   * UUID of the session currently shown in the foreground of this
   * tab's UI. In the multi-runtime model the engine may have many
   * runtimes alive at once (background agent tasks on sessions the
   * user has switched away from); `activeSessionId` only identifies
   * the one whose thread is on screen, NOT the only one with a
   * running cli. The foreground session is the target of composer
   * send() calls from the UI, but `send()` itself accepts any
   * runtime id that exists in the sessions map.
   *
   * Null before the user creates / picks a session in the sidebar.
   * Populated by `switchToSession()` and mirrored by the SDK `sessionId`
   * option on each query(), so renderer + main + JSONL all agree.
   */
  private activeSessionId: string | null = null

  /**
   * Set to true for the short window during which `switchToSession()`
   * is updating session state. With lazy spawn this window is ~0ms,
   * but we keep the guard so `send()` still rejects cleanly if the
   * renderer races a click-and-type.
   */
  private switching = false

  /**
   * Current UI permission mode. Passed straight to the Agent SDK as
   * `permissionMode` on each new `query()` call and also forwarded to
   * every live runtime via `handle.setPermissionMode()` when the
   * renderer flips the picker mid-session.
   *
   * Source of truth: the renderer's localStorage-backed store. On
   * mount the renderer pushes its persisted value here via the
   * PERMISSION_MODE_SET IPC. Before that happens the engine's default
   * is `'default'`, which matches the pre-picker behaviour.
   */
  private uiPermissionMode: UiPermissionMode = 'bypassPermissions'

  /**
   * External MCP servers the user configured in Open Design's
   * Settings → External MCP (stored daemon-side, fetched over HTTP via
   * `fetchExternalMcpServers`). Mirrored into the SDK `mcpServers` query
   * option on every `openSession` so the desktop tab's fusion-code can
   * call the same tools the Open Design web tab gets.
   *
   * Cached (not fetched per-spawn) because `openSession` is synchronous —
   * it can't await an HTTP round-trip without serialising cold start.
   * Refreshed in the background: once at construction, and again at the
   * top of every `send()` so toggling a server in Settings takes effect
   * on the next turn rather than only on app restart. Empty `{}` until
   * the first successful fetch — which matches the product contract that
   * the chat tab opens immediately without waiting on the daemon.
   */
  private externalMcpServers: SdkExternalMcpServers = {}

  /** In-flight refresh dedupe so a burst of sends issues one fetch. */
  private externalMcpRefresh: Promise<void> | null = null

  // 把识别到的产品映射成「镜像子目录绝对路径 + 该产品在索引里的文件清单」，喂给
  // buildProposalAppend 前置进提示词，让 AI 直接 Read 命中、跳过 Glob/Grep 探路
  // （写方案反复翻文件慢的根因）。镜像目录结构 <kbOutDir>/<产品线>/<产品> 由阶段 A
  // 索引器固定（见 build-kb-index.ts）。
  //
  // 读 index.json 一次（openSession 首发 spawn 与 warm-spawn send 各调一次，非热路径，
  // 不缓存以保持简单）。索引缺失（未建）或某产品未命中文件时，files 退为空数组——提示词
  // 渲染层会退回「只给目录、让 AI 自查」的旧行为，功能不降级、仅少了加速。
  //
  // 纯度/缓存：products 取自同一份索引快照，索引不变则文件清单 bit 一致，落 prompt
  // 尾部不破坏上游 cache_control 断点。绝不读 engine 全局字段——products 由调用方从对应
  // runtime 取出传入（per-engine 字段会被 warmup 跨会话抢读）。
  /**
   * 产品集的稳定签名：排序后拼接 `productLine::product`，与顺序无关、只看成员集合。
   * 用于比对 spawn 烘焙 / 上次注入的产品集与本轮是否一致（见 runtime.proposalGroundedKey）。
   * 空集 → 空串。
   */
  private proposalProductsKey(
    products: readonly { productLine: string; product: string }[]
  ): string {
    return products
      .map((p) => `${p.productLine}::${p.product}`)
      .sort()
      .join('|')
  }

  private proposalProductScopes(
    products: readonly { productLine: string; product: string }[]
  ): ProposalProductScope[] {
    // 抽到 proposalScopes.buildProposalProductScopes 共享：send 热路径（本方法）与「召回预览」
    // 只读 IPC（方案三）走同一份 scope 构建，避免两边漂移。空集短路、不读盘的优化也在那里。
    return buildProposalProductScopes(products)
  }

  constructor(webContents: WebContents, opts: ChatEngineOptions = {}) {
    super()
    this.webContents = webContents
    this.opts = opts
    this.permissionBroker = new PermissionBroker()
    this.wireWebContentsBridges()
    // Warm the external-MCP cache in the background. Fire-and-forget: the
    // daemon may not be ready yet (chat tab opens before daemon ready), in
    // which case the fetch fails silently and the cache stays empty until
    // the next refresh. Never throws (fetchExternalMcpServers swallows).
    void this.refreshExternalMcpServers()
  }

  /**
   * Re-pull external MCP config from the daemon into `externalMcpServers`.
   * Deduped via `externalMcpRefresh` so concurrent callers share one fetch.
   * Always resolves (errors are absorbed downstream) so callers can `void`
   * it without an unhandled-rejection risk.
   *
   * `waitForDaemon` makes the load poll until the daemon is reachable (capped
   * at ~8s) instead of giving up on the first connection refusal. Use it on
   * the spawn path (warmup / cold first send) where the daemon may still be
   * booting — without it, the very first spawn races ahead with an empty map
   * and the configured servers never reach fusion-code (which won't reload
   * MCP config mid-process). Steady-state background refreshes pass false.
   */
  private refreshExternalMcpServers(
    opts: { waitForDaemon?: boolean } = {}
  ): Promise<void> {
    if (this.externalMcpRefresh) return this.externalMcpRefresh
    const task = loadExternalMcpServers(opts)
      .then((servers) => {
        this.externalMcpServers = servers
      })
      .catch(() => {
        // loadExternalMcpServers already degrades to {} on failure; this
        // catch is belt-and-suspenders so a future throw can't leak.
      })
      .finally(() => {
        if (this.externalMcpRefresh === task) this.externalMcpRefresh = null
      })
    this.externalMcpRefresh = task
    return task
  }

  /**
   * Forward engine/broker events to the bound WebContents. Replaces
   * the ipc/register.ts listener block from the singleton era — each
   * engine is responsible for shipping its own events to its own
   * tab's webContents, so a broadcast in tab A can never reach tab B.
   */
  private wireWebContentsBridges(): void {
    this.on('chat', (sessionId: string, event: ChatEvent) => {
      if (this.webContents.isDestroyed()) return
      const payload: ChatEventPayload = { sessionId, event }
      this.webContents.send(IPC_CHANNELS.CHAT_EVENT, payload)
      // Unread badge: bump on `end` of a complete turn only when the
      // user isn't looking at this tab right now. The default check is
      // webContents.isFocused(), but inside a WebContentsView that
      // returns nonsense — the tabRegistry injects a proper resolver
      // that accounts for "shell window focused AND this tab active".
      if (event.type === 'end' && this.shouldBumpOnTurnEnd()) {
        bumpUnread()
      }
    })

    this.on('sessionListChanged', () => {
      if (this.webContents.isDestroyed()) return
      this.webContents.send(IPC_CHANNELS.SESSION_LIST_CHANGED)
    })

    this.on('sessionMetaChanged', () => {
      if (this.webContents.isDestroyed()) return
      this.webContents.send(IPC_CHANNELS.SESSION_META_CHANGED)
    })

    this.on('log', (event: LogEvent) => {
      if (this.webContents.isDestroyed()) return
      const payload: LogEventPayload = { event }
      this.webContents.send(IPC_CHANNELS.LOG_EVENT, payload)
    })

    this.on('permissionModeChanged', (mode: UiPermissionMode) => {
      if (this.webContents.isDestroyed()) return
      this.webContents.send(IPC_CHANNELS.PERMISSION_MODE_CHANGED, { mode })
    })

    this.permissionBroker.on('request', (request: PermissionRequest) => {
      if (this.webContents.isDestroyed()) return
      this.webContents.send(IPC_CHANNELS.PERMISSION_REQUEST, request)
      // Permission requests are always user-attention — bump unread
      // even if the tab is focused so the tray gives a transient
      // flash. Cleared from the PERMISSION_RESPOND handler when the
      // user answers.
      bumpUnread()
    })

    // Forward cancellations so the renderer can tear down any inline
    // prompt bound to the dead requestId. Without this the user would
    // see a stale "allow/deny" row on a tool card whose engine has
    // already given up and moved on to deny.
    this.permissionBroker.on('cancel', (requestId: string) => {
      if (this.webContents.isDestroyed()) return
      this.webContents.send(IPC_CHANNELS.PERMISSION_CANCELLED, requestId)
    })
  }

  /**
   * True when the tray should bump its unread counter on the next
   * turn-end. The tabRegistry injects a resolver that returns
   * `false` when the shell window is focused AND this tab is the
   * active one. Falls back to `webContents.isFocused()` when no
   * hook was provided (shouldn't happen in production).
   */
  private shouldBumpOnTurnEnd(): boolean {
    if (this.opts.shouldBumpOnTurnEnd) {
      return this.opts.shouldBumpOnTurnEnd()
    }
    return !this.webContents.isFocused()
  }

  /**
   * Tear down the engine — called when the owning window closes.
   * Cancels every pending permission request, shuts down every live
   * fusion-code child, and unbinds all listeners. Safe to call multiple
   * times; sessions map is cleared and subsequent calls become no-ops.
   */
  async dispose(): Promise<void> {
    this.permissionBroker.cancelAll('Window closing')
    const entries = Array.from(this.sessions.entries())
    this.sessions.clear()
    const teardowns: Promise<void>[] = []
    for (const [id, rt] of entries) {
      if (rt.handle || rt.queue) {
        teardowns.push(
          this.teardownRuntime(id, rt).catch((err) => {
            console.warn('[engine] dispose teardown failed:', err)
          })
        )
      }
    }
    this.activeSessionId = null
    await Promise.all(teardowns)
    this.removeAllListeners()
    this.permissionBroker.removeAllListeners()
  }

  /**
   * Return the set of session ids currently backed by a live (or
   * warming-up) fusion-code runtime. "Live" here means the pump
   * hasn't exited — either handle or queue is still set. Empty slots
   * from a new-session click that never got send()'d are excluded.
   *
   * Used by the renderer to render running-badges in ThreadListSidebar
   * (so the user can see which threads still have agent work in
   * flight) and to decide what to subscribe to in the multi-runtime
   * IPC bridge.
   */
  listActiveRuntimeIds(): string[] {
    const ids: string[] = []
    for (const [id, rt] of this.sessions) {
      if (rt.handle || rt.queue) ids.push(id)
    }
    return ids
  }

  /**
   * Recycle every live runtime so the NEXT turn re-spawns under the
   * current `cliBackend` setting. Called by CLI_BACKEND_SET when the
   * user flips between bundled fusion-code and system claude.
   *
   * Why this is needed: `backend` is read exactly once, inside
   * `openSession()` at spawn time. A runtime, once spawned, is reused
   * verbatim for the rest of its life — `ensureSessionReady` short-
   * circuits the moment `handle && queue` are set. So without an
   * explicit recycle, a backend flip only took effect after an app
   * restart cleared the whole sessions map. (That's the "must restart
   * to switch" bug.) Here we proactively tear the runtimes down so the
   * next `send()` cold-starts on the new backend.
   *
   * What we keep:
   *   - The sessions map ENTRY (we don't `delete`) and its on-disk
   *     `.jsonl` transcript. We replace the runtime's live fields with
   *     a fresh empty slot and set `pendingResume = true`, so the next
   *     send re-spawns with `--resume <id>` and the full history is
   *     reloaded under the new backend. Deleting the entry would lose
   *     the resume intent and silently start the session from scratch.
   *   - An IN-FLIGHT runtime (one with an `active` turn awaiting the
   *     model). Tearing that down mid-turn would abort the user's
   *     request; the settings UI promises "an in-flight turn keeps its
   *     current backend". Those finish on the old backend and only the
   *     turn AFTER completion picks up the new one (the pump's finally
   *     clears handle/queue → next send re-spawns).
   *
   * Returns the count of runtimes actually recycled (for logging).
   */
  async restartRuntimesForBackendChange(): Promise<number> {
    const targets: Array<[string, SessionRuntime]> = []
    for (const [id, rt] of this.sessions) {
      // Empty slots (never sent to) carry no live child — skip; their
      // first send will naturally read the new backend.
      if (!rt.handle && !rt.queue) continue
      // In-flight turn: keep its current backend (see doc above).
      if (rt.active) continue
      targets.push([id, rt])
    }
    if (targets.length === 0) {
      this.logEvent('backendChange:noRuntimesToRecycle')
      return 0
    }
    this.logEvent('backendChange:recycle', {
      count: targets.length,
      ids: targets.map(([id]) => id)
    })
    await Promise.all(
      targets.map(async ([id, rt]) => {
        // Detach the live fields BEFORE the async teardown so a racing
        // send()/switchToSession sees an empty slot (and re-spawns)
        // rather than aliasing the runtime we're killing. We reuse the
        // SAME object identity and just null its live handles, so any
        // code already holding this runtime reference (e.g. a pending
        // getSession await) transparently observes the reset.
        const dying = {
          handle: rt.handle,
          queue: rt.queue,
          pumpPromise: rt.pumpPromise
        }
        rt.handle = null
        rt.queue = null
        rt.pumpPromise = null
        rt.readyPromise = null
        rt.readyResolve = null
        rt.readyReject = null
        rt.readySettled = false
        rt.active = null
        rt.openedViaSend = false
        // Next send must reload the transcript so history survives the
        // backend swap.
        rt.pendingResume = true
        // Tear down the detached child with the live fields we just
        // captured. teardownRuntime mutates a runtime, so feed it a
        // throwaway carrying only the old handles — the real `rt` is
        // already reset above and must not be touched again.
        const throwaway = { ...rt, ...dying } as SessionRuntime
        try {
          await this.teardownRuntime(id, throwaway)
        } catch (err) {
          console.warn('[engine] backend-change teardown failed:', err)
        }
      })
    )
    return targets.length
  }

  /**
   * Explicitly tear down a session's runtime without deleting its
   * JSONL on disk. User-facing "close this background session"
   * action: the row stays in the sidebar (the transcript is still
   * readable) but the cli process exits and future clicks will
   * resume from disk rather than pick up where it left off.
   *
   * Safe to call on an unknown or already-closed id — both are
   * silent no-ops so the UI can fire-and-forget.
   */
  async closeSessionRuntime(sessionId: string): Promise<void> {
    const rt = this.sessions.get(sessionId)
    if (!rt) return
    // Detach first so a racing switchToSession(sessionId) builds a
    // fresh slot rather than aliasing the one we're tearing down.
    this.sessions.delete(sessionId)
    this.logEvent('closeSessionRuntime', { sessionId })
    if (rt.handle || rt.queue) {
      try {
        await this.teardownRuntime(sessionId, rt)
      } catch (err) {
        console.warn('[engine] closeSessionRuntime teardown failed:', err)
      }
    }
    // If the user just closed the foreground session, clear the
    // pointer so subsequent send() calls don't target a dead slot.
    // The renderer should immediately pick a new foreground or drop
    // back to the empty thread view.
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }
    this.emit('sessionListChanged')
  }

  /** Snapshot of the cached session meta. Returns a fresh object so
      the renderer cannot accidentally mutate main-process state. */
  getSessionMeta(): SessionMeta {
    // Lazy disk seed: the composer always calls this on mount. If no seed
    // has been attempted and the authoritative list hasn't arrived, kick one
    // off (fire-and-forget; it emits `sessionMetaChanged` when done so the
    // renderer re-pulls). Covers the resume path where setWorkspace — the
    // original seed trigger — is never called.
    if (!this.seedAttempted && !this.systemInitSeen) {
      void this.seedSessionMetaFromDisk()
    }
    return {
      skills: [...this.sessionMeta.skills],
      mcpServers: this.sessionMeta.mcpServers.map((s) => ({ ...s })),
      slashCommands: [...this.sessionMeta.slashCommands],
      model: this.sessionMeta.model,
      cwd: this.sessionMeta.cwd
    }
  }

  /** Current workspace path, or null before the user has picked one. */
  getWorkspace(): string | null {
    return this.workspaceDir
  }

  /**
   * Commit a user-picked workspace directory.
   *
   * In the per-window engine model this is a **once-only** bind: each
   * window has a single workspace for its whole lifetime. Calling with
   * the same path re-returns it as a no-op so the renderer's cold-start
   * gate stays idempotent. Calling with a different path throws — the
   * renderer should open a new workspace window via
   * `openWorkspaceWindow` IPC instead.
   *
   * Validation rules:
   *   - must be a non-empty string
   *   - must be an absolute path (renderer has no business sending
   *     relative paths; absolute is what `webUtils.getPathForFile`
   *     returns)
   *   - must exist on disk and be a directory
   *
   * On first successful set, invalidate the file-suggestions cache so
   * the first `@`-mention popover after the gate reflects the new
   * workspace instead of stale entries.
   */
  async setWorkspace(candidate: string): Promise<string> {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new Error('Workspace path is required.')
    }
    if (!isAbsolute(candidate)) {
      throw new Error(`Workspace path must be absolute (got "${candidate}").`)
    }
    let stat
    try {
      stat = statSync(candidate)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Workspace path does not exist: ${msg}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${candidate}`)
    }

    // First-time set — fast path.
    if (this.workspaceDir === null) {
      this.workspaceDir = candidate
      invalidateFileSuggestions()
      this.logEvent('workspace:set', { path: candidate, mode: 'initial' })
      console.log('[engine] workspace set', { path: candidate })
      void this.seedSessionMetaFromDisk()
      return candidate
    }

    // Same path — no-op. The gate may re-call with the current path.
    if (this.workspaceDir === candidate) {
      return candidate
    }

    // Different path on an already-bound engine. Refuse — the UX
    // contract is "one workspace per window". The renderer should
    // open a new window for the new workspace.
    throw new Error(
      `Window is already bound to workspace "${this.workspaceDir}". Open a new workspace window to use "${candidate}".`
    )
  }

  /**
   * Seed `sessionMeta.skills` / `slashCommands` by scanning skill dirs
   * on disk, so the `/` composer popover and SkillsDialog show content
   * before fusion-code's first `system init` arrives (which only fires
   * after the first user turn). Best-effort: errors are logged and
   * swallowed. The authoritative list from `updateSessionMeta()` later
   * overwrites this seed — the `systemInitSeen` guard prevents a
   * late-returning seed from clobbering real data in the opposite race.
   */
  private async seedSessionMetaFromDisk(): Promise<void> {
    // Mark immediately (not after the await) so a second getSessionMeta call
    // that races in while this scan is in flight doesn't kick off a duplicate.
    this.seedAttempted = true
    try {
      const skills = await seedSkillsFromDisk(this.workspaceDir)
      if (this.systemInitSeen) return // real data already landed — drop seed
      if (skills.length === 0) return
      this.sessionMeta = {
        ...this.sessionMeta,
        skills,
        slashCommands: skills
      }
      console.log('[engine] sessionMeta seeded from disk', {
        skillCount: skills.length
      })
      this.logEvent('sessionMeta:seeded', { skillCount: skills.length })
      this.emit('sessionMetaChanged')
    } catch (err) {
      console.warn('[engine] seedSessionMetaFromDisk failed:', err)
    }
  }

  async send(
    sessionId: string,
    text: string,
    images?: readonly ChatImagePayload[],
    proposalMode = false,
    proposalProducts: readonly { productLine: string; product: string }[] = [],
    proposalRetrieve = false
  ): Promise<{ messageId: string }> {
    // Hard gate: the workspace must have been picked via the drag-drop
    // gate before we spawn anything. The renderer already refuses to
    // render the composer until getWorkspace() returns a non-null path,
    // but we re-check here so a buggy (or malicious) renderer can't
    // bypass the UI by directly invoking chatApi.send.
    if (this.workspaceDir === null) {
      throw new Error(
        'Workspace not set. Drop a folder on the window to pick one first.'
      )
    }
    if (this.switching) {
      throw new Error('Session switch in progress — please retry in a moment.')
    }
    if (!sessionId) {
      throw new Error('No session — create or open one from the sidebar.')
    }

    // Refresh the external-MCP cache BEFORE we might spawn fusion-code, so
    // the SDK `mcpServers` option in openSession reflects the user's current
    // Settings → External MCP list. The SDK only emits `--mcp-config` when
    // the map is non-empty, so a stale-empty cache here means the server
    // (e.g. mysql-hospital) silently never reaches the CLI.
    //
    // We await — but with a hard cap baked into fetchExternalMcpServers —
    // ONLY when the cache is still empty (cold first turn, or daemon wasn't
    // ready at construction). Once we have a non-empty cache we just kick a
    // background refresh and proceed, so steady-state sends pay nothing.
    // The await is bounded (fetch has its own AbortController timeout) so a
    // down daemon can't wedge a turn — worst case we proceed with `{}` and
    // the user retries after the daemon is up.
    if (Object.keys(this.externalMcpServers).length === 0) {
      await this.refreshExternalMcpServers({ waitForDaemon: true })
    } else {
      void this.refreshExternalMcpServers()
    }

    // Multi-runtime: the target session may be the foreground one OR a
    // background task the user started earlier. Either way, as long as
    // the runtime slot exists we're allowed to push a turn into it.
    // `getSession` lazily creates the slot if missing (new session path).
    const runtime = await this.getSession(sessionId)
    // Record the proposal-mode intent for THIS turn on the TARGET runtime
    // (not an engine-global field) BEFORE anything below can trigger a spawn
    // — ensureSessionReady → openSession reads it off `runtime`. Writing it
    // per-runtime is what keeps switchToSession's background warmup (which
    // spawns a DIFFERENT session) from baking the wrong intent. Set
    // unconditionally so leaving proposal mode also takes effect on the next
    // fresh spawn of this runtime.
    runtime.proposalMode = proposalMode
    runtime.proposalProducts = proposalProducts
    // Mark the runtime as "has real work" — this is the signal
    // `switchToSession` uses to keep the runtime alive when the user
    // switches away (warmup-cancel only kills never-sent runtimes).
    runtime.openedViaSend = true
    const messageId = randomUUID()
    const requestId = this.nextRequestId++

    this.logEvent('send:begin', {
      sessionId,
      messageId,
      textLength: text.length,
      imageCount: images?.length ?? 0,
      runtimeReady: !!(runtime.queue && runtime.handle && runtime.readySettled)
    })

    // Make sure the cli is spawned and ready. This is a no-op when
    // the background warmup kicked off in `switchToSession` has
    // already completed (both queue/handle set AND readyPromise
    // resolved), a await-on-same-promise when warmup is still in
    // flight, and a full spawn+wait when nothing has happened yet
    // (rare — only if the user hit send before the React effect
    // pipeline committed the switch). ensureSessionReady swallows
    // its own timeout / pump-failure, so we re-check the runtime
    // state after the await and throw a clean error when the spawn
    // didn't stick.
    try {
      await this.ensureSessionReady(sessionId)
      if (!runtime.queue || !runtime.handle) {
        throw new Error('fusion-code cli failed to start (no ready signal)')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[engine] ensureSessionReady in send failed:', msg)
      this.emitEvent(sessionId, { type: 'start', messageId })
      this.emitEvent(sessionId, {
        type: 'error',
        messageId,
        error: msg
      })
      this.emitEvent(sessionId, { type: 'end', messageId })
      return { messageId }
    }

    // Register this turn as the active one. The pump looks at
    // `runtime.active` to decide which messageId to emit ChatEvents for.
    runtime.active = {
      requestId,
      messageId,
      toolNameByUseId: new Map(),
      sawTextDelta: false,
      sawTextContent: false,
      sdkMessageCount: 0,
      streamedToolUseIds: new Set(),
      toolUseIdByBlockIndex: new Map(),
      thinkingBlockIndices: new Set()
    }
    this.emitEvent(sessionId, { type: 'start', messageId })

    // warm-spawn grounding: the proposal discipline + absolute mirror dir
    // normally ride in systemPrompt.append, baked at spawn (openSession,
    // gated on `proposalActive`). But the background warmup can spawn this
    // session's child BEFORE the user picks a product — that child carries
    // NO proposal append (the common "boot → first thread → pick product →
    // send" path). Re-spawning the live child to re-bake it is fragile
    // (resuming a just-killed same-id session makes `claude` exit 1), so we
    // instead inject the same instructions into THIS user message — spawn-
    // timing-independent. We skip injection when the live child already
    // baked the append (`spawnedWithProposal` — i.e. it was (re)spawned
    // under proposal mode, including a fresh first-send spawn just now via
    // ensureSessionReady above) AND the baked product set is still current,
    // to avoid duplicating the block (see the stale-products case (b) below).
    // Slash commands (e.g. /compact, /clear) must reach fusion-code with '/'
    // at offset 0 — the CLI's short-path detection is prefix-sensitive. Never
    // inject the proposal grounding ahead of one, or the leading '/' is no
    // longer at the start and the command silently runs as ordinary prose
    // (评审 #10). Such turns aren't drafting proposal content anyway, so
    // skipping the grounding costs nothing — the next non-slash turn re-injects
    // it (spawnedWithProposal is still false on the warm child).
    //
    // 注入触发有两种情形（都靠注入本轮消息修复，绝不重 spawn / 热改 systemPrompt）：
    //   (a) 活进程根本没烘焙方案 append（warmup 在选产品前就 spawn 了）——即
    //       !spawnedWithProposal，原有逻辑。
    //   (b) 烘焙过，但用户随后增删了产品 chip，烘焙进 systemPrompt 的产品集已过时——
    //       当前产品集签名 ≠ 已 grounding 的签名（proposalGroundedKey）。此前这种改动
    //       对 warm 会话完全不生效，AI 一直按首发的产品清单写（评审发现 2）。
    // 注入后把 proposalGroundedKey 更新为当前签名：产品集稳定的会话只在 chip 变动后
    // 注入一次，不每轮重注入（warm-spawn (a) 情形 spawnedWithProposal 恒 false，仍按
    // 原行为每轮注入，符合既有预期）。
    const isSlashCommand = text.trimStart().startsWith('/')
    const proposalKey = proposalMode ? this.proposalProductsKey(runtime.proposalProducts) : ''
    const needsGrounding =
      proposalMode &&
      !isSlashCommand &&
      (!runtime.spawnedWithProposal || proposalKey !== runtime.proposalGroundedKey)
    // 内容级召回（#2）：目录+正文回合（renderer 在 phase !== 'cover' 时置 proposalRetrieve）
    // 对已限定产品的镜像原文做关键词召回，把命中片段注入本回合（与文件清单并存、增量），治
    // 「知识库有料却没引到」。slash 命令不注入（同 grounding：注入会顶走开头的 '/'，CLI 短
    // 路检测失效）。召回失败/空 → 不注入，回落到「只给文件清单让 AI 自查」。
    const wantsRetrieval = proposalMode && proposalRetrieve && !isSlashCommand
    // grounding/召回构建段包 try/catch，与上面 spawn 路径（ensureSessionReady 的 catch：
    // emit start/error/end 后 clean return）对称。为什么必须兜：buildProposalAppend 自
    // skill 化后运行期读模板（skills/proposal-writer），模板缺失/被改坏会 throw——本段
    // 跑在 'start' 已 emit 之后，若异常裸逃出 send()，IPC reject 只会让 renderer 在合成
    // err_ id 下补错误气泡，1050 行那条真实 messageId 的 start 永远等不到配对的 end/
    // error，本轮 spinner 悬挂成半终结态（终审 finding #1）。catch 里对真实 messageId
    // 补发 error+end 并清 active，下一轮可正常重试。
    let groundedText: string
    try {
      // scopes 在 grounding 或召回任一需要时读一次（proposalProductScopes 对空集已短路、不读盘）。
      const scopes =
        needsGrounding || wantsRetrieval
          ? this.proposalProductScopes(runtime.proposalProducts)
          : []
      let retrievalBlock = ''
      if (wantsRetrieval) {
        // 混合语义检索（embedding 在 utilityProcess，带超时不冻 send）。engine 自动召回
        // 【忽略 staleIndex】——拿到什么（混合或 BM25 降级）就注什么，绝不因 stale 变空（防回归）。
        // 仍留在现有 try 内：kbSemanticSearch 自身吞异常降级，这里的 try 继续兜 buildProposalAppend。
        const { hits } = await kbSemanticSearch(text, scopes)
        const passages = hits.map((h) => ({
          text: h.text, title: h.title, mirrorPath: h.mirrorPath, score: h.score
        }))
        retrievalBlock = renderRetrievedBlock(passages)
        // 调试可观测：让 dev 终端能看到召回有没有命中、抓了哪些文件（#2 手测靠它，因为
        // 召回注入在主进程消息里、UI 看不见）。命中为空也打，便于区分「没触发」和「触发但零命中」。
        console.log('[engine] proposal semantic retrieval', {
          query: text.slice(0, 40),
          scopes: scopes.length,
          hits: hits.length,
          titles: hits.map((h) => h.title)
        })
      }
      const retrievedText = retrievalBlock ? `${retrievalBlock}\n\n---\n\n${text}` : text
      groundedText = needsGrounding
        ? `${buildProposalAppend(kbOutDir(), scopes)}\n\n---\n\n${retrievedText}`
        : retrievedText
      if (needsGrounding) runtime.proposalGroundedKey = proposalKey
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[engine] proposal grounding/retrieval build failed:', msg)
      runtime.active = null
      this.emitEvent(sessionId, { type: 'error', messageId, error: msg })
      this.emitEvent(sessionId, { type: 'end', messageId })
      return { messageId }
    }
    // Build the SDK user message. Text-only turns keep the string
    // short-path (fusion-code expects this for slash commands and
    // zero-image prompts). Image turns switch to a ContentBlockParam[]
    // array with the text first and each image as an ImageBlockParam.
    //
    // Mirrors free-code's processTextPrompt.ts ordering: text on top,
    // images below. The Anthropic API doesn't care about order but
    // the model's chain-of-thought tends to reference images better
    // when they come after the prompt sentence describing them.
    const messageContent: MessageParam['content'] =
      images && images.length > 0
        ? this.buildMultimodalContent(groundedText, images)
        : groundedText

    const userMsg = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: messageContent
      },
      parent_tool_use_id: null,
      session_id: sessionId
    }
    runtime.queue!.push(userMsg)
    console.log('[engine] send queued user turn', {
      sessionId,
      messageId,
      textLength: text.length,
      textPreview: text.slice(0, 120),
      imageCount: images?.length ?? 0,
      queueSize: runtime.queue!.size
    })
    this.logEvent('send:queued', { messageId, queueSize: runtime.queue!.size })

    return { messageId }
  }

  /**
   * Convert validated ChatImagePayload entries into Anthropic SDK
   * ContentBlockParam format, prepending the user's text block.
   *
   * The data URL was already shape-checked by validateImages() in the
   * IPC layer (see main/ipc/register.ts), so here we can trust:
   *   - prefix matches `data:image/<subtype>;base64,<body>`
   *   - subtype is one of the API-accepted media types
   *
   * We still do a defensive parse in case a future caller bypasses the
   * validator — a malformed entry just gets skipped with a warning
   * rather than corrupting the whole turn.
   */
  private buildMultimodalContent(
    text: string,
    images: readonly ChatImagePayload[]
  ): ContentBlockParam[] {
    const blocks: ContentBlockParam[] = []

    // Text block goes first even if empty — matching free-code's
    // processTextPrompt.ts, which always emits the text before images.
    // An empty string is a valid text block per the Anthropic SDK
    // types; we only skip if the user has no caption AND no whitespace.
    if (text.length > 0) {
      const textBlock: TextBlockParam = { type: 'text', text }
      blocks.push(textBlock)
    }

    for (const img of images) {
      const parsed = this.parseImageDataUrl(img.dataUrl)
      if (!parsed) {
        console.warn('[engine] skipping malformed image data URL')
        continue
      }
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType,
          data: parsed.data
        }
      }
      blocks.push(imageBlock)
    }

    // Edge case: all images were malformed and text was empty. Fall
    // back to a placeholder so we don't push an empty-content message
    // into the SDK, which some protocol versions reject.
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: '(empty message)' })
    }

    return blocks
  }

  /**
   * Parse `data:image/<subtype>;base64,<body>` into the shape the SDK
   * expects. Returns null on any mismatch — caller treats null as
   * "skip this image".
   */
  private parseImageDataUrl(dataUrl: string): {
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
    data: string
  } | null {
    const match = dataUrl.match(
      /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/
    )
    if (!match) return null
    // Normalize image/jpg → image/jpeg for the Base64ImageSource union
    // (Anthropic's type only accepts image/jpeg, not image/jpg).
    const mediaType = match[1]!.replace(
      'image/jpg',
      'image/jpeg'
    ) as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
    return { mediaType, data: match[2]! }
  }

  abort(sessionId: string): void {
    const runtime = this.sessions.get(sessionId)
    const active = runtime?.active
    if (!runtime || !active) return

    console.log('[engine] abort called', {
      sessionId,
      messageId: active.messageId
    })

    // Ask the SDK to interrupt the current turn. This is a control
    // request that the CLI handles via the stream-json protocol; if the
    // SDK kills the whole query(), the pump's finally block will reset
    // the session and the next send() will spawn a fresh child.
    try {
      const p = runtime.handle?.interrupt()
      if (p && typeof (p as Promise<void>).catch === 'function') {
        void (p as Promise<void>).catch(() => {})
      }
    } catch {
      // ignore abort cleanup errors
    }

    this.emitEvent(sessionId, { type: 'end', messageId: active.messageId })
    runtime.active = null
  }

  subscribe(sessionId: string, handler: (e: ChatEvent) => void): () => void {
    const key = `chat:${sessionId}`
    this.on(key, handler)
    return () => this.off(key, handler)
  }

  /**
   * Spawn the long-lived fusion-code child process and wire up the
   * AsyncMessageQueue → query() → pump pipeline. Called once per
   * session switch (new or resume). The pump runs in the background
   * until the SDK stream ends; its `finally` resets `runtime.queue` /
   * `runtime.handle` / `runtime.pumpPromise` so the next openSession
   * spawns a fresh child.
   *
   * The `sessionId` is forwarded to the SDK via its `sessionId` option
   * (or `resume` when `opts.resume` is true), so fusion-code's JSONL
   * filename matches what the renderer sees in the sidebar.
   *
   * Throws if the CLI binary cannot be located.
   */
  private openSession(
    sessionId: string,
    runtime: SessionRuntime,
    opts?: { resume?: boolean }
  ): void {
    const backend = getAppSettings().cliBackend
    const rawCliPath = this.resolveCliPath(backend)
    // Windows 上系统 claude 是 claude.cmd（批处理 shim）。claude-agent-sdk 的
    // Fx() 判断「路径不以 .js/.mjs/.ts… 结尾 → 当 native binary 直接 spawn」，
    // 于是它会裸 spawn(claude.cmd) → spawn EINVAL（Node 不带 shell 执行不了 .cmd）。
    // 把 shim 解析成它真正调用的 cli.js（非 Windows / 已是脚本则原样返回），这样
    // Fx() 返回 false，SDK 改走 `executable cli.js` 路径，再配合下面显式指定的
    // executable（自带 node）就能正常起。fusion-code-cli[.exe] 不是 .cmd，原样穿过。
    // 见 [[2026-05-25-windows系统claude.cmd经SDK裸node-spawn-EINVAL]]。
    const cliPath = resolveSystemClaudeJsEntry(rawCliPath)
    // 当 cliPath 是 JS 入口（Windows 系统 claude 解析后、或未来任何 .js cli）时，SDK
    // 需要一个 node 去跑它，默认取裸 'node'——但打包 Electron 的精简 PATH 里常无
    // node.exe → spawn EINVAL。显式指到 app 自带的 node-runtime（绝对路径，绕开 PATH）。
    // 对非 JS 入口（fusion-code-cli[.exe]、mac 无后缀 claude 脚本）SDK 直接执行二进制，
    // executable 不参与，给了也无害；但仅在确有自带 node 且确是 JS 入口时才设，避免
    // 改变现状行为。
    const jsRuntimeBin = /\.m?js$/i.test(cliPath) ? resolveJsRuntimeBin() : null
    // Repo-root skills/ packaged as a local plugin (see
    // resolveBundledSkillsPluginDir). null when the manifest is missing — we
    // then omit the `plugins` option entirely rather than pass an empty array.
    const skillsPluginDir = resolveBundledSkillsPluginDir()
    // Bundled standalone Python home for the ppt-master skill's bootstrap.
    // Injected as PPT_MASTER_PYTHON_HOME into BOTH backends' child env (see the
    // env: block below) so `bin/ensure-python.sh` can build its venv off our
    // pinned 3.12 instead of the machine's bare python3. null in dev / on a
    // platform we don't bundle — the bootstrap then falls back to system python.
    const pythonHome = resolveBundledPythonHome()
    const resume = opts?.resume === true
    this.logEvent('openSession:begin', { sessionId, resume, cliPath, backend })
    // Report the env the CHILD will actually see, not raw process.env:
    // for the system backend the gateway keys are stripped, so this log
    // must reflect that (otherwise it falsely shows csdn for system claude).
    const childEnvForLog = backend === 'bundled' ? process.env : systemBackendEnv()
    console.log('[engine] opening long-lived SDK session', {
      sessionId,
      resume,
      cliPath,
      backend,
      cwd: this.getWorkingDirectory(),
      env: {
        ANTHROPIC_BASE_URL: childEnvForLog.ANTHROPIC_BASE_URL ?? '(unset)',
        ANTHROPIC_AUTH_TOKEN: childEnvForLog.ANTHROPIC_AUTH_TOKEN ? '(set)' : '(unset)',
        ANTHROPIC_API_KEY: childEnvForLog.ANTHROPIC_API_KEY ? '(set)' : '(unset)',
        ANTHROPIC_DEFAULT_SONNET_MODEL: childEnvForLog.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '(unset)',
        ANTHROPIC_DEFAULT_OPUS_MODEL: childEnvForLog.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '(unset)',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: childEnvForLog.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '(unset)'
      },
      // Diagnostic: which external MCP servers (from Settings → External MCP)
      // are being wired into THIS spawn. Empty array = the cache was still
      // cold when we built sdkOptions, so `--mcp-config` won't be emitted.
      externalMcpServers: Object.keys(this.externalMcpServers),
      // null here means the repo-root skills/ plugin manifest wasn't found,
      // so its skills won't appear in the `/` popover for this session.
      skillsPluginDir: skillsPluginDir ?? '(none)',
      // null = no bundled Python runtime (dev / unbundled platform); the
      // ppt-master bootstrap then falls back to system python3.
      pythonHome: pythonHome ?? '(none)'
    })

    // 方案写作模式：在常量中文 append 之后再拼一段「方案专家纪律」，并把知识库
    // 文本镜像目录（userData/kb-index）的绝对路径写进提示词。镜像目录本身在下面
    // 通过 additionalDirectories 加进可读范围——cwd 绝不改动（不变量）。
    // 意图从 THIS runtime 读（send() 在本次 spawn 前写到该 runtime）——绝不读 engine
    // 全局字段，否则 warmup 跑别的会话的 openSession 会抢到错误意图（见 SessionRuntime
    // .proposalMode 注释）。
    const baseChineseAppend =
      '始终用中文回复。所有解释、注释、与用户的交流都用中文。技术术语和代码标识符保留原形。'
    const proposalActive = runtime.proposalMode
    // 方案 spawn 时后台预载 embedding worker，让模型在用户首次 send 前就绪。
    // warmEmbedWorker 幂等（已有 worker 直接返回），不会重复 fork。
    if (proposalActive) warmEmbedWorker()
    const mirrorDir = kbOutDir()
    // productScopes 只在方案模式下计算——非方案会话不调用 proposalProductScopes，避免
    // 普通会话的 spawn 热路径也白读一遍 KB 索引再丢弃（评审发现 7）。下面 systemPromptAppend
    // 与 additionalDirectories 两处共用本次结果。
    const productScopes = proposalActive
      ? this.proposalProductScopes(runtime.proposalProducts)
      : []
    const systemPromptAppend = proposalActive
      ? `${baseChineseAppend}\n\n${buildProposalAppend(mirrorDir, productScopes)}`
      : baseChineseAppend

    const queue = new AsyncMessageQueue<unknown>()
    runtime.queue = queue

    // Wire up the "ready" promise before the pump can start. It's
    // resolved on the first `system init` SDK message (see runPump) and
    // rejected from the pump's finally if the cli exited first.
    runtime.readySettled = false
    runtime.readyPromise = new Promise<void>((resolve, reject) => {
      runtime.readyResolve = () => {
        if (runtime.readySettled) return
        runtime.readySettled = true
        resolve()
      }
      runtime.readyReject = (err: Error) => {
        if (runtime.readySettled) return
        runtime.readySettled = true
        reject(err)
      }
    })

    // Build the SDK query options. On resume we pass `resume: sessionId`
    // so fusion-code reloads the JSONL; on new sessions we pass
    // `sessionId: sessionId` so the CLI uses our UUID as the filename
    // instead of auto-generating one. The SDK type union forbids
    // passing both simultaneously, so we branch at the field level.
    const sdkOptions = {
      pathToClaudeCodeExecutable: cliPath,
      // 仅当 cliPath 是 JS 入口且我们有自带 node 时设置：让 SDK 用它（而非裸 'node'）
      // 去跑那个 .js。undefined 时 SDK 回退默认（dev 下裸 'node' 通常能在 PATH 命中）。
      ...(jsRuntimeBin ? { executable: jsRuntimeBin as 'node' } : {}),
      cwd: this.getWorkingDirectory(),
      // 方案模式才扩大可读范围到知识库镜像目录（绝对路径）。SDK 0.2.98 的字段是
      // `additionalDirectories?: string[]`（sdk.d.ts:962，注释「Additional directories
      // Claude can access beyond the current working directory. Paths should be
      // absolute.」）。spread-omit：非方案模式不传，等价于不设——绝不通过这个字段
      // 或 cwd 改变默认可读范围（cwd 不变量）。
      ...(proposalActive
        ? {
            additionalDirectories:
              productScopes.length > 0 ? productScopes.map((p) => p.dir) : [mirrorDir]
          }
        : {}),
      // UI-picked permission mode. Values:
      //   - default           → canUseTool → broker → dialog (current flow)
      //   - plan              → SDK restricts to read-only tools, assistant
      //                          emits a plan block
      //   - acceptEdits       → SDK auto-allows Edit/Write/NotebookEdit,
      //                          broker still fires for everything else
      //   - bypassPermissions → SDK skips every prompt (requires
      //                          allowDangerouslySkipPermissions below)
      //   - dontAsk           → SDK denies anything not pre-approved
      //
      // Allow rules added via "allow during session" live in the
      // SDK's in-process `session` scope, so the dialog only fires
      // once per { toolName, scope } pair for the lifetime of the
      // fusion-code child process.
      permissionMode: this.uiPermissionMode as PermissionMode,
      // Required for bypassPermissions to take effect. It's a no-op
      // under every other mode so we set it unconditionally — the
      // mode field is the actual gate.
      allowDangerouslySkipPermissions: true,
      canUseTool: (
        toolName: string,
        input: Record<string, unknown>,
        ctx: {
          signal: AbortSignal
          toolUseID: string
          title?: string
          displayName?: string
          description?: string
        }
      ) =>
        // Multi-runtime: route by the openSession closure's own id,
        // NOT this.activeSessionId — the foreground session may be a
        // different runtime at the moment this callback fires. The
        // pump-local `sessionId` already tracks any rebinds that
        // updateSessionMeta applies, so the closure capture is the
        // correct binding.
        this.handleCanUseTool(sessionId, toolName, input, ctx),
      // Stream text deltas so the UI sees typewriter-style chunks.
      includePartialMessages: true,
      // env.json has already been merged into process.env during
      // bootstrap — forward everything so ANTHROPIC_BASE_URL / auth
      // tokens / model alias overrides reach the child CLI.
      //
      // Two cache-preservation env overrides layered on top of the
      // parent env:
      //
      // 1. CLAUDE_CODE_MCP_INSTR_DELTA=true moves MCP server
      //    instructions out of the org-scope cached system prompt
      //    into persisted `mcp_instructions_delta` attachments (see
      //    free-code utils/mcpInstructionsDelta.ts:37). Without this
      //    the set of connected MCP servers reaches prompts.ts in
      //    async-connect order — every fresh cli spawn hashes
      //    differently and the whole `rest` block cache misses.
      //    With delta mode the attachment list is name-sorted
      //    (delta.ts:124) and only injected once per conversation.
      //
      // 2. CLAUDE_CODE_ATTRIBUTION_HEADER=false disables the
      //    `x-anthropic-billing-header` text block that free-code
      //    prepends as the first system block (splitSysPromptPrefix
      //    Default-mode branch in utils/api.ts). That header embeds
      //    a `cch=00000` placeholder which the fetch wrapper
      //    replaces with an xxHash64 of the request body *before*
      //    sending — so it changes on every request even when the
      //    rest of the prompt is bit-identical. Because Anthropic's
      //    cache_control matcher hashes blocks by sequence prefix,
      //    a mutating leading block busts every downstream cache
      //    breakpoint. Trading billing attribution + fast-mode
      //    attestation for cache stability is the right call here:
      //    this is a desktop app, we don't use fast mode gating.
      //    Can be force-enabled via CLAUDE_CODE_ATTRIBUTION_HEADER=true.
      //
      // 3. ENABLE_TOOL_SEARCH=true force-enables `tool_reference`
      //    defer_loading for MCP tools. Free-code's optimistic gate
      //    (utils/toolSearch.ts:299) auto-disables tool search when
      //    ANTHROPIC_BASE_URL points at a non-first-party host,
      //    because many proxies don't forward the `tool_reference`
      //    beta header/block. Claude-desktop users typically run
      //    through a proxy (that's why they picked the desktop in
      //    the first place), so the default gate strips
      //    defer_loading and the 5 configured MCP servers pour
      //    their full tool schemas into the request — that's the
      //    ~15k token bloat measured against a 27k total. Flipping
      //    this to true makes MCP tools become discoverable via
      //    `ToolSearchTool` instead of inline, cutting typical
      //    first-turn input tokens roughly in half. Trade-off: if
      //    the proxy actually strips the beta, the API returns
      //    400 — user can set to 'false' to revert.
      //
      // All three respect parent-process overrides so ops can flip
      // them back for diagnostics without recompiling.
      //
      // Only injected when running the bundled fusion-code CLI.
      // Upstream claude-code from the user's system doesn't implement
      // these feature flags (they're fusion-code-specific patches), so
      // pushing them to vanilla claude is a no-op at best and a
      // spurious "unknown env" warning at worst. System-backend users
      // get their own `~/.claude/settings.json` instead.
      // Bundled fusion-code keeps the full parent env (incl. the env.json
      // csdn gateway — that's its whole point) plus the cache-preservation
      // flags. System claude instead gets the gateway env.json keys stripped
      // (see systemBackendEnv) so it uses the user's own ~/.claude login and
      // default Anthropic models, not csdn / gpt-5.4. A gateway var the user
      // exported in their OWN shell still survives — only the env.json leak
      // is removed.
      env: (backend === 'bundled'
        ? {
            ...process.env,
            CLAUDE_CODE_MCP_INSTR_DELTA:
              process.env.CLAUDE_CODE_MCP_INSTR_DELTA ?? 'true',
            CLAUDE_CODE_ATTRIBUTION_HEADER:
              process.env.CLAUDE_CODE_ATTRIBUTION_HEADER ?? 'false',
            ENABLE_TOOL_SEARCH:
              process.env.ENABLE_TOOL_SEARCH ?? 'true',
            // 给扩展思考钉一个 token 预算上限，作为思考进度条的分母。
            // 这是做"真进度"的代价：思考超过该预算会被 CLI 截断。尊重用户
            // 在自己 shell 里导出的覆盖。值与 renderer 算百分比共用 shared 常量。
            MAX_THINKING_TOKENS:
              process.env.MAX_THINKING_TOKENS ?? String(THINKING_TOKEN_BUDGET),
            // ppt-master skill bootstrap reads this to pick its venv base
            // interpreter. Respect a user-exported override; otherwise hand
            // over the bundled 3.12 home (omitted when null so the bootstrap
            // falls back to system python on its own).
            ...(process.env.PPT_MASTER_PYTHON_HOME
              ? {}
              : pythonHome
                ? { PPT_MASTER_PYTHON_HOME: pythonHome }
                : {})
          }
        : {
            ...systemBackendEnv(),
            // 给扩展思考钉一个 token 预算上限，作为思考进度条的分母。
            // 这是做"真进度"的代价：思考超过该预算会被 CLI 截断。尊重用户
            // 在自己 shell 里导出的覆盖。值与 renderer 算百分比共用 shared 常量。
            MAX_THINKING_TOKENS:
              process.env.MAX_THINKING_TOKENS ?? String(THINKING_TOKEN_BUDGET),
            // Same passthrough under system claude: PPT_MASTER_PYTHON_HOME is a
            // main-process runtime path, not an env.json gateway key, so it
            // never affects claude's model routing — safe to hand over so the
            // ppt-master skill works under the system backend too.
            ...(process.env.PPT_MASTER_PYTHON_HOME
              ? {}
              : pythonHome
                ? { PPT_MASTER_PYTHON_HOME: pythonHome }
                : {})
          }) as Record<string, string>,
      // 用 preset 形式追加中文回复指令，而不是用字符串整体覆盖。
      // 整体覆盖会丢掉 claude_code preset 自带的工具说明 / 权限语义 /
      // 环境上下文，得不偿失；`{ type:'preset', preset:'claude_code', append }`
      // 保留原系统提示词，只在末尾拼一段。append 内容是常量，每次 spawn
      // 都 bit 一致，落在 prompt 尾部不影响上面那几个 cache_control 断点
      // （与 CLAUDE_CODE_ATTRIBUTION_HEADER=false 的缓存保护互不冲突）。
      // 方案模式时 append = 中文指令 + 方案专家纪律（见上面 systemPromptAppend
      // 的构造）；普通模式只有中文指令。始终保留 preset+append 模式，绝不整体
      // 覆盖 systemPrompt——否则会丢掉 claude_code preset 自带的工具说明 / 权限语义。
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: systemPromptAppend
      },
      // Pin fusion-code's session identity. Mutually exclusive: either
      // we're resuming an existing transcript (`resume`) or we're
      // creating a new one with an explicit id (`sessionId`).
      //
      // `forkSession: false` is the SDK default but we set it
      // explicitly so the intent is visible: we want `--resume X` to
      // keep writing back to X's JSONL, not fork into a new id Y.
      // See free-code sessionRestore.ts:435-451 — the `!opts.forkSession`
      // branch calls `switchSession(result.sessionId)` which reuses X.
      // Without this guarantee, claude-desktop would need a rebind
      // race handler between `switchToSession` and the first `system
      // init` message, which defeats the lazy-switch optimization.
      forkSession: false,
      // External MCP servers configured in Open Design's Settings → External
      // MCP. Read from the per-engine cache (warmed in the background from the
      // daemon — see refreshExternalMcpServers). Empty `{}` is a no-op: the
      // SDK simply wires no extra servers. This is what lets the desktop tab's
      // fusion-code reach the same tools (e.g. the local MySQL MCP) the Open
      // Design web tab gets, from one shared config. We pass via the SDK
      // option rather than writing a `.mcp.json` into the workspace cwd
      // because the desktop tab's cwd is the user's own folder (default: the
      // Desktop), not a daemon-managed project dir — writing there could
      // clobber a `.mcp.json` the user keeps in their own source tree. The
      // daemon side writes `.mcp.json` only because it targets PROJECTS_DIR
      // (see daemon server.ts isManagedProjectCwd gating).
      mcpServers: this.externalMcpServers,
      // Repo-root skills/ wired in as a local plugin so its SKILL.md entries
      // become `/`-triggerable in this chat tab (namespaced
      // `claude-desktop:<skill>`). Spread-omit when null: the SDK type allows
      // `plugins?: SdkPluginConfig[]`, and passing `undefined` is the same as
      // not setting it, so a missing manifest degrades to "no extra plugin"
      // instead of a load error. Independent of the daemon, which reads the
      // SAME dir over /api/skills for the Settings → Skills panel.
      ...(skillsPluginDir
        ? { plugins: [{ type: 'local' as const, path: skillsPluginDir }] }
        : {}),
      ...(resume ? { resume: sessionId } : { sessionId })
    }

    // The cast on iterable() pins it to SDKUserMessage for the SDK type
    // signature. We don't import SDKUserMessage explicitly because the
    // shape we push (`{ type: 'user', message: { role, content } ... }`)
    // is intentionally minimal — adding typing here would force the
    // user-message construction in send() to drag in MessageParam.
    const handle = query({
      prompt: queue.iterable() as unknown as AsyncIterable<{
        type: 'user'
        message: { role: 'user'; content: string }
        parent_tool_use_id: string | null
        session_id: string
      }>,
      options: sdkOptions
    })
    runtime.handle = handle
    // Record whether THIS spawn baked the proposal append (see
    // `proposalActive` above). send() reads it to decide whether a warm
    // child spawned outside proposal mode needs the grounding injected into
    // the message for a proposal turn.
    runtime.spawnedWithProposal = proposalActive
    // 记录本次 spawn 烘焙进 systemPrompt 的产品集签名（非方案 spawn 为空串）。send()
    // 据它发现「用户随后改了产品 chip → 烘焙的清单已过时」并注入最新 grounding（发现 2）。
    runtime.proposalGroundedKey = proposalActive
      ? this.proposalProductsKey(runtime.proposalProducts)
      : ''

    // Launch the pump in the background. The pump owns the lifetime
    // of `runtime.handle` / `runtime.queue` — when it exits (cleanly
    // or via error), it nulls them out so the next openSession
    // re-opens.
    const pumpPromise = this.runPump(sessionId, runtime, handle)
    runtime.pumpPromise = pumpPromise
    // Defensive no-op rejection handler. If the pump rejects BEFORE
    // any caller awaits `pumpPromise` (the classic case: a fast
    // switchToSession races the cli's cold start and `runPump` blows
    // up with "cli exited before first init" while no one has yet
    // entered the try/catch inside `teardownRuntime`), Node would
    // raise an UnhandledPromiseRejectionWarning — noisy in dev and
    // fatal under `--unhandled-rejections=strict`. Attaching this
    // handler doesn't swallow the error for the real awaiter: the
    // original promise still rejects into `teardownRuntime`'s
    // `await rt.pumpPromise`, which logs it. We just stop Node from
    // thinking nobody has signed up for the error yet.
    pumpPromise.catch(() => {})
    this.logEvent('openSession:queued', { sessionId })
  }

  /**
   * Tear down a live runtime object in place: interrupt any in-flight
   * turn, close the queue so the pump's `for await` exits, await the
   * pump's `finally` cleanup.
   *
   * Split from teardownSession() because `switchToSession` wants to
   * teardown asynchronously WITHOUT holding the sessions map entry
   * open. The caller is responsible for having already detached
   * `rt` from `this.sessions` before calling us, so a racing
   * switchToSession(sessionId) can allocate a fresh empty runtime
   * under the same key without aliasing the runtime being torn down.
   *
   * Passing `sessionId` in is purely for log readability — we never
   * touch the map here.
   */
  private async teardownRuntime(
    sessionId: string,
    rt: SessionRuntime
  ): Promise<void> {
    console.log('[engine] tearing down runtime', { sessionId })
    try {
      const p = rt.handle?.interrupt()
      if (p && typeof (p as Promise<void>).catch === 'function') {
        void (p as Promise<void>).catch(() => {})
      }
    } catch {
      // interrupt is best-effort; the queue.close below is the
      // deterministic teardown path.
    }
    rt.queue?.close()
    if (rt.pumpPromise) {
      try {
        await rt.pumpPromise
      } catch {
        // pump errors are already logged in runPump itself
      }
    }
    rt.active = null
  }

  /**
   * Atomically move from the current active session (if any) to
   * `newId`. When `opts.resume` is true, the new fusion-code child is
   * told to reload `<newId>.jsonl` from disk — giving the model full
   * history of that prior conversation. When false, the child starts
   * fresh and the jsonl is created on the first user turn.
   *
   * Callers:
   *  - ipc `session:new`  + `session:switch { resume: false }` on the
   *    "+ New chat" button
   *  - ipc `session:switch { resume: true }` on a sidebar click
   *
   * Guarded by `this.switching` to block concurrent switches. The only
   * caller that can race is a very fast double-click on the sidebar,
   * which the adapter already disables via `isLoading`, but we
   * double-guard here so a buggy renderer can't wedge the engine.
   */
  async switchToSession(
    newId: string,
    opts: { resume: boolean }
  ): Promise<{ sessionId: string }> {
    if (this.workspaceDir === null) {
      throw new Error('Workspace not set. Drop a folder on the window first.')
    }
    if (this.switching) {
      throw new Error('Another session switch is already in progress.')
    }

    // Multi-runtime switch. The expensive work — spawning a fresh
    // fusion-code child and waiting for its `system init` — is deferred
    // to the first send() on the new session. Here we only:
    //
    //   1. For the previous foreground session, decide whether it's
    //      worth keeping its runtime alive in the background:
    //        - openedViaSend = true  → real agent task, leave running
    //          so the user can come back and find accumulated messages
    //        - openedViaSend = false → only warmed up speculatively;
    //          kill the warmup to reclaim the CLI process. This is the
    //          "flipping through old sessions" case, which would
    //          otherwise leak one idle cli per visited session.
    //   2. Allocate (or reuse) a runtime slot for the new session.
    //      Reused slots keep their handle/queue/pumpPromise intact,
    //      so switching back to a background-running session is
    //      instantaneous and lossless.
    //   3. Record the resume flag on the runtime itself so the lazy
    //      openSession in send() / warmup gets the right --resume
    //      semantics without a shared class field.
    //
    // The whole function runs in a single microtask (modulo the
    // `getSession` await which is actually synchronous), so the UI
    // sees the click complete instantly and can mount the thread's
    // history immediately. If the user never sends a message, we
    // never pay the cold start.
    this.logEvent('switchToSession:begin', {
      newId,
      prev: this.activeSessionId,
      resume: opts.resume
    })
    this.switching = true
    try {
      const prev = this.activeSessionId
      if (prev && prev !== newId) {
        const prevRt = this.sessions.get(prev)
        if (prevRt && !prevRt.openedViaSend && (prevRt.handle || prevRt.queue)) {
          // Warmup cancel: prev had a cli spawned but the user never
          // actually sent a message. Detach and teardown so we don't
          // leak idle processes when the user flips through old
          // sessions. Runtimes that have been send()'d stay put.
          this.sessions.delete(prev)
          this.logEvent('switchToSession:warmupCancel', { sessionId: prev })
          void this.teardownRuntime(prev, prevRt).catch((err) => {
            console.warn('[engine] warmup-cancel teardown failed:', err)
          })
        }
      }

      // Allocate (or reuse) a runtime slot for the new id. Existing
      // slots keep their pump and messages intact, so switching back
      // to a background-running session picks up where we left off.
      const rt = await this.getSession(newId)
      rt.pendingResume = opts.resume
      this.activeSessionId = newId
    } finally {
      this.switching = false
    }
    this.emit('sessionListChanged')
    this.logEvent('switchToSession:end', { newId })

    // Background warmup — fire-and-forget a cli spawn so the ~30s
    // first-run cold start runs in parallel with the user reading
    // the freshly-mounted thread and typing their first prompt.
    // Without this, the first `send()` on a brand-new chat pays the
    // full cold start synchronously (30+s of spinner). ensureSessionReady
    // is idempotent — if the user hits send while we're still warming
    // up, `send()` will await the same readyPromise and NOT spawn a
    // second cli. Errors here are purely advisory; the real error path
    // lives in `send()` where the user is actively waiting.
    //
    // Crucial ordering: warm the external-MCP cache BEFORE the spawn when
    // it's still empty. The warmup is what actually spawns fusion-code on a
    // fresh tab, so if we let it race ahead with an empty cache the CLI
    // comes up WITHOUT `--mcp-config` and the later `send()` finds the
    // process already ready (no re-spawn) — the user-configured servers
    // would never load. Bounded by fetch's own timeout so a down daemon
    // can't stall warmup. A non-empty cache skips the await entirely.
    void (async () => {
      if (Object.keys(this.externalMcpServers).length === 0) {
        await this.refreshExternalMcpServers({ waitForDaemon: true })
      }
      await this.ensureSessionReady(newId)
    })().catch((err) => {
      console.warn('[engine] background warmup failed:', err)
    })

    // We never rebind eagerly now. The rebind branch in
    // updateSessionMeta() is kept as defense-in-depth but cannot fire
    // under the current SDK defaults (`forkSession: false` → fusion-code
    // keeps the requested session id; see free-code's
    // sessionRestore.ts `if (!opts.forkSession)` branch).
    return { sessionId: newId }
  }

  /**
   * Idempotent cli spawn.
   *
   * Safe to call concurrently — only one actual `openSession` happens
   * per runtime lifetime. Callers:
   *
   *   - `send()` on the first send to a freshly-switched session
   *     ("on-demand" spawn, user is actively waiting)
   *   - `switchToSession()` fire-and-forget at the end ("background
   *     warmup" — kicks off the cli cold start in parallel with the
   *     user reading the UI + typing their prompt, so when they
   *     finally hit enter some of the cold start is already behind us)
   *
   * IMPORTANT: this does NOT wait for fusion-code to emit its first
   * `system init` message. That message is yielded from inside
   * `QueryEngine.submitMessage` (free-code/src/QueryEngine.ts:540),
   * which only runs after a user msg has been pushed into the stream.
   * Waiting on `readyPromise` here before send() has pushed would
   * always hit the `waitForSessionReady` timeout for no reason — the
   * earlier "wait for system init as a cli-ready handshake" design
   * was based on a wrong assumption about cli lifecycle.
   *
   * The SDK's `AsyncMessageQueue` is a buffered channel, so send() can
   * safely push userMsgs into `runtime.queue` while openSession is
   * still spinning up fusion-code in the background — the queued
   * msgs get consumed the moment the cli's stdin loop is alive.
   * Callers should re-check `runtime.queue` / `runtime.handle` after
   * this resolves (in case openSession threw, which `send()` turns
   * into a user-visible error event).
   */
  private async ensureSessionReady(sessionId: string): Promise<void> {
    const runtime = await this.getSession(sessionId)
    // Already spawned — either by a prior send(), or by the warmup
    // kicked off in switchToSession(). openSession assigns queue and
    // handle synchronously, so "both present" is a reliable signal
    // that a pump is running in the background. If the pump has
    // since exited (crash, cli killed), its finally clears both
    // together and we fall through to a fresh spawn below.
    if (runtime.handle && runtime.queue) {
      this.logEvent('ensureSessionReady:alreadySpawned')
      return
    }
    const resume = runtime.pendingResume
    runtime.pendingResume = false
    this.logEvent('ensureSessionReady:spawn', { resume, sessionId })
    this.openSession(sessionId, runtime, { resume })
    // openSession returns synchronously once query() has been called
    // and the pump has been scheduled. No await — the pump runs in
    // the background, processes the SDK stream, and will consume any
    // userMsgs that send() pushes into runtime.queue afterward.
  }

  /** The currently live session UUID, or null before one has been opened. */
  getActiveSessionId(): string | null {
    return this.activeSessionId
  }

  /** Current UI permission mode. */
  getPermissionMode(): UiPermissionMode {
    return this.uiPermissionMode
  }

  /**
   * Internal: update the field + emit the `permissionModeChanged`
   * event. Does NOT forward to any live SDK runtime. Used for cases
   * where the SDK transitions its own internal mode (e.g. ExitPlanMode
   * approval) and we just need to mirror the change on the engine
   * side so the picker stays honest.
   *
   * Idempotent: returns false without emitting when the mode is
   * already the requested value.
   */
  private applyPermissionMode(mode: UiPermissionMode): boolean {
    if (this.uiPermissionMode === mode) return false
    this.uiPermissionMode = mode
    this.emit('permissionModeChanged', mode)
    this.logEvent('permissionMode:apply', { mode })
    return true
  }

  /**
   * Update the UI permission mode. Stores the new value on the engine
   * so the next `openSession()` picks it up, AND forwards it to every
   * live runtime via `query.setPermissionMode()` so in-flight sessions
   * switch immediately instead of waiting for a restart.
   *
   * The SDK's `setPermissionMode` is async but we deliberately don't
   * await each one in parallel — the forwarding is best-effort. If a
   * runtime's handle has already torn down (pump exited, cli crashed)
   * the call throws; we swallow it and move on so a single dead
   * session can't block the rest.
   *
   * Renderer-initiated — the renderer already knows the new value, so
   * we do NOT re-broadcast a `permissionModeChanged` event here. The
   * event is reserved for main-initiated changes (ExitPlanMode).
   */
  async setPermissionMode(mode: UiPermissionMode): Promise<void> {
    if (this.uiPermissionMode === mode) return
    this.uiPermissionMode = mode
    const sdkMode = mode as PermissionMode
    const failures: string[] = []
    for (const [sessionId, rt] of this.sessions) {
      const handle = rt.handle
      if (!handle) continue
      try {
        await handle.setPermissionMode(sdkMode)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`${sessionId}: ${msg}`)
      }
    }
    if (failures.length > 0) {
      console.warn('[engine] setPermissionMode forwarding failed', failures)
    }
    this.logEvent('permissionMode:set', { mode })
  }

  /**
   * True when a tool call is a READ-only access (Read/Grep/Glob) whose target
   * path resolves inside the knowledge-base text mirror (`kbOutDir()`).
   *
   * Used by handleCanUseTool to silently allow proposal-mode KB reads without
   * a dialog, closing the warm-spawn permission gap (the live child may not
   * have baked `additionalDirectories`). Deliberately read-only — the mirror
   * is reference material, never written through this path.
   *
   * Containment uses resolved absolute paths with a separator boundary so a
   * sibling like `<userData>/kb-index-evil` can't masquerade as the mirror.
   * Relative / missing paths return false (they'd be cwd-relative, not the
   * mirror) and fall through to the normal broker.
   */
  private isKbMirrorRead(toolName: string, input: Record<string, unknown>): boolean {
    let raw: unknown
    if (toolName === 'Read') raw = input.file_path
    else if (toolName === 'Grep' || toolName === 'Glob') raw = input.path
    else return false
    if (typeof raw !== 'string' || !raw || !isAbsolute(raw)) return false
    const target = resolve(raw)
    const root = resolve(kbOutDir())
    return target === root || target.startsWith(root + sep)
  }

  /**
   * SDK `canUseTool` callback. Called by the Agent SDK for every tool
   * invocation the CLI would otherwise need to prompt on.
   *
   * Flow
   * ----
   *   1. Derive a user-facing scope (displayName, summary, scopeLabel,
   *      rules) from the tool name + raw input via `deriveScope`.
   *   2. Hand the request to `permissionBroker.request`, which mints a
   *      requestId, emits a `request` event (picked up by register.ts
   *      and forwarded to the renderer via IPC), and returns a promise
   *      that resolves once the renderer replies with a
   *      `PermissionResponse`.
   *   3. Translate the user's decision into an SDK `PermissionResult`.
   *      - `allow-once`    → `{ behavior: 'allow' }` (no rule added)
   *      - `allow-session` → `{ behavior: 'allow', updatedPermissions: [
   *                           addRules → destination: 'session' ] }`
   *        The SDK's in-process rule engine will then auto-approve any
   *        future tool call that matches a rule in this list, without
   *        calling us again.
   *      - `deny`          → `{ behavior: 'deny', message, interrupt: false }`
   *        `interrupt: false` lets the assistant keep going after a
   *        rejected tool — matching the free-code CLI experience.
   *   4. If the broker throws (user hit stop, window closed, signal
   *      aborted), fall back to `deny` so the SDK unblocks cleanly
   *      instead of hanging forever.
   *
   * NB: `options.toolUseID` is typed as `string | undefined` in the SDK
   * d.ts in case the CLI ever omits it; we default to '' so the
   * downstream payload shape stays stable.
   */
  private async handleCanUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    ctx: {
      signal: AbortSignal
      toolUseID: string
      title?: string
      displayName?: string
      description?: string
    }
  ): Promise<PermissionResult> {
    const scope = deriveScope(toolName, input)
    const toolUseId = ctx.toolUseID ?? ''

    // 方案模式：对知识库镜像目录（userData/kb-index）内的「读类」工具静默放行，
    // 不进 broker / 不弹窗。
    //
    // 为什么需要它：可读范围本应由 spawn 时的 additionalDirectories 烘焙，但那是
    // spawn 冻结的——warmup 在用户选产品前就 spawn 了子进程（spawnedWithProposal=
    // false），那个活进程没烘焙镜像目录。send() 的 warm-spawn grounding 只把镜像
    // 绝对路径注入进消息（告知去哪检索），却补不上可读范围；若不在这里放行，AI 对
    // 镜像目录的 Read/Grep/Glob（cwd 之外）就会触发权限弹窗，用户取消即读不到知识库
    // → 退回「资料缺失」或臆想，正是本功能要避免的。在此放行让「是否在 spawn 烘焙了
    // additionalDirectories」不再影响读取结果：cold-spawn（已烘焙）下 CLI 自行放行、
    // 本回调对镜像读根本不触发；warm-spawn（没烘焙）下由本回调兜底。两条路径一致。
    //
    // 严格限定：仅 proposalMode 的 runtime、仅读类工具（Read/Grep/Glob，绝不含
    // Write/Edit——镜像是只读参考料）、仅路径确实落在 kbOutDir() 之内。其余一律照常
    // 走 broker。绝不放宽到 cwd 之外的任意目录（cwd 可读范围不变量）。
    if (this.sessions.get(sessionId)?.proposalMode && this.isKbMirrorRead(toolName, input)) {
      console.log('[engine] canUseTool → auto-allow (proposal KB read)', { sessionId, toolName })
      return { behavior: 'allow', updatedInput: input, decisionClassification: 'user_temporary' }
    }

    console.log('[engine] canUseTool', {
      sessionId,
      toolName,
      toolUseId,
      hasScope: !!scope.scopeLabel
    })

    try {
      const outcome = await this.permissionBroker.request(
        {
          sessionId,
          toolUseId,
          toolName,
          // Prefer the SDK-provided friendly label when it gives us one
          // (e.g. "Read file"), otherwise fall back to our own mapping.
          displayName: ctx.displayName ?? scope.displayName,
          summary: scope.summary,
          scopeLabel: scope.scopeLabel,
          input
        },
        ctx.signal
      )

      if (outcome.decision === 'deny') {
        return {
          behavior: 'deny',
          message: 'User declined this tool call.',
          interrupt: false,
          decisionClassification: 'user_reject'
        }
      }

      // ExitPlanMode auto-transition. When the assistant calls
      // ExitPlanMode and the user approves, the SDK/CLI internally
      // flips its own permissionMode out of `plan` (implementation
      // detail of the upstream fusion-code CLI — see cli.js `ExitPlanMode`
      // handler). We mirror that on our side so the renderer's picker
      // and its localStorage catch up without the user re-clicking.
      //
      // We don't `setPermissionMode('default')` here, only
      // `applyPermissionMode('default')` — the SDK is already doing the
      // real work; calling the forwarding variant would send a
      // redundant control request back into the CLI, and worse, race
      // with its own transition. `applyPermissionMode` just updates
      // the engine field + emits `permissionModeChanged` so the
      // renderer picks it up via the PERMISSION_MODE_CHANGED IPC.
      //
      // Target mode is hardcoded to `default` to match the CLI's
      // post-plan behaviour. If we ever want to expose "after plan go
      // to X" as a setting, the X lives in a user preference and is
      // read here.
      if (toolName === 'ExitPlanMode' && this.uiPermissionMode === 'plan') {
        this.applyPermissionMode('default')
      }

      // `updatedInput` is typed as optional in @anthropic-ai/claude-agent-sdk's
      // sdk.d.ts (`updatedInput?: Record<string, unknown>`), but the runtime
      // Zod schema fusion-code's CLI uses for the stream-json protocol
      // validates it as **required** on the allow branch. If we omit it we
      // get a Zod invalid_union error that fusion-code folds back into
      // `tool_result.is_error = true`, which the assistant reads as "the
      // permission check failed" and keeps retrying with different args.
      //
      // For most tools we pass the original `input` unchanged. The
      // exception is AskUserQuestion, where the PermissionDialog
      // collects the user's answers into `updatedInput.answers` and
      // sends it back through broker.respond(). We merge the two so
      // fields the dialog didn't touch survive intact.
      const effectiveInput = this.mergeUpdatedInput(input, outcome.updatedInput)

      if (outcome.decision === 'allow-session' && scope.rules.length > 0) {
        return {
          behavior: 'allow',
          updatedInput: effectiveInput,
          updatedPermissions: [
            {
              type: 'addRules',
              rules: scope.rules,
              behavior: 'allow',
              destination: 'session'
            }
          ],
          decisionClassification: 'user_permanent'
        }
      }

      return {
        behavior: 'allow',
        updatedInput: effectiveInput,
        decisionClassification: 'user_temporary'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Permission request failed.'
      console.warn('[engine] canUseTool → deny (broker error):', msg)
      return {
        behavior: 'deny',
        message: msg,
        interrupt: false
      }
    }
  }

  /**
   * Background consumer of the SDK stream. Iterates a single long-lived
   * `Query` and fans messages out to the renderer via `handleSdkMessage`.
   *
   * Turn boundary detection
   * -----------------------
   * Each user turn is followed by exactly one `result` SDK message
   * (subtype 'success' | 'error_*'). When we see one, we emit `end`
   * for the active turn and clear `runtime.active`. Future SDK
   * messages without an active turn (e.g. the very first `system init`
   * before any user input, or stragglers after we cleared) are dropped.
   *
   * Error / shutdown
   * ----------------
   * If the SDK throws or the child process dies, we emit a final
   * error event for the active turn (if any) and reset the session
   * state in `finally`. The next `send()` will then call
   * `openSession()` again and pay another cold start.
   */
  private async runPump(
    initialSessionId: string,
    runtime: SessionRuntime,
    handle: Query
  ): Promise<void> {
    // `sessionId` is mutable so we can track fusion-code's silent
    // session-id rebind (cli's `--resume X` actually forks to a new
    // id Y). `updateSessionMeta` updates `this.activeSessionId` on
    // rebind; we pick it up here and keep using the new id for every
    // downstream `emitEvent` / `handleSdkMessage` call so the renderer
    // (which receives the new id via `switchToSession`'s return value)
    // subscribes to the same key we're emitting on.
    let sessionId = initialSessionId
    console.log('[engine] pump started', { sessionId })
    try {
      // Iterate as AsyncIterable<unknown> so downstream duck-typing
      // (handleSdkMessage) doesn't trip over the SDKMessage
      // discriminated-union narrowing — several variants (e.g.
      // SDKAssistantMessage) lack the `subtype` field we read.
      for await (const sdkMessage of handle as AsyncIterable<unknown>) {
        // Always cache SessionMeta from system init, regardless of
        // whether there's an active turn. This message arrives once
        // per session lifetime, on the first SDK warmup, and carries
        // skills/mcp_servers/slash_commands the renderer dialogs need.
        if (
          this.isRecord(sdkMessage) &&
          sdkMessage.type === 'system' &&
          sdkMessage.subtype === 'init'
        ) {
          // The single most important timestamp in the whole pipeline:
          // this is when fusion-code has finished its cold start
          // (node spawn + module eval + plugin init + MCP connect)
          // and is ready to accept user turns. The delta from the
          // preceding `openSession:queued` event measures the real
          // cli cold start cost.
          this.logEvent('systemInit:received', {
            skillCount: Array.isArray(sdkMessage.skills)
              ? sdkMessage.skills.length
              : 0,
            mcpServerCount: Array.isArray(sdkMessage.mcp_servers)
              ? sdkMessage.mcp_servers.length
              : 0,
            slashCommandCount: Array.isArray(sdkMessage.slash_commands)
              ? sdkMessage.slash_commands.length
              : 0
          })
          this.updateSessionMeta(sdkMessage, sessionId)
          // updateSessionMeta may have moved our Map entry to a new
          // key. Pick up the new id by reverse-lookup against the
          // runtime object so subsequent emits target the right key.
          // (activeSessionId is the foreground pointer — unreliable
          // in multi-runtime mode.)
          for (const [id, rt] of this.sessions) {
            if (rt === runtime && id !== sessionId) {
              console.log('[engine] pump sessionId rebound', {
                from: sessionId,
                to: id
              })
              sessionId = id
              break
            }
          }
          // Resolve the ready promise so `switchToSession` unblocks:
          // the cli is now fully initialized and will accept turns.
          runtime.readyResolve?.()
        }

        const active = runtime.active
        const msgType =
          this.isRecord(sdkMessage) && typeof sdkMessage.type === 'string'
            ? sdkMessage.type
            : 'unknown'
        const subtype =
          this.isRecord(sdkMessage) && typeof sdkMessage.subtype === 'string'
            ? sdkMessage.subtype
            : ''

        if (!active) {
          // Stragglers between turns — log the full message anyway so
          // we can see what the SDK emitted, then drop.
          console.log(
            `[engine] pump: no active turn, dropping ${msgType}${subtype ? ' ' + subtype : ''}`,
            inspect(sdkMessage, SDK_INSPECT_OPTS)
          )
          continue
        }

        active.sdkMessageCount++
        console.log(
          `[engine] sdkMsg #${active.sdkMessageCount} ${msgType}${subtype ? ' ' + subtype : ''}`,
          inspect(sdkMessage, SDK_INSPECT_OPTS)
        )

        this.handleSdkMessage(sessionId, active, sdkMessage)

        // Authoritative turn boundary: a `result` message is the
        // SDK's per-turn closing record. Emit `end` and let the next
        // user turn install a fresh ActiveTurn.
        if (this.isRecord(sdkMessage) && sdkMessage.type === 'result') {
          console.log('[engine] turn ended', {
            messageId: active.messageId,
            sdkMessageCount: active.sdkMessageCount,
            sawTextContent: active.sawTextContent
          })
          if (!active.sawTextContent) {
            console.warn(
              '[engine] turn produced zero text content — UI will show empty assistant bubble'
            )
          }
          // Pull API-side accounting off the SDK result message so the
          // LogsDialog can show cache hit/miss + true API latency
          // alongside our own perceived-latency breadcrumbs. These
          // fields come straight from the wire protocol; the generated
          // SDK type is a narrowed subset that doesn't list them, so we
          // reach through `isRecord` to read them without an `any` cast.
          const rawResult = sdkMessage as Record<string, unknown>
          const usage = this.isRecord(rawResult.usage) ? rawResult.usage : {}
          this.logEvent('turn:end', {
            messageId: active.messageId,
            sdkMessageCount: active.sdkMessageCount,
            sawTextContent: active.sawTextContent,
            inputTokens: usage.input_tokens as number | undefined,
            outputTokens: usage.output_tokens as number | undefined,
            cacheCreate: usage.cache_creation_input_tokens as number | undefined,
            cacheRead: usage.cache_read_input_tokens as number | undefined,
            durationMs: rawResult.duration_ms as number | undefined,
            durationApiMs: rawResult.duration_api_ms as number | undefined
          })
          // Surface the per-turn context size to the renderer so the
          // sidebar can show a "xk / 200k" badge per session. We sum
          // the three input buckets because the wire protocol splits
          // one logical "prompt size" across input_tokens (fresh),
          // cache_read_input_tokens (hit), and cache_creation_input_tokens
          // (write) — only the sum matches what gets charged against
          // the model's context window.
          const inputTokens = (usage.input_tokens as number | undefined) ?? 0
          const cacheRead =
            (usage.cache_read_input_tokens as number | undefined) ?? 0
          const cacheCreate =
            (usage.cache_creation_input_tokens as number | undefined) ?? 0
          const outputTokens = (usage.output_tokens as number | undefined) ?? 0
          const contextTokens = inputTokens + cacheRead + cacheCreate
          if (contextTokens > 0 || outputTokens > 0) {
            this.emitEvent(sessionId, {
              type: 'usage',
              messageId: active.messageId,
              contextTokens,
              outputTokens
            })
          }
          this.emitEvent(sessionId, {
            type: 'end',
            messageId: active.messageId
          })
          runtime.active = null
        }
      }
      console.log('[engine] pump exited gracefully', { sessionId })
    } catch (error) {
      console.error('[engine] pump threw:', error)
      if (error instanceof Error && error.stack) {
        console.error('[engine] stack:\n' + error.stack)
      }
      const active = runtime.active
      if (active) {
        const message = error instanceof Error ? error.message : String(error)
        this.emitEvent(sessionId, {
          type: 'error',
          messageId: active.messageId,
          error: message
        })
        this.emitEvent(sessionId, {
          type: 'end',
          messageId: active.messageId
        })
        runtime.active = null
      }
    } finally {
      // Pump exit means the SDK child process is gone — either it
      // ended cleanly (queue closed) or it crashed. Either way, reset
      // session state so the next send() opens a fresh session.
      if (runtime.queue) {
        runtime.queue.close()
        runtime.queue = null
      }
      runtime.handle = null
      runtime.pumpPromise = null
      // If the pump exited before we ever saw `system init`, the cli
      // never became ready. Reject any awaiters (switchToSession) so
      // the UI stops its loading spinner instead of hanging forever.
      if (runtime.readyReject && !runtime.readySettled) {
        runtime.readyReject(new Error('cli exited before first init'))
      }
      runtime.readyPromise = null
      runtime.readyResolve = null
      runtime.readyReject = null
      console.log('[engine] session reset after pump exit', { sessionId })
    }
  }

  private handleSdkMessage(
    sessionId: string,
    active: ActiveTurn,
    sdkMessage: unknown
  ): void {
    if (!this.isRecord(sdkMessage) || typeof sdkMessage.type !== 'string') return

    switch (sdkMessage.type) {
      case 'stream_event':
        this.handleStreamEvent(sessionId, active, sdkMessage.event)
        break
      case 'assistant':
        this.handleAssistantMessage(sessionId, active, sdkMessage)
        break
      case 'user':
        this.handleUserMessage(sessionId, active, sdkMessage)
        break
      case 'assistant_error':
        this.emitEvent(sessionId, {
          type: 'error',
          messageId: active.messageId,
          error:
            typeof sdkMessage.message === 'string'
              ? sdkMessage.message
              : 'Assistant returned an error.'
        })
        break
      case 'result':
        this.handleResultMessage(sessionId, active, sdkMessage)
        break
      default:
        break
    }
  }

  /**
   * Fan the SDK's raw `stream_event` messages into the narrower
   * `ChatEvent` shape the renderer consumes. The SDK passes through
   * Anthropic's content_block_start / content_block_delta /
   * content_block_stop events unchanged. We handle three of them:
   *
   *   - content_block_start with content_block.type === 'tool_use' or
   *     'server_tool_use' → emit `tool_use_start` so the renderer
   *     creates an empty tool-call card. Record the toolUseId so we
   *     can route subsequent deltas and suppress the finalize event.
   *   - content_block_delta with delta.type === 'text_delta' → emit
   *     `chunk` (unchanged from before — text streaming already worked).
   *   - content_block_delta with delta.type === 'input_json_delta' →
   *     look up the toolUseId for this block index and emit
   *     `tool_use_delta` with the partial_json fragment. The renderer
   *     appends it to the argsText buffer for that tool-call card.
   *   - content_block_stop → if this index is a streamed tool_use,
   *     emit `tool_use_end` and drop the index from the lookup.
   *
   * We intentionally do NOT try to parse partial_json here — it's
   * almost always a half-open JSON string that any strict parser would
   * reject. The renderer stores argsText raw and re-parses on
   * tool_use_end; components that care about partial state (e.g. the
   * TodoWrite → right rail sync) run a lenient parse on their side.
   */
  private handleStreamEvent(
    sessionId: string,
    active: ActiveTurn,
    event: unknown
  ): void {
    if (!this.isRecord(event) || typeof event.type !== 'string') return

    switch (event.type) {
      case 'content_block_start':
        this.handleContentBlockStart(sessionId, active, event)
        return
      case 'content_block_delta':
        this.handleContentBlockDelta(sessionId, active, event)
        return
      case 'content_block_stop':
        this.handleContentBlockStop(sessionId, active, event)
        return
      default:
        return
    }
  }

  private handleContentBlockStart(
    sessionId: string,
    active: ActiveTurn,
    event: Record<string, unknown>
  ): void {
    const index = typeof event.index === 'number' ? event.index : null
    const block = this.isRecord(event.content_block) ? event.content_block : null
    if (index === null || !block) return
    if (typeof block.type !== 'string') return

    // Diagnostic breadcrumb — one line per opened block so we can see
    // in the engine log whether thinking blocks are being routed
    // through the new branch below. Tagged `[engine]` to match the
    // existing pump logging.
    console.log('[engine] content_block_start', {
      sessionId,
      index,
      blockType: block.type
    })

    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return
      active.toolUseIdByBlockIndex.set(index, block.id)
      active.toolNameByUseId.set(block.id, block.name)
      active.streamedToolUseIds.add(block.id)
      this.emitEvent(sessionId, {
        type: 'tool_use_start',
        messageId: active.messageId,
        toolUseId: block.id,
        toolName: block.name
      })
      return
    }

    if (block.type === 'thinking') {
      // Extended-thinking block opened. Text arrives via
      // `content_block_delta` with `delta.type === 'thinking_delta'`,
      // so we remember this index routes to the reasoning slot and
      // emit `thinking_start` for the renderer to spin up the card.
      //
      // We emit on EVERY thinking block — not once per turn. A single
      // user turn can span multiple assistant messages interleaved
      // with tool calls, and each post-tool assistant message may
      // open its own thinking block. Suppressing later starts left
      // the renderer with no signal to open a new reasoning card,
      // so the second round of "thinking" silently disappeared into
      // the chat store without any visible "正在思考…" label.
      //
      // `startReasoning` in the chat store is idempotent: if the
      // current message's trailing part is already a reasoning part
      // (streaming first block in the same message) it no-ops; if
      // the trailing part is a tool-call (tool run between two
      // thinking blocks) it pushes a fresh empty reasoning part.
      // Both branches are what we want here.
      active.thinkingBlockIndices.add(index)
      this.emitEvent(sessionId, {
        type: 'thinking_start',
        messageId: active.messageId
      })
      return
    }
    // text blocks don't need a start event — renderer still lazily
    // creates the assistant message on first `chunk` delta.
  }

  private handleContentBlockDelta(
    sessionId: string,
    active: ActiveTurn,
    event: Record<string, unknown>
  ): void {
    if (!this.isRecord(event.delta)) return
    const delta = event.delta
    const index = typeof event.index === 'number' ? event.index : null

    if (delta.type === 'text_delta') {
      if (typeof delta.text !== 'string' || delta.text.length === 0) return
      // First text delta of the turn — emit a log breadcrumb so the
      // dialog can show "time to first token" (the interval between
      // `send:queued` and here). We check `sawTextDelta` before
      // flipping it so repeated deltas don't spam.
      if (!active.sawTextDelta) {
        this.logEvent('turn:firstChunk', {
          messageId: active.messageId,
          chars: delta.text.length
        })
      }
      active.sawTextDelta = true
      active.sawTextContent = true
      this.emitEvent(sessionId, {
        type: 'chunk',
        messageId: active.messageId,
        delta: delta.text
      })
      return
    }

    if (delta.type === 'input_json_delta') {
      if (typeof delta.partial_json !== 'string' || delta.partial_json.length === 0) {
        return
      }
      if (index === null) return
      const toolUseId = active.toolUseIdByBlockIndex.get(index)
      // If we never saw a matching content_block_start, swallow the
      // delta silently — emitting without an id would strand the
      // fragment on the renderer side with nothing to attach to.
      if (!toolUseId) return
      this.emitEvent(sessionId, {
        type: 'tool_use_delta',
        messageId: active.messageId,
        toolUseId,
        partialJson: delta.partial_json
      })
      return
    }

    if (delta.type === 'thinking_delta') {
      // Extended-thinking text fragment. The SDK gives us
      // `delta.thinking: string` (matches the Anthropic API
      // ThinkingDelta shape exactly).
      if (typeof delta.thinking !== 'string' || delta.thinking.length === 0) return
      console.log('[engine] thinking_delta', {
        sessionId,
        index,
        chars: delta.thinking.length,
        knownIndex: index !== null && active.thinkingBlockIndices.has(index)
      })
      // Index check is best-effort — if for some reason we didn't
      // see the matching content_block_start (out-of-order delivery,
      // a future SDK that emits deltas without a start), still
      // forward the delta so the user sees the thinking text. The
      // renderer accumulates by messageId, not by index, so it's
      // safe to drop the gating.
      this.emitEvent(sessionId, {
        type: 'thinking_delta',
        messageId: active.messageId,
        delta: delta.thinking
      })
      return
    }

    // signature_delta carries the cryptographic signature attached to
    // the thinking block. The renderer doesn't display it, so we
    // intentionally drop it on the floor here. The signature still
    // round-trips to the SDK's transcript via the `assistant`
    // message that arrives at end-of-turn.
  }

  private handleContentBlockStop(
    sessionId: string,
    active: ActiveTurn,
    event: Record<string, unknown>
  ): void {
    const index = typeof event.index === 'number' ? event.index : null
    if (index === null) return

    // Thinking block close: drop the index from the active set. We
    // do NOT emit a `thinking_end` per close — the renderer treats
    // every thinking block in a turn as a single rolling card, and
    // the final close (along with the streaming spinner) happens at
    // turn end. Multiple thinking blocks from the same turn append
    // into the same reasoning part separated by blank lines.
    if (active.thinkingBlockIndices.has(index)) {
      active.thinkingBlockIndices.delete(index)
      return
    }

    const toolUseId = active.toolUseIdByBlockIndex.get(index)
    if (!toolUseId) return
    active.toolUseIdByBlockIndex.delete(index)
    this.emitEvent(sessionId, {
      type: 'tool_use_end',
      messageId: active.messageId,
      toolUseId
    })
  }

  private handleAssistantMessage(
    sessionId: string,
    active: ActiveTurn,
    sdkMessage: Record<string, unknown>
  ): void {
    const content = this.getContentBlocks(sdkMessage)
    for (const block of content) {
      if (!this.isRecord(block) || typeof block.type !== 'string') continue

      if (
        (block.type === 'tool_use' || block.type === 'server_tool_use') &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        active.toolNameByUseId.set(block.id, block.name)
        // Two paths:
        //
        //   a) We already streamed this block via content_block_start +
        //      input_json_delta + content_block_stop. `tool_use_start`
        //      created the card, deltas filled argsText, `tool_use_end`
        //      closed the stream. The renderer already has everything
        //      it needs, so we DO NOT re-emit a full `tool_use` event —
        //      that would blow away the argsText with the parsed input
        //      and cause a visible flicker. (Same pattern as the
        //      sawTextDelta guard for text blocks below.)
        //
        //   b) The SDK skipped the fine-grained stream path and gave us
        //      the block only as part of the finalized `assistant`
        //      message. Emit a single `tool_use` with the full input so
        //      the renderer can render the card in one shot.
        if (active.streamedToolUseIds.has(block.id)) {
          continue
        }
        this.emitEvent(sessionId, {
          type: 'tool_use',
          messageId: active.messageId,
          toolUseId: block.id,
          toolName: block.name,
          input: this.normalizeToolInput(block.input)
        })
        continue
      }

      if (
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.length > 0 &&
        !active.sawTextDelta
      ) {
        active.sawTextContent = true
        this.emitEvent(sessionId, {
          type: 'chunk',
          messageId: active.messageId,
          delta: block.text
        })
      }
    }
  }

  private handleUserMessage(
    sessionId: string,
    active: ActiveTurn,
    sdkMessage: Record<string, unknown>
  ): void {
    const content = this.getContentBlocks(sdkMessage)
    for (const block of content) {
      if (!this.isRecord(block) || block.type !== 'tool_result') continue

      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const toolName = active.toolNameByUseId.get(toolUseId) ?? 'UnknownTool'
      this.emitEvent(sessionId, {
        type: 'tool_result',
        messageId: active.messageId,
        toolUseId,
        toolName,
        output: block.content
      })
    }
  }

  private handleResultMessage(
    sessionId: string,
    active: ActiveTurn,
    sdkMessage: Record<string, unknown>
  ): void {
    const isSuccess = sdkMessage.subtype === 'success' && sdkMessage.is_error !== true

    if (!isSuccess) {
      this.emitEvent(sessionId, {
        type: 'error',
        messageId: active.messageId,
        error: this.getResultErrorText(sdkMessage)
      })
      return
    }

    if (!active.sawTextContent && typeof sdkMessage.result === 'string' && sdkMessage.result) {
      active.sawTextContent = true
      this.emitEvent(sessionId, {
        type: 'chunk',
        messageId: active.messageId,
        delta: sdkMessage.result
      })
    }
  }

  private async getSession(sessionId: string): Promise<SessionRuntime> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const runtime: SessionRuntime = {
      messages: [],
      active: null,
      queue: null,
      handle: null,
      pumpPromise: null,
      readyPromise: null,
      readyResolve: null,
      readyReject: null,
      readySettled: false,
      pendingResume: false,
      openedViaSend: false,
      spawnedWithProposal: false,
      proposalMode: false,
      proposalProducts: [],
      proposalGroundedKey: ''
    }
    this.sessions.set(sessionId, runtime)
    return runtime
  }

  /**
   * Locate the CLI binary the Agent SDK should spawn. Dispatches on
   * the user's cliBackend setting:
   *
   *   - `bundled` (default): locates the shipped fusion-code CLI
   *     (`FUSION_CODE_CLI_PATH` env override → resourcesPath →
   *     dev-layout siblings).
   *
   *   - `system`: uses whatever path `cliDetect` resolved on startup
   *     (cached in `cachedSystemClaudePath`, refreshed via the
   *     CLI_BACKEND_GET IPC). If the user flipped to system mode but
   *     no binary is installed, we fall back to the bundled path
   *     instead of throwing — the settings UI already greys out the
   *     system radio when detection fails, so hitting this branch
   *     means the user's install disappeared between toggling and the
   *     next session spawn, and falling back silently is strictly
   *     better than bricking the chat.
   */
  private resolveCliPath(backend: CliBackend): string {
    if (backend === 'system') {
      const systemPath = this.cachedSystemClaudePath
      if (systemPath && existsSync(systemPath)) return systemPath
      // `cachedSystemClaudePath` is only populated by the engine-backed
      // CLI_BACKEND_GET IPC. The settings OVERLAY toggles backend via the
      // engine-free SETTINGS_CLI_BACKEND_GET/SET path, which never touches
      // this engine instance — so after flipping to "system" from the
      // overlay, the cache is still null here and we'd wrongly fall back to
      // bundled fusion-code (→ csdn / gpt-5.4). Recover with a synchronous,
      // PATH-independent scan of common install locations before giving up.
      const syncPath = detectSystemClaudeSync()
      if (syncPath && existsSync(syncPath)) {
        this.cachedSystemClaudePath = syncPath
        return syncPath
      }
      console.warn(
        '[engine] cliBackend=system but no system claude detected; falling back to bundled fusion-code'
      )
    }
    return this.resolveFusionCliPath()
  }

  /**
   * Last-known absolute path of the user's system `claude` binary,
   * refreshed every time the renderer polls CLI_BACKEND_GET. Kept on
   * the engine instance (not a module-level singleton) because the
   * engine already owns the lifecycle other main-side state depends
   * on, and the IPC handler already has an engine reference.
   */
  public cachedSystemClaudePath: string | null = null

  /**
   * Resolve the bundled fusion-code CLI path (same logic the engine
   * uses internally on spawn). Exposed so the IPC layer can show the
   * current binary location in the settings UI without duplicating
   * the resolution order. Throws with the full candidate list if no
   * bundled binary is found.
   */
  getBundledCliPath(): string {
    return this.resolveFusionCliPath()
  }

  /**
   * Refresh `cachedSystemClaudePath` from `cliDetect`. Called by the
   * CLI_BACKEND_GET IPC before each reply, so the renderer's settings
   * page always sees fresh info without the engine doing a subprocess
   * spawn on every query (cliDetect caches for 30s internally).
   */
  async refreshSystemClaudeDetection(): Promise<{
    path: string | null
    version: string | null
  }> {
    const info = await detectSystemClaude()
    this.cachedSystemClaudePath = info?.path ?? null
    return { path: info?.path ?? null, version: info?.version ?? null }
  }

  /**
   * Locate the bundled fusion-code ./cli binary. Resolution order:
   *
   *   1. `FUSION_CODE_CLI_PATH` env var — highest precedence; set it
   *      in env.json or the shell to pin an explicit path
   *   2. `<resourcesPath>/fusion-code-cli[.exe]` — packaged Electron
   *      app, the CLI is shipped via electron-builder extraResources
   *   3. `<cwd>/../free-code/cli` — pre-monorepo `bun run dev` layout
   *      (cwd == claude-desktop/), kept for backward compat
   *   4. `<cwd>/../../../free-code/cli` — bun monorepo `bun run dev`
   *      layout: cwd == claude-desktop/apps/desktop/, so three levels
   *      up lands at claude_code_01/, where free-code/ is a sibling of
   *      claude-desktop/
   *   5. `<importer>/../../../free-code/cli` — bundled main at
   *      `out/main/index.js`, three levels up lands at claude_code_01/
   *   6. `<importer>/../../../../free-code/cli` — extra fallback for
   *      dev when the importer is the source file not the bundle
   *   7. `<importer>/../../../../../free-code/cli` — monorepo variant of
   *      (6): bundle now lives at apps/desktop/out/main/, one level deeper
   *
   * Throws with every candidate listed, so a misconfigured install is
   * easy to diagnose from the console error shown in the UI.
   */
  private resolveFusionCliPath(): string {
    // Delegates to the engine-free resolver in cliDetect so the same logic
    // serves both this per-engine path and the settings-overlay handler.
    return resolveBundledCliPath()
  }

  private getContentBlocks(sdkMessage: Record<string, unknown>): unknown[] {
    if (!this.isRecord(sdkMessage.message)) return []
    const { content } = sdkMessage.message
    return Array.isArray(content) ? content : []
  }

  private normalizeToolInput(input: unknown): unknown {
    if (typeof input !== 'string') return input
    try {
      return JSON.parse(input)
    } catch {
      return input
    }
  }

  /**
   * Merge a PermissionDialog-supplied `updatedInput` rewrite over the
   * original tool input, preserving fields the dialog didn't touch.
   *
   * Used by the AskUserQuestion branch: the dialog only knows how to
   * fill in `answers` / `annotations`, so we need to keep the original
   * `questions` array intact — otherwise the SDK would re-validate an
   * input with no questions and reject the tool call.
   *
   * If the original isn't an object (unlikely for tools routed through
   * canUseTool, which always produces a Record), or if the rewrite
   * isn't an object (e.g. the dialog chose not to rewrite), we fall
   * back to the rewrite-or-original rule rather than trying to merge.
   */
  private mergeUpdatedInput(
    original: Record<string, unknown>,
    rewrite: unknown
  ): Record<string, unknown> {
    if (!this.isRecord(rewrite)) return original
    return { ...original, ...rewrite }
  }

  private getResultErrorText(sdkMessage: Record<string, unknown>): string {
    const { errors, result, message } = sdkMessage
    if (Array.isArray(errors) && errors.every((item) => typeof item === 'string')) {
      return errors.join('\n')
    }
    if (typeof result === 'string' && result.length > 0) return result
    if (typeof message === 'string' && message.length > 0) return message
    return 'QueryEngine 执行失败。'
  }

  /**
   * Pulls the four interesting arrays out of fusion-code's `system init`
   * SDK message and stores them on `this.sessionMeta`. Defensively
   * filters every entry so a malformed payload from a future CLI
   * version can never crash the renderer dialogs.
   *
   * Shape we read (from the actual logs):
   *   {
   *     type: 'system',
   *     subtype: 'init',
   *     skills: string[],
   *     mcp_servers: [{ name: string, status: string }],
   *     slash_commands: string[],
   *     model: string,
   *     cwd: string,
   *     ...
   *   }
   */
  private updateSessionMeta(
    initMsg: Record<string, unknown>,
    pumpedSessionId: string
  ): void {
    const skills = Array.isArray(initMsg.skills)
      ? initMsg.skills.filter((s): s is string => typeof s === 'string')
      : []

    const mcpServers: McpServerInfo[] = Array.isArray(initMsg.mcp_servers)
      ? initMsg.mcp_servers
          .filter((s): s is Record<string, unknown> => this.isRecord(s))
          .map((s) => ({
            name: typeof s.name === 'string' ? s.name : 'unknown',
            status: this.normalizeMcpStatus(s.status)
          }))
      : []

    const slashCommands = Array.isArray(initMsg.slash_commands)
      ? initMsg.slash_commands.filter((s): s is string => typeof s === 'string')
      : []

    const model = typeof initMsg.model === 'string' ? initMsg.model : undefined
    const cwd = typeof initMsg.cwd === 'string' ? initMsg.cwd : undefined

    this.sessionMeta = { skills, mcpServers, slashCommands, model, cwd }
    this.systemInitSeen = true
    console.log('[engine] sessionMeta cached', {
      skillCount: skills.length,
      serverCount: mcpServers.length,
      commandCount: slashCommands.length,
      model
    })

    // ── Session ID rebind ────────────────────────────────────────────
    // fusion-code's `--resume <id>` has a surprising behavior: it
    // loads the history of <id> into context but writes the new turns
    // to a FRESH session id (effectively a silent fork). The
    // `forkSession: false` SDK option is supposed to prevent this, so
    // under normal circumstances the rebind branch is a no-op — but
    // we keep it as defense-in-depth.
    //
    // Multi-runtime: the rebind target is the specific pump calling
    // us, NOT this.activeSessionId (which may point at a different
    // foreground session in a multi-runtime scenario). The pump
    // passes its own current id as `pumpedSessionId`.
    const sdkSessionId =
      typeof initMsg.session_id === 'string' ? initMsg.session_id : undefined
    if (sdkSessionId && sdkSessionId !== pumpedSessionId) {
      const rt = this.sessions.get(pumpedSessionId)
      if (rt) {
        this.sessions.delete(pumpedSessionId)
        this.sessions.set(sdkSessionId, rt)
      }
      // Only move the foreground pointer if the rebinding runtime
      // was in fact the foreground one. Otherwise leave activeSessionId
      // alone — a background runtime rebind shouldn't yank the UI.
      if (this.activeSessionId === pumpedSessionId) {
        this.activeSessionId = sdkSessionId
      }
      console.log('[engine] session id rebound from fusion-code init', {
        from: pumpedSessionId,
        to: sdkSessionId
      })
    }

    // The very first `system init` after a new session spawn is also
    // the moment fusion-code creates the JSONL file on disk. Broadcast
    // so the sidebar can pick up the new row (otherwise the user has
    // to cold-restart or manually re-focus for it to appear).
    this.emit('sessionListChanged')

    // Also broadcast that sessionMeta changed. Before this event
    // existed, the renderer only re-polled `getSessionMeta()` when a
    // turn ended — so during the first ~30s of a new session the
    // slash popover had only the hard-coded client commands (/skill,
    // /mcp) and not the cli's built-in command set. Now the Composer
    // refreshes the instant the cli finishes warming up, even while
    // the first turn is still streaming.
    this.emit('sessionMetaChanged')
  }

  /** Coerce any string the CLI hands us into a known status union. */
  private normalizeMcpStatus(value: unknown): McpServerInfo['status'] {
    if (typeof value !== 'string') return 'unknown'
    const v = value.toLowerCase()
    if (v === 'connected') return 'connected'
    if (v === 'disconnected') return 'disconnected'
    if (v === 'pending' || v === 'connecting') return 'pending'
    if (v === 'error' || v === 'failed') return 'error'
    return 'unknown'
  }

  /**
   * Working directory handed to `query()` on SDK spawn. Always reads
   * the user-picked workspace — `send()` already guarantees this is
   * non-null by the time openSession() runs, but we throw if called
   * in some other code path to catch regressions loudly instead of
   * silently falling back to process.cwd() (which in a packaged .app
   * is `/`, the wrong answer).
   */
  private getWorkingDirectory(): string {
    if (this.workspaceDir === null) {
      throw new Error('getWorkingDirectory() called before workspace was set.')
    }
    return this.workspaceDir
  }

  private emitEvent(sessionId: string, event: ChatEvent): void {
    this.emit(`chat:${sessionId}`, event)
    this.emit('chat', sessionId, event)
  }

  /**
   * Instrumentation breadcrumb. Emits one `log` event on the engine's
   * EventEmitter which `ipc/register.ts` forwards to the renderer's
   * LogsDialog. We also mirror to console.log so the live terminal
   * output still tracks the same moments when the dialog isn't open —
   * the cost of the extra log line is negligible next to what each
   * event marks (network, process spawn, API RTT).
   *
   * Labels are plain strings, dot/colon-separated by convention
   * (`switchToSession:begin`, `ensureSessionReady:reuse`,
   * `turn:firstChunk`, ...). No enum, no shared type — adding a new
   * event is "call this.logEvent('your:name', details)" and nothing
   * else. The dialog just renders whatever strings arrive.
   */
  private logEvent(label: string, details?: Record<string, unknown>): void {
    const event: LogEvent = {
      ts: Date.now(),
      label,
      sessionId: this.activeSessionId ?? undefined,
      ...(details !== undefined ? { details } : {})
    }
    this.emit('log', event)
    // Mirror to console with a short prefix so terminal tails can
    // still see engine flow without the LogsDialog being open.
    if (details !== undefined) {
      console.log(`[engine/log] ${label}`, details)
    } else {
      console.log(`[engine/log] ${label}`)
    }
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null
  }
}

/**
 * Construct a fresh ChatEngine bound to a WebContents.
 *
 * Each call produces an independent engine with its own sessions Map,
 * its own PermissionBroker, and its own event routing to the given
 * webContents. The tabRegistry owns the mapping from webContents.id →
 * engine so IPC handlers can resolve the right one via `event.sender`.
 *
 * `opts.shouldBumpOnTurnEnd` lets the caller override the tray
 * badge-bump gate (see ChatEngine.shouldBumpOnTurnEnd) — pass a
 * resolver that checks both "shell window focused" and "this tab
 * active" so badges only fire when the user isn't looking.
 */
export function createChatEngine(
  webContents: WebContents,
  opts: ChatEngineOptions = {}
): ChatEngine {
  return new ChatEngine(webContents, opts)
}
