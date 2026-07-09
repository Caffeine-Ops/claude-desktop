import { useCallback, useEffect, useRef, useState } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import { AnimatePresence, motion } from 'motion/react'
import { MessageSquareText, MoreHorizontal, Pencil } from 'lucide-react'
import { Button } from '@/src/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'

import { useI18n, useT } from '../../../i18n'
import { useChatStore, useDelayedSessionLoading } from '../../../stores/chat'
import { useComposerModeStore } from '../../../stores/composerMode'
import { useComposerOverlayStore } from '../../../stores/composerOverlay'
import { useSessionTitleStore } from '../../../stores/sessionTitle'
import { Composer } from './Composer'
import { PermissionFloatDock } from '../../permissions/PermissionFloatCard'
import { UserMessage } from './UserMessage'
import { AssistantMessage, SystemMessage } from './AssistantMessage'
import { SlidesWorkspace } from './SlidesWorkspace'
import {
  WorkflowScriptPanel,
  useWorkflowScriptPanelOpen
} from './WorkflowScriptPanel'
import { ProposalDocPanel } from '../../workspace/ProposalDocPanel'
import { useProposalWorkspace } from '../../../stores/proposal'
import { SpreadsheetPreviewPanel } from './SpreadsheetPreviewPanel'
import { ImageEditPanel } from './ImageEditPanel'
import {
  useImageEditStore,
  useSheetPreviewStore
} from '../../../stores/filePreview'

/**
 * ThreadView
 * ----------
 * A minimal but polished chat UI assembled from assistant-ui primitives.
 * We deliberately avoid the high-level `<Thread />` component because it
 * ships only via the shadcn CLI and would drag the whole shadcn/ui stack
 * into this repo. Primitives give us the same runtime wiring (auto
 * scroll-to-bottom, keyboard handling, message pairing, streaming
 * indicator) while leaving us in full control of styling.
 *
 * Layout
 * ------
 *   ThreadPrimitive.Root              (flex column, fills .main)
 *     ThreadPrimitive.Viewport        (flex-1, scrollable)
 *       centered width-capped column
 *         Empty state (when no messages)
 *         ThreadPrimitive.Messages    (renders per-message UI)
 *           UserMessage               (right-aligned bubble)
 *           AssistantMessage          (avatar + streaming text + tools)
 *     Composer dock                   (shrink-0, pinned to bottom)
 *       Composer                      (textarea + send / cancel)
 *
 * Important: the Composer lives OUTSIDE the Viewport instead of inside
 * a `ViewportFooter` with `sticky bottom-0`. Sticky only pins when there
 * is enough content to scroll; with a short thread it collapses into the
 * normal flow and floats in the middle of the screen. Making Composer a
 * direct flex child of Root guarantees it always sits at the bottom.
 *
 * Message rendering dispatches per role via MessagePrimitive.Parts —
 * text parts render as plain text (whitespace-pre-wrap), tool-call
 * parts render an inline collapsible card (ToolCallCard).
 */

// Chat-rail width bounds (px). The min keeps the composer + messages
// readable; the max stops the rail from swallowing the slides pane. The
// default matches the old hard-coded `w-[560px]`.
const CHAT_COL_MIN = 432
const CHAT_COL_MAX = 880
const CHAT_COL_DEFAULT = 560
const CHAT_COL_STORAGE_KEY = 'slides.chatColWidth'

/**
 * Resizable width state for the slides-mode chat rail.
 *
 * Returns the current width (px) and an `onResizeStart` to wire to the
 * gutter handle's `onPointerDown`. The width is seeded from localStorage so
 * a drag persists across reloads and session switches, and written back when
 * a drag ends (not on every move — one write per gesture).
 *
 * The drag tracks raw `clientX` deltas against the width captured at
 * pointer-down (held in a ref so the move handler isn't re-created per
 * render), clamps to [MIN, MAX], and uses Pointer Events + setPointerCapture
 * so the gesture keeps tracking even if the cursor outruns the thin handle.
 */
function useResizableChatColumn(): {
  width: number
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void
} {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return CHAT_COL_DEFAULT
    const raw = window.localStorage.getItem(CHAT_COL_STORAGE_KEY)
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10)
    if (Number.isNaN(parsed)) return CHAT_COL_DEFAULT
    // Clamp on read too — a persisted value can fall out of range if the
    // bounds change between versions.
    return Math.min(CHAT_COL_MAX, Math.max(CHAT_COL_MIN, parsed))
  })

  // Drag bookkeeping. Refs (not state) so the listeners are stable and the
  // move handler reads live values without re-subscribing per frame.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Left button / primary pointer only.
      if (e.button !== 0) return
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: width }
      const handleEl = e.currentTarget
      handleEl.setPointerCapture(e.pointerId)

      const onMove = (ev: PointerEvent): void => {
        const drag = dragRef.current
        if (drag === null) return
        // The handle sits to the RIGHT of the chat rail, so dragging right
        // (positive delta) widens the rail.
        const next = drag.startW + (ev.clientX - drag.startX)
        setWidth(Math.min(CHAT_COL_MAX, Math.max(CHAT_COL_MIN, next)))
      }
      const onUp = (): void => {
        dragRef.current = null
        handleEl.releasePointerCapture?.(e.pointerId)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        // Persist once per gesture. Read the freshest width via the setter's
        // functional form so we never write a stale closure value.
        setWidth((w) => {
          window.localStorage.setItem(CHAT_COL_STORAGE_KEY, String(Math.round(w)))
          return w
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [width]
  )

  return { width, onResizeStart }
}

/**
 * Drag handle / gutter between the chat rail and the slides pane.
 *
 * This is what replaced the `border-r` hairline. It is a fixed-width
 * transparent gutter (so the two panes read as separated blocks across a
 * gap, per design figure 2) whose center reveals a faint vertical divider on
 * hover / during a drag, and which carries `cursor-col-resize` + the resize
 * gesture. `shrink-0` so flex never collapses the gutter; `group` so the
 * inner divider can react to the gutter's own hover.
 */
function ChatColumnResizeHandle({
  onResizeStart
}: {
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onResizeStart}
      // w-1.5 = 6px gutter between the two white panes, painted bg-sidebar
      // （窗口底面同款灰）。透明版透出的是 .chat-app 背后的
      // shell-content-card（--card，近白），白缝夹两白面板等于隐形，所以
      // 必须自涂。Root 保持透明满铺（「双浮卡」方案已被否，见 Root 注释），
      // 缝的颜色只能落在这里。（旧浮卡时代是 10px、与 rail↔卡的 gutter
      // 同色同宽呼应；2026-07-08 平铺化后 gutter 没了，同日用户要求缝再
      // 收窄——6px 是拖拽热区可抓性的下限档位，别再往下压。）
      // The hit area spans the whole gutter so the handle is easy to
      // grab; touch-none stops scroll/pan hijacking the drag; `group`
      // drives the child divider's hover reveal.
      className="group relative flex h-full w-1.5 shrink-0 cursor-col-resize touch-none items-stretch justify-center bg-sidebar"
    >
      {/* The visible divider: a soft accent (green) line, invisible at rest,
          fading in on hover and while dragging (group-active). A vertical
          mask-image gradient fades the line's TOP and BOTTOM ends out to
          transparent so it does NOT run edge-to-edge — it's strongest in the
          middle and dissolves at both ends. A gentle accent glow keeps it
          reading as the highlighted drag affordance. Centered in the gutter so
          the whitespace splits evenly between the two panes. */}
      <div className="h-full w-px bg-accent/80 opacity-0 shadow-[0_0_8px_2px_hsl(var(--accent)/0.3)] transition-opacity duration-150 [mask-image:linear-gradient(to_bottom,transparent_0,black_18%,black_82%,transparent_100%)] group-hover:opacity-100 group-active:opacity-100" />
    </div>
  )
}

