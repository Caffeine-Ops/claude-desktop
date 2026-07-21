import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ThreadPrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  useAuiState,
  useComposerRuntime
} from '@assistant-ui/react'
import type { Attachment } from '@assistant-ui/core'
import { useComposerSend } from '@assistant-ui/core/react'
import { AnimatePresence, motion } from 'motion/react'

import type { SessionMeta } from '@desktop-shared/types'
import { useI18n, useT } from '../../../i18n'
import { useChatStore, useTeamMemberTasks, useTurnActivity } from '../../../stores/chat'
import { isReplaySessionId } from '../../../replay/replayStore'
import { useWorkspaceStore } from '../../../stores/workspace'
import { matchProposalSlash } from '../../../lib/proposalSlash'
import { attachFilesToComposer } from '../../../composer/attachFiles'
import { useComposerOverlayStore } from '../../../stores/composerOverlay'
import { useProposalStore } from '../../../stores/proposal'
import { buildSlashAdapter, buildSkillPickerEntries, type SkillPickerEntry } from '../../../composer/slashAdapter'
import { buildFileMentionAdapter } from '../../../composer/fileMentionAdapter'
import {
  ProseMirrorComposerInput,
  type ProseMirrorComposerInputHandle
} from '../../../composer/ProseMirrorComposerInput'
import { QueuePanel } from './QueuePanel'
import { ScenarioRail } from './ScenarioRail'
import { AgentTeamBar } from './AgentTeamBar'
import { buildWfRows } from './WorkflowTaskTree'
import { useAgentTeamStore } from '../../../stores/agentTeam'
import { FileTypeIcon } from '../FileTypeIcon'
import { SkillChipIcon } from '../SkillChipIcon'
import { DictationWaveform } from '../DictationWaveform'
import { PermissionModePicker } from '../../permissions/PermissionModePicker'
import {
  AskComposerSwap,
  AskUserComposerPanel
} from '../../permissions/AskUserComposerPanel'
import { PermissionComposerPanel } from '../../permissions/PermissionComposerPanel'
import {
  usePendingFloatPermissions,
  usePermissionStore
} from '../../../stores/permissions'
import { useComposerModeStore } from '../../../stores/composerMode'
import { cancelActiveDictation } from '../../../runtime/openaiWhisperDictationAdapter'
import { FILE_PATH_MIME } from '../../../runtime/imageAttachmentAdapter'
import {
  useImageEditStore,
  useSheetPreviewStore,
  useSplitWorkspaceBusy
} from '../../../stores/filePreview'
import { useKbStore } from '../../../stores/kb'

/* ───────────────────── Composer ────────────────────────────── */

/**
 * Chinese labels for the composer status bar, keyed by the activity string
 * useTurnActivity derives from the current running tool. Kept here (UI layer)
 * so the store stays text-free.
 */
const ACTIVITY_LABELS: Record<string, string> = {
  thinking: '思考中',
  planning: '拆一下任务',
  exploring: '探索中',
  reading: '查阅中',
  writing: '编写中',
  running: '执行中',
  // 「上网查资料」而非「联网中」（2026-07-17 用户拍板）：联网可以是任何网络
  // 动作，说了等于没说——用户要知道的是「AI 在干嘛」。也刻意没用「搜索网页
  // 中」：本档同时覆盖 WebSearch 与 WebFetch（见 stores/chat.ts 的 toolActivity
  // 映射），而 WebFetch 是按 URL 抓取、并不是搜索，「上网查资料」两者都成立。
  // 不带「中」字与其余动词的节奏略异，是有意的口语化（同「拆一下任务」）。
  searching: '上网查资料',
  asking: '等待你回答',
  working: '处理中'
}

/**
 * ComposerStatusPill
 * ------------------
 * The "✺ 探索中 · 2.5s" pill that lives IN the toolbar's center slot
 * (2026-07-16 redesign, prototype docs/ui-prototype-composer-states.html).
 * It replaced the old full-width green strip on top of the card: the strip's
 * position DRIFTED — card top with no queue, mid-card once the queue segment
 * appeared — so the same information kept jumping around. The toolbar slot is
 * a fixed anchor (the flex spacer between the attach/skill buttons and the
 * model chip), sits on the same row as the Stop button (status next to its
 * action), and costs zero extra card height.
 *
 * Pure presentation: `active`/`startedAt`/`activity` come from the parent
 * (which calls useTurnActivity once). Ticks every 100ms for the
 * tenths-of-a-second readout. Timer basis is the CURRENT STEP's start
 * (useTurnActivity picks it): the label names the current activity, so the
 * number must be that activity's elapsed — a turn-total next to "执行中"
 * reads as a lie. The readout restarts as each new tool begins.
 *
 * The verb swaps with a keyed re-mount (slide-up-in); no exit animation — an
 * AnimatePresence popLayout here would make the pill width snap around the
 * outgoing word, which reads worse than the simple swap.
 *
 * 窄档收起动词（2026-07-17，用户实锤截图：窄窗口下「联网中 · 16.2s」压在
 * 技能按钮与模型 chip 上）。成因是 flex 的收缩规则，不是定位错误：本 pill
 * `whitespace-nowrap` 且没有 min-w-0，作为 flex item 的默认 min-width:auto
 * 意味着**它不会缩到内容宽度以下**；toolbar 两侧的按钮又全是 shrink-0，唯一
 * 能让的只有中间那个 flex-1 spacer——它被压到比 pill 还窄后，pill 就在
 * justify-center 下朝**左右对称溢出**，正好各盖住一边。
 * 退化策略取「留图标+耗时、收动词」而非 truncate：运行状态的核心信息是
 * 「在动」+「多久」，动词是锦上添花；truncate 会切出「联网…」这种半个中文。
 * 断点挂在 spacer 的 @container/status 上而不是视口——composer 宽度由 rail
 * 收放 / 分栏决定，视口媒体查询探不到（同 SlidesWorkspace 的理由）。
 * 两级退化，断点都按 spacer 实测宽度定（真机量的，不是估的）：
 *   @max-10rem(160px) 收动词 → pill 64px。完整 pill 宽度随动词字数在 116px
 *     （3 字，如「思考中」）~140px（5 字，如「上网查资料」「等待你回答」）之间，
 *     160px 断点按最长的 5 字留了余量——加新动词别超 5 字，超了要重算这里。
 *   @max-4rem(64px)  连耗时也收，只剩转圈图标 → pill 约 38px。这是为
 *     toolbar ≤410px 的极窄档兜底：388px 时 spacer 被压到只剩 53px，光收
 *     动词后的 64px 仍会左右各溢出 5px 压住技能按钮与模型 chip（2026-07-17
 *     用户第二次实锤截图）。只留图标不算丢信息——图标在转本身就是「在运行」，
 *     Stop 按钮同排佐证；aria-label 始终保留完整动词+耗时，读屏不受影响。
 * 为什么不靠隐藏麦克风/模型 chip 让位：那是让功能不可达换布局，代价比
 * 状态文字降级大；pill 是临时态，退化只持续到本轮结束。
 */
const PILL_SPRING = { type: 'spring', bounce: 0, visualDuration: 0.25 } as const

function ComposerStatusPill({
  startedAt,
  activity
}: {
  startedAt: number
  activity: string
}): React.JSX.Element {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(id)
  }, [])

  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const label = `${(elapsedMs / 1000).toFixed(1)}s`
  const verb = ACTIVITY_LABELS[activity] ?? ACTIVITY_LABELS.thinking

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={PILL_SPRING}
      className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-brand/[0.09] px-3 py-1 text-[12px] font-semibold text-brand"
      role="status"
      aria-live="polite"
      aria-label={`${verb}, ${label}`}
    >
      <span aria-hidden className="shrink-0 animate-spin [animation-duration:2.4s]">
        ✺
      </span>
      <motion.span
        key={verb}
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={PILL_SPRING}
        className="@max-[10rem]/status:hidden"
      >
        {verb}
      </motion.span>
      <span aria-hidden className="opacity-40 @max-[10rem]/status:hidden">
        ·
      </span>
      <span className="shrink-0 font-mono text-[11px] font-medium tabular-nums opacity-75 @max-[4rem]/status:hidden">
        {label}
      </span>
    </motion.div>
  )
}

/**
 * Composer with `/` slash-command autocomplete AND `@` file-mention
 * autocomplete.
 *
 * Wired in four layers:
 *
 *   1. **SessionMeta fetch** — pulled from main on mount and after
 *      every turn end. The first user turn triggers fusion-code's
 *      cold start, which emits a `system init` SDK message containing
 *      `slash_commands` / `mcp_servers` / `skills`. Once that meta is
 *      cached in main, subsequent `getSessionMeta` calls return the
 *      real list.
 *
 *   2. **File list fetch** — pulled from main via IPC on mount and
 *      when streaming ends. Main scans `cwd` via `git ls-files` (or
 *      readdir fallback) with a 5s TTL cache, so rapid re-fetches
 *      share the same result. Loaded into React state so the
 *      Unstable_TriggerAdapter.search() can be synchronous (the
 *      primitive requires sync data access).
 *
 *   3. **Adapters** — `buildSlashAdapter` and `buildFileMentionAdapter`
 *      return Unstable_TriggerAdapter instances memoized on their
 *      respective data sources. File adapter does O(n) substring +
 *      path-depth ranking on every keystroke (see fileMentionAdapter.ts).
 *
 *   4. **Popover JSX** — Two nested `Unstable_TriggerPopoverRoot`s
 *      share the same ComposerPrimitive.Input. Each root listens to
 *      its own trigger character (`/` or `@`) and only opens its
 *      popover when that character is active. Because
 *      `unstable_useTriggerPopoverContext()` walks up the React tree
 *      to find the *nearest* root, the slash popover JSX lives in
 *      the outer root (above the @ root) and the file popover lives
 *      inside the inner root — each then reads its own context.
 *
 * On selection both popovers use `insertDirective`, which removes
 * the `<trigger><query>` token from the input and writes
 * `serialize(item)` in its place. For slash commands that's the
 * literal `/cmd`; for file mentions that's `@path `. The user then
 * presses Enter to submit — at which point free-code's CLI runs
 * `extractAtMentionedFiles` on the text and auto-attaches each file.
 */
/**
 * GapFillBanner
 * -------------
 * 资料缺失·补料提示条：用户在【只读】方案草稿点某处缺口的「去对话框补充」后，pendingGapFill 被置，
 * 这条提示条即在输入框顶部弹出——把「这一章缺什么」告诉用户，并指引其在下方输入这段资料的原文
 * （或指认知识库文件）并发送。发送时 onNew 会把原文包成「只重写这一章」的指令、清掉 pendingGapFill，
 * 本条随之消失。× 取消本次补料（清标记）。纯展示 + 一个取消动作，本身【不发任何消息】——AI 只在
 * 用户真正发出资料后才运行。仅当补料标记属于当前 composer 会话时渲染（多 tab 不串）。
 */
function GapFillBanner({ sessionId }: { sessionId: string | null }): React.JSX.Element | null {
  const gap = useProposalStore((s) =>
    s.active && s.sessionId === sessionId ? s.pendingGapFill : null
  )
  if (!gap) return null
  return (
    <>
      <div className="flex items-start gap-2 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-700 dark:text-amber-400">
        <span className="mt-px shrink-0">⚠️</span>
        <div className="min-w-0 flex-1 leading-snug">
          <div className="font-medium">补充资料：{gap.gapDesc}</div>
          <div className="text-amber-600/80 dark:text-amber-400/80">
            在下方输入这段资料的原文（或指认知识库文件）并发送，我就据此补写这一章、删掉缺口标记。
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded px-1 leading-none text-amber-600/70 hover:bg-amber-500/15 hover:text-amber-700 dark:text-amber-400/70 dark:hover:text-amber-300"
          title="取消补充"
          onClick={() => useProposalStore.getState().setPendingGapFill(null)}
        >
          ✕
        </button>
      </div>
      <div className="h-px bg-border/70" />
    </>
  )
}

/**
 * Composer 的两种形态：
 *   - 'default' — 底部 dock（有消息后）：卡片 + 裸排的工作目录/权限 chips，
 *     维持原布局不动。
 *   - 'hero'    — EmptyState 空态（原型 docs/empty-state-composer-prototype
 *     .html）：卡片上方多一条 ScenarioRail（分类 tab + 技能/推荐 prompt
 *     chips），卡片和底行一起包进一个浅灰圆角「托盘」，底行成为托盘露出的
 *     延伸条——WorkBuddy 参考里的「选择工作空间 / 默认权限」灰条。
 */
