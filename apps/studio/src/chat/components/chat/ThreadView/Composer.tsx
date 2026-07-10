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
import { AnimatePresence, motion } from 'motion/react'

import type { SessionMeta } from '@desktop-shared/types'
import { useI18n, useT } from '../../../i18n'
import { useChatStore, useTurnActivity } from '../../../stores/chat'
import { useWorkspaceStore } from '../../../stores/workspace'
import { useComposerModeStore, type ComposerModeId } from '../../../stores/composerMode'
import { useComposerOverlayStore } from '../../../stores/composerOverlay'
import { buildSlashAdapter, buildSkillPickerEntries, type SkillPickerEntry } from '../../../composer/slashAdapter'
import { buildFileMentionAdapter } from '../../../composer/fileMentionAdapter'
import {
  ProseMirrorComposerInput,
  type ProseMirrorComposerInputHandle
} from '../../../composer/ProseMirrorComposerInput'
import { QueuePanel } from './QueuePanel'
import { useMessageQueueStore } from '../../../stores/messageQueue'
import { FileTypeIcon, fileIconPathsByKey } from '../FileTypeIcon'
import { DictationWaveform } from '../DictationWaveform'
import { PermissionModePicker } from '../../permissions/PermissionModePicker'
import { cancelActiveDictation } from '../../../runtime/openaiWhisperDictationAdapter'

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
  searching: '联网中',
  asking: '等待你回答',
  working: '处理中'
}

/**
 * ComposerStatusBar
 * -----------------
 * The "✻ 探索中…  ·······  2.5s" strip that sits flush on top of the composer
 * input, sharing one outer green frame with it so the two read as a SINGLE
 * piece (see the reference). It carries no border/background of its own — the
 * parent wrapper (in Composer) owns the green ring + tint and the rounded
 * outer corners; this row only paints its content and a hairline divider
 * above the input.
 *
 * Pure presentation: `active`/`startedAt`/`activity` come from the parent
 * (which calls useTurnActivity once), so the wrapper and this row stay in
 * sync. Ticks every 100ms for the tenths-of-a-second readout. Timer basis is
 * the CURRENT STEP's start (useTurnActivity picks it): the label names the
 * current activity, so the number must be that activity's elapsed — a
 * turn-total next to "执行中…" reads as a lie. The readout restarts as each
 * new tool begins.
 */