/**
 * Session-switch transition phases. See the curtain comment inside
 * ThreadView for the full design rationale.
 *
 *   idle → (beginSessionSwitch) → out → [600ms unresolved] → skeleton
 *        → (setSession mounts target) ──────────────────────→ in → idle
 *
 * Two independent triggers feed the machine:
 *   - `sessionSwitching` (store): raised on click, cleared on mount. Only
 *     observable when the mount is asynchronous (disk load) — a cache-hit
 *     switch sets+clears it inside one store batch, invisible here.
 *   - `sessionId` change: fires for every switch INCLUDING cache hits, and
 *     is what plays the entrance that masks the message-array swap +
 *     scroll reset.
 */
type SessionSwitchPhase = 'idle' | 'out' | 'skeleton' | 'in'

/**
 * 会话切换过渡总开关。2026-07-04 应用户要求关闭：切换即时呈现——不播
 * 帘幕（ssw-out 的沉降磨砂 / ssw-in 的显影归位），也不升级骨架屏；慢加载
 * 的用户反馈只剩右下角「正在打开会话…」toast。相位机与骨架组件原样保留：
 * 机器挂着 store 的 sessionSwitching 信号与 600ms 升级时序，删了再装回
 * 成本高，翻这个开关即可恢复。
 */
const SESSION_SWITCH_TRANSITION_ENABLED = false

function useSessionSwitchPhase(sessionId: string | null): SessionSwitchPhase {
  const switching = useChatStore((s) => s.sessionSwitching)
  const [phase, setPhase] = useState<SessionSwitchPhase>('idle')

  useEffect(() => {
    if (switching) {
      setPhase('out')
      // Escalate to the skeleton only when the load outlives the curtain —
      // 600ms ≈ well past any cache hit / normal JSONL parse, so it only
      // shows for genuinely slow loads (huge transcript, cold disk).
      const t = window.setTimeout(() => setPhase('skeleton'), 600)
      return () => window.clearTimeout(t)
    }
    // Switch ended without a sessionId change (throw path, or a rebind to
    // the same id): lift the veil through the entrance rather than
    // snapping, so the error path still resolves gracefully.
    setPhase((p) => (p === 'out' || p === 'skeleton' ? 'in' : p))
    return undefined
  }, [switching])

  // Entrance on every mounted switch — the only signal a cache-hit switch
  // emits (see above).
  const prevIdRef = useRef(sessionId)
  useEffect(() => {
    if (prevIdRef.current === sessionId) return
    prevIdRef.current = sessionId
    setPhase('in')
  }, [sessionId])

  // The entrance is a one-shot CSS animation; return to idle afterwards so
  // the class (and its filter/transform) is removed and the viewport goes
  // back to a plain unfiltered scroll container.
  useEffect(() => {
    if (phase !== 'in') return
    const t = window.setTimeout(() => setPhase('idle'), 400)
    return () => window.clearTimeout(t)
  }, [phase])

  // 开关关闭时对外恒等 'idle'（消费端零 ssw 类、零骨架/veil 挂载）。内部
  // 状态机照常空转——保持 hooks 顺序稳定，也让开关翻回来即刻能用。
  return SESSION_SWITCH_TRANSITION_ENABLED ? phase : 'idle'
}

/**
 * Chat-shaped shimmer skeleton shown when a session load outlives the
 * switch curtain. The rows mirror the transcript's real anatomy — a
 * right-aligned user pill, then left-aligned assistant paragraph bars —
 * so the loading state previews the shape of what's coming instead of
 * showing a generic spinner. Shimmer gradient matches `.pes-sk`
 * (main.css); classes live there too (`.ssw-*`).
 */
function SessionSwitchSkeleton(): React.JSX.Element {
  return (
    <div className="absolute inset-0 z-10 overflow-hidden bg-background/55">
      <div className="mx-auto flex w-full max-w-4xl flex-col px-3 pt-10">
        <div className="ssw-sk mb-7 h-9 w-1/3 self-end rounded-[18px]" />
        <div className="mb-7 flex flex-col gap-2.5 pl-[18px]">
          <div className="ssw-sk h-3.5 w-3/4" style={{ animationDelay: '60ms' }} />
          <div className="ssw-sk h-3.5 w-3/5" style={{ animationDelay: '90ms' }} />
          <div className="ssw-sk h-3.5 w-[68%]" style={{ animationDelay: '120ms' }} />
        </div>
        <div
          className="ssw-sk mb-7 h-9 w-1/4 self-end rounded-[18px]"
          style={{ animationDelay: '150ms' }}
        />
        <div className="flex flex-col gap-2.5 pl-[18px]">
          <div className="ssw-sk h-3.5 w-[70%]" style={{ animationDelay: '180ms' }} />
          <div className="ssw-sk h-3.5 w-1/2" style={{ animationDelay: '210ms' }} />
        </div>
      </div>
      {/* Composer skeleton for the dock-less case. The dock renders under
          `ThreadPrimitive.If empty={false}` (see the main layout):
          switching away from the empty-state hero (composer centered
          inside the now-veiled viewport, no dock) leaves the bottom of the
          pane hollow — this fills that hole and previews the target
          session's layout. The NON-empty case (real dock present) gets its
          own overlay INSIDE the dock instead (same ComposerSkeleton,
          perfectly aligned over the real composer). */}
      <ThreadPrimitive.If empty>
        <div className="absolute inset-x-0 bottom-3 px-3">
          <ComposerSkeleton />
        </div>
      </ThreadPrimitive.If>
    </div>
  )
}

/**
 * Skeleton of the composer block: the rounded input card (with attach /
 * send button hints) plus the accessory row underneath (working-dir · tone
 * · model pickers). Shared by the two switch-skeleton mounts — inside the
 * viewport overlay when there's no dock (empty-state origin), and inside
 * the dock veil when there is one. Geometry mirrors the real composer:
 * max-w-4xl column, rounded-[22px] card.
 */
function ComposerSkeleton(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="relative">
        <div
          className="ssw-sk h-[96px] rounded-[22px]"
          style={{ animationDelay: '240ms' }}
        />
        {/* Hint of the toolbar row: attach button (left) and send button
            (right), slightly deeper wash over the shimmer so the shape
            reads "input card", not just a slab. */}
        <div className="absolute bottom-3 left-3 size-8 rounded-full bg-foreground/[0.06]" />
        <div className="absolute bottom-3 right-3 size-8 rounded-full bg-foreground/[0.08]" />
      </div>
      {/* Accessory row under the card (选择工作目录 · 语气 · 模型). */}
      <div className="mt-2.5 flex items-center justify-between px-1">
        <div className="ssw-sk h-3 w-44" style={{ animationDelay: '280ms' }} />
        <div className="ssw-sk h-3 w-20" style={{ animationDelay: '310ms' }} />
      </div>
    </div>
  )
}