export function Composer({ variant = 'default' }: { variant?: 'default' | 'hero' } = {}): React.JSX.Element {
  const t = useT()
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const [files, setFiles] = useState<readonly string[]>([])
  const streaming = useChatStore((s) => s.streaming)
  // Working-status for the toolbar pill (ComposerStatusPill) — the single
  // useTurnActivity subscription both the pill's presence and its content
  // derive from.
  const turnActivity = useTurnActivity()
  // Slides binding: when the user sends while the global picker is on
  // 幻灯片, mark the CURRENT session as a slides session so ThreadView
  // shows its two-pane layout from then on (per-session, not global).
  // Called on every send path (Enter → onSubmit, and the Send button's
  // onClick); markSlidesSession is idempotent so double-calls are fine.
  const composerSessionId = useChatStore((s) => s.sessionId)
  // 知识库只服务「写方案」——聊天框底栏的知识库 chip 仅在写方案语境下露出。
  // ComposerModePicker 退役后（2026-07-16，模式入口统一到 EmptyState 的
  // ScenarioRail 技能 chip），「写方案语境」的判定改为两个真源的并集：
  //   1. 方案已激活且绑定本会话（proposal store，发送/斜杠拦截后的进行时）；
  //   2. composer 正文以 /proposal-writer 命令开头（选了技能 chip 还没发）。
  // 两个 selector 都返回稳定布尔，逐键输入不会白重渲染整个 Composer。
  const proposalActiveHere = useProposalStore(
    (s) => s.active && s.sessionId !== null && s.sessionId === composerSessionId
  )
  const composerLeadsProposal = useAuiState((s) => {
    const text = ((s as { composer?: { text?: string } }).composer?.text as string | undefined) ?? ''
    return matchProposalSlash(text) !== null
  })
  // Read dictation state at the Composer level (single subscription)
  // and branch the composer row layout on it. When dictating, the
  // textarea is replaced by a live waveform, the send + mic slots
  // become a pair of X / ✓ controls — matching the mutually
  // exclusive UX in the design reference.
  const isDictating = useAuiState(
    (s) => (s as { composer?: { dictation?: unknown } }).composer?.dictation != null
  )
  // Composer runtime — used to submit via the same path Send uses
  // (the ProseMirror input's onSubmit calls composerRuntime.send()).
  const composerRuntime = useComposerRuntime()

  // 当前会话最早的 pending AskUserQuestion（2026-07-16 形态迁移，见
  // AskUserComposerPanel 头注释）：有它时输入卡整个变形为提问面板。
  // 只认本会话（后台会话的提问不劫持前台输入区）；请求对象引用稳定，
  // Map 变更时 selector 重跑但引用相同不触发重渲染。
  const askRequest = usePermissionStore((s) => {
    if (!composerSessionId) return null
    for (const r of s.requests.values()) {
      if (r.toolName === 'AskUserQuestion' && r.sessionId === composerSessionId) return r
    }
    return null
  })
  // slides 会话的 AskUserQuestion 由 canvas 问题 tab 全权接管（同
  // ToolCallCard 的 askHandledByCanvas 判定），composer 不抢；听写态
  // 不切面（面板 morph 会把听写 UI 连同波形一起藏掉，等确认/取消后再切）。
  const composerIsSlides = useComposerModeStore((s) =>
    composerSessionId ? s.slidesSessions[composerSessionId] === true : false
  )
  const showAskPanel = askRequest !== null && !composerIsSlides && !isDictating
  // 权限请求（AskUserQuestion 之外的 canUseTool 门）同走 composer 接管
  // （2026-07-16 迁移，替代 ThreadView 的 PermissionFloatDock 浮卡）：
  // 显示最旧一个 + 排队计数，与提问面板同一形态。权限先于提问——权限门
  // 是硬阻塞（模型完全走不下去），提问只是要输入（对齐 store 里
  // usePendingPermissionKindsBySession 的 approval-wins 语义）。
  const floatPermissions = usePendingFloatPermissions(composerSessionId)
  const permRequest = floatPermissions[0] ?? null
  const showPermPanel = permRequest !== null && !isDictating

  // Pull session meta on mount and whenever a turn ends. The first
  // pull (mount) returns empty arrays because fusion-code hasn't
  // spawned yet; the post-first-turn pull picks up the populated
  // cache. Subsequent turn-end pulls are no-ops on stable data but
  // cheap (one IPC round-trip).
  useEffect(() => {
    if (streaming) return
    // 回放期 streaming 每个 turn 都翻转（表演需要），但 replay: slot 在
    // main 侧没有会话——别拿着表演节拍去打真 IPC（读实时前台 id，闭包外）。
    if (isReplaySessionId(useChatStore.getState().sessionId)) return
    let cancelled = false
    window.chatApi
      .getSessionMeta()
      .then((meta) => {
        if (!cancelled) setSessionMeta(meta)
      })
      .catch((err) => {
        console.error('[Composer] getSessionMeta failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [streaming])

  // Also refresh sessionMeta the instant main fires
  // `session:meta-changed` — this is what carries fusion-code's
  // skills / mcp servers / slash commands, and it arrives on the
  // first `system init` message (which is ~30s into the initial
  // cold start, mid-stream). Without this subscription, the `/`
  // popover would only see the full command set after the first
  // turn ends and the [streaming] effect above re-polls — a bad
  // UX when the user is already typing their second prompt while
  // the first is still rendering. One IPC round-trip per push,
  // main-side cache keeps it cheap.
  useEffect(() => {
    if (!window.chatApi) return
    let cancelled = false
    const unsub = window.chatApi.onSessionMetaChanged(() => {
      window.chatApi
        .getSessionMeta()
        .then((meta) => {
          if (!cancelled) setSessionMeta(meta)
        })
        .catch((err) => {
          console.error('[Composer] getSessionMeta (pushed) failed', err)
        })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Pull the file list on the same cadence as session meta. Main's
  // 5s TTL cache makes rapid re-fetches cheap, so we don't need to
  // throttle here. First fetch fires on mount so the `@` popover
  // has data available before the user even types.
  useEffect(() => {
    if (streaming) return
    // 同上：回放的 streaming 翻转不该触发文件列表拉取。
    if (isReplaySessionId(useChatStore.getState().sessionId)) return
    let cancelled = false
    window.chatApi
      .listFileSuggestions()
      .then((result) => {
        if (cancelled) return
        if (result.truncated) {
          console.warn(
            `[Composer] file list truncated to ${result.files.length} entries — large project`
          )
        }
        setFiles(result.files)
      })
      .catch((err) => {
        console.error('[Composer] listFileSuggestions failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [streaming])

  // Build the adapters from the latest data. Memoized so the popover
  // primitives don't recreate their internal state on every render.
  const slashAdapter = useMemo(
    () => buildSlashAdapter(sessionMeta),
    [sessionMeta]
  )
  const fileAdapter = useMemo(() => buildFileMentionAdapter(files), [files])

  // ── Attachment "+" button: any file, images OR path-only files ──────
  // The native ComposerPrimitive.AddAttachment hard-wires the adapter's
  // accept ('image/*' on the old image-only adapter) and only opens a
  // file picker filtered to that. We replace it with our own hidden
  // <input> (no accept filter) so the user can pick ANY file, and route
  // every pick through the same runtime.addAttachment the unified
  // fileAttachmentAdapter consumes (see fileAttachmentAdapter.ts):
  //
  //   - image/*  → resized + base64-encoded → inline thumbnail chip →
  //     sent to the model as a vision block.
  //   - any other file → resolved to its on-disk absolute path → shown
  //     above the input as a chip carrying the FILE NAME (not a
  //     thumbnail) → on send, the path (not the bytes) is appended to
  //     the prompt as an `@"path"` mention so fusion-code's
  //     extractAtMentionedFiles reads the file itself.
  //
  // Both kinds therefore appear in the SAME attachments row above the
  // composer, exactly like pasted/dropped images already do.
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // 技能按钮的入口 ref：点击时调用 openSlashMenu() 在编辑器里敲一个 `/`，
  // 复用建议插件自己的弹窗，而不是另起一套菜单实现（见 ProseMirrorComposerInput
  // 里 ProseMirrorComposerInputHandle 的注释）。
  const composerInputRef = useRef<ProseMirrorComposerInputHandle | null>(null)

  // Agent-team takeover addressing (2026-07-19, fourth pass): there's no
  // separate mailbox UI (user rejected a second standalone input box in
  // AgentTeamDetail, "都共用这个input不可以吗") — the ONE shared composer
  // doubles as "message a member" when a takeover is active.
  //
  // The prefix uses the member's REAL `agentId` when one exists — verified
  // live (fusion-code-cli, resume-probe, 2026-07-19): given a prompt
  // addressed by real agentId, the model calls `SendMessage({to: agentId,
  // ...})`, whose result text is literally `"Agent \"<id>\" had no active
  // task; resumed from transcript in the background with your message"` —
  // it genuinely re-runs that COMPLETED subagent with the new text as its
  // next prompt, not just a generic reply from the main agent. This
  // corrects an earlier (wrong) assumption in this file that a finished
  // subagent process is unreachable — it isn't; only a fabricated persona
  // NAME is (an earlier attempt used one and the model replied "没找到叫
  // 清拓野的agent" — the model has no way to resolve a name it never
  // assigned, but it resolves a real agentId fine). Falls back to the
  // member's `label` (task description) when there's no agentId (a
  // `local_workflow` top-level row — that's the script's own bookkeeping
  // task, not a subagent, so there's nothing to resume).
  //
  // `submitTurn` wraps BOTH send triggers (Enter's onSubmit below, and the
  // custom Send button that replaces `<ComposerPrimitive.Send>` further
  // down) so the prefix applies no matter which one the user actually
  // uses — `<ComposerPrimitive.Send>` calls straight into
  // `@assistant-ui/core`'s internal send, bypassing our onSubmit entirely,
  // which is exactly the gap the first attempt at this fix missed.
  const teamMemberTasks = useTeamMemberTasks()
  const teamSelectedRowId = useAgentTeamStore((s) => s.selectedRowId)
  const teamSelectedRowAddress = useMemo(() => {
    if (!teamSelectedRowId) return null
    const row = buildWfRows(teamMemberTasks).find((r) => r.id === teamSelectedRowId)
    if (!row) return null
    return row.agentId
      ? `发给 agentId: ${row.agentId}（${row.label}）`
      : row.label
  }, [teamMemberTasks, teamSelectedRowId])
  const submitTurn = useCallback(
    (rawSend: () => void) => {
      // trim-guard: an empty composer reaching here (e.g. an errant Enter)
      // must NOT gain a prefix — that would turn "nothing to send" into a
      // real non-empty message that assistant-ui's own isEmpty-based
      // disabled check no longer catches.
      if (teamSelectedRowAddress) {
        const currentText = composerRuntime.getState().text
        if (currentText.trim().length > 0) {
          composerInputRef.current?.fillBody(`[${teamSelectedRowAddress}] ${currentText}`)
          // 退出接管、回到主视口——这样用户能实际看到这轮消息怎么被处理，
          // 而不是发完仍卡在详情页里看不到效果（上一版原样复现的 bug）。
          useAgentTeamStore.getState().clear()
        }
      }
      rawSend()
    },
    [teamSelectedRowAddress, composerRuntime]
  )
  const composerSend = useComposerSend()

  const handleFilesPicked = useCallback(
    async (fileList: FileList | null): Promise<void> => {
      if (!fileList || fileList.length === 0) return
      // 统一附件分流（2026-07-16 附件内联化）：有路径 → 编辑器内联
      // `@"path"` mention chip；无路径 → attachments 行兜底。选择器拿到
      // 的 File 永远有磁盘路径，实际都走内联分支。
      await attachFilesToComposer(Array.from(fileList), composerRuntime)
      // Reset the input so re-picking the same file fires `change` again.
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [composerRuntime]
  )

  return (
    <div className="mx-auto w-full max-w-4xl">
      {/* Two-row composer (per docs/ui-prototype-composer.html): a large
          multi-line input on top, then a dedicated toolbar row below. The
          PermissionModePicker moved OUT of a strip above the card and INTO
          the toolbar's right cluster (it sits where the prototype's "Auto"
          pill is). All assistant-ui wiring is preserved — only the layout
          (rows/positions/classNames) changed.

          The slash/mention popovers are driven by the ProseMirror
          suggestion plugin inside ProseMirrorComposerInput; only the
          assistant-ui pieces that read the composer *store*
          (AttachmentDropzone / Attachments / Send / Cancel / Dictation)
          remain. */}
      {variant === 'hero' ? (
        // 场景导航挂在 Composer 内（而不是 EmptyState）：它的两个动作都要
        // 驱动 composerInputRef（插 slash chip / fillBody 填正文），ref 不
        // 出组件边界，联动状态（composer.text）走 assistant-ui store。
        <div className="mb-4">
          <ScenarioRail
            onInsertSkill={(value) => composerInputRef.current?.resetWithSlashCommand(value)}
            onFillPrompt={(text) => composerInputRef.current?.fillBody(text)}
            snapshotDraft={() => composerInputRef.current?.snapshotDoc() ?? null}
            restoreDraft={(snapshot) => composerInputRef.current?.restoreDoc(snapshot)}
          />
        </div>
      ) : null}
      {/* Agent team bar — mounted unconditionally in both variants; it
          self-hides (returns null) when the session has no workflow team
          to show, so there's no variant branch to keep in sync here. */}
      <AgentTeamBar />
      <div
        className={
          variant === 'hero'
            ? // hero 托盘：比页面底色深一档的圆角灰壳，白卡叠在上面，底部
              // 露出工作目录/权限延伸条（原型 .composer-shell）。
              'relative rounded-[28px] bg-foreground/[0.035] dark:bg-white/[0.045]'
            : 'relative'
        }
      >
        {/* SINGLE-CONTAINER COMPOSER (redesign — replaces the old three stacked
            rounded boxes joined by negative margins, which clipped the status
            row and doubled up borders; see the bug screenshots).

            This used to be its own `AttachmentDropzone` (the drop target was
            just the composer card). The drop target has since moved up to
            wrap the whole ThreadView column (see ThreadView.tsx's
            `group/dropzone` — drops now work anywhere over the viewport too,
            not just the input), so this is now a plain rounded frame; the
            `group-data-[dragging=true]/dropzone:*` variants below still tint
            this card while a drag is in progress, driven by the ancestor
            dropzone's state rather than one of its own.

            Everything lives INSIDE it as flat, full-width segments
            separated by 1px hairline dividers, top-to-bottom:

              ┌─ message queue (QueuePanel) ─┐   ← only while queue non-empty,
              ├──────── hairline ────────────┤     collapsed to a summary row
              │ attachments · input · toolbar│     by default
              └──────────────────────────────┘

            The working status lives IN the toolbar as a centered pill
            (ComposerStatusPill) — a fixed anchor that never drifts when other
            segments come and go; the old full-width green strip is gone
            (2026-07-16 redesign, docs/ui-prototype-composer-states.html).

            `overflow-hidden` clips each segment's square corners to the card's
            radius. No segment carries its own border/radius/negative margin, so
            nothing can overlap or clip anything else. */}
        {/* AskComposerSwap（2026-07-16）：pending 的权限请求 / AskUserQuestion
            时输入卡 morph 成对应接管面板（同一个槽，权限优先）。输入卡是
            children **常驻不卸载**（卸载毁 ProseMirror 草稿），接管态只
            脱流隐藏——见 AskUserComposerPanel 尾部的 swap 实现注释。下方
            整张输入卡的 JSX 原封未动。 */}
        <AskComposerSwap
          // dock 态卡底贴窗口底：所有高度动画（队列展开/收起、接管面板
          // morph）锚定底边，input 屏幕位置全程不动，变化都长在卡顶。
          // hero 空态卡在页面中段，维持默认顶锚。
          anchor={variant === 'hero' ? 'top' : 'bottom'}
          ask={
            showPermPanel && permRequest ? (
              <PermissionComposerPanel
                key={permRequest.requestId}
                request={permRequest}
                queuedCount={floatPermissions.length - 1}
              />
            ) : showAskPanel && askRequest ? (
              <AskUserComposerPanel key={askRequest.requestId} request={askRequest} />
            ) : null
          }
        >
        {/* 聚焦效果 = 方案 B「柔光聚拢」（docs/ui-prototype-composer-focus
            .html 定稿，2026-07-17；同日撤换掉的方案 E「流光描边」实际观感
            不好看，改用这版更稳的纯 CSS 效果）。描边加深 + 4px 光晕徐徐
            晕开 + 一层带色环境投影——三层堆一个 box-shadow，:focus-within
            零 JS 驱动。

            颜色特意用 --accent 不是 --brand：截图实锤 composer 聚焦环是
            写死的品牌绿，但用户在设置页选的主题色是蓝——两者对不上。
            --accent 由 appearance.applier.ts 写在 documentElement.style
            上（最高优先级），用户切主题色即改写这个 token，这里引用它就
            自动跟着变，不需要额外监听。resting 态的中性 ring-1 保留；
            focus-within:ring-0 把它清零，避免跟下面的 shadow 堆叠出双环。 */}
        <div
          className={
            // 毛玻璃质感（2026-07-18，用户参考账户菜单的玻璃处理定稿；首版 /75
            // 用户截图实锤"看不出效果"——CDP 量过 computed style，alpha/blur
            // 确实生效，问题是 /75 在深色主题下跟大多数壁纸预设的暗色调太接近，
            // 肉眼分辨不出"半透明+模糊"和"实底"的差异；强制降到 /35 现场对比
            // 壁纸清晰透出后确认是纯粹的透明度不够，不是机制没生效。改到 /45
            // 留一点余量给持续阅读的输入态可读性，比账户菜单的 /70（只是瞥一眼
            // 的菜单，可以更保守）更激进。blur-xl + saturate-150 本就在。卡片内
            // 所有子元素（+/模型 chip/麦克风）本就是 ghost 样式无自带底色，透明度
            // 一降全跟着透出玻璃；发送/停止钮的实心色是功能色（就绪/生成中状态），
            // 不在这次"材质"调整范围内。
            'relative overflow-hidden rounded-[22px] bg-popover/45 ring-1 ring-black/[0.08] backdrop-blur-xl backdrop-saturate-150 transition-all focus-within:ring-0 focus-within:shadow-[0_0_0_1px_hsl(var(--accent)/0.55),0_0_0_4px_hsl(var(--accent)/0.12),0_2px_6px_rgba(0,0,0,0.04),0_10px_32px_-6px_hsl(var(--accent)/0.22)] group-data-[dragging=true]/dropzone:ring-2 group-data-[dragging=true]/dropzone:ring-[hsl(var(--brand)/0.5)] group-data-[dragging=true]/dropzone:bg-brand/[0.08] dark:ring-white/[0.08]' +
            // hero：卡片浮在托盘上，需要一层柔和投影把「白卡叠灰壳」的层次
            // 立起来（dock 态背景就是页面底色，不加）。聚焦时投影被
            // focus-within 整体接管（主题色环境光替换中性环境光），失焦回落。
            (variant === 'hero'
              ? ' shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_28px_-4px_rgba(0,0,0,0.07)]'
              : '')
          }
        >
          {/* Segment 0 — 资料缺失·补料提示条。仅当用户点了草稿里某处缺口的「去对话框补充」
              （pendingGapFill 属于本会话）时露出，指引其在下方输入资料并发送；自带底部 hairline。 */}
          <GapFillBanner sessionId={composerSessionId} />

          {/* Segment 1 — message queue. Renders null when empty; owns its own
              enter/exit height animation AND the hairline divider below it
              (so segment + divider appear/disappear as one animated block).
              Its own frame styling was stripped; it's pure content here. */}
          <QueuePanel sessionId={composerSessionId} />

          {/* Segment 2 — the input body (attachments · text · toolbar). */}
          {/* Attachment preview row (pasted / dropped / picked). */}
          <div className="flex flex-wrap gap-2 px-4 pt-3 empty:hidden">
            <ComposerPrimitive.Attachments>
              {({ attachment }) => (
                <ComposerAttachmentChip attachment={attachment} />
              )}
            </ComposerPrimitive.Attachments>
          </div>

          {/* ComposerPrimitive.Root is the composer form context. We lay it
              out as a column: input row on top, toolbar row beneath. */}
          <ComposerPrimitive.Root className="flex w-full flex-col">
            {/* Hidden file input — shared by the toolbar "+" button. Kept
                here (inside Root) so it lives in the form context. */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(e) => {
                void handleFilesPicked(e.target.files)
              }}
            />

            {isDictating ? (
              // Dictation takes over the whole composer body (input + mic +
              // send slot) — same as before, just hosted in the column.
              <div className="flex items-end gap-2 px-3 py-2">
                <DictationActiveControls
                  cancelLabel={t('composerCancelDictation')}
                  confirmLabel={t('composerConfirmDictation')}
                />
              </div>
            ) : (
              <>
                {/* —— Top row: the multi-line input —— */}
                {/* hero 空态给一块「敞口」输入区（原型 ~118px）——大输入区
                    本身就是「从这里开始」的视觉邀请；dock 态维持紧凑高度。
                    正文 14px 加粗（2026-07-16 用户拍板）：chip/占位 pill 仍是
                    13px/500 的内联样式不受继承影响，字重差让用户键入的正文
                    成为行内视觉主体；placeholder（.is-empty::before）同步继承
                    这组字号字重。
                    pt-4/pb-3（纵向）挪到这层**不滚动**的外层，`overflow-y-auto`
                    单独留给内层——此前纵向 padding 跟滚动同挂一个 div，只是
                    "内容顶端"的留白，只有真滚到最开头那一行才看得见；输入撑到
                    max-h-52 触发内部滚动后，可视区顶部贴着的是当前滚到的那一
                    行，不再是内容头部，留白视觉上就消失了（2026-07-17 用户
                    截图实锤）。外层不滚动，纵向 padding 就是滚动视口和卡片
                    边框之间恒定的一圈框，不随滚动位置变化。
                    横向 px-5 留在内层（滚动的这个 div）没挪——滚动只发生在
                    纵向，横向 padding 不会有「滚过就消失」的问题，反而是
                    原生滚动条（main.css 定的 10px 宽）需要落脚的位置：挪去
                    外层会让内层贴着卡片右边界铺满，滚动条只能直接压在文字
                    上（2026-07-17 用户第二次截图实锤：内容一多滚动条就叠住
                    最后几个字）。 */}
                <div
                  className={
                    (variant === 'hero' ? 'min-h-[108px]' : 'min-h-[52px]') +
                    ' pb-3 pt-4'
                  }
                >
                  {/* caret 跟主题色（同下面聚焦柔光用同一个 --accent），
                      不用 --brand——理由见上方卡片聚焦效果的注释。 */}
                  <div className="max-h-52 overflow-y-auto px-5 text-[14px] font-bold leading-relaxed [caret-color:hsl(var(--accent))]">
                    <ProseMirrorComposerInput
                      ref={composerInputRef}
                      placeholder={
                        streaming
                          ? t('composerPlaceholderStreaming')
                          : t('composerPlaceholder')
                      }
                      slashAdapter={slashAdapter}
                      mentionAdapter={fileAdapter}
                      onSubmit={() => {
                        submitTurn(() => composerRuntime.send())
                      }}
                    />
                  </div>
                </div>

                {/* —— Bottom row: toolbar —— */}
                <div className="flex items-center gap-2 px-3 pb-3 pt-2">
                  {/* Left: attachment "+". We do NOT use
                      ComposerPrimitive.AddAttachment (it hard-wires
                      accept='image/*'); the hidden input above accepts any
                      file and routes images vs. other files via
                      handleFilesPicked. */}
                  <button
                    type="button"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground/80 ring-1 ring-black/[0.06] transition-colors hover:bg-foreground/[0.06] hover:text-foreground dark:ring-white/[0.08]"
                    aria-label={t('composerAttachFile')}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>

                  {/* 技能入口图标（Sparkles）：ComposerModePicker 在
                      hasMessages 后收起会留下空档，这颗图标补在同一位置。
                      点击直接打开 SkillPickerPopover（搜索框 + 技能列表，
                      WorkBuddy 参考样式），跟旧的「复用 / 建议弹窗」是两套
                      UI——手动打 `/` 仍走原来的紧凑单行菜单，互不影响。选中
                      一项后调用 insertSlashCommand 把同一个 slash 原子节点
                      插进编辑器，跟手动 `/` 选中同一项产出的 chip 一致。 */}
                  <SkillPickerButton
                    sessionMeta={sessionMeta}
                    onPick={(value) => composerInputRef.current?.insertSlashCommand(value)}
                  />

                  {/* （已退役，2026-07-16）ComposerModePicker——通用/设计/幻灯
                      片/写作/写方案/处理表格/制作视频的模式弹窗。模式入口统一
                      收敛到 EmptyState 的 ScenarioRail 技能 chip：chip 直接把
                      技能斜杠写进 composer，发送链路按 leading 命令自适应
                      （slides 标记见 FusionRuntimeProvider onNew、方案激活见
                      matchProposalSlash 拦截），不再经由全局 mode 单例。通用/
                      设计/写作三个模式本就没有任何发送效果，随 picker 一并
                      退役。组件与 COMPOSER_MODES 定义已删，恢复从 git 历史。 */}

                  {/* Spacer pushes the rest to the right edge AND hosts the
                      working-status pill dead-center. The pill's anchor is
                      this fixed slot — same row as the Stop button (status
                      next to its action), zero extra card height, and it
                      cannot drift when the queue segment comes and goes.
                      @container/status：pill 按**本槽实际宽度**收起动词（窄档
                      防溢出，理由见 ComposerStatusPill 头注释）。容器必须是
                      这里而不是卡片/视口——本槽宽度才是 pill 真正能用的空间。 */}
                  <div className="@container/status flex min-w-0 flex-1 items-center justify-center">
                    <AnimatePresence>
                      {turnActivity.active && turnActivity.startedAt !== undefined ? (
                        <ComposerStatusPill
                          startedAt={turnActivity.startedAt}
                          activity={turnActivity.activity}
                        />
                      ) : null}
                    </AnimatePresence>
                  </div>

                  {/* Right cluster: 模型选择器 · mic · send（2026-07-05 用户要求
                      把模型 chip 与「全自动」权限 chip 互换——模型放这排紧挨麦克风/
                      发送，权限模式挪到卡片下方 chip 排）。 */}
                  <ComposerModelChip model={sessionMeta?.model} />
                  <MicButton label={t('composerDictate')} />
                  {/* Mutually exclusive Send / Stop slot. */}
                  <ThreadPrimitive.If running={false}>
                    {/* Custom button instead of `<ComposerPrimitive.Send>` —
                        that primitive calls straight into
                        `@assistant-ui/core`'s internal send, bypassing our
                        `submitTurn` wrapper entirely (it doesn't go through
                        the ProseMirror input's onSubmit either). Sourcing
                        `send`/`disabled` from the SAME public hook the
                        primitive itself uses (`useComposerSend` from
                        `@assistant-ui/core/react`) keeps behavior identical
                        — only the click handler routes through submitTurn
                        first. See its declaration above for why that
                        matters (agent-team takeover addressing). */}
                    <button
                      type="button"
                      aria-label="Send message"
                      disabled={composerSend.disabled}
                      onClick={() => submitTurn(() => composerSend.send())}
                      // ready 态固定品牌绿（2026-07-18 从 --accent 改回——
                      // 2026-07-17 那次改动是因为发送键跟用户选的主题色对
                      // 不上而临时跟色，这次用户明确要求发送键不跟主题
                      // 色、就要固定绿：改回 --brand，与聊天列拖拽分隔条 /
                      // 大纲选中态等其它「chrome 级」绿色提示同变量）：
                      // 空输入是 muted disabled 盘，有内容才亮色——状态差
                      // 本身就是「可以发了」的信号，比常亮黑盘的信息量大。
                      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-[0_1px_2px_rgba(0,0,0,0.1),0_2px_8px_-2px_rgba(0,0,0,0.18)] transition-all hover:brightness-[1.08] active:scale-95 disabled:cursor-not-allowed disabled:bg-foreground/[0.08] disabled:text-muted-foreground/50 disabled:shadow-none"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 19V5" />
                        <path d="m6 11 6-6 6 6" />
                      </svg>
                    </button>
                  </ThreadPrimitive.If>
                  <ThreadPrimitive.If running>
                    <ComposerPrimitive.Cancel
                      aria-label="Stop generating"
                      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-[0_1px_2px_rgba(0,0,0,0.1),0_2px_8px_-2px_rgba(0,0,0,0.15)] transition-all hover:brightness-[1.1] active:scale-95"
                    >
                      <span className="block size-2.5 rounded-[2px] bg-card" />
                    </ComposerPrimitive.Cancel>
                  </ThreadPrimitive.If>
                </div>
              </>
            )}
          </ComposerPrimitive.Root>
        </div>
        </AskComposerSwap>

        {/* Below-card chips (figure 18): 选择工作目录已实装（统一会话管理，
            2026-07-07：新会话可选工作目录，发过消息后锁定只读）；语气 创意
            占位 chip 已移除（从未接实际功能）。权限模式 chip on the right is
            FUNCTIONAL（2026-07-05 与模型 chip 互换位置后落这排）——它切换
            引擎的权限模式（default/plan/acceptEdits/bypass/dontAsk）。上下文
            用量 chip（ContextUsageChip，2026-07-10）暂时隐藏不挂载——它的
            200k 窗口分母是从 ThreadListSidebar 抄来的写死常量，没有按当前
            会话实际模型取值，模型切换到非 200k 窗口时百分比会算错。组件与
            数据链路（engine.ts usage 事件的三个分量字段）保留，待窗口容量
            改成按模型动态取值后再挂回这排。 */}
        <div
          className={
            variant === 'hero'
              ? // hero：这排就是托盘露出的延伸条（原型 .composer-footer），
                // 间距从托盘内侧起算，不再需要 mt。
                'flex items-center gap-4 px-6 pb-3.5 pt-3'
              : 'mt-3 flex items-center gap-4 px-2'
          }
        >
          <WorkspaceDirPicker />
          {/* 知识库管理入口：与「选择工作目录」并排的 FUNCTIONAL chip——点开
              接管聊天区的 KbManagerView（openManager 会先 refresh 一次）。
              仅在「写方案」语境露出（方案进行中，或 composer 里已选写方案
              chip 待发）：知识库只喂写方案流程，其它场景隐藏它。 */}
          {proposalActiveHere || composerLeadsProposal ? (
            <ComposerKbChip label={t('catKnowledgeBase')} />
          ) : null}
          <div className="ml-auto">
            <PermissionModePicker />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 技能按钮 + 弹窗（截图参考 WorkBuddy 的技能选择器）：搜索框 + 彩色图标/
 * 标题/副标题两行式条目。数据只用本项目已有的——`buildSkillPickerEntries`
 * 读 sessionMeta.slashCommands 匹配 skillChipRegistry，跟旧的 `/` 建议菜单
 * 「技能」分组同一份真源，只是过滤掉「命令」分组、换成更大的两行式行高。
 * 不做截图里的「从本地添加技能」「管理技能」——本项目没有对应的技能安装/
 * 管理能力（那是另一产品 WorkBuddy 的功能），加两行点了没反应的假按钮不如
 * 不加。
 *
 * 交互形状照抄 ComposerModePicker：portal 到 body + fixed 锚点（同样要逃出
 * AttachmentDropzone 的 overflow-hidden 裁剪）、点外 / Esc 关闭、
 * AnimatePresence 淡入淡出。区别于 ComposerModePicker 的是自带一个受控
 * 搜索框和键盘上下选择。
 */
function SkillPickerButton({
  sessionMeta,
  onPick
}: {
  sessionMeta: SessionMeta | null
  onPick: (value: string) => void
}): React.JSX.Element | null {
  const entries = useMemo(() => buildSkillPickerEntries(sessionMeta), [sessionMeta])
  // 新会话（还没发过消息）时 sessionMeta.slashCommands 尚未从 CLI 的
  // `system init` 握手回填（lazy spawn：冷启动延迟到第一次 send），技能
  // 列表恒为空——与其露出一个点开永远空的按钮，不如整颗按钮跟 hasMessages
  // 挂钩，仅在发过消息（技能真的有得选）之后出现。
  const hasMessages = useChatStore((s) => s.messages.length > 0)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        (e.spec.label ?? e.value).toLowerCase().includes(q) ||
        (e.spec.description?.toLowerCase().includes(q) ?? false)
    )
  }, [entries, query])

  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const b = btnRef.current?.getBoundingClientRect()
      if (b) setAnchor({ left: b.left, bottom: window.innerHeight - b.top })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  // 打开即清空搜索、重置高亮、把焦点丢给搜索框——跟截图一致，弹出即可
  // 直接打字过滤，不用先点一下输入框。
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlighted(0)
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    setHighlighted((h) => (h >= filtered.length ? 0 : h))
  }, [filtered])

  useEffect(() => {
    if (!open) return
    const overlay = useComposerOverlayStore.getState()
    overlay.setOpen(true)
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      const inRoot = rootRef.current?.contains(target)
      const inMenu = menuRef.current?.contains(target)
      if (!inRoot && !inMenu) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => {
      overlay.setOpen(false)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const choose = (entry: SkillPickerEntry): void => {
    onPick(entry.value)
    setOpen(false)
  }

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const entry = filtered[highlighted]
      if (entry) choose(entry)
    }
  }

  // hooks 必须先跑完再判断——上面的 useLayoutEffect/useEffect 依赖 open 状态，
  // 提前 return 必须放在所有 hook 调用之后（同 ComposerModePicker 的写法）。
  if (!hasMessages) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="技能"
        title="技能"
        className={
          'flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground/80 ring-1 ring-black/[0.06] transition-colors hover:bg-foreground/[0.06] hover:text-foreground dark:ring-white/[0.08] ' +
          (open ? 'bg-foreground/[0.06] text-foreground' : '')
        }
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
          <path d="M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4Z" />
        </svg>
      </button>

      {anchor !== null &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={menuRef}
                initial={{ opacity: 0, y: 4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                style={{ left: anchor.left, bottom: anchor.bottom }}
                // 毛玻璃化（2026-07-19，用户点名要求）：同重命名弹窗/dropdown-
                // menu 那套配方——bg-card/55 + backdrop-blur-xl + backdrop-
                // saturate-150 + backdrop-brightness-125，border 换固定
                // border-white/15 + inset 顶部高光，原来是完全不透明的
                // bg-card，零 blur。
                className="fixed z-[9999] mb-1.5 flex w-[340px] flex-col overflow-hidden rounded-2xl border border-white/15 bg-card/55 shadow-[0_24px_80px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-100 dark:backdrop-brightness-125"
                role="listbox"
              >
                {/* 搜索框 */}
                <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-3">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0 text-muted-foreground/60"
                    aria-hidden
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  <input
                    ref={searchInputRef}
                    data-slot="skill-picker-search"
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onSearchKeyDown}
                    placeholder="搜索技能"
                    className="w-full min-w-0 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/50"
                  />
                </div>

                {/* 列表 */}
                <div className="max-h-[320px] overflow-y-auto py-1.5">
                  {filtered.length === 0 ? (
                    <div className="px-3.5 py-6 text-center text-[13px] text-muted-foreground/60">
                      没有匹配的技能
                    </div>
                  ) : (
                    filtered.map((entry, i) => (
                      <button
                        key={entry.value}
                        type="button"
                        data-slot="skill-picker-item"
                        role="option"
                        aria-selected={i === highlighted}
                        onMouseEnter={() => setHighlighted(i)}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          choose(entry)
                        }}
                        className={
                          'flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors ' +
                          (i === highlighted ? 'bg-muted' : '')
                        }
                      >
                        <SkillChipIcon
                          src={entry.spec.image}
                          size={20}
                          className="mt-0.5"
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-[13.5px] font-medium text-foreground">
                            {entry.spec.label ?? entry.value}
                          </span>
                          {entry.spec.description && (
                            <span className="truncate text-[12px] text-muted-foreground/70">
                              {entry.spec.description}
                            </span>
                          )}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </div>
  )
}

/**
 * 模型目录的 window 级共享缓存（2026-07-05 加，治「点开才 loading 不丝滑」）。
 *
 * listModels() 对整个 window 返回同一份目录（不随会话变），main 侧还有 TTL
 * 缓存。原来每个 ComposerModelChip 只在 open 时才 fetch，首次点开必等一次
 * 网络往返 → 「加载模型列表…」loading。这里把结果提到模块级：
 *  - 首个实例挂载即预取（prefetchModels），填充 modelCache；
 *  - 组件 state 用 modelCache 做初值，命中即首帧就有数据、点开零 loading；
 *  - 切会话 composer 重挂载也共享同一份缓存，不重复拉。
 * 只缓存成功结果；失败不写缓存（下次实例照常重试），也不吞错误（open 时的
 * fetch 兜底仍会把 error 显示出来）。
 */
let modelCache: string[] | null = null
let modelPrefetch: Promise<void> | null = null

function prefetchModels(): void {
  // 已有缓存或正在预取就不重复发起。
  if (modelCache !== null || modelPrefetch !== null) return
  const api = typeof window !== 'undefined' ? window.chatApi : undefined
  if (!api?.listModels) return
  modelPrefetch = api
    .listModels()
    .then((res) => {
      if (res.models.length > 0) modelCache = res.models
    })
    .catch(() => {
      // 预取失败静默——open 时的 fetch 会重试并负责显示错误。
    })
    .finally(() => {
      modelPrefetch = null
    })
}

/**
 * 模型展示元数据（2026-07-05 富菜单重设计）——按后端返回的真实模型 id 补齐
 * 图标 / 友好名 / 一句话描述 / 上下文窗口 / 消耗倍率，驱动富菜单每一行 + hover
 * 详情卡。**未在表内的 id 走 fallback**（default meta：id 原样当名、通用图标、
 * 无倍率徽章），保证后端加新模型也不会漏显、不报错。
 *
 * ⚠️ rate（倍率）目前是**前端静态占位**：当前后端 listModels() 只返回 id 字符串，
 * 没有计费/折扣数据。等后端就绪（gateway 返回真实倍率/折扣/低峰时段）再把这里
 * 换成数据驱动。图标用极简几何占位（无品牌 svg 资源，按 design 铁律用占位不乱画
 * 假图标）。'auto' 段（default）单列在菜单顶部，与具名模型用分隔线隔开（图 2）。
 */
interface ModelMeta {
  /** 友好显示名（chip + 菜单行）。 */
  name: string
  /** 是否 auto 智能挡（菜单里单列顶部）。 */
  auto?: boolean
}

// 按「模型家族」键。1m 变体的 name 后缀由 modelMetaOf 动态加，不各写一份，
// 避免 haiku/haiku[1m]/完整 id 三份漂移。
const MODEL_META: Record<string, ModelMeta> = {
  default: { name: 'Auto', auto: true },
  opus: { name: 'Opus 4.8' },
  sonnet: { name: 'Sonnet 5' },
  haiku: { name: 'Haiku 4.5' },
  fable: { name: 'Fable 5' }
}

/**
 * 归一化模型 id → { family, is1m }（2026-07-05「chip 完整 id 与菜单短别名对不
 * 上、选中无勾」实锤修复）。
 *
 * 背景：同一模型有多种 id 写法——菜单来自 listModels 的短别名（`haiku` /
 * `opus[1m]` / `claude-fable-5[1m]`），chip 来自 system init 报的**完整 id**
 * （`claude-haiku-4-5-20251001`）。两者字符串不等 → chip 走 fallback 显裸 id、
 * 菜单选中判断 `id===current` 恒 false（无勾）。归一化按**家族子串**把两种写法
 * 收敛到同一 key，让 meta 查找 + 选中比较都对得上；`[1m]` / `1m` 检出 context
 * 变体，给友好名 / context 动态加「· 1M」后缀。未识别家族返回 raw（走 fallback）。
 */
function normalizeModelId(id: string): { family: string; is1m: boolean } {
  const lower = id.toLowerCase()
  const is1m = /\[1m\]|-1m\b|1m$/.test(lower)
  const family =
    lower.includes('fable')
      ? 'fable'
      : lower.includes('haiku')
        ? 'haiku'
        : lower.includes('opus')
          ? 'opus'
          : lower.includes('sonnet')
            ? 'sonnet'
            : lower === 'default' || lower.includes('auto')
              ? 'default'
              : id // 未识别：原样，走 fallback
  return { family, is1m }
}

/**
 * 取模型元数据（按归一化家族查）。1m 变体在家族 meta 上叠加 name 加「· 1M」。
 * 未知家族走 fallback（id 原样当名）。
 */
function modelMetaOf(id: string): ModelMeta {
  const { family, is1m } = normalizeModelId(id)
  const base = MODEL_META[family]
  if (!base) {
    return { name: id }
  }
  if (is1m && !base.auto) {
    return { ...base, name: `${base.name} · 1M` }
  }
  return base
}

/** 两个 model id 是否指同一模型（归一化家族 + 1m 变体都相等）。 */
function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const na = normalizeModelId(a)
  const nb = normalizeModelId(b)
  return na.family === nb.family && na.is1m === nb.is1m
}

/**
 * 模型 chip — the composer footer's model switcher (moved into the in-card
 * toolbar's right cluster, left of mic/send — 2026-07-05). Shows the session's
 * current model as a friendly name + glyph, and opens an upward dropdown
 * (portal'd to body to escape the composer card's overflow-hidden clip): a
 * plain-text list with a right-aligned checkmark on the selected row and an
 * Auto row split off on top (2026-07-19 restyle to match a flatter reference
 * design — dropped the per-row icon/rate badge and the hover detail card).
 * Prefetch primes the catalog so opening is instant. Picking an id calls
 * MODEL_SET (live + future default); the label flips optimistically
 * (`pending`) until sessionMeta catches up.
 *
 * 二级弹出结构：点开 chip 先弹一级面板，只有「模型」一行摘要（当前值 +
 * 箭头）；点这一行才在一级面板*左侧*再弹一个二级面板显示模型列表（chip 贴
 * 窗口右边，参考设计里二级面板是往右弹——这里镜像成往左，否则出屏）。二级
 * 面板的锚点由 `menuRef`（一级面板）的实测 rect 动态算，不是写死偏移，一级
 * 面板高度随内容变也能跟上。选中某一项两级面板一起关（沿用 choose 里的
 * setOpen(false)）。
 */
function ComposerModelChip({
  model
}: {
  model?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // 初值取共享缓存：命中则首帧就有列表，点开零 loading。
  const [models, setModels] = useState<string[] | null>(() => modelCache)
  const [listError, setListError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  // 二级面板当前展开哪个维度；null = 只显示一级摘要面板。
  const [activeSection, setActiveSection] = useState<'model' | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const secondaryMenuRef = useRef<HTMLDivElement | null>(null)
  // 菜单 portal 到 body 后用 fixed 定位（脱离 composer 卡片 overflow-hidden
  // 裁剪，同姊妹 picker）。右对齐：菜单右缘贴按钮右缘。
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(
    null
  )
  // 二级面板锚点：贴一级面板左侧（+8px 间隙），底缘对齐一级面板底缘。不在
  // 关闭时清空——留着旧值让 AnimatePresence 退场动画有个稳定位置可以播完，
  // 同 anchor 的既有惯例（见下面 useEffect 只清 activeSection 不清这个）。
  const [secondaryAnchor, setSecondaryAnchor] = useState<{
    right: number
    bottom: number
  } | null>(null)

  // 打开时测按钮 rect 换算 fixed 锚点；滚动/缩放跟随。
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const b = btnRef.current?.getBoundingClientRect()
      if (b)
        setAnchor({
          right: window.innerWidth - b.right,
          bottom: window.innerHeight - b.top
        })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  // 一级面板收起（chip 关闭）时二级也跟着收起，下次点开总是从摘要面板起。
  // 不清 secondaryAnchor：留最后一次测量值，退场动画期间二级面板位置不跳。
  useEffect(() => {
    if (!open) setActiveSection(null)
  }, [open])

  // 二级面板紧贴一级面板左侧——一级面板高度随「模型」/「推理强度」两行摘要
  // 固定不变，但仍按一级面板的实测 rect 算（不写死偏移），跟 anchor 那套
  // 测量逻辑保持一致，扛得住字体/缩放差异。
  useLayoutEffect(() => {
    if (activeSection === null) return
    const measureSecondary = (): void => {
      const r = menuRef.current?.getBoundingClientRect()
      if (r)
        setSecondaryAnchor({
          right: window.innerWidth - r.left + 8,
          bottom: window.innerHeight - r.bottom
        })
    }
    measureSecondary()
    window.addEventListener('scroll', measureSecondary, true)
    window.addEventListener('resize', measureSecondary)
    return () => {
      window.removeEventListener('scroll', measureSecondary, true)
      window.removeEventListener('resize', measureSecondary)
    }
  }, [activeSection])

  // 挂载即预取模型目录（不等 open）：填充共享缓存，让首次点开也零 loading。
  // 若缓存已在（别的实例先预取过 / 本实例初值已命中），prefetchModels 内部
  // 早退；预取完成后把缓存同步进本实例 state（本实例初值 miss 但预取赶上的
  // 场景）。cancelled 守卫防卸载后 setState。
  useEffect(() => {
    if (models !== null) return
    prefetchModels()
    let cancelled = false
    // 预取的 promise 完成后（modelPrefetch 变 null），把缓存同步进来。
    void Promise.resolve(modelPrefetch).then(() => {
      if (!cancelled && modelCache !== null) setModels(modelCache)
    })
    return () => {
      cancelled = true
    }
  }, [models])

  // 切 CLI backend（fusion-code↔system claude）后模型目录整套换（gpt↔Claude）。
  // main 在 restartRuntimesForBackendChange 里 emit sessionMetaChanged，这里借
  // 它清模块级缓存 + 重拉：新旧列表不同才先 setModels(null)（触发骨架屏过渡），
  // 避免旧列表「啪」地跳成新列表（2026-07-05 用户要求）。相同则静默不闪。
  useEffect(() => {
    const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined
    if (!chatApi?.onSessionMetaChanged) return
    let cancelled = false
    const unsub = chatApi.onSessionMetaChanged(() => {
      void chatApi
        .listModels()
        .then((res) => {
          if (cancelled) return
          const next = res.models
          modelCache = next.length > 0 ? next : modelCache
          setModels((prev) => {
            const changed =
              prev === null ||
              prev.length !== next.length ||
              prev.some((id, i) => id !== next[i])
            if (!changed) return prev
            // 列表变了：先 null 一帧走骨架屏，微任务后填新列表。
            queueMicrotask(() => {
              if (!cancelled) setModels(next)
            })
            return null
          })
        })
        .catch(() => {
          /* 重拉失败保留旧列表，不打扰 */
        })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Same popover bookkeeping as ComposerModePicker: hold the composer blur
  // strip closed while open + dismiss on outside click / Escape. 菜单已 portal
  // 到 body（不在 rootRef 子树）——点击既不在按钮壳也不在菜单里才关闭。
  useEffect(() => {
    if (!open) return
    const overlay = useComposerOverlayStore.getState()
    overlay.setOpen(true)
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      const inRoot = rootRef.current?.contains(target)
      // 二级面板是独立 portal 出去的兄弟节点，不在 menuRef 子树里——两个都要
      // 判，漏一个会导致点二级面板选项时先被 mousedown 关掉，click 追不上
      // （元素已经从 DOM 摘掉），选不中。
      const inMenu =
        Boolean(menuRef.current?.contains(target)) ||
        Boolean(secondaryMenuRef.current?.contains(target))
      if (!inRoot && !inMenu) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      overlay.setOpen(false)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Fetch the catalog on open to keep it fresh (prefetch already primed it,
  // so there's usually no visible loading). Main's TTL cache makes this cheap;
  // a failed fetch still returns the last good list (stale beats empty), so
  // only a genuinely empty result shows the error row. 成功结果回写共享缓存，
  // 后续新挂载的实例首帧即命中。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.chatApi
      .listModels()
      .then((res) => {
        if (cancelled) return
        if (res.models.length > 0) modelCache = res.models
        setModels(res.models)
        setListError(res.models.length === 0 ? (res.error ?? '模型列表为空') : null)
      })
      .catch((err) => {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Engine reflects a pick into SessionMeta.model and broadcasts — once the
  // prop catches up (or a system init reports a different truth), the
  // optimistic label retires.
  useEffect(() => {
    setPending(null)
  }, [model])

  const current = pending ?? model
  const choose = (id: string): void => {
    setOpen(false)
    // 归一化比较：current 可能是 system init 报的完整 id、id 是菜单短别名，
    // 同一模型不同写法要判等，避免「切到自己」多发一次 setModel。
    if (sameModel(id, current)) return
    setPending(id)
    void window.chatApi.setModel(id).catch((err) => {
      console.error('[Composer] setModel failed', err)
      setPending(null)
    })
  }

  // chip 上显示当前模型的友好名（未知 id 原样）。
  const currentMeta = current ? modelMetaOf(current) : null
  const modelLabel = currentMeta?.name ?? current ?? '模型'
  // 菜单分两组：auto 挡（default）单列顶部，具名模型在下，虚线分隔。
  const list = models ?? []
  const autoIds = list.filter((id) => modelMetaOf(id).auto)
  const namedIds = list.filter((id) => !modelMetaOf(id).auto)

  const renderRow = (id: string): React.JSX.Element => {
    // 归一化比较：current（完整 id）与菜单行 id（短别名）指同一模型才打勾。
    const selected = sameModel(id, current)
    const meta = modelMetaOf(id)
    return (
      <button
        key={id}
        data-slot="model-option"
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => choose(id)}
        className={
          'flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[13.5px] transition-colors ' +
          (selected ? 'font-medium text-foreground' : 'text-foreground/90 hover:bg-foreground/[0.05]')
        }
      >
        <span className="min-w-0 flex-1 truncate" title={meta.name}>
          {meta.name}
        </span>
        {/* 选中态：纯文本行 + 右侧对勾（参照目标设计），不再用左侧实心圆勾图标。 */}
        {selected ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : null}
      </button>
    )
  }

  // 一级面板的摘要行——目前只有「模型」一行，label + 当前值 + 箭头，
  // 点击展开/收起二级面板。
  const renderSectionRow = (
    section: 'model',
    label: string,
    value: string
  ): React.JSX.Element => {
    const active = activeSection === section
    return (
      <button
        key={section}
        data-slot="model-section-row"
        type="button"
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={active}
        onClick={() => setActiveSection((s) => (s === section ? null : section))}
        className={
          'flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left text-[13.5px] transition-colors ' +
          (active ? 'bg-foreground/[0.05] text-foreground' : 'text-foreground hover:bg-foreground/[0.05]')
        }
      >
        <span>{label}</span>
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <span className="max-w-[6.5rem] truncate" title={value}>
            {value}
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </button>
    )
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* chip：图标 + 友好名 + 下拉箭头（图 1）。放在卡片内右簇、麦克风左侧。 */}
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="切换模型"
        className={
          'flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[13px] transition-colors ' +
          (open
            ? 'text-foreground'
            : 'text-muted-foreground/80 hover:bg-foreground/[0.05] hover:text-foreground')
        }
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3 2.3 6.2L21 11l-6.7 1.8L12 19l-2.3-6.2L3 11l6.7-1.8z" />
        </svg>
        {/* max-w 160→6rem(96px)（2026-07-17 用户实锤截图：模型名把 toolbar
            撑到挤掉状态 pill）。160px 形同虚设——`gpt-5.2-pro-2025-12-11`
            实测自然宽度才 145px，够不着阈值，整个 chip 吃掉 200px。
            96px 的由来：长 id 的信息在**前缀**（`gpt-5.2-pro` 是标识，
            `-2025-12-11` 是日期噪音），截成「gpt-5.2-pro-…」关键部分不丢；
            同时短名不受影响——`Sonnet 5`≈53px、`gpt-5.6-terra`≈86px 都在
            阈值内不截断（实测每字符 6.6px）。
            title 是截断的配套，不是可选项：截了就必须能 hover 看全名，
            同菜单行 `title={meta.name}` 的既有惯例。 */}
        <span className="max-w-[6rem] truncate leading-none" title={modelLabel}>
          {modelLabel}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={'text-muted-foreground/50 transition-transform ' + (open ? 'rotate-180' : '')} aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* 一级面板 portal 到 body（脱离 composer 卡片 overflow-hidden 裁剪，同
          姊妹 picker）；fixed 定位，右缘贴按钮右缘、底缘贴按钮顶缘上方。只有
          「模型」一行摘要，点行才在左侧弹二级面板。 */}
      {anchor !== null &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={menuRef}
                initial={{ opacity: 0, y: 4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                style={{ right: anchor.right, bottom: anchor.bottom }}
                className="fixed z-[9999] mb-2 w-64 overflow-hidden rounded-2xl border border-border bg-card p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
                role="menu"
              >
                {renderSectionRow('model', '模型', modelLabel)}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}

      {/* 二级面板——「模型」的可选项列表，贴一级面板左侧弹出（chip 靠窗口
          右边，参考设计里二级面板本是往右弹，这里镜像成往左，不然直接出屏）。
          挂载 = 独立于一级面板的另一个 portal；secondaryAnchor 的测量见上面
          useLayoutEffect。 */}
      {secondaryAnchor !== null &&
        createPortal(
          <AnimatePresence>
            {activeSection !== null && (
              <motion.div
                ref={secondaryMenuRef}
                initial={{ opacity: 0, x: 4, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 4, scale: 0.98 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                style={{ right: secondaryAnchor.right, bottom: secondaryAnchor.bottom }}
                className="fixed z-[9999] w-64 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
                role="listbox"
              >
                <div className="border-b border-border px-3.5 py-2.5 text-[12px] font-medium text-muted-foreground">
                  模型
                </div>

                {models === null && listError === null ? (
                  // 骨架屏（2026-07-05 用户要求：切 backend 列表突变太生硬）——
                  // 纯文本行的宽度脉冲条。首次打开（有预取缓存）通常直接跳过
                  // loading，这里主要覆盖切 backend 后缓存失效重拉的空窗。
                  <div className="flex flex-col gap-1 p-1.5">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <div key={i} className="flex items-center rounded-lg px-3 py-2.5">
                        <span
                          className="h-3.5 animate-pulse rounded bg-foreground/[0.06]"
                          style={{ width: `${[55, 40, 62, 46, 38][i]}%` }}
                        />
                      </div>
                    ))}
                  </div>
                ) : listError !== null ? (
                  <div className="px-4 py-3 text-[12.5px] text-muted-foreground">{listError}</div>
                ) : (
                  // 高度上限 + 超出滚动（2026-07-05 用户要求）：模型多时（后端
                  // 返 12+ 个）菜单 bottom-full 向上弹会撑出屏幕外。max-h 取
                  // min(60vh, 420px)（不超视口 60% 也不超 420px，够放约 8-9 行），
                  // overflow-y-auto 让超出部分内部滚动。外层菜单壳 overflow-hidden
                  // 只管圆角裁剪，与此内层滚动不冲突。
                  <div className="max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain p-1.5">
                    {/* auto 组（顶部，虚线分隔） */}
                    {autoIds.length > 0 ? (
                      <>
                        {autoIds.map(renderRow)}
                        {namedIds.length > 0 ? (
                          <div className="mx-2.5 my-1 border-t border-dashed border-border" />
                        ) : null}
                      </>
                    ) : null}
                    {/* 具名模型组 */}
                    {namedIds.map(renderRow)}
                    {/* 注：图 2 底部有「模型设置 >」入口，但设置页当前无独立
                        模型 section、chatApi 也无干净的「跳 section」方法——先不
                        放这个入口，等补了模型设置页再加，避免指向空处。 */}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </div>
  )
}

/**
 * 工作目录 chip（composer 卡片下方那排的第一个）。任何会话都可改
 * （2026-07-07 实测验证迁移方案后放开）：
 *
 *   - 新会话：选中经 SESSION_WORKSPACE_SET 记为预选，首次 send 烘焙进
 *     子进程 cwd。
 *   - 已有记录的会话：main 侧迁移 transcript 到新目录（历史无损，之后
 *     按新 cwd resume）。菜单顶部对这类会话显示一行迁移提示。
 *   - 只读态仅两种：本轮对话正在进行（child 正在写 transcript，main
 *     也会拒绝）、或当前无会话。
 *
 * 展示规则：默认工作区显示「桌面」，其余显示目录 basename。菜单 portal
 * 到 body + fixed 定位（同 PermissionModePicker：躲 Composer 卡片的
 * overflow 裁剪；portal 子树脱离 .chat-app 豁免，行按钮必须带 data-slot
 * 逃逸 canvas 裸 button reset）。
 */
function WorkspaceDirPicker(): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  const sessionId = useChatStore((s) => s.sessionId)
  const hasMessages = useChatStore((s) => s.messages.length > 0)
  const streaming = useChatStore((s) => s.streaming)
  const defaultWorkspace = useWorkspaceStore((s) => s.current)
  const lockedPath = useWorkspaceStore((s) =>
    sessionId ? s.sessionWorkspaces[sessionId] : undefined
  )
  const pendingPath = useWorkspaceStore((s) =>
    sessionId ? s.pendingChoices[sessionId] : undefined
  )
  const switchingPath = useWorkspaceStore((s) =>
    sessionId ? s.switching[sessionId] : undefined
  )
  const chooseForSession = useWorkspaceStore((s) => s.chooseForSession)

  const [open, setOpen] = useState(false)
  const [known, setKnown] = useState<readonly string[]>([])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 左对齐锚点（菜单左缘贴 chip 左缘，向上弹）——PermissionModePicker 是
  // 右对齐（right 锚点），本 chip 在行首，用 left + bottom。
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
    null
  )

  // 已有对话记录 → 换目录走 main 的迁移路径，菜单里给一行提示。
  const hasHistory = hasMessages || Boolean(lockedPath)
  // 只读：本轮进行中（child 正在写 transcript，main 也会拒绝）或无会话。
  const readonly = streaming || !sessionId
  // 展示优先级：预选（用户刚选的乐观值，迁移后也是它）→ 磁盘归属镜像
  // → 默认工作区。
  const displayPath = pendingPath ?? lockedPath ?? defaultWorkspace
  const nameFor = (p: string): string =>
    p === defaultWorkspace
      ? zh ? '桌面' : 'Desktop'
      : p.split(/[\\/]/).filter(Boolean).pop() ?? p
  // 菜单行的路径胶囊（2026-07-16 重设计，docs/ui-prototype-workspace-
  // picker-v2.html 的 V3「胶囊」变体落地）：完整绝对路径的噪音太大
  // （/Users/xxx/ 前缀每行重复一遍，把面板撑得又高又宽——用户实锤
  // 「太丑」），压缩成「父目录尾两段」的 mono 小胶囊，全路径留给行
  // title 的 hover tooltip。home 前缀从 defaultWorkspace（main 侧恒为
  // 「桌面」目录）反推——推不出（非标准桌面路径）就不做 ~ 替换，胶囊
  // 退化为真实尾段，无害。
  const homePrefix = defaultWorkspace
    ? /^(.*)[\\/](?:Desktop|桌面)$/.exec(defaultWorkspace)?.[1] ?? null
    : null
  const parentCapsule = (p: string): string => {
    const t =
      homePrefix && p.startsWith(homePrefix) ? `~${p.slice(homePrefix.length)}` : p
    const parent = t.split(/[\\/]/).filter(Boolean).slice(0, -1)
    if (parent.length <= 1) return parent[0] ?? '~'
    return parent.slice(-2).join('/')
  }
  const label =
    displayPath === null
      ? zh ? '选择工作目录' : 'Choose folder'
      : nameFor(displayPath)

  // 切换结束后的一拍反馈（B 胶囊方案，原型 docs/ui-prototype-workspace-
  // picker.html）：done → 品牌绿胶囊 1.2s；fail → chip 回落 + 轻抖 +
  // 红字 2.4s 淡出。成败判定不走异常通道（choose 的 catch 只 console.warn，
  // 不好从那里回传 UI 态），而是看 switching 清掉那一刻乐观镜像是否已落到
  // 目标路径——store 只在 IPC 成功时写 pendingChoices，判据与 main 的真实
  // 结果同源。
  const [flash, setFlash] = useState<{
    kind: 'done' | 'fail'
    path: string
  } | null>(null)
  const prevSwitchRef = useRef<{
    sid: string | null
    path: string | undefined
  }>({ sid: null, path: undefined })
  useEffect(() => {
    const prev = prevSwitchRef.current
    prevSwitchRef.current = { sid: sessionId, path: switchingPath }
    if (prev.sid !== sessionId) {
      // 换了前台会话：上一条记录属于别的会话，不做成败判定，清掉残留。
      setFlash(null)
      return
    }
    if (prev.path === undefined || switchingPath !== undefined || !sessionId)
      return
    const succeeded =
      useWorkspaceStore.getState().pendingChoices[sessionId] === prev.path
    setFlash({ kind: succeeded ? 'done' : 'fail', path: prev.path })
    const timer = setTimeout(() => setFlash(null), succeeded ? 1200 : 2400)
    return () => clearTimeout(timer)
  }, [switchingPath, sessionId])

  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const b = btnRef.current?.getBoundingClientRect()
      if (b)
        setAnchor({
          left: b.left,
          bottom: window.innerHeight - b.top
        })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  // 打开时拉一次已知工作区列表（[0] 恒为默认/桌面）。量级个位数，
  // 每次现拉即可，不做缓存。
  useEffect(() => {
    if (!open || !window.chatApi) return
    let cancelled = false
    window.chatApi
      .listKnownWorkspaces()
      .then((r) => {
        if (!cancelled) setKnown(r.workspaces)
      })
      .catch((err) => console.warn('[workspacePicker] known list failed', err))
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const overlay = useComposerOverlayStore.getState()
    overlay.setOpen(true)
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      const inRoot = rootRef.current?.contains(target)
      const inMenu = menuRef.current?.contains(target)
      if (!inRoot && !inMenu) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      overlay.setOpen(false)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = useCallback(
    (path: string) => {
      setOpen(false)
      // switchingPath 挡二次触发：在途时 chip 已换成 loading 态摸不到菜单，
      // 但 browse 的系统对话框是异步的，可能在切换开始后才回调进来。
      if (!sessionId || switchingPath !== undefined) return
      void chooseForSession(sessionId, path).catch((err) => {
        // main 拒绝（竞态下会话刚落盘 transcript / 路径失效）。下一次
        // listSessions 镜像会把 chip 翻成锁定态，这里不弹错误打断输入。
        console.warn('[workspacePicker] chooseForSession failed', err)
      })
    },
    [sessionId, switchingPath, chooseForSession]
  )

  const browse = useCallback(() => {
    void (async () => {
      if (!window.chatApi) return
      try {
        const { path } = await window.chatApi.pickWorkspace()
        if (path) choose(path)
        else setOpen(false)
      } catch (err) {
        console.warn('[workspacePicker] pickWorkspace failed', err)
        setOpen(false)
      }
    })()
  }, [choose])

  const folderIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )

  // 三个非交互态（切换在途/切换成功一拍/只读）共用的胶囊壳（2026-07-19）：
  // 之前这仨是裸 flex span，紧挨着已经玻璃化的交互态胶囊摆在同一排时，
  // 流状态切过来会突然掉回没有边框/底色的纯文字，一眼看出「这里坏了」
  // （用户实锤截图，流式回复期间 readonly 态正是这样）。跟交互按钮同一套
  // h-7 + border-white/15 + bg-card/50 + 满配方玻璃，只是没有 hover/群组态。
  const staticChipClass =
    'inline-flex h-7 items-center gap-1.5 rounded-full border border-white/15 bg-card/50 px-2.5 text-[12px] text-muted-foreground/70 shadow-[0_1px_2px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.4)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-125'

  // 切换在途（C 搬家，原型 docs/ui-prototype-workspace-picker.html）：
  // 三粒点在源/目标两个文件夹图标之间依次流动——把「transcript 在物理
  // 搬家」讲成故事，非交互。已有记录的会话换目录要 teardown 子进程 +
  // 搬 transcript，几百 ms 到数秒可感知——没有反馈用户会连点或以为没
  // 生效。flag 成败都会清（见 workspace store）。文案按是否真在搬记录
  // 分「搬」/「切换」两说。
  if (switchingPath !== undefined) {
    return (
      <span
        className={staticChipClass}
        title={switchingPath}
        aria-busy="true"
      >
        <span className="inline-flex items-center gap-[3px]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span className="mx-[3px] inline-flex gap-[3px]" aria-hidden="true">
            <span className="ws-move-dot size-[3px] rounded-full bg-muted-foreground/80" />
            <span className="ws-move-dot size-[3px] rounded-full bg-muted-foreground/80" />
            <span className="ws-move-dot size-[3px] rounded-full bg-muted-foreground/80" />
          </span>
          <span className="text-foreground/75">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </span>
        </span>
        {zh
          ? hasHistory
            ? `正在把对话搬到「${nameFor(switchingPath)}」…`
            : `正在切换到「${nameFor(switchingPath)}」…`
          : hasHistory
            ? `Moving this chat to “${nameFor(switchingPath)}”…`
            : `Switching to “${nameFor(switchingPath)}”…`}
      </span>
    )
  }

  // 切换成功的一拍确认：目标位弹一下换成品牌绿勾，1.2s 后由 flash 计时器
  // 收回。刻意排在 readonly 之前——刚切完立刻发消息进入 streaming 时，
  // 确认拍照常走完。
  if (flash?.kind === 'done') {
    return (
      <span
        className={staticChipClass}
        title={flash.path}
      >
        <span className="inline-flex items-center gap-[3px]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span className="mx-[3px] inline-flex gap-[3px]" aria-hidden="true">
            <span className="ws-move-dot size-[3px] rounded-full bg-muted-foreground/80" />
            <span className="ws-move-dot size-[3px] rounded-full bg-muted-foreground/80" />
            <span className="ws-move-dot size-[3px] rounded-full bg-muted-foreground/80" />
          </span>
          <span className="ws-dest-pop text-brand">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
        </span>
        {zh
          ? hasHistory
            ? `已搬到「${nameFor(flash.path)}」`
            : `已切到「${nameFor(flash.path)}」`
          : `Moved to “${nameFor(flash.path)}”`}
      </span>
    )
  }

  // 只读态（本轮进行中 / 无会话）：纯展示。hover 之前只给全路径，灰底
  // 看着像坏了却猜不出原因（2026-07-19 用户实锤）——改成先说明「为什么
  // 点不动」，路径信息跟在后面保留，两个只读成因文案不同（进行中 vs
  // 压根没有会话）。
  if (readonly) {
    const reason = streaming
      ? zh
        ? '对话进行中，暂时无法切换工作区'
        : "Chat is running — can't switch workspace right now"
      : zh
        ? '暂无对话，无法切换工作区'
        : 'No active chat to switch workspace for'
    return (
      <span
        className={staticChipClass}
        title={displayPath ? `${reason} · ${displayPath}` : reason}
      >
        {folderIcon}
        {label}
      </span>
    )
  }

  return (
    <div ref={rootRef} className="relative flex items-center gap-2.5">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={zh ? '选择工作目录' : 'Choose working folder'}
        title={displayPath ?? undefined}
        // 2026-07-19 补一颗真正的按钮壳：此前是裸文字+图标贴在壁纸上，没有
        // 任何可点击affordance，跟右侧 PermissionModePicker 的胶囊比显得很
        // 「没做完」。中间两版 /70+blur-sm、/55+blur-md 真机逐像素采样过都太
        // 弱（胶囊底色跟壁纸只差个位数 RGB），跟 PermissionModePicker 同步
        // 换成大弹层那套满配方：blur-xl + brightness-125 + border-white/15 +
        // inset 顶部高光，理由见该组件同处更长注释。h-7 显式定高——12px 字号
        // 撑出的行高跟 PermissionModePicker 的 11px 不一样，py-1 撑高会让两颗
        // 胶囊差 7px（实测 28 vs 21），锁 h-7 后两端对齐。
        // 2026-07-20：全项目其它 ~13 处同配方在补「亮色主题 brightness-125
        // 会把身后壁纸乘溢出到白」的 dark: 分流（见 dropdown-menu.tsx 头注释
        // 第四条）时，这颗胶囊、它的下拉面板（下方 anchor !== null 那处）与
        // staticChipClass（只读态镜像）三处刻意排除在外——上面这段注释就是
        // 反例：2026-07-19 真机逐像素采样明确验证过，这颗胶囊贴在壁纸上时
        // brightness-125 在亮色主题下同样是必要的、没有漂白问题（跟
        // PermissionModePicker 那颗同步测的），不能凭亮色主题 popover/card
        // 接近纯白这条通用推理就反过来改掉一个已经用真机验证过的具体反例。
        className={
          'group inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] shadow-[0_1px_2px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.4)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-125 transition-colors ' +
          'border-white/15 bg-card/50 text-muted-foreground hover:border-accent/50 hover:bg-card/75 hover:text-foreground ' +
          (open ? 'border-accent/60 text-foreground ' : '') +
          (flash?.kind === 'fail' ? 'ws-chip-shake' : '')
        }
      >
        {folderIcon}
        {label}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={
            'text-muted-foreground/40 transition-transform ' +
            (open ? 'rotate-180' : '')
          }
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* 切换失败：chip 已回落原目录（轻抖一下），红字点明「没切成」，
        * 2.4s 淡出（unmount 由 flash 计时器兜底），不弹窗打断输入。 */}
      {flash?.kind === 'fail' && (
        <span className="ws-fail-fade flex items-center gap-1 text-[12px] text-destructive">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          {zh
            ? `没切成，还留在「${label}」`
            : `Couldn't switch — still in “${label}”`}
        </span>
      )}

      {anchor !== null &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={menuRef}
                initial={{ opacity: 0, y: 4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                style={{ left: anchor.left, bottom: anchor.bottom }}
                // 毛玻璃化（2026-07-19），跟 PermissionModePicker 那颗独立
                // 手写弹层同一套配方——理由见该组件同处注释。
                className="fixed z-[9999] mb-1.5 w-72 overflow-hidden rounded-xl border border-white/15 bg-popover/55 p-[5px] shadow-[0_24px_80px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-125"
                role="listbox"
              >
                {/* 已有记录的会话：换目录 = main 侧迁移 transcript。一行
                  * 大白话说清后果，不弹确认框打断。 */}
                {hasHistory && (
                  <div className="px-2 pb-1.5 pt-1 text-[11px] leading-snug text-muted-foreground/70">
                    {zh
                      ? '更改后，这个对话和它的记录会搬到新文件夹继续。'
                      : 'Changing folders moves this chat and its history to the new folder.'}
                  </div>
                )}
                {/* 行形态 = 原型 V3「胶囊」（2026-07-16 用户定稿）：单行制
                  * ——名称为主 + 「默认」小 tag + 父目录尾两段的 mono 胶囊，
                  * 全路径进 title 走 hover tooltip（此前名称/全路径两行制，
                  * 面板被路径撑得又高又宽）。选中态做减法：绿勾（复用
                  * ws-dest-pop 弹入）+ 名称加重，退掉大块 brand/10 底色——
                  * 勾尾端恒占位（w-3.5 空槽），选中与否行内胶囊右缘对齐。 */}
                {known.map((path, i) => {
                  const isDef = i === 0
                  const name = isDef
                    ? zh ? '桌面' : 'Desktop'
                    : path.split(/[\\/]/).filter(Boolean).pop() ?? path
                  const selected = displayPath === path
                  return (
                    <button
                      key={path}
                      data-slot="workspace-option"
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => choose(path)}
                      title={path}
                      className={
                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover/70 ' +
                        (selected
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground')
                      }
                    >
                      <span className="shrink-0 opacity-60">{folderIcon}</span>
                      <span
                        className={
                          'min-w-0 flex-1 truncate text-[13px] ' +
                          (selected ? 'font-semibold' : '')
                        }
                      >
                        {name}
                      </span>
                      {isDef && (
                        <span className="shrink-0 rounded bg-muted px-[5px] py-px text-[10px] font-medium text-muted-foreground/85">
                          {zh ? '默认' : 'default'}
                        </span>
                      )}
                      <span className="max-w-[46%] shrink-0 truncate rounded-full bg-muted/75 px-1.5 py-px font-mono text-[10px] text-muted-foreground/80">
                        {parentCapsule(path)}
                      </span>
                      <span className="flex w-3.5 shrink-0 justify-center">
                        {selected && (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="ws-dest-pop text-brand"
                            aria-hidden
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                    </button>
                  )
                })}
                <div className="mx-2 my-1 border-t border-border/60" aria-hidden />
                <button
                  data-slot="workspace-option"
                  type="button"
                  onClick={browse}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-hover/70 hover:text-foreground"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="shrink-0 opacity-60" aria-hidden>
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <path d="M12 11v4M10 13h4" />
                  </svg>
                  {zh ? '选择其他文件夹…' : 'Browse…'}
                </button>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </div>
  )
}

/**
 * 知识库管理 chip——和上面的 ComposerBelowChip 视觉一致，但是真按钮：
 * 点击调用 openManager() 打开接管聊天区的 KbManagerView。
 * 在 .chat-app 子树内，裸 <button> 不受 canvas reset 影响；仍带 data-slot 以防万一。
 */
function ComposerKbChip({ label }: { label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      data-slot="button"
      onClick={() => useKbStore.getState().openManager()}
      className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
        <path d="M14 3v5h5M8 13h8M8 17h5" />
      </svg>
      {label}
    </button>
  )
}

/**
 * Highlight layer that sits *behind* the composer textarea and renders
 * the same text — but with slash commands (`/skill`) and file mentions
 * (`@src/index.ts`) swapped out for proper pill chips with an icon and
 * real horizontal padding.
 *
 * Alignment strategy
 * ------------------
 * Giving chips real width means overlay characters no longer sit on
 * top of the textarea's character columns, so the native caret would
 * drift off-screen from the visible text. We solve that by:
 *
 *   1. Painting the textarea's text transparent AND hiding its caret
 *      (`caret-color: transparent`).
 *   2. Tracking `selectionStart` via `onSelect` and passing it to this
 *      overlay as `caretPos`.
 *   3. Rendering our own blinking caret element at the right slot in
 *      the token stream — inserted *between* token spans so it
 *      inherits the overlay's actual layout (chip widths included).
 *
 * Because the caret is painted in the overlay's flow, it automatically
 * follows chips, line wraps, and padding without any pixel math.
 *
 * Snap-out behavior for chip interiors
 * ------------------------------------
 * If the user clicks mid-chip the composer's onSelect handler snaps
 * `selectionStart` to the closer chip edge before it reaches this
 * component, so we can treat chips as atomic: the caret never paints
 * inside a chip.
 */

/**
 * Mic button shown in the normal (non-dictating) composer row.
 *
 * `startDictation` is deferred to a microtask so the click event
 * finishes propagating BEFORE the state change happens. Without the
 * defer, React synchronously re-renders during the click, the
 * composer row swaps Normal → Dictation mid-click, and whatever
 * element lands at the old mic position can receive a secondary
 * click — exactly the race that kept auto-cancelling the session
 * before. `queueMicrotask` is bulletproof because JS's event loop
 * guarantees microtasks run only after the current sync task
 * (which includes the full click dispatch) is done.
 */
function MicButton({ label }: { label: string }): React.JSX.Element {
  const runtime = useComposerRuntime()
  const onClick = useCallback(() => {
    queueMicrotask(() => {
      runtime.startDictation()
    })
  }, [runtime])
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v4" />
        <path d="M8 22h8" />
      </svg>
    </button>
  )
}

/**
 * Dictation-mode row content — live waveform filling the input slot
 * plus a cancel (X) and a confirm (✓) button on the right.
 *
 * Lifecycle:
 *  - This component mounts the instant dictation starts. On mount,
 *    it snapshots the composer text via `useRef` so that cancelling
 *    can revert to the pre-dictation state. (The first render is
 *    always at dictation start, so `composer.text` at mount == the
 *    original user text before any chunk commit.)
 *  - Confirm (✓): stops the session. Any chunks already transcribed
 *    stay in the composer text, and when this component unmounts
 *    the Normal row's textarea rematerializes populated.
 *  - Cancel (X): stops the session, then resets composer text to
 *    the snapshot. Drops any committed chunks.
 *
 * Both actions defer their runtime calls to `queueMicrotask` so the
 * click event finishes propagating before React's dictation-state
 * change tears down this row — exactly the same defense the mic
 * button uses.
 */
function DictationActiveControls({
  cancelLabel,
  confirmLabel
}: {
  cancelLabel: string
  confirmLabel: string
}): React.JSX.Element {
  const runtime = useComposerRuntime()
  // Latched "finishing" state — flips on the first X / ✓ click and
  // stays on until this component unmounts (which happens once
  // stopDictation resolves). While finishing, both buttons render
  // as disabled so a second click can't queue a duplicate
  // stopDictation call (the adapter guards that as well, but the
  // visual feedback stops users from mashing the button during the
  // 1-3s transcribe wait).
  const [isFinishing, setIsFinishing] = useState(false)

  const onCancel = useCallback(() => {
    if (isFinishing) return
    setIsFinishing(true)
    // True cancel — bypass `runtime.stopDictation()` because that
    // path always flushes the tail audio through Gemini and commits
    // the transcript into the composer. We want to throw away the
    // recorded audio without touching the textarea.
    //
    // `cancelActiveDictation()` calls `session.cancel()` on the
    // adapter, which tears down immediately with no transcribe. The
    // composer runtime's internal 100ms status poll will notice
    // `session.status === 'ended'` a few frames later and fire
    // `_cleanupDictation`, which drops the `composer.dictation` flag
    // — at which point this component unmounts and the normal
    // textarea row rematerializes showing the pre-dictation text
    // unchanged. No setText needed because this single-shot adapter
    // never commits anything until `stop()`, so `_text` is still
    // whatever it was when startDictation ran.
    queueMicrotask(() => {
      cancelActiveDictation()
    })
  }, [isFinishing])

  const onConfirm = useCallback(() => {
    if (isFinishing) return
    setIsFinishing(true)
    queueMicrotask(() => {
      runtime.stopDictation()
    })
  }, [isFinishing, runtime])

  return (
    <>
      <div className="flex min-h-[24px] max-h-40 flex-1 items-center overflow-hidden">
        <DictationWaveform />
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={isFinishing}
        aria-label={cancelLabel}
        title={cancelLabel}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={isFinishing}
        aria-label={confirmLabel}
        title={confirmLabel}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition hover:bg-foreground/90 disabled:cursor-wait"
      >
        {isFinishing ? (
          // Inline spinner while we wait for the tail transcribe to
          // land. Same animation Composer's attachments use
          // elsewhere — one stroke rotating around a dim ring.
          <svg
            className="size-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeOpacity="0.3"
            />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </button>
    </>
  )
}

/* ───────────── Composer attachment chip ────────────────────── */

/**
 * Single attachment chip in the composer's attachment row.
 *
 * Renders a thumbnail for image attachments plus a filename label and
 * a remove button. The thumbnail is read via `FileReader.readAsDataURL`
 * (not `URL.createObjectURL`) because:
 *
 *   1. **StrictMode safety** — useMemo + createObjectURL + useEffect
 *      cleanup is inherently racy (the mount→unmount→mount cycle of
 *      dev-mode re-invocation can revoke the URL before the second
 *      mount uses it, even though the memoized string is reused).
 *
 *   2. **Electron wire semantics** — in Electron 33, a File dropped
 *      from an external app (Finder, CleanShot, Preview) can carry
 *      a lazily-materialized blob body. blob: URLs sometimes fail to
 *      decode in that scenario, giving the `<img>` a broken-image
 *      icon even though `file.size` and `file.type` look correct.
 *      FileReader reads through to the underlying bytes synchronously
 *      and always produces a valid data URL.
 *
 *   3. **Symmetry with send()** — the adapter's send() path also
 *      reads to data URL, so the chip preview now matches what the
 *      model will actually receive. No chance of "chip shows X,
 *      model gets Y".
 *
 * The data URL is held in component state and cleared on unmount.
 * Unlike blob URLs there's nothing to revoke — data URLs are plain
 * strings and are garbage-collected with the component.
 *
 * Layout: a compact pill with the thumb on the left, name truncated
 * in the middle, and a floating ×-button in the top-right corner that
 * calls through to the adapter's remove() via AttachmentPrimitive.Remove.
 */
function ComposerAttachmentChip({
  attachment
}: {
  attachment: Attachment
}): React.JSX.Element {
  // Pending attachments carry a `file` field we can preview from.
  // Complete attachments (briefly, between send() finishing and
  // onNew firing) also retain the file field. Guard on file presence
  // and type — non-image attachments render as a generic chip.
  const file =
    'file' in attachment && attachment.file instanceof File
      ? attachment.file
      : null

  const isImage = attachment.type === 'image'

  // ── click-to-preview（2026-07-13）──────────────────────────────────
  // 点击 chip 主体在右栏打开预览：表格 → SpreadsheetPreviewPanel、图片 →
  // ImageEditPanel，与消息里 DeliverableCard / OutputsPanel 的 open() 分支
  // 完全同构（AssistantMessage.tsx ~L209），空白新会话也能开——两个面板在
  // ThreadView 里没有 empty gate，且 sessionId 在空态就已定死不会因首条
  // 发送而变。磁盘路径取 add() 时 stash 进 content 的 FILE_PATH_MIME
  // part（imageAttachmentAdapter），剪贴板粘贴的图片没有磁盘路径
  // （content 为空）→ chip 保持不可点，不能拿 blob 喂面板。
  const stashedPath = attachment.content?.find(
    (p): p is { type: 'file'; data: string; mimeType: string; filename?: string } =>
      p.type === 'file' && p.mimeType === FILE_PATH_MIME
  )
  const diskPath = stashedPath?.data ?? ''
  const ext = attachment.name.includes('.')
    ? attachment.name.split('.').pop()!.toLowerCase()
    : ''
  // 与 DeliverableCard 同一套判定：表格三件套进预览面板；图片只放 edit
  // API 认的格式（gif 只能看不能改，走系统应用）。
  const previewableSheet = ext === 'xlsx' || ext === 'xls' || ext === 'csv'
  const editableImage = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp'
  const splitBusy = useSplitWorkspaceBusy()
  const zh = useI18n((s) => s.lang) === 'zh'

  const openPreview = (): void => {
    if (!diskPath) return
    // slides/proposal 分栏时右栏被工作区占用、预览面板让位——降级回系统
    // 应用打开，点了必须有反应（与 DeliverableCard 的纪律一致）。其余
    // 不可预览的类型（pdf/docx/…）也走系统应用。
    if (previewableSheet && !splitBusy) {
      useSheetPreviewStore.getState().openPreview(diskPath)
      return
    }
    if (editableImage && !splitBusy) {
      useImageEditStore.getState().openEditor(diskPath)
      return
    }
    void window.chatApi.openPath({ absPath: diskPath })
  }

  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    // Only images get a thumbnail preview. Reading a non-image file
    // (which could be hundreds of MB) into a data URL would waste
    // memory for a preview we never render — the file chip shows the
    // name + a generic glyph instead.
    if (!file || !isImage) {
      setPreviewURL(null)
      setPreviewError(null)
      return
    }

    let cancelled = false
    const reader = new FileReader()
    reader.onload = () => {
      if (cancelled) return
      if (typeof reader.result === 'string') {
        setPreviewURL(reader.result)
      } else {
        setPreviewError('FileReader returned non-string')
      }
    }
    reader.onerror = () => {
      if (cancelled) return
      setPreviewError(reader.error?.message ?? 'FileReader error')
    }
    reader.readAsDataURL(file)

    return () => {
      cancelled = true
      // FileReader.abort() is safe even if the read already completed.
      try {
        reader.abort()
      } catch {
        // abort can throw DOMException if already done — ignore
      }
    }
  }, [file, isImage])

  return (
    <AttachmentPrimitive.Root className="group/att relative flex items-center rounded-lg border border-border bg-card/60 p-1.5 pr-6">
      {/* chip 主体是一个真 <button>（可达性 + 焦点态免费拿），点击开右栏
          预览；Remove ×是独立兄弟元素不经过这里，无冒泡冲突。无磁盘路径
          （剪贴板粘贴图）时禁用，视觉与旧版静态 chip 一致。 */}
      <button
        type="button"
        disabled={!diskPath}
        onClick={openPreview}
        title={
          diskPath
            ? (previewableSheet || editableImage) && !splitBusy
              ? zh
                ? '点击预览'
                : 'Click to preview'
              : zh
                ? '用系统应用打开'
                : 'Open with system app'
            : undefined
        }
        className="flex min-w-0 cursor-pointer items-center gap-2 text-left disabled:cursor-default"
      >
        {isImage && previewURL ? (
          <img
            src={previewURL}
            alt=""
            className="h-10 w-10 shrink-0 rounded object-cover"
          />
        ) : (
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground/80"
            title={previewError ?? undefined}
          >
            {previewError ? (
              <span className="text-[10px] font-mono">!</span>
            ) : (
              // Per-type file glyph for non-image attachments. The file
              // name is shown to the right; the icon signals the file kind
              // (PDF / Word / code / …) without previewing unknown bytes.
              <FileTypeIcon pathOrName={attachment.name} size={22} />
            )}
          </div>
        )}
        <span className="max-w-[140px] truncate text-[11px] text-foreground/80">
          {attachment.name}
        </span>
      </button>
      <AttachmentPrimitive.Remove
        className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-muted text-[10px] leading-none text-muted-foreground opacity-0 transition group-hover/att:opacity-100 hover:bg-secondary hover:text-foreground"
        aria-label="Remove attachment"
      >
        ×
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  )
}