function ComposerStatusBar({
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
    <div
      className="flex items-center gap-2 px-4 pb-2 pt-2.5 text-[13px]"
      role="status"
      aria-live="polite"
      aria-label={`${verb}, ${label}`}
    >
      <span aria-hidden className="shrink-0 animate-spin text-brand [animation-duration:2.4s]">
        ✺
      </span>
      <span className="font-medium text-brand">{verb}…</span>
      <span className="ml-auto shrink-0 font-mono text-[12px] tabular-nums text-brand/80">
        {label}
      </span>
    </div>
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
export function Composer(): React.JSX.Element {
  const t = useT()
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const [files, setFiles] = useState<readonly string[]>([])
  const streaming = useChatStore((s) => s.streaming)
  // Working-status for the strip fused on top of the composer. `active` also
  // toggles the shared green frame that makes the strip + input read as one
  // piece; when inactive the composer renders as its normal standalone card.
  const turnActivity = useTurnActivity()
  // Slides binding: when the user sends while the global picker is on
  // 幻灯片, mark the CURRENT session as a slides session so ThreadView
  // shows its two-pane layout from then on (per-session, not global).
  // Called on every send path (Enter → onSubmit, and the Send button's
  // onClick); markSlidesSession is idempotent so double-calls are fine.
  const composerSessionId = useChatStore((s) => s.sessionId)
  // Whether this session has any queued turns — drives the hairline divider
  // BELOW the queue segment (the divider must not show when the queue is
  // empty, and QueuePanel itself renders null then). A boolean selector, so
  // it's a stable scalar (no fresh-array churn / useShallow pitfalls).
  const hasQueue = useMessageQueueStore((s) =>
    composerSessionId ? (s.queues[composerSessionId]?.length ?? 0) > 0 : false
  )
  const markIfSlides = useCallback(() => {
    const st = useComposerModeStore.getState()
    if (st.mode === 'slides') st.markSlidesSession(composerSessionId ?? '')
  }, [composerSessionId])
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

  // Pull session meta on mount and whenever a turn ends. The first
  // pull (mount) returns empty arrays because fusion-code hasn't
  // spawned yet; the post-first-turn pull picks up the populated
  // cache. Subsequent turn-end pulls are no-ops on stable data but
  // cheap (one IPC round-trip).
  useEffect(() => {
    if (streaming) return
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

  const handleFilesPicked = useCallback(
    async (fileList: FileList | null): Promise<void> => {
      if (!fileList || fileList.length === 0) return
      const picked = Array.from(fileList)
      await Promise.all(
        picked.map((file) =>
          composerRuntime.addAttachment(file).catch((err) => {
            console.error('[Composer] addAttachment failed', err)
          })
        )
      )
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
      <div className="relative">
        {/* SINGLE-CONTAINER COMPOSER (redesign — replaces the old three stacked
            rounded boxes joined by negative margins, which clipped the status
            row and doubled up borders; see the bug screenshots).

            The AttachmentDropzone is now the ONE rounded frame for the whole
            stack. Everything lives INSIDE it as flat, full-width segments
            separated by 1px hairline dividers, top-to-bottom:

              ┌─ message queue (QueuePanel) ─┐   ← only while queue non-empty
              ├──────── hairline ────────────┤
              │ working-status strip (green) │   ← only while streaming
              ├──────── hairline ────────────┤
              │ attachments · input · toolbar│
              └──────────────────────────────┘

            `overflow-hidden` clips each segment's square corners to the card's
            radius. No segment carries its own border/radius/negative margin, so
            nothing can overlap or clip anything else — the status row is always
            a full, un-obscured line. */}
        <ComposerPrimitive.AttachmentDropzone className="relative overflow-hidden rounded-[22px] bg-popover/95 ring-1 ring-black/[0.08] backdrop-blur-xl backdrop-saturate-150 transition-all focus-within:ring-[hsl(var(--brand)/0.4)] data-[dragging=true]:ring-2 data-[dragging=true]:ring-[hsl(var(--brand)/0.5)] data-[dragging=true]:bg-brand/[0.08] dark:ring-white/[0.08]">
          {/* Segment 1 — message queue. Renders null when empty (so no divider
              shows either). Its own frame styling was stripped; it's pure
              content here. */}
          <QueuePanel sessionId={composerSessionId} />
          {hasQueue ? <div className="h-px bg-border/70" /> : null}

          {/* Segment 2 — working-status strip: animated glyph + current Chinese
              activity on the left, live elapsed timer on the right. A slim band
              with a faint green tint (accent only, never floods the input).
              Only while the turn streams (and not during plain prose output).
              A full, un-clipped row — the whole point of the redesign. */}
          {turnActivity.active && turnActivity.startedAt !== undefined ? (
            <>
              <div className="bg-brand/[0.07]">
                <ComposerStatusBar
                  startedAt={turnActivity.startedAt}
                  activity={turnActivity.activity}
                />
              </div>
              <div className="h-px bg-border/70" />
            </>
          ) : null}

          {/* Segment 3 — the input body (attachments · text · toolbar). */}
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
                <div className="min-h-[52px] max-h-52 overflow-y-auto px-5 pb-1 pt-4 text-[15px] leading-relaxed">
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
                      markIfSlides()
                      composerRuntime.send()
                    }}
                  />
                </div>

                {/* —— Bottom row: toolbar —— */}
                <div className="flex items-center gap-2 px-3 pb-3 pt-1">
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

                  {/* Composer mode picker (通用 / 设计 / 幻灯片 / 写作). The
                      幻灯片 option is the slides entry point: choosing it sets
                      mode='slides', and sending then marks the session as a
                      slides session → ThreadView's two-pane layout. Replaces
                      the old single monitor-icon slides toggle. Read-only
                      once the session has messages: the picker itself hides
                      (see its hasMessages guard) — the skill it dispatched
                      is shown in the chat header instead (ChatHeader in
                      ThreadView.tsx), not re-shown here. */}
                  <ComposerModePicker />

                  {/* Spacer pushes the rest to the right edge. */}
                  <div className="flex-1" />

                  {/* Right cluster: 模型选择器 · mic · send（2026-07-05 用户要求
                      把模型 chip 与「全自动」权限 chip 互换——模型放这排紧挨麦克风/
                      发送，权限模式挪到卡片下方 chip 排）。 */}
                  <ComposerModelChip model={sessionMeta?.model} />
                  <MicButton label={t('composerDictate')} />
                  {/* Mutually exclusive Send / Stop slot. */}
                  <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send
                      aria-label="Send message"
                      onClick={markIfSlides}
                      // ready 态品牌绿（原型 .btn-send.ready）：空输入是 muted
                      // disabled 盘，有内容才亮绿——状态差本身就是「可以发了」
                      // 的信号，比常亮黑盘的信息量大。
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
                    </ComposerPrimitive.Send>
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
        </ComposerPrimitive.AttachmentDropzone>

        {/* Below-card chips (figure 18): 选择工作目录已实装（统一会话管理，
            2026-07-07：新会话可选工作目录，发过消息后锁定只读）；语气 创意
            占位 chip 已移除（从未接实际功能）。权限模式 chip on the right is
            FUNCTIONAL（2026-07-05 与模型 chip 互换位置后落这排）——它切换
            引擎的权限模式（default/plan/acceptEdits/bypass/dontAsk）。 */}
        <div className="mt-3 flex items-center gap-4 px-2">
          <WorkspaceDirPicker />
          <div className="ml-auto">
            <PermissionModePicker />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Composer mode metadata for the picker (通用 / 设计 / 幻灯片 / 写作 / 写方案 / 处理表格 / 制作视频). */
interface ComposerModeMeta {
  id: ComposerModeId
  label: string
  beta?: boolean
  icon: React.ReactNode
}

const COMPOSER_MODES: readonly ComposerModeMeta[] = [
  {
    id: 'general',
    label: '通用',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
        <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z" />
      </svg>
    )
  },
  {
    id: 'design',
    label: '设计',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M4 9h16M9 9v11" />
      </svg>
    )
  },
  {
    id: 'slides',
    label: '幻灯片',
    beta: true,
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4.5" width="18" height="12" rx="2" />
        <path d="M8 20.5h8M12 16.5v4" />
      </svg>
    )
  },
  {
    id: 'writing',
    label: '写作',
    beta: true,
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M16.5 3.5 20.5 7.5 8 20 3.5 20.5 4 16z" />
        <path d="M14 6 18 10" />
      </svg>
    )
  },
  {
    id: 'proposal',
    label: '写方案',
    beta: true,
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5z" />
        <path d="M14 3.5V8.5H19M8.5 12.5h7M8.5 16h4.5" />
      </svg>
    )
  },
  {
    id: 'spreadsheet',
    label: '处理表格',
    beta: true,
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
        <path d="M3.5 9.5h17M9.5 9.5v10M3.5 14.5h17" />
      </svg>
    )
  },
  {
    id: 'video',
    label: '制作视频',
    beta: true,
    // 影片胶片框 + 中央播放三角：一眼是「视频」。描边同其余项 1.7 无填充。
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 9.5h18M8 5v4.5M16 5v4.5" />
        <path d="M11 12.5v3l2.5-1.5z" />
      </svg>
    )
  }
]