/**
 * 「显示更早的消息」gate —— 尾部窗口渲染的顶端入口（机制见 chat.ts
 * `historyWindowStart` 注释：切会话只同步挂载最近 30 条，把全量 mount
 * 的主线程长任务砍掉）。窗口外还有历史时渲染在消息列顶部，点一次向上
 * 多挂一批。
 *
 * 滚动保持：prepend 发生在用户已滚到顶（scrollTop≈0）的时刻，而浏览器
 * 的 overflow anchoring 在滚动位置为 0 时不生效——不补偿的话视口会
 * 停在新内容的顶端，阅读位置丢失。
 *
 * 补偿时机只能用 ResizeObserver 等「内容列真实长高」：同步方案全被实测
 * 排除——消息行不直接订阅 zustand，而是走 assistant-ui ExternalStore
 * 管道（useExternalStoreRuntime 收到新 messages 后经它自己的内部 store
 * 通知 Thread 重渲染），比 gate 自身的 commit 晚一拍。rAF 会跟这拍竞态
 * （偶发量到差值 0），flushSync 只能同步提交 gate 自己（量到的还是旧
 * 高度）。RO 回调在 layout 之后、paint 之前触发，长高的那一帧内回补，
 * 零闪烁且与管道时序解耦。
 */
function EarlierMessagesGate(): React.JSX.Element | null {
  const hiddenCount = useChatStore((s) => s.historyWindowStart)
  const revealEarlierMessages = useChatStore((s) => s.revealEarlierMessages)
  const lang = useI18n((s) => s.lang)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // 上一次 reveal 尚未完成的补偿任务的取消函数。连点时先取消旧任务，
  // 只让最新一次按自己的基线补偿——两个 RO 同时存活会各补一次（双倍
  // 位移）。
  const pendingCompRef = useRef<(() => void) | null>(null)

  const onReveal = useCallback((): void => {
    pendingCompRef.current?.()
    pendingCompRef.current = null

    const sc = findScrollParent(wrapRef.current)
    const prevHeight = sc?.scrollHeight ?? 0
    const prevTop = sc?.scrollTop ?? 0
    revealEarlierMessages()
    if (!sc) return
    // 观察 Viewport 的内容列（唯一子元素）。条件用「高于基线」而不是
    // 「变化」：最后一批 reveal 会先经历 gate 自身卸载的一次缩水，
    // 不能在那一拍就补偿并收工。
    const content = sc.firstElementChild
    if (!(content instanceof HTMLElement)) return
    const ro = new ResizeObserver(() => {
      if (sc.scrollHeight <= prevHeight) return
      cancel()
      sc.scrollTop = prevTop + (sc.scrollHeight - prevHeight)
    })
    // 兜底：内容始终没长高（不应发生）时 1s 后放手，别让 RO 泄漏。
    const bail = window.setTimeout(() => cancel(), 1000)
    const cancel = (): void => {
      ro.disconnect()
      window.clearTimeout(bail)
      if (pendingCompRef.current === cancel) pendingCompRef.current = null
    }
    pendingCompRef.current = cancel
    ro.observe(content)
  }, [revealEarlierMessages])

  if (hiddenCount <= 0) return null
  return (
    <div ref={wrapRef} className="mb-6 flex justify-center">
      <button
        type="button"
        onClick={onReveal}
        className="rounded-full border border-border/70 bg-background px-3.5 py-1.5 text-[12px] text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
      >
        {lang === 'zh'
          ? `显示更早的消息（还有 ${hiddenCount} 条）`
          : `Show earlier messages (${hiddenCount} more)`}
      </button>
    </div>
  )
}