/**
 * Composer mode picker in the toolbar — a pill showing the current mode
 * (icon + label, e.g.「通用」) that opens a popover to switch between
 * 通用 / 设计 / 幻灯片 / 写作 / 写方案 / 处理表格 / 制作视频. Replaces the old single monitor-icon slides
 * toggle: the popover's 幻灯片 row is now the slides entry point (picking it
 * sets mode='slides'; sending then marks the session as a slides session via
 * markIfSlides → ThreadView's two-pane layout).
 *
 * Reuses PermissionModePicker's interaction shape: upward popover (the
 * composer sits at the window bottom), click-outside + Esc to close, motion
 * fade, a check on the selected row. 幻灯片 / 写作 carry a blue "Beta" tag.
 */
function ComposerModePicker(): React.JSX.Element | null {
  const mode = useComposerModeStore((s) => s.mode)
  const setMode = useComposerModeStore((s) => s.setMode)
  // 仅新会话（还没发过消息）可选：mode 是全局单例，发送时会被实时读取去拼
  // 技能斜杠命令，选定后不再允许中途改判——发过消息就整体收起，而不是像
  // WorkspaceDirPicker 那样退化成禁用态展示。
  const hasMessages = useChatStore((s) => s.messages.length > 0)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 菜单 portal 到 body 后用 fixed 定位，锚点靠测量按钮 rect 得出（见下方
  // 「为什么必须 portal」注释）。null = 还没测量 / 未打开。
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
    null
  )

  const current =
    COMPOSER_MODES.find((m) => m.id === mode) ?? COMPOSER_MODES[0]!

  // 打开时测量按钮位置换算成 fixed 锚点：菜单左缘对齐按钮左缘，菜单底缘
  // 贴按钮顶缘上方（bottom = 视口高 − 按钮 top，配 mb 间距向上弹）。
  // useLayoutEffect：在浏览器绘制前定位好，避免菜单先闪现在 (0,0) 再跳位。
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const b = btnRef.current?.getBoundingClientRect()
      if (b) setAnchor({ left: b.left, bottom: window.innerHeight - b.top })
    }
    measure()
    // 滚动 / 缩放时跟随重定位（composer 在滚动视口内，滚动会移动按钮）。
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    // Hold an "overlay open" count while this popover is up so the composer's
    // blur strip hides (its backdrop-blur otherwise slices across the menu).
    // +1 on open, -1 in cleanup → balanced (open→false runs the cleanup, then
    // the early return skips re-incrementing).
    const overlay = useComposerOverlayStore.getState()
    overlay.setOpen(true)
    const onDown = (e: MouseEvent): void => {
      // 菜单已 portal 到 body（不在 rootRef 子树内），点击既不在按钮壳
      // 也不在菜单里才算「点外面」→ 关闭。少了 menuRef 这半边，点菜单项
      // 会被当成点外部先关掉菜单、选择丢失。
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

  const choose = (next: ComposerModeId): void => {
    setMode(next)
    setOpen(false)
  }

  // hooks 必须先跑完再判断——上面的 useLayoutEffect/useEffect 依赖 open 状态，
  // 提前 return 必须放在所有 hook 调用之后。
  if (hasMessages) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="对话模式"
        className={
          'group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[12.5px] transition-colors ' +
          'border-border/70 bg-card/70 text-muted-foreground hover:border-brand/50 hover:bg-card hover:text-foreground ' +
          (open ? ' border-brand/60 text-foreground' : '')
        }
      >
        <span className="flex shrink-0 items-center">{current.icon}</span>
        <span className="leading-none">{current.label}</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={'opacity-60 transition-transform ' + (open ? 'rotate-180' : '')}
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* ⚠️ 为什么必须 portal 到 body（2026-07-05「菜单顶部被欢迎语盖住」实锤）：
        * 菜单原本 `absolute bottom-full` 相对本组件向上弹，但 Composer 卡片
        * 外壳是 `relative overflow-hidden rounded-[…]`（圆角裁剪必需，不能去），
        * 向上溢出卡片的菜单顶部被 overflow-hidden **裁掉**、露出后面的空态欢迎语
        * 标题（CDP elementFromPoint 命中 H1 实锤）——不是 z-index 能救的（裁剪
        * 与层叠无关）。portal 到 body 让菜单脱离卡片的 overflow 裁剪，fixed 定位
        * 靠测量按钮 rect 得出锚点（anchor）。菜单在 .chat-app 之外，canvas 的裸
        * <button> reset 会命中菜单项 → 每项加 data-slot 逃逸（同 2026-07-04 打开
        * 方式菜单/lightbox 家族）。 */}
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
                className="fixed z-[9999] mb-1.5 w-56 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
                role="listbox"
              >
                {COMPOSER_MODES.map((meta) => {
                  const selected = meta.id === mode
                  return (
                    <button
                      key={meta.id}
                      data-slot="composer-mode-option"
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => choose(meta.id)}
                      className={
                        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ' +
                        (selected
                          ? 'bg-brand/10 text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground')
                      }
                    >
                      <span className="flex shrink-0 items-center">{meta.icon}</span>
                      <span className="font-medium">{meta.label}</span>
                      {meta.beta ? (
                        <span className="rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold leading-none text-sky-500">
                          Beta
                        </span>
                      ) : null}
                      <span className="flex-1" />
                      {selected ? (
                        <svg
                          width="14" height="14" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                          className="shrink-0 text-brand"
                          aria-hidden
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : null}
                    </button>
                  )
                })}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
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
                className="fixed z-[9999] mb-1.5 flex w-[340px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
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
                        <svg
                          width={20}
                          height={20}
                          viewBox="0 0 48 48"
                          aria-hidden="true"
                          className="mt-0.5 shrink-0"
                        >
                          {fileIconPathsByKey(entry.spec.icon).map((p, pi) => (
                            <path key={pi} d={p.d} fill={p.fill} />
                          ))}
                        </svg>
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
  /** 友好显示名（chip + 菜单行 + 详情卡标题）。 */
  name: string
  /** 一句话卖点（hover 详情卡）。 */
  desc: string
  /** 上下文窗口（详情卡）。 */
  context: string
  /** 消耗倍率文案（菜单行右侧 + 详情卡），null = 不显示倍率徽章。 */
  rate: string | null
  /** 是否 auto 智能挡（菜单里单列顶部）。 */
  auto?: boolean
}