/**
 * 从元素向上找最近的纵向滚动容器（实际命中 ThreadPrimitive.Viewport）。
 * 不用 ref 穿透拿 Viewport：它由 assistant-ui 渲染，没有暴露元素 ref 的
 * 公开口子，而「最近的 overflow-y:auto 祖先」对这里的 DOM 形状是稳定不
 * 变式（gate 就挂在 Viewport 的内容列里）。
 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
  }
  return null
}

export function ThreadView(): React.JSX.Element {
  // Session transition signals from the chat store.
  //   - sessionId      : switches when loadSession resolves (~100ms, or
  //                      synchronously on a history-cache hit). Drives the
  //                      controlled opacity fade-in below (NOT a keyed
  //                      remount — see the content column).
  //   - sessionLoading : stays true until switchSession resolves
  //                      (~3-8s cold start). Drives ONLY the thin
  //                      top progress bar — no full-column veil, no
  //                      content hide. Old content stays visible
  //                      until the new messages arrive, then swaps
  //                      with a soft fade.
  // Rationale: the full-screen loading overlay was reading as a hard
  // interrupt — eye jumped to the center, waited, jumped back. A
  // thin top bar is standard "something is loading" signal that
  // keeps the user's focus anchored on content, while the fade on
  // swap preserves the sense of "the view changed".
  const sessionId = useChatStore((s) => s.sessionId)
  // Debounced variant for the *visual* progress bar only: a fast switch
  // (cache hit / lazy engine) clears `sessionLoading` within a frame or
  // two, and lighting the bar for that flicker reads as "always busy".
  // `useDelayedSessionLoading` only returns true once loading has held
  // for ~200ms, so a quick switch shows no bar at all while a real cold
  // start still surfaces it. The raw `sessionLoading` is kept for any
  // logic that must react immediately.
  const sessionLoadingChrome = useDelayedSessionLoading()
  // Slides two-pane layout is bound PER SESSION, not to the live composer
  // picker: a session shows the right-hand slides workspace only if it was
  // *started* in slides mode (marked on first send — see the composer send
  // path / markSlidesSession). So switching to a slides session splits the
  // layout; switching to any other session keeps it single-column,
  // regardless of what the picker currently says. We subscribe to the
  // whole map so re-marking the active session re-renders this.
  const slidesSessions = useComposerModeStore((s) => s.slidesSessions)
  const isSlidesMode =
    sessionId !== null && slidesSessions[sessionId] === true
  // 写方案两栏：绑定 proposal store（active + 前台 sid 一致 + workspaceOpen）。
  // 与 slides 不同，它不按「会话启动时的模式」标记，而是随方案激活/离开实时切换
  // （激活即接管、leaveMode 即还原——Install-Plan 的原语义）。两者理论上互斥
  // （proposal 由 slash/模式激活的普通会话承载）；若同时为真，proposal 优先。
  const isProposalMode = useProposalWorkspace()
  // 任一分栏模式：chat 列都收窄成固定宽度 rail（共用同一条拖拽宽度）。
  const isSplitMode = isProposalMode || isSlidesMode
  // Workflow 脚本面板（右栏）：AI 正在写 workflow 脚本时自动弹出，或用户
  // 点了某张 Workflow 卡片的脚本入口。slides/proposal 分栏时禁用——右栏
  // 已被工作区占用，再开就是三列（chat 被夹成一线）。此 hook 只订阅稳定
  // 信号（toolCallId / 开关 id），流式文本的每 delta 重渲染被隔离在面板
  // 组件自身（见 useStreamingWorkflowCallId 头注释）。
  const workflowPanelWanted = useWorkflowScriptPanelOpen()
  // 表格预览右栏：用户点了成果卡片里的 xlsx/xls/csv。slides/proposal 分栏
  // 时让位（卡片点击自身降级回系统应用打开，见 useSplitWorkspaceBusy）；
  // 与 workflow 面板相争时预览赢——它是用户刚刚的显式点击，workflow 的
  // 自动弹出不该压过它。
  const sheetPreviewPath = useSheetPreviewStore((s) => s.path)
  const showSheetPreview = sheetPreviewPath !== null && !isSplitMode
  // 图片标记编辑右栏：用户点了成果卡片里的图片文件。开关语义与表格预览
  // 完全同构；两者在 store 层交叉互斥（后开的赢，见 stores/filePreview），
  // 这里不会同时非 null。
  const imageEditPath = useImageEditStore((s) => s.path)
  const showImageEdit = imageEditPath !== null && !isSplitMode
  const showWorkflowPanel =
    workflowPanelWanted && !isSplitMode && !showSheetPreview && !showImageEdit
  // chat 列收窄成 rail 的诱因：slides / proposal / workflow 脚本 / 表格
  // 预览 / 图片编辑任一右栏打开。宽度共用同一条持久化的 chatColWidth。
  const chatRailed =
    isSplitMode || showWorkflowPanel || showSheetPreview || showImageEdit
  // 切会话即收起表格预览与图片编辑：路径虽跨会话有效（文件还在盘上），但
  // 都是「点开看一眼/改一下」的瞬时动作，残留与新会话无关的旧面板读作
  // 串台。挂载首跑也会触发一次——两个 close 都幂等，启动时 path 本就是 null。
  useEffect(() => {
    useSheetPreviewStore.getState().closePreview()
    useImageEditStore.getState().closeEditor()
  }, [sessionId])
  // Slides two-pane split is user-resizable. The chat rail used to be a
  // hard `w-[560px]` with a `border-r` hairline between the panes; per design
  // the hairline is gone (the panes now read as two separated blocks across a
  // gutter), and the boundary is a drag handle. `chatColWidth` is the chat
  // rail's width in px, persisted to localStorage so a drag survives reloads
  // and session switches. See useResizableChatColumn for the clamp + persist.
  const { width: chatColWidth, onResizeStart } = useResizableChatColumn()
  // Hide the composer's frosted transition strip while any composer popover
  // (mode / permission picker) is open — its backdrop-blur otherwise sliced a
  // blurred band across the open menu (see stores/composerOverlay).
  const composerOverlayOpen = useComposerOverlayStore((s) => s.openCount > 0)
  // Session-switch curtain (replaces both the old keyed content remount and
  // the interim 0.3→1 opacity fade).
  //
  // History, so nobody re-treads it:
  //   v1 keyed the content column by sessionId → full subtree remount, every
  //      code block re-highlighting in one frame ("switch jank").
  //   v2 kept node identity + played a 0.3→1 opacity fade on the INNER
  //      column. Deliberately opacity-only, because a y+blur intro applied
  //      to the inner column had pushed the scroll container past its
  //      viewport and flickered the scrollbar.
  //   v3 (this): the curtain animates the SCROLL CONTAINER itself, not the
  //      inner column — transform/filter on the container are composited on
  //      the whole box and cannot alter its internal scroll geometry, so the
  //      v2 regression physically can't recur. That unlocks the richer
  //      blur+rise transition without the jitter that killed it in v2.
  //
  // Phase machine (useSessionSwitchPhase):
  //   out      — click → target transcript not yet mounted: old content
  //              sinks behind a frost veil (masks the array swap + scroll
  //              reset that used to read as "抖动").
  //   skeleton — mount outlived the curtain (>600ms: huge JSONL / cold
  //              disk): chat-shaped shimmer rows over the veil.
  //   in       — transcript mounted: pane rises + unblurs. A cache-hit
  //              switch collapses begin/end into one store batch, so it
  //              plays ONLY this phase — zero pre-mount chrome.
  //
  // ⚠️ 目前整套过渡被 SESSION_SWITCH_TRANSITION_ENABLED=false 关停
  //（用户要求切换零动画），本值恒为 'idle'——下面所有 ssw 类与骨架/veil
  // 分支都是死路，重新启用翻那个开关即可。
  const switchPhase = useSessionSwitchPhase(sessionId)

  return (
    <ThreadPrimitive.Root
      // No mode-dependent padding. Both normal and slides modes fill the
      // surface edge-to-edge, so the root's box is IDENTICAL across a switch —
      // that's what stops the page "jolting" when toggling between a normal
      // (single-column) session and a slides (two-pane) session: previously
      // slides mode added a 4px `p-1` inset that normal mode lacked, so every
      // cross-mode switch animated the whole layout in/out by 4px on all sides.
      //
      // ⚠️ 2026-07-04 试过「双浮卡」方案（Root 涂 bg-sidebar + p-2.5、面板
      // 6px 圆角，让分栏读作两张浮在灰底上的卡）——用户当天否掉：shell
      // 浮卡里再套两张卡 = 卡片套卡片，层次太重。定稿回到本形态：面板
      // 满铺贴边，仅中缝 10px 灰缝（ChatColumnResizeHandle 自涂
      // bg-sidebar）提供视觉分隔。别再往这个方向试。
      //
      // The cards' outer corners are clipped by `.chat-app`'s own 4px radius
      // (overflow:hidden in main.css) — the same as each card's
      // `rounded-[4px]`, so the clip and the card radius coincide and no
      // corner reads as mismatched.
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-row bg-transparent"
    >
      {/* Left column: the chat itself (progress bar + message viewport +
          composer dock). In normal modes it's flex-1 and fills the whole
          width — visually identical to the old single column. In slides
          mode it shrinks to a fixed-width chat rail card and the slides
          workspace card takes the rest (figure 27); the workflow-script
          split rails it the same way. */}
      <div
        className={
          'relative flex h-full min-h-0 flex-col ' +
          // 4px (the smallest radius, matching .chat-app's clip) — explicit so
          // it can't drift if Tailwind's bare `rounded` default ever changes.
          (chatRailed
            ? 'shrink-0 overflow-hidden rounded-[4px] bg-card'
            : 'min-w-0 flex-1 bg-card')
        }
        // Split mode (slides / proposal / workflow script): width is
        // user-controlled (drag handle) and persisted. The old fixed
        // `w-[560px]` + `border-r` hairline are both gone — the gutter handle
        // now provides the visual separation. In normal modes width stays
        // flex-driven, so leave style unset.
        style={chatRailed ? { width: chatColWidth } : undefined}
      >
      {/* Chat header — 46px 单行顶栏：命令 chip + 标题 + 「AI 生成」徽标，
          hairline 底边（见 ChatHeader 注释）。shrink-0 so it never gets
          squeezed by the scrolling viewport below. */}
      <ChatHeader />

      {/* Top indeterminate progress bar. Absolute at the very top of
          the Thread root so it sits above the viewport mask and the
          composer. Presence-animated so it also fades in/out rather
          than popping. */}
      <AnimatePresence>
        {sessionLoadingChrome && <TopProgressBar />}
      </AnimatePresence>

      {/* Scrollable message area. The wrapper takes the flex slot
          (min-h-0 + flex-1, the canonical shrink-inside-flex-column
          pattern) and stays UNfiltered — it hosts the skeleton overlay,
          which must not inherit the curtain's blur. The Viewport fills it
          (h-full) and carries the switch-phase classes: transform/filter
          on the scroll CONTAINER composite the whole box without touching
          its internal scroll geometry (see the curtain history comment
          above — animating the inner column is what used to jitter). */}
      <div className="relative min-h-0 flex-1">
        <ThreadPrimitive.Viewport
          autoScroll
          // (Removed) top/bottom fade mask. The viewport used to fade its first
          // ~44px and last ~56px to transparent so scrolling text dissolved
          // near the header / composer; per design that fade-out is gone, so
          // messages now cut off cleanly at the edges. The inner column's
          // `pt-8` / `pb-20` padding still keeps the first/last message clear of
          // the header and composer dock.
          //
          // `scrollbar-gutter: stable` (kept) reserves the scrollbar track slot
          // whether or not the content overflows. Without it, the empty state
          // can land at the "just fits" boundary and any sub-pixel wobble
          // (font-metric changes, motion, font loading) flickers the scrollbar
          // in/out → horizontal reflow → visible jitter.
          className={
            'h-full overflow-y-auto [scrollbar-gutter:stable] ' +
            (switchPhase === 'out' || switchPhase === 'skeleton'
              ? 'ssw-out'
              : switchPhase === 'in'
                ? 'ssw-in'
                : '')
          }
        >
          {/* Inner column caps reading width and centers messages. The
              `min-h-full` lets the empty-state `flex-1` stretch so the
              hero text lands at the vertical center of the viewport
              even when there are no messages yet. The node identity is
              stable (no `key`) so the message list diffs by id instead of
              remounting the whole subtree on a switch. */}
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-3 pb-20 pt-8">
            <ThreadPrimitive.Empty>
              <EmptyState />
            </ThreadPrimitive.Empty>

            {/* 尾部窗口 gate：窗口外还有更早消息时出现在列顶。 */}
            <EarlierMessagesGate />

            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
                SystemMessage
              }}
            />
          </div>
        </ThreadPrimitive.Viewport>

        {/* Chat-shaped shimmer rows for loads that outlive the curtain.
            Sibling of the (blurred) Viewport, so it renders crisp on top
            of the veil. */}
        {switchPhase === 'skeleton' && <SessionSwitchSkeleton />}
      </div>

      {/* (Removed) 顶部渐进模糊带 — the backdrop-blur strip over the viewport
          top was dropped per design. The viewport's own top mask-image still
          fades the first ~44px of text to transparent so messages don't hit a
          hard edge as they scroll up; only the frosted blur layer is gone. */}

      {/* Composer dock — pinned to the bottom of Root, but ONLY once the
          thread has messages. While empty, the composer is rendered inside
          the centered EmptyState block instead (figure 26), so the dock is
          hidden to avoid a second Composer instance.

          `relative` so the frosted transition strip can absolutely position
          itself directly ABOVE the dock (bottom-full). The strip is a thin
          backdrop-blur band whose blur + opacity fade UPWARD to zero via a
          mask, so messages scrolling toward the composer soften and dissolve
          into it instead of hitting a hard edge — the bottom counterpart of
          the (removed) top blur band. pointer-events-none so it never blocks
          scrolling or text selection underneath. */}
      <ThreadPrimitive.If empty={false}>
        {/* Wrapper carries NO backdrop-filter of its own — critical, because a
            backdrop-filter on an ancestor cancels a descendant's
            backdrop-filter (CSS spec). The earlier strip lived INSIDE the
            blurred dock and so never blurred anything. Here the strip is a
            child of this clean wrapper, with the blur kept on the inner dock,
            so the strip's own backdrop-blur actually applies to the messages
            behind it. */}
        <div className="relative shrink-0">
          {/* Scroll-to-bottom affordance. Anchored to THIS wrapper (which hugs
              the composer dock) rather than Thread.Root, so it floats just
              above the input regardless of how tall the dock grows (composer
              content, slides dropdown, etc.) — the old Root-level
              `bottom-[80px]` was a magic number that landed the button INSIDE
              the dock once the composer got taller. Centering is also relative
              to the dock's width now, so it stays centered over the chat column
              instead of the whole ThreadView (which includes the slides pane). */}
          <ScrollToBottomButton />
          {/* Frosted transition strip — sits directly above the dock
              (bottom-full), blur + opacity fading UPWARD via the mask, so
              messages soften and dissolve into the composer instead of a hard
              edge. pointer-events-none so it never blocks scroll / selection. */}
          {/* Geometry: `bottom` is measured from the WRAPPER's bottom, and the
              wrapper hugs the dock, so bottom:100% puts the strip's bottom edge
              at the dock's TOP. The dock's pt-4 is 16px, so to drop the strip
              down to ~1px above the input we offset by (16px − 1px) = 15px:
              bottom-[calc(100%-15px)]. This covers the dock's pale pt-4
              background gap while leaving a 1px sliver for the input's top
              border. (Earlier 1px offset barely entered the dock → full gap;
              16px reached the input → blurred its border.) */}
          {!composerOverlayOpen ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-[calc(100%-15px)] z-10 h-14 backdrop-blur-md [mask-image:linear-gradient(to_top,black_0,black_40%,transparent_100%)]"
            />
          ) : null}
          {/* rounded-b-[4px] matches the card's bottom corners (the unified 4px
              radius). The dock's `backdrop-blur` rasterizes independently of the
              card's overflow-hidden + rounded clip (Chromium behavior), so
              without its OWN bottom radius the dock's square corners punched
              through and the card's bottom-left/right read as square. Rounding
              the dock itself to the same 4px restores the corners. */}
          <div className="rounded-b-[4px] bg-background/45 px-3 pb-3 pt-4 backdrop-blur-xl backdrop-saturate-150">
            {/* Floating permission card — docked directly above the
                composer (Codex-style), replacing the old amber inline
                prompt inside each tool card. Lives INSIDE the dock so it
                shares the frosted band and the composer's width column
                (the dock itself is full-rail width; the card's own
                max-w-4xl wrapper keeps it on the composer's axis).
                Renders null when nothing is pending. */}
            <PermissionFloatDock />
            <Composer />
          </div>
          {/* Dock veil for the skeleton phase of a session switch: the real
              composer stays mounted (no layout jump — the veil just covers
              it), and the shared ComposerSkeleton draws the loading shape
              exactly over it. Opaque background: unlike the viewport
              overlay (which sits on frosted content), the composer beneath
              is crisp text and would bleed through a translucent wash.
              justify-end pins the skeleton to the dock's bottom so any
              extra dock height (status strip / attachment row) is simply
              covered above it. */}
          {switchPhase === 'skeleton' && (
            <div className="absolute inset-0 z-20 flex flex-col justify-end rounded-b-[4px] bg-background px-3 pb-3 pt-4">
              <ComposerSkeleton />
            </div>
          )}
        </div>
      </ThreadPrimitive.If>
      </div>

      {/* Drag handle + gutter between the chat rail and the slides pane.
          Replaces the old `border-r` hairline: it carries the visual gap
          (a transparent gutter that reveals a faint divider on hover) AND
          the resize affordance. Gated on the same empty={false} as the pane
          so it only appears once the layout actually splits. */}
      {isSlidesMode && !isProposalMode ? (
        <ThreadPrimitive.If empty={false}>
          <ChatColumnResizeHandle onResizeStart={onResizeStart} />
        </ThreadPrimitive.If>
      ) : null}

      {/* Right pane: slides workspace. Only in slides mode AND once the
          thread has messages (empty={false}) — so picking 幻灯片 on the
          empty state keeps the centered hero until the first message is
          sent, then the layout splits (figure 27). */}
      {isSlidesMode && !isProposalMode ? (
        <ThreadPrimitive.If empty={false}>
          <SlidesWorkspace />
        </ThreadPrimitive.If>
      ) : null}

      {/* 写方案右栏：方案激活即分栏（不等首条消息——start() 即接管是原语义，
          面板自带空态引导）。拖拽手柄与 slides 共用同一实现与持久化宽度。 */}
      {isProposalMode ? (
        <>
          <ChatColumnResizeHandle onResizeStart={onResizeStart} />
          <ProposalDocPanel />
        </>
      ) : null}

      {/* 表格预览右栏：点成果卡片里的 xlsx/xls/csv 打开，应用内直接看
          数据。布局同 workflow 面板（chat rail 在左、面板 flex-1 在右），
          与它互斥且优先（用户显式点击 > 自动弹出）。 */}
      {showSheetPreview ? (
        <>
          <ChatColumnResizeHandle onResizeStart={onResizeStart} />
          <SpreadsheetPreviewPanel />
        </>
      ) : null}

      {/* 图片标记编辑右栏：点成果卡片里的图片打开，图上落标记逐点描述
          改动、可加融合素材，发送即走 imagegen skill 改图。布局与表格
          预览同构，二者 store 层互斥。 */}
      {showImageEdit ? (
        <>
          <ChatColumnResizeHandle onResizeStart={onResizeStart} />
          <ImageEditPanel />
        </>
      ) : null}

      {/* Workflow 脚本右栏（普通单栏会话专属，slides/proposal 分栏时让位
          ——showWorkflowPanel 已含 !isSplitMode，三列太挤）。AI 写脚本时
          自动弹出、args 定稿自动收起、点 Workflow 卡片的脚本入口手动重
          开。方向与 slides/proposal 一致：chat rail 在左、工作面板在右，
          面板 flex-1 吃大头（代码要宽），拖拽手柄同一实现同一持久化宽度。 */}
      {showWorkflowPanel ? (
        <>
          <ChatColumnResizeHandle onResizeStart={onResizeStart} />
          <WorkflowScriptPanel />
        </>
      ) : null}
    </ThreadPrimitive.Root>
  )
}

/**
 * Floating "scroll to bottom" affordance.
 *
 * Click behavior comes from `ThreadPrimitive.ScrollToBottom` (its
 * scroll-to-end math is fine). VISIBILITY, however, we compute
 * OURSELVES rather than keying on the primitive's `disabled` flag —
 * because that flag is unreliable at sub-pixel viewport heights.
 *
 * Why: assistant-ui decides "at bottom" with
 *   Math.abs(scrollHeight - scrollTop - clientHeight) < 1
 * but `Element.clientHeight` is an INTEGER (rounded). When the flex
 * layout sizes the viewport to e.g. 970.5px, clientHeight rounds to
 * 971 (or 970) while the real scrollable max is 970.5, so once pinned
 * to the bottom the expression evaluates to ±1 — and `|±1| < 1` is
 * false. The primitive then thinks we're NOT at bottom and the button
 * sticks around forever (observed: scrollHeight 1245, scrollTop 689,
 * clientHeight 557 → diff −1 → button never hides). A half-pixel
 * viewport height is enough to trigger it, so it's not a one-off.
 *
 * Fix: walk up to the scroll container, listen to scroll + resize, and
 * recompute "at bottom" with a 2px tolerance that swallows the rounding
 * jitter. We drive a `data-at-bottom` attribute the className keys on.
 *
 * Positioned absolutely inside the composer-dock wrapper (`bottom-full`
 * + mb-2), so it floats just above the input over the fading bottom of
 * the message list, tracking the dock's height instead of a fixed
 * offset, without pushing other layout around.
 */