// 按「模型家族」键（不含 context 变体后缀）。1m 变体的 context/name 后缀
// 由 modelMetaOf 动态加，不各写一份，避免 haiku/haiku[1m]/完整 id 三份漂移。
const MODEL_META: Record<string, ModelMeta> = {
  default: {
    name: 'Auto',
    desc: '按任务自动挑选最合适的模型，省心之选。',
    context: '自适应',
    rate: '0.5X',
    auto: true
  },
  opus: {
    name: 'Opus 4.8',
    desc: '最强推理与代码能力，攻坚复杂任务的旗舰。',
    context: '200K',
    rate: '1X'
  },
  sonnet: {
    name: 'Sonnet 5',
    desc: '速度与能力均衡，日常主力，写作、跑流程都靠得住。',
    context: '200K',
    rate: '0.3X'
  },
  haiku: {
    name: 'Haiku 4.5',
    desc: '轻量极速，简单问答与批量任务的性价比之选。',
    context: '200K',
    rate: '0.1X'
  },
  fable: {
    name: 'Fable 5',
    desc: '创意写作与叙事特化，文风生动、构思跳脱。',
    context: '200K',
    rate: '0.3X'
  }
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
 * 取模型元数据（按归一化家族查）。1m 变体在家族 meta 上叠加：name 加「· 1M」、
 * context 改 1M。未知家族走 fallback（id 原样当名、无倍率）。
 */
function modelMetaOf(id: string): ModelMeta {
  const { family, is1m } = normalizeModelId(id)
  const base = MODEL_META[family]
  if (!base) {
    return { name: id, desc: '', context: '', rate: null }
  }
  if (is1m && !base.auto) {
    return { ...base, name: `${base.name} · 1M`, context: '1M' }
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
 * 模型行图标——极简几何占位（无品牌 svg 资源）。auto 挡用「闪电」示意智能，
 * 具名模型用「星芒」；同一套描边风格，混排不违和。
 */
function ModelGlyph({ auto }: { auto?: boolean }): React.JSX.Element {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/[0.05] text-muted-foreground">
      {auto ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3 2.3 6.2L21 11l-6.7 1.8L12 19l-2.3-6.2L3 11l6.7-1.8z" />
        </svg>
      )}
    </span>
  )
}

/**
 * 模型 chip — the composer footer's model switcher (moved into the in-card
 * toolbar's right cluster, left of mic/send — 2026-07-05). Shows the session's
 * current model as a friendly name + glyph, and opens an upward RICH dropdown
 * (portal'd to body to escape the composer card's overflow-hidden clip):
 * per-model rows with glyph / name / rate, an Auto row split off on top, a
 * hover detail card, and a 模型设置 footer link. Prefetch primes the catalog
 * so opening is instant. Picking an id calls MODEL_SET (live + future default);
 * the label flips optimistically (`pending`) until sessionMeta catches up.
 */
function ComposerModelChip({ model }: { model?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // 初值取共享缓存：命中则首帧就有列表，点开零 loading。
  const [models, setModels] = useState<string[] | null>(() => modelCache)
  const [listError, setListError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  // hover 的模型行 id → 右侧弹详情卡（图 2 那张）。null = 不弹。
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 菜单 portal 到 body 后用 fixed 定位（脱离 composer 卡片 overflow-hidden
  // 裁剪，同姊妹 picker）。右对齐：菜单右缘贴按钮右缘。
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(
    null
  )

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

  // 关闭时清 hover 态，下次打开不残留上次的详情卡。
  useEffect(() => {
    if (!open) setHoveredId(null)
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
  // 菜单分两组：auto 挡（default）单列顶部，具名模型在下（图 2 的分隔线）。
  const list = models ?? []
  const autoIds = list.filter((id) => modelMetaOf(id).auto)
  const namedIds = list.filter((id) => !modelMetaOf(id).auto)
  // hover 详情卡的数据（悬停哪行取哪行 meta）。
  const hoveredMeta = hoveredId ? modelMetaOf(hoveredId) : null

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
        onMouseEnter={() => setHoveredId(id)}
        className={
          'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ' +
          (selected ? 'bg-foreground/[0.04]' : 'hover:bg-foreground/[0.04]')
        }
      >
        {/* 选中打勾占位（图 2：选中行左侧一个实心勾圈）——未选留白等宽，行不跳。 */}
        <span className="grid size-4 shrink-0 place-items-center">
          {selected ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-foreground" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="m8.5 12 2.5 2.5 4.5-5" fill="none" stroke="hsl(var(--card))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </span>
        <ModelGlyph auto={meta.auto} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground" title={meta.name}>
          {meta.name}
        </span>
        {meta.rate ? (
          <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
            {meta.rate}
          </span>
        ) : null}
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
          'flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] transition-colors ' +
          (open
            ? 'text-foreground'
            : 'text-muted-foreground/80 hover:bg-foreground/[0.05] hover:text-foreground')
        }
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3 2.3 6.2L21 11l-6.7 1.8L12 19l-2.3-6.2L3 11l6.7-1.8z" />
        </svg>
        <span className="max-w-[160px] truncate leading-none">
          {currentMeta?.name ?? current ?? '模型'}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={'text-muted-foreground/50 transition-transform ' + (open ? 'rotate-180' : '')} aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* 富菜单 portal 到 body（脱离 composer 卡片 overflow-hidden 裁剪，同姊妹
          picker）；fixed 定位，右缘贴按钮右缘、底缘贴按钮顶缘上方。 */}
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
                className="fixed z-[9999] mb-2 w-80 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
                role="listbox"
                onMouseLeave={() => setHoveredId(null)}
              >
                {/* hover 详情卡：悬停某行时在菜单左侧浮出（fixed，贴菜单左缘）。
                    数据来自 MODEL_META。无描述（未知 id）不弹。 */}
                {hoveredMeta && hoveredMeta.desc ? (
                  <div
                    className="fixed z-[10000] w-64 rounded-2xl border border-border bg-card p-4 shadow-[0_24px_80px_rgba(0,0,0,0.28)]"
                    // 详情卡贴菜单左侧：菜单右缘距视口右 anchor.right、菜单宽
                    // 320(w-80)→左缘距右 anchor.right+320，详情卡再左移 12px 间隙。
                    // 底缘与菜单底缘对齐上抬一点，读作从菜单「探出」。
                    style={{ right: anchor.right + 320 + 12, bottom: anchor.bottom + 40 }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold text-foreground">{hoveredMeta.name}</span>
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                      {hoveredMeta.desc}
                    </p>
                    <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3 text-[12.5px]">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">上下文窗口</span>
                        <span className="font-mono tabular-nums text-foreground">{hoveredMeta.context}</span>
                      </div>
                      {hoveredMeta.rate ? (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">消耗</span>
                          <span className="font-mono tabular-nums text-foreground">{hoveredMeta.rate}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {models === null && listError === null ? (
                  // 骨架屏（2026-07-05 用户要求：切 backend 列表突变太生硬）——
                  // 每行仿真实模型行的布局（图标方块 + 名条 + 倍率条），脉冲
                  // 动画。首次打开（有预取缓存）通常直接跳过 loading，这里主要
                  // 覆盖切 backend 后缓存失效重拉的空窗。
                  <div className="flex flex-col gap-1 p-1.5">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 rounded-lg px-2.5 py-2"
                      >
                        <span className="size-4 shrink-0" />
                        <span className="size-8 shrink-0 animate-pulse rounded-lg bg-foreground/[0.06]" />
                        <span
                          className="h-3.5 animate-pulse rounded bg-foreground/[0.06]"
                          style={{ width: `${[62, 48, 70, 54, 44][i]}%` }}
                        />
                        <span className="flex-1" />
                        <span className="h-3 w-8 animate-pulse rounded bg-foreground/[0.05]" />
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

  // 切换在途（C 搬家，原型 docs/ui-prototype-workspace-picker.html）：
  // 三粒点在源/目标两个文件夹图标之间依次流动——把「transcript 在物理
  // 搬家」讲成故事，非交互。已有记录的会话换目录要 teardown 子进程 +
  // 搬 transcript，几百 ms 到数秒可感知——没有反馈用户会连点或以为没
  // 生效。flag 成败都会清（见 workspace store）。文案按是否真在搬记录
  // 分「搬」/「切换」两说。
  if (switchingPath !== undefined) {
    return (
      <span
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70"
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
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70"
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

  // 只读态（本轮进行中 / 无会话）：纯展示，hover 出全路径。
  if (readonly) {
    return (
      <span
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70"
        title={displayPath ?? undefined}
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
        className={
          'flex items-center gap-1.5 text-[13px] text-muted-foreground/70 transition-colors hover:text-foreground ' +
          (open ? 'text-foreground ' : '') +
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
                className="fixed z-[9999] mb-1.5 w-72 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
                role="listbox"
              >
                {/* 已有记录的会话：换目录 = main 侧迁移 transcript。一行
                  * 大白话说清后果，不弹确认框打断。 */}
                {hasHistory && (
                  <div className="px-3 pb-1.5 pt-1 text-[11px] leading-snug text-muted-foreground/70">
                    {zh
                      ? '更改后，这个对话和它的记录会搬到新文件夹继续。'
                      : 'Changing folders moves this chat and its history to the new folder.'}
                  </div>
                )}
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
                      className={
                        'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ' +
                        (selected
                          ? 'bg-brand/10 text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground')
                      }
                    >
                      <span className="shrink-0 opacity-70">{folderIcon}</span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[12px] font-medium">
                          {name}
                          {isDef && (
                            <span className="ml-1.5 text-[11px] font-normal opacity-60">
                              {zh ? '默认' : 'default'}
                            </span>
                          )}
                        </span>
                        <span className="truncate text-[11px] opacity-60">
                          {path}
                        </span>
                      </span>
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
                          className="shrink-0 text-brand"
                          aria-hidden
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  )
                })}
                <div className="mx-3 my-1 border-t border-border/60" aria-hidden />
                <button
                  data-slot="workspace-option"
                  type="button"
                  onClick={browse}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="shrink-0 opacity-70" aria-hidden>
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
    <AttachmentPrimitive.Root className="group/att relative flex items-center gap-2 rounded-lg border border-border bg-card/60 p-1.5 pr-6">
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
      <AttachmentPrimitive.Remove
        className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-muted text-[10px] leading-none text-muted-foreground opacity-0 transition group-hover/att:opacity-100 hover:bg-secondary hover:text-foreground"
        aria-label="Remove attachment"
      >
        ×
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  )
}