function ScrollToBottomButton(): React.JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null)
  const viewportRef = useRef<HTMLElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    // The scroll viewport is NOT on our ancestor chain — it's a SIBLING.
    // DOM shape: Thread.Root → [ChatHeader, Viewport, dock-wrapper → us].
    // So: walk UP to the ancestor that contains the viewport in its subtree
    // (Thread.Root), then querySelector DOWN to grab it.
    //
    // We match by the viewport's own marker class `[scrollbar-gutter:stable]`
    // (set on exactly one element in ThreadView — the Viewport) rather than
    // by "is currently overflowing", so we still bind the listener when the
    // thread is short and only overflows LATER. Overflow is then decided per
    // tick by the distance math in recompute().
    const VIEWPORT_SELECTOR = '[class*="scrollbar-gutter"]'
    const findViewport = (): HTMLElement | null => {
      let anc: HTMLElement | null = btnRef.current?.parentElement ?? null
      while (anc) {
        const hit = anc.querySelector<HTMLElement>(VIEWPORT_SELECTOR)
        if (hit) return hit
        anc = anc.parentElement
      }
      return null
    }

    const TOLERANCE = 2 // px — absorbs sub-pixel clientHeight rounding
    const recompute = (): void => {
      const vp = viewportRef.current
      if (!vp) {
        // Not overflowing (no viewport found) ⇒ nothing to scroll ⇒ at bottom.
        setAtBottom(true)
        return
      }
      const distance = vp.scrollHeight - vp.scrollTop - vp.clientHeight
      setAtBottom(distance <= TOLERANCE)
    }

    const viewport = findViewport()
    viewportRef.current = viewport
    recompute()
    if (!viewport) return

    viewport.addEventListener('scroll', recompute, { passive: true })
    // Content height changes (streaming, message resize) move the bottom
    // without firing a scroll event, so watch the box too.
    const ro = new ResizeObserver(recompute)
    ro.observe(viewport)
    return () => {
      viewport.removeEventListener('scroll', recompute)
      ro.disconnect()
    }
  }, [])

  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        ref={btnRef}
        type="button"
        aria-label="Scroll to bottom"
        data-at-bottom={atBottom ? '' : undefined}
        className={
          'pointer-events-auto absolute left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/70 bg-background/90 text-foreground shadow-lg shadow-black/10 backdrop-blur transition-all duration-200 ease-out hover:border-brand/60 hover:bg-background hover:text-brand active:scale-95 ' +
          // Anchored to the dock wrapper: `bottom-full` puts the button's bottom
          // edge at the dock's TOP, then mb-2 lifts it 8px clear so it floats
          // just above the input. This tracks the dock height automatically —
          // no magic offset to drift out of sync when the composer grows.
          'bottom-full mb-2 ' +
          // We own the at-bottom check (see JSDoc): when our 2px-tolerant
          // calc says we're pinned, fade + drop + disable pointer so it
          // doesn't trap clicks. Keyed on data-at-bottom, NOT the primitive's
          // disabled flag, which mis-fires at half-pixel viewport heights.
          'data-[at-bottom]:pointer-events-none data-[at-bottom]:translate-y-2 data-[at-bottom]:opacity-0'
        }
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
          aria-hidden
        >
          <path d="M12 5v14" />
          <path d="m6 13 6 6 6-6" />
        </svg>
      </button>
    </ThreadPrimitive.ScrollToBottom>
  )
}

/* ───────────────────────── TopProgressBar ───────────────────────── */

/**
 * Thin indeterminate progress bar pinned to the top of ThreadView.
 * Shown while a session switch / new-session IPC is in flight
 * (see FusionRuntimeProvider.onSwitchToThread / onSwitchToNewThread —
 * both toggle `sessionLoading` on the chat store).
 *
 * Replaces the old full-column SessionLoadingView: that one read as a
 * hard interrupt (focus jumped to center, waited, jumped back). A
 * 2px top bar is the standard "something is loading" signal for modern
 * apps — keeps the user's focus on content and lets the existing keyed
 * enter animation do the "view changed" work on its own.
 *
 * Visual anatomy:
 *   - Track: full-width line, transparent so it only reads as the
 *            moving segment on top of the thread.
 *   - Segment: 35%-wide accent-colored strip that slides left → right
 *              in a 1.1s loop. The segment has a soft box-shadow in
 *              the accent color so it looks like a faint glow trailing
 *              the leading edge, echoing browser loading bars.
 *   - Fade in/out: the whole container fades 0 → 1 / 1 → 0 via
 *                  AnimatePresence in ThreadView. Keeps the bar from
 *                  popping in harshly for very fast switches.
 */
function TopProgressBar(): React.JSX.Element {
  return (
    <motion.div
      role="progressbar"
      aria-label="Loading session"
      aria-busy="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] overflow-hidden"
    >
      {/* Inner slider is absolutely positioned inside the track (which
          is already `absolute`, so it's the positioning context). A
          35%-wide accent segment animates from off-screen left to
          off-screen right in a 1.1s loop — the track's `overflow-hidden`
          clips the ends so it reads as a sliding highlight rather
          than a wrapping strip. Box-shadow in accent gives the
          leading edge a soft glow trail. */}
      <motion.div
        className="absolute top-0 h-full w-[35%] rounded-r-full bg-brand shadow-[0_0_10px_0_hsl(var(--brand)/0.55)]"
        initial={{ left: '-40%' }}
        animate={{ left: '100%' }}
        transition={{
          duration: 1.1,
          repeat: Infinity,
          ease: [0.42, 0, 0.58, 1]
        }}
      />
    </motion.div>
  )
}

/* ─────────────────────────── Chat header ─────────────────────── */

/**
 * Chat column header — 46px 单行顶栏（docs/ui-prototype-tool-card.html 的
 * 「标题·顶栏」定稿方案 + 2026-07-08 Notion 式收敛）：斜杠命令拆成绿色
 * mono chip、会话标题 14px 超长省略、紧跟一枚 ··· 会话操作菜单（重命名
 * 入口，样式与 rail 行菜单配对）、右端「AI 生成」hairline 徽标，底部
 * hairline 让它读作一根栏。
 * 取代旧的两行式（16px 标题 + 「内容由 AI 生成」副行）——副行独占一行
 * 且标题与内容列错位，读作调试信息而非会话锚点。
 *
 * Title comes from the shared sessionTitle store (fed by
 * FusionRuntimeProvider's thread-list adapter from the active session's
 * ThreadSummary). Falls back to a placeholder while no session is selected.
 *
 * `shrink-0` keeps it from being compressed by the scrolling viewport.
 * 单栏与 PPT 分栏共用：header 就在聊天列内部，slides 模式列宽收窄时
 * 内层对齐容器（max-w-4xl，同消息列）自然退化为全宽。
 */
function ChatHeader(): React.JSX.Element {
  const t = useT()
  const title = useSessionTitleStore((s) => s.title)
  const setTitle = useSessionTitleStore((s) => s.setTitle)
  // sessionId 供重命名链路使用（入口 disabled 判定、切会话丢弃编辑器、
  // commit 落到正确会话）。曾同时给标题入场动画做 remount key，动画已于
  // 2026-07-04 退役。
  const sessionId = useChatStore((s) => s.sessionId)
  const display = title && title.trim() ? title : t('chatHeaderUntitled')

  // 斜杠命令标题拆分：'/claude-desktop:ppt-master 武汉大学介绍' →
  // chip '/ppt-master'（冒号后短名；完整命令进 hover title）+ 正文标题。
  // 纯命令无参数、或非 '/' 开头的标题不拆——chip 只在「命令 + 参数」
  // 形态下才有语义（参数才是会话主题，命令是它的来源标记）。
  const cmdMatch = /^\/(\S+)\s+(\S[\s\S]*)$/.exec(display)
  const cmdFull = cmdMatch ? '/' + cmdMatch[1] : null
  const cmdShort = cmdMatch
    ? '/' + (cmdMatch[1].split(':').pop() ?? cmdMatch[1])
    : null
  const restTitle = cmdMatch ? cmdMatch[2] : display

  // ── In-place rename ──
  // The title itself is the rename entry point (mirrors the sidebar's
  // in-row editor; both funnel into the same renameSession IPC). Blur
  // COMMITS here — dropping half-typed input on a stray click reads as
  // data loss for a lightweight edit like this; Esc is the explicit
  // "never mind". (The sidebar editor keeps cancel-on-outside-click
  // because rows have a competing click action: switching sessions.)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  // ··· 菜单选「重命名」时置 true：菜单关闭的 auto-focus 默认把焦点还给
  // trigger 按钮，会跟 useEffect 里 rename input 的 focus 打架（radix 的
  // restore 也是异步的，晚一拍就把 input 的焦点抢走）。选中重命名的那次
  // 关闭用它拦掉 auto-focus，让 input 独占焦点；Esc/点外关闭不受影响，
  // 焦点照常回 trigger（键盘可达性）。
  const pendingEditRef = useRef(false)

  const startEdit = useCallback((): void => {
    if (!sessionId) return
    setDraft(title ?? '')
    setEditing(true)
  }, [sessionId, title])

  useEffect(() => {
    if (!editing) return
    const timer = window.setTimeout(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [editing])

  // A session switch mid-edit discards the editor — the draft belonged to
  // the PREVIOUS session's title; committing it against the new sessionId
  // would rename the wrong chat.
  useEffect(() => {
    setEditing(false)
  }, [sessionId])

  const commitEdit = useCallback(async (): Promise<void> => {
    setEditing(false)
    const trimmed = draft.trim()
    if (!sessionId || !trimmed || trimmed === title) return
    const previous = title
    // Optimistic: the header repaints now; the rename's sessionListChanged
    // broadcast re-derives the same value from disk via the list adapter.
    setTitle(trimmed)
    try {
      await window.chatApi.renameSession({ sessionId, title: trimmed })
    } catch (err) {
      console.error('[chatHeader] rename failed', err)
      setTitle(previous)
      window.alert(t('renameChatFailed'))
    }
  }, [draft, sessionId, title, setTitle, t])

  return (
    // 本 header 不再声明 app-region:drag（2026-07-08 拖拽面收敛重构）：
    // 窗口拖拽/双击缩放由根 layout 的 .window-drag-strip（常驻 fixed 全宽
    // 46px）统一负责——header 随会话切换反复重挂载，曾经自带的 drag 声明
    // 正是「region 上报被竞态吞掉 → 整窗拖不动」的脆弱源（globals.css 的
    // .window-drag-strip 注释有完整事故链）。header 只剩两件事：布局，和
    // 给顶部 46px 内的交互控件（标题按钮 / rename 输入框 / ··· 菜单）标
    // no-drag 在 strip 上挖洞——点它们是改名/开菜单，不是拖窗。
    // `select-none` keeps a press-drag on the chrome from starting a text
    // selection.
    //
    // 收起态左净空（2026-07-05，2026-07-08 标题左贴边后机制更直白）：rail
    // 收起后 chat 列顶到窗口左缘，左贴边的标题行会依次撞上左上角两样东西
    // ——① 红绿灯（浮在窗口 x≈30~90）② 收起态图标排（RailShell 的 fixed
    // 展开/搜索/新建，x≈100~184）。展开态无此问题：rail（244px）整体推开
    // chat 列，红绿灯落 rail 顶栏、图标排不渲染。故仅收起态给外层补左
    // padding 把整行推过两者。208px = 图标排右缘（x≈184）− 内容面左缘
    // （平铺后为 0，2026-07-08 stage gutter 归零，见 globals.css
    // .shell-stage；浮卡时代左缘 10px、本值 198）= 184 的净空基线，再 +24 让
    // 标题与图标排（尤其紧挨的「+」新建钮）之间留出呼吸（2026-07-05 用户要求
    // 「新对话钮跟标题加间距」，用户选 +24）。起点必须跟 tabRegistry 的
    // trafficLightPosition 与 RailShell 图标排 left-[100px] 联动（红绿灯/图标
    // 排右移则同增）。
    <div className="flex h-[46px] shrink-0 select-none items-center border-b border-border/55 [body[data-rail-collapsed]_&]:pl-[208px]">
      {/* 内层容器：标题左贴边（2026-07-08 用户定稿，参考 Claude.ai 顶栏
          「图标 + 标题 + ···」左对齐形态）。此前是 mx-auto max-w-4xl 与
          消息列同参居中——宽窗口时标题漂在中间偏左、与左缘脱节，用户
          否掉。px-4 与 rail 列表的左内边距呼应；「AI 生成」徽标仍 ml-auto
          钉右端。（旧结构在外层+内层各标一份 drag——现在拖拽由根
          .window-drag-strip 负责，声明已摘除。） */}
      <div className="flex h-full w-full min-w-0 items-center gap-2 px-4">
        {/* 会话图标（参考形态的左端锚点）：纯装饰的 muted 线性图标，给
            左贴边的标题一个视觉起笔；编辑态也保留，rename 输入框展开时
            行首不跳。 */}
        <MessageSquareText
          aria-hidden
          strokeWidth={1.75}
          className="size-4 shrink-0 text-muted-foreground/80"
        />
        {editing ? (
          <input
            ref={titleInputRef}
            value={draft}
            maxLength={200}
            name="rename-session-title"
            aria-label={t('renameChatPrompt')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commitEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              }
            }}
            onBlur={() => void commitEdit()}
            // Same type metrics as the h1 (14px/medium/leading-tight) so the
            // header doesn't jump a pixel entering/leaving edit mode; negative
            // margin re-absorbs the input's own padding for the same reason.
            // 编辑的是完整原始标题（含命令前缀）——chip 只是展示态拆分。
            // border 用 --brand 而非 --ring：ring 会被 appearance applier 换成
            // 用户主题色，而「正在重命名」的绿框与 rail 行内编辑是同一身份。
            className="-mx-1.5 -my-0.5 w-[min(480px,100%)] rounded-md border-[1.5px] border-brand bg-background px-1.5 py-0.5 text-[14px] font-medium leading-tight text-foreground outline-none ring-2 ring-brand/20 [-webkit-app-region:no-drag]"
          />
        ) : (
          <>
            {cmdShort ? (
              <span
                title={cmdFull ?? undefined}
                className="shrink-0 rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 font-mono text-[11px] leading-none text-brand"
              >
                {cmdShort}
              </span>
            ) : null}
            {/* 无切换动画：曾是 key={sessionId} 重挂载的 motion.h1（淡入+3px
               上浮入场），2026-07-04 应用户要求退役——切会话时标题即时呈现，
               与 rail 选中态同一节奏（同日退役的 glider 滑块）。 */}
            <h1 className="flex min-w-0 items-center text-[14px] font-medium leading-tight text-foreground">
              <button
                type="button"
                onClick={startEdit}
                disabled={!sessionId}
                title={sessionId ? t('renameChat') : undefined}
                aria-label={
                  sessionId ? `${t('renameChat')}: ${display}` : undefined
                }
                // group/title scopes the pencil reveal to hovering the title
                // itself, not the whole header band.
                className="group/title flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 text-left transition-colors [-webkit-app-region:no-drag] enabled:cursor-text enabled:hover:bg-foreground/[0.05] disabled:cursor-default"
              >
                <span className="min-w-0 truncate" title={display}>
                  {restTitle}
                </span>
                {sessionId ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-80 group-focus-visible/title:opacity-80"
                  >
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                ) : null}
              </button>
            </h1>
            {/* ··· 会话操作菜单（2026-07-08 用户要求，Notion 顶栏样式）：
               紧跟截断标题右侧，超长标题省略后菜单钮仍然贴着可见文本。
               目前只有「重命名」（与点击标题的行内编辑同一入口）；后续
               会话级操作（删除/移动工作区…）往这里加。无会话时不渲染
               ——菜单里全是会话操作，空态挂个禁用按钮只是噪音。
               Content portal 到 body、脱离 .chat-app 豁免，但 shadcn 原语
               自带 data-slot，天然逃逸 canvas 裸元素 reset（CLAUDE.md）。 */}
            {sessionId ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('chatHeaderMenu')}
                    title={t('chatHeaderMenu')}
                    className="shrink-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                {/* 样式零覆盖：菜单精修档已是 ui/dropdown-menu 基件默认
                   （2026-07-08 晋升，见其头注释），与 rail 行菜单天然同款，
                   不再需要手工同步数值。 */}
                <DropdownMenuContent
                  align="start"
                  onCloseAutoFocus={(e) => {
                    if (pendingEditRef.current) {
                      pendingEditRef.current = false
                      e.preventDefault()
                    }
                  }}
                >
                  <DropdownMenuItem
                    onSelect={() => {
                      pendingEditRef.current = true
                      startEdit()
                    }}
                  >
                    <Pencil strokeWidth={1.75} /> {t('renameChat')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        )}
        {/* 「AI 生成」合规声明：从独占一行的副行收敛为右端 hairline 徽标。 */}
        <span className="ml-auto shrink-0 rounded-full border border-border/90 px-2 py-0.5 text-[10.5px] leading-none text-muted-foreground/85">
          {t('chatHeaderAiBadge')}
        </span>
      </div>
    </div>
  )
}

/* ───────────────────────── EmptyState ───────────────────────── */

/* The scenario prompt-card grid was removed from the empty state — it's now
   just the title + hint, and the user starts by typing in the composer.
   The card definitions (SCENARIO_CARDS), the onPickScenario handler, and the
   per-card icon components (PptIcon / LightbulbIcon / UserCheckIcon /
   ChartIcon) were deleted with it; the `scenario*` i18n keys are left in
   i18n.ts. Restore from git history to bring the grid back. */

/**
 * Empty thread state (figure 26): a vertically-centered block of
 * mascot → title → subtitle → composer → promo banner. The composer is
 * rendered HERE (not in the bottom dock) so it sits in the centered group;
 * the bottom dock is hidden while empty (ThreadPrimitive.If empty={false}
 * in the main render) so there's only ever one Composer instance. Once the
 * thread has messages, the dock takes over and the composer pins to the
 * bottom as usual.
 */
function EmptyState(): React.JSX.Element {
  const t = useT()
  return (
    // Enter fade on mount (new chat / switching to an empty session). Pure
    // opacity ONLY: this block lives INSIDE the scroll viewport, where any
    // transform risks the scrollbar-flicker regression documented on the
    // viewport — so no y/scale here, just a slightly longer fade for feel.
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-1 flex-col items-stretch justify-center py-10"
    >
      {/* Mascot — green chat-bubble glyph. */}
      <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-[var(--rail-accent-soft,#dcf5e6)]">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16.5H9l-4 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z"
            stroke="var(--rail-accent-ink,#0f7a38)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle cx="9" cy="11" r="1" fill="var(--rail-accent-ink,#0f7a38)" />
          <circle cx="15" cy="11" r="1" fill="var(--rail-accent-ink,#0f7a38)" />
        </svg>
      </div>
      <h1 className="mb-2.5 text-[30px] font-bold tracking-tight text-foreground">
        {t('emptyStateTitle')}
      </h1>
      <p className="mb-7 text-[14px] text-muted-foreground/80">
        {t('emptyStateScenarioHint')}
      </p>

      {/* Composer sits inside the centered block (not the bottom dock). */}
      <Composer />

      {/* Promo banner (figure 26) — VISUAL-ONLY placeholder; the desktop app
          has no credits/PRO system behind it. */}
      <div className="mt-7 flex items-center gap-4 rounded-2xl bg-foreground/[0.03] px-5 py-4 ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
        <div className="size-11 shrink-0 rounded-xl bg-gradient-to-br from-sky-200 to-emerald-200" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-foreground">
            新用户首登立领2000积分，教师/学生认证再送4000积分
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            2000积分含新用户注册时赠送的300积分，查看{' '}
            <span className="text-[var(--rail-accent-ink,#0f7a38)]">教师/学生认证</span> 和{' '}
            <span className="text-[var(--rail-accent-ink,#0f7a38)]">活动规则</span>
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-full bg-foreground px-4 py-2 text-[12.5px] font-medium text-background"
        >
          领取PRO
        </button>
      </div>
    </motion.div>
  )
}
