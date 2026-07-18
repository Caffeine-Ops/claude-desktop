import { useCallback, useEffect, useRef, useState } from 'react'
import { ThreadPrimitive, ComposerPrimitive, useComposerRuntime } from '@assistant-ui/react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Clapperboard,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Play
} from 'lucide-react'
import { Button } from '@/src/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/src/components/ui/dialog'
import { Input } from '@/src/components/ui/input'
import { Label } from '@/src/components/ui/label'

import { useBackgroundZoneStore } from '@/src/stores/backgroundZone'
import { useI18n, useT } from '../../../i18n'
import { attachFilesToComposer } from '../../../composer/attachFiles'
import { useChatStore } from '../../../stores/chat'
import { useComposerModeStore } from '../../../stores/composerMode'
import { useSessionTitleStore } from '../../../stores/sessionTitle'
import { findSkillChipSpec } from '../../../composer/skillChipRegistry'
import { SkillChipIcon } from '../SkillChipIcon'
import { Composer } from './Composer'
import { DemoShowcase } from './DemoShowcase'
import { ReplayControlBar } from '../ReplayControlBar'
import { ReplayController } from '../../../replay/ReplayController'
import { isReplaySessionId } from '../../../replay/replayStore'
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
import { stripMessageMarker } from '../../../lib/messageMarkers'
import { condenseFileMentions } from '../../../lib/mentionDisplay'
import { OutputsButton } from './OutputsPanel'

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
      // w-1.5 = 6px gutter between the two panes，原是纯色 bg-sidebar（窗口底面
      // 同款灰）：透明版透出的是 .chat-app 背后的 shell-content-card
      // （--card，近白），白缝夹两白面板等于隐形，所以必须自涂。Root 保持
      // 透明满铺（「双浮卡」方案已被否，见 Root 注释），缝的颜色只能落在
      // 这里。（旧浮卡时代是 10px、与 rail↔卡的 gutter 同色同宽呼应；
      // 2026-07-08 平铺化后 gutter 没了，同日用户要求缝再收窄——6px 是
      // 拖拽热区可抓性的下限档位，别再往下压。）
      // 毛玻璃质感（2026-07-18，跟 composer/rail/workspace 面同一批）：纯色
      // 换成半透明 + backdrop-blur——两侧面板现在也都是玻璃质感，缝还按老
      // 实色画会在两片玻璃中间夹一条突兀的纯色硬线。半透明不会重蹈"白缝
      // 隐形"：blur 本身在边界处产生的折射/明暗过渡就是可见的缝，不需要
      // 底色纯不透明来撑存在感。
      // The hit area spans the whole gutter so the handle is easy to
      // grab; touch-none stops scroll/pan hijacking the drag; `group`
      // drives the child divider's hover reveal.
      className="group relative flex h-full w-1.5 shrink-0 cursor-col-resize touch-none items-stretch justify-center bg-sidebar/55 backdrop-blur-xl backdrop-saturate-150"
    >
      {/* The visible divider: a soft brand-green line, invisible at rest,
          fading in on hover and while dragging (group-active). A vertical
          mask-image gradient fades the line's TOP and BOTTOM ends out to
          transparent so it does NOT run edge-to-edge — it's strongest in the
          middle and dissolves at both ends. A gentle glow keeps it reading as
          the highlighted drag affordance. Fixed --brand (not --accent): this
          is a chrome affordance, not a user-theme surface — it must stay the
          same green regardless of the user's accent color. Centered in the
          gutter so the whitespace splits evenly between the two panes. */}
      <div className="h-full w-px bg-brand/80 opacity-0 shadow-[0_0_8px_2px_hsl(var(--brand)/0.3)] transition-opacity duration-150 [mask-image:linear-gradient(to_bottom,transparent_0,black_18%,black_82%,transparent_100%)] group-hover:opacity-100 group-active:opacity-100" />
    </div>
  )
}

/**
 * 会话切换加载态 = 骨架屏，唯一信号是 store 的 `sessionSwitching`
 * （2026-07-17 用户要求：去掉顶部进度条，对话区改骨架屏加载）。
 *
 *   idle ──(beginSessionSwitch)──> skeleton ──(setSession 挂载目标)──> idle
 *
 * 为什么绑 `sessionSwitching` 而不是 `sessionLoading`（进度条的旧数据源）：
 * 两者看着都是「切换中」，语义却差一整个冷启动——
 *   - sessionSwitching：click → 目标 transcript 上屏。**正是历史还没内容
 *     可显的窗口**，也正是骨架该占位的窗口。
 *   - sessionLoading：一路 true 到 switchSession resolve。历史那时早已上屏，
 *     拿骨架盖住已在屏的内容是错的（见 stores/chat.ts 对该字段的警告）。
 * 实测两窗口现已几乎重合：engine.switchToSession 是 lazy 的（只切指针、
 * 单微任务返回，cli 冷启动推迟到首次 send），所以 sessionLoading 实际只
 * 跟着 loadSession 的磁盘读走——换句话说进度条能覆盖的时间，骨架一样覆盖，
 * 删它不留反馈真空。冷启动期的交互闸门另在别处（composer 走 isLoading）。
 *
 * 不做延迟门槛（旧进度条要 200ms 去抖、旧帘幕要 600ms 才升级骨架）：
 * cache-hit 路径的 setSession 与 beginSessionSwitch 落在同一个 store batch，
 * 订阅者根本观察不到 true，快切天然零骨架；真有磁盘读时骨架立刻占位才是
 * 「点了有反应」。
 *
 * ⚠️ 更要命的是：**延迟门槛在这条路径上根本不可能生效**。冷路径一 resolve，
 * 主线程就被 IPC 大 payload 的反序列化 + setSession 的同步大 commit 连续占满
 * （实测切一个 PPT 长会话，8ms 的 setInterval 探针被推迟到 ~130ms 才跑一次，
 * 持续 400ms）。setTimeout / rAF / React 渲染在那扇窗口里全部停摆——门槛的
 * timer 只会在阻塞结束后才 fire，骨架反而卡在「加载已完成」的时刻才出现。
 * 骨架必须在阻塞**开始之前**就已合成上屏，也就是 beginSessionSwitch 的同一拍。
 */
function useSessionSwitchLoading(): boolean {
  return useChatStore((s) => s.sessionSwitching)
}

/**
 * Chat-shaped shimmer skeleton shown while a session switch loads its
 * transcript. The rows mirror the transcript's real anatomy — a
 * right-aligned user pill, then left-aligned assistant paragraph bars —
 * so the loading state previews the shape of what's coming instead of
 * showing a generic spinner. Shimmer gradient matches `.pes-sk`
 * (main.css); classes live there too (`.ssw-*`).
 *
 * 底必须挡住旧内容：帘幕退役后，身下是旧会话内容，纯透明会让两个会话的
 * 文字**清晰**叠印在一起。骨架必须完全接管这块区域的可读性——但「完全
 * 接管」≠「必须纯实底」：2026-07-18 毛玻璃质感统一改造后加了 backdrop-
 * blur（2026-07-19 用户两轮要求调低模糊度，2xl → xl → 目前的 lg——比同批
 * 其它玻璃面板的 xl 标准更轻，是刻意的例外，不要「统一」回 xl）。**lg 这一档
 * 比 xl 更接近「能看清壁纸细节」和「旧文字彻底认不出」之间的临界点**——配
 * 合下方 veil-strong（只有 ~0.5 不透明）已经不是很有富余了，以后如果真机
 * 发现旧会话文字有可辨认的鬼影，先回调这里的 blur 档位，不要改 veil-strong
 * （那个数值全项目其它玻璃面板共用）。所以配合较高但非 100% 的不透明度：
 * 既跟全项目玻璃质感语言一致，又不会重新踩「两会话文字叠印」的坑。**别把
 * 这里的不透明度降到跟菜单/composer 那些浮在壁纸上的用法一个档位**——那些
 * 身下是壁纸，这里身下是真实文字内容，风险不对等。
 *
 * 壁纸换肤开着时（`html[data-bg-art]`）改走 veil 变量，不再是这里的固定
 * `/85`（2026-07-18 用户要求骨架屏期间也要看得见壁纸图案）：`.session-
 * switch-skeleton` 类是 background-art.css 的挂钩，那条规则把底色换成
 * `--bg-art-veil-strong`——跟 focus 态消息区、workspace-split-panel 同一档，
 * 因为身下同样是「真实内容 + 需要盖住」的风险类别，不是新发明一档。这里的
 * `bg-card/85` 只在无壁纸（data-bg-art 不存在）时生效，是该规则的选择范围
 * 之外，两者不冲突。
 *
 * ⚠️ 底色是 bg-card 不是 bg-background——聊天内容列自身铺的就是 bg-card
 * （见 dropzone 容器的 className），而两个 token 差着一档（浅色 100% vs
 * 97%、暗色 13% vs 10%）。盖错会在白卡上糊出一块灰色矩形，正是「canvas
 * 内容区铺灰底盖住共享白色 shell-content-card」那条事故的同族。改这里的
 * 底色前先确认身下那层现在铺的是什么。
 *
 * ⚠️ **刻意没有淡入**（只有 exit 淡出）——别「补」回来。第一版写了
 * initial/animate 的 150ms opacity 淡入，实测（CDP 逐帧采样）峰值透明度只
 * 到 **0.27**：motion 的 opacity 是 JS 驱动的，而骨架服役的整个窗口恰恰是
 * 主线程被 IPC 反序列化 + 大 commit 占满的窗口，淡入根本跑不动，直到加载
 * 结束主线程空闲才爬起来——然后立刻被 exit 打断。骨架于是只在「已经不需要
 * 它」的一瞬现身，把「立刻占位」这个唯一使命弄丢了。mount 即 opacity:1 与
 * 主线程状态无关，任何时候都成立。
 * （exit 淡出可以留：那时 mount 已完成、主线程空闲，实测曲线平滑。）
 * 骨架条自身的交错入场仍由 .ssw-sk 的 CSS animation 负责——CSS 的
 * opacity/transform 动画跑在合成器线程上，不受主线程阻塞影响，与这里的
 * JS 驱动动画是两回事。
 */
function SessionSwitchSkeleton(): React.JSX.Element {
  return (
    <motion.div
      aria-hidden
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="session-switch-skeleton absolute inset-0 z-10 overflow-hidden bg-card/85 backdrop-blur-lg backdrop-saturate-150"
    >
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
          inside the now-covered viewport, no dock) leaves the bottom of the
          pane hollow — this fills that hole and previews the target
          session's layout. The NON-empty case (real dock present) gets its
          own overlay INSIDE the dock instead (same ComposerSkeleton,
          perfectly aligned over the real composer). */}
      <ThreadPrimitive.If empty>
        <div className="absolute inset-x-0 bottom-3 px-3">
          <ComposerSkeleton />
        </div>
      </ThreadPrimitive.If>
    </motion.div>
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
        // 毛玻璃质感（2026-07-18，跟账户菜单/composer/rail 同一批）：实底
        // bg-background 换成半透明 + backdrop-blur。
        className="rounded-full border border-border/70 bg-background/55 px-3.5 py-1.5 text-[12px] text-muted-foreground shadow-sm backdrop-blur-xl backdrop-saturate-150 transition-colors hover:bg-hover hover:text-foreground"
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

/**
 * Reports "which background-art scrim tier does the chat face want" to
 * SurfaceHost (the sole `data-bg-zone` writer) — renders nothing. Mounted
 * once in each of the two `ThreadPrimitive.Empty` / `ThreadPrimitive.If
 * empty={false}` branches below; since assistant-ui only ever keeps one of
 * the two mounted at a time, this is a plain last-write on mount, not a
 * race between siblings. See stores/backgroundZone.ts for why this lives
 * outside chat/stores.
 */
function BgZoneReporter({ zone }: { zone: 'ambient' | 'focus' }): null {
  useEffect(() => {
    useBackgroundZoneStore.getState().setChatZone(zone)
  }, [zone])
  return null
}

export function ThreadView(): React.JSX.Element {
  // Session transition signals from the chat store.
  //   - sessionId      : switches when loadSession resolves (~100ms, or
  //                      synchronously on a history-cache hit).
  //   - sessionSwitching : click → 目标 transcript 上屏的窗口，驱动骨架屏
  //                      （见 useSessionSwitchLoading 的长注释）。
  // 旧的 sessionLoading → 顶部细进度条这条链已删（2026-07-17）：切换加载
  // 态统一由骨架屏承担，形状即目标页面，而不是一条与内容无关的顶部细线。
  const sessionId = useChatStore((s) => s.sessionId)
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
  // 自管整列 dropzone（原 AttachmentDropzone，2026-07-16 附件内联化）：
  // dragenter/leave 深度计数（子元素间成对冒泡，归零才是真离开），drop 走
  // attachFilesToComposer 统一分流。runtime 只给无路径文件的 addAttachment
  // 兜底用。
  const dragDepthRef = useRef(0)
  const composerRuntime = useComposerRuntime()
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
  // 会话切换加载态：骨架屏盖住内容区直到目标 transcript 上屏。
  //
  // History, so nobody re-treads it（这块反复翻烧过三轮，别再往回走）：
  //   v1 keyed the content column by sessionId → full subtree remount, every
  //      code block re-highlighting in one frame ("switch jank").
  //   v2 kept node identity + played a 0.3→1 opacity fade on the INNER
  //      column. Deliberately opacity-only, because a y+blur intro applied
  //      to the inner column had pushed the scroll container past its
  //      viewport and flickered the scrollbar.
  //   v3 帘幕：把 blur+位移挪到滚动容器自身（不碰内部滚动几何，v2 的抖动
  //      物理上不可能复现）。2026-07-04 用户否决——切换要即时呈现，整套被
  //      SESSION_SWITCH_TRANSITION_ENABLED 关停，只留顶部细进度条报进度。
  //   v4 (this，2026-07-17)：进度条也去掉，加载态回归骨架屏——一条与内容
  //      无关的顶部细线读不出「在加载什么」，骨架的形状本身就是答案。帘幕
  //      连同那个开关一并删除（两次判定同向：切换不要转场动画）。
  //
  // 骨架只在 sessionSwitching 期间挂载，快切（cache hit）零骨架——原因见
  // useSessionSwitchLoading 的注释。
  const switchLoading = useSessionSwitchLoading()

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
          split rails it the same way.

          It's also the file-drop target, applied to this ENTIRE column
          rather than just the composer card, so dragging a file over the
          message viewport or header works too, not only over the input.
          （2026-07-16 附件内联化）曾是 assistant-ui 的 AttachmentDropzone
          (asChild)——其 drop 只会 addAttachment；换成自管的四个 drag
          handler 后，drop 走统一分流 attachFilesToComposer：有路径 →
          编辑器内联 `@"path"` mention chip，无路径 → attachments 兜底。
          `data-dragging` 由 dragenter 深度计数命令式维护（enter/leave 在
          子元素间成对冒泡，计数归零才算真正离开），高亮 overlay 的
          `group-data-[dragging=true]/dropzone` CSS 原样复用。 */}
        <div
          onDragEnter={(e) => {
            if (!e.dataTransfer?.types.includes('Files')) return
            e.preventDefault()
            if (++dragDepthRef.current === 1)
              e.currentTarget.setAttribute('data-dragging', 'true')
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types.includes('Files')) return
            e.preventDefault()
          }}
          onDragLeave={(e) => {
            if (dragDepthRef.current > 0 && --dragDepthRef.current === 0)
              e.currentTarget.setAttribute('data-dragging', 'false')
          }}
          onDrop={(e) => {
            e.preventDefault()
            dragDepthRef.current = 0
            e.currentTarget.setAttribute('data-dragging', 'false')
            const files = Array.from(e.dataTransfer?.files ?? [])
            if (files.length > 0) void attachFilesToComposer(files, composerRuntime)
          }}
          className={
            // chat-content-column：语义类名，仅供 background-art.css 在背景图
            // 换肤开启时把这层从不透明 bg-card 转透明（html[data-bg-art]
            // .chat-content-column）——这是聊天列自己的底色（见上面 ⚠️ 注释），
            // 挡在 .surface-face--chat 的壁纸遮罩之上，不打透整个消息区就是
            // 纯黑（2026-07-17 真机实锤）。不参与本来的视觉语义，只是挂点。
            'group/dropzone chat-content-column relative flex h-full min-h-0 flex-col ' +
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

      {/* （已删）顶部细进度条 —— 2026-07-17 用户要求，切换加载态改由下面的
          骨架屏承担。 */}

      {/* Scrollable message area. The wrapper takes the flex slot
          (min-h-0 + flex-1, the canonical shrink-inside-flex-column
          pattern) and is the positioning context for the skeleton overlay
          （骨架是它的绝对定位子节点，盖住 Viewport 但不盖 header）。 */}
      <div className="relative min-h-0 flex-1">
        <ThreadPrimitive.Viewport
          // turnAnchor="top"：新一轮开始时，把刚发的用户消息钉在视口顶部
          // （assistant-ui 内置行为，MessagePrimitive.Root 已经在用、不需要
          // 额外标记——见其自身文档："No additional component is required"）。
          // 效果是发送后整页基本只看得到这一条消息，下面留白随回复流式填满，
          // 而不是像旧版那样把整段历史继续钉在屏幕上、新消息只是缀在底部。
          //
          // 不再传 autoScroll（连带上面旧的 hasMessages 派生一起删）：库在
          // turnAnchor="top" 时把它默认成 false（useThreadViewportAutoScroll.js
          // 的 `autoScroll = turnAnchor !== "top"`）。这里刻意不显式传 true 扳回
          // 来——库的跟随分支门槛是它自己的 isAtBottom，而那个判定式
          // `|scrollHeight-scrollTop-clientHeight| < 1` 在本项目的半像素视口下
          // 不可靠（实测视口真实高 1009.5、clientHeight 取整成 1010，差值 −0.5；
          // 换个窗口尺寸就能凑出 ±1 让判定恒假，2026-07-13 那次「明明在最底部
          // 却不动」就是它）。跟随统一交给 ScrollToBottomButton 里那套 2px 容差
          // 的自研实现（followIfSticky），不受亚像素影响，见其注释。
          //
          // 空态（欢迎页）关闭 autoScroll 的旧诉求也顺带被这个默认值覆盖了。
          turnAnchor="top"
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
          // 不再挂 ssw-out / ssw-in 帘幕类（v3 随进度条一起退役）：切换期
          // 视口保持原样，由骨架屏不透明盖住即可——容器上再叠 filter 会让
          // 它成为 fixed 后代的 containing block，白付一份合成开销。
          className="h-full overflow-y-auto [scrollbar-gutter:stable]"
        >
          {/* Inner column caps reading width and centers messages. The
              `min-h-full` lets the empty-state `flex-1` stretch so the
              hero text lands at the vertical center of the viewport
              even when there are no messages yet. The node identity is
              stable (no `key`) so the message list diffs by id instead of
              remounting the whole subtree on a switch. */}
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-3 pb-20 pt-8">
            <ThreadPrimitive.Empty>
              <BgZoneReporter zone="ambient" />
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

        {/* 切换加载骨架：Viewport 的兄弟节点，不透明盖住旧 transcript 直到
            目标会话上屏。AnimatePresence 在这里只为**延迟 unmount** 以播 exit
            淡出（入场刻意无动画，理由见 SessionSwitchSkeleton 注释）。 */}
        <AnimatePresence>
          {switchLoading && <SessionSwitchSkeleton />}
        </AnimatePresence>
      </div>

      {/* (Removed) 顶部渐进模糊带 — the backdrop-blur strip over the viewport
          top was dropped per design. The viewport's own top mask-image still
          fades the first ~44px of text to transparent so messages don't hit a
          hard edge as they scroll up; only the frosted blur layer is gone. */}

      {/* Composer dock — pinned to the bottom of Root, but ONLY once the
          thread has messages. While empty, the composer is rendered inside
          the centered EmptyState block instead (figure 26), so the dock is
          hidden to avoid a second Composer instance.

          `relative` anchors the scroll-to-bottom button (absolute, just
          above the dock). */}
      <ThreadPrimitive.If empty={false}>
        <BgZoneReporter zone="focus" />
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
          {/* Frosted band 全退役（2026-07-16 用户实锤「去掉模糊」）：dock 的
              backdrop-blur-xl 毛玻璃底 + 上沿的渐变 blur 过渡条曾让滚到
              composer 上方的消息糊成一片。现在 dock 纯透明——消息清晰滚过，
              滚到卡后面由卡自身的 bg-popover/95 遮住。连带退役的还有为
              blur 光栅化服务的 rounded-b-[4px] workaround 和「盖住 pt-4
              浅色 gap」的 15px 偏移几何（gap 随半透明底一起消失了）。 */}
          <div className="px-3 pb-3">
            {/* 权限请求不再是这里的浮卡（PermissionFloatDock 已退役，
                2026-07-16）：pending 权限时 Composer 输入卡自己整卡 morph
                成 PermissionComposerPanel（与 AskUserQuestion 提问面板
                同一个 AskComposerSwap 槽），恢复自 git 历史。 */}
            <Composer />
          </div>
          {/* Dock veil during a session switch: the real composer stays
              mounted (no layout jump — the veil just covers it), and the
              shared ComposerSkeleton draws the loading shape exactly over
              it. 身下是清晰的真 composer，所以配 backdrop-blur-lg 磨成认不出
              字形的色斑（同视口骨架的论证与档位，两处一起调过，见
              SessionSwitchSkeleton 注释——那边有临界点的提醒）—
              —有了这层模糊，底色才能安全地跟视口骨架一样挂 `.session-switch-
              skeleton` 钩子：无壁纸时是这里的 bg-card（= 内容列自身的底，
              别改成 bg-background，两者差一档会糊出灰块），壁纸开着时
              background-art.css 换成 --bg-art-veil-strong（2026-07-18，同
              视口骨架一起要求「骨架屏也要看得见壁纸图案」）。
              justify-end pins the skeleton to the dock's bottom so any
              extra dock height (status strip / attachment row) is simply
              covered above it. Padding 与 dock 同参（px-3 pb-3，dock 的
              pt-4 已随 frosted band 一起退役）——骨架必须画在真 composer
              的精确位置上。淡入淡出与视口骨架同参，两块一起进退。 */}
          <AnimatePresence>
            {switchLoading && (
              <motion.div
                aria-hidden
                // 与视口骨架同参：无淡入（主线程阻塞期跑不动，理由见
                // SessionSwitchSkeleton 注释），只淡出。
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="session-switch-skeleton absolute inset-0 z-20 flex flex-col justify-end rounded-b-[4px] bg-card px-3 pb-3 backdrop-blur-lg backdrop-saturate-150"
              >
                <ComposerSkeleton />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </ThreadPrimitive.If>

      {/* Full-column drag highlight. Sibling of the header/viewport/dock
          stack (not a descendant), absolutely positioned over the whole
          column, so it reads as "drop anywhere in this chat" rather than
          just tinting the composer card. Driven purely by CSS via the
          `group/dropzone` marker + the primitive's `data-dragging`
          attribute — no local state needed here. pointer-events-none so it
          never steals the dragover/drop events the primitive is capturing
          on the column itself. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-30 hidden rounded-[4px] ring-2 ring-inset ring-[hsl(var(--brand)/0.5)] bg-brand/[0.06] group-data-[dragging=true]/dropzone:block"
      />
      {/* 回放播放控制条：录像播放期悬浮在聊天列底部中央（absolute 挂本列
          的 relative 容器，贴底避开顶部 drag-strip）。status==='idle' 时
          自渲染 null，零成本常驻。 */}
      <ReplayControlBar />
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
          sent, then the layout splits (figure 27).
          回放的 slides 会话也走 SlidesWorkspace——大纲/文件/图片 tab 全是
          消息派生的，回放免费复活；只有依赖 live server 的预览 tab 在
          workspace 内部按回放态换成静态查看器（见 ReplaySlidesViewer）。 */}
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
 * Floating "scroll to bottom" affordance + 钉底跟随兜底 (sticky-bottom).
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
 * 钉底跟随兜底（2026-07-13）：同一个坏判定式还杀死了 Viewport 的
 * autoScroll——库的跟随条件是内部 isAtBottom 标志，而该标志只在 scroll
 * 事件里按 `<1` 式重算，且「向下滚动未到底一律忽略」：用户滚上去一次
 * （标志置 false）再滚回底部，在半像素几何下判定式恒为 ±1，标志永远
 * 回不到 true → 内容再长高也不跟随（「明明在最底部却不动」）。库的
 * isAtBottom 无法从外部矫正（useThreadViewportStore 不在包根导出，
 * exports map 只开放 "."，deep import 会被构建器拒绝），所以这里用
 * 同一套 2px 容差自己实现跟随：`sticky` 随每个 scroll 事件更新（滚上
 * 去解除、滚回底部挂上），任何几何变化（内容长高 / 视口盒子变化）时
 * sticky 就把 scrollTop 钉回底。与库的原生 autoScroll 并存不冲突——
 * 几何完好时两边滚向同一位置（幂等），几何坏时我们兜底。
 *
 * RO 同时观察内容列（Viewport 的唯一子元素）：视口自身盒子不随内容
 * 长高变化，只观察视口盒子的话，跟随失效期间纯内容增长连按钮重算都
 * 不触发（按钮迟到出现的次生 bug，与跟随一起修）。
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
    const distanceToBottom = (vp: HTMLElement): number =>
      vp.scrollHeight - vp.scrollTop - vp.clientHeight

    // 「用户正在展开/收起某个折叠块」的让路窗口（见 followIfSticky 的门控）。
    // 事件委托在视口上，而不是给每个折叠组件挂钩子：聊天流里的折叠块有四处
    // <details>（ToolCallCard / WorkflowTaskTree / bash、web 两个 formatter）
    // 外加思考过程那个 aria-expanded 按钮，将来还会有——委托一处全覆盖，新增
    // 折叠块零改动。
    //
    // 只认 summary / [aria-expanded]，不是「点了任何东西都让路」：流式期间
    // 用户点个复制按钮、选段文字都不该让跟随停摆。
    //
    // 用 click 而不是 details 的 toggle 事件：toggle 分不清人点的还是代码改
    // 的，而 ToolCallCard 的 <details open={running}> 在 running→settled 时会
    // 自己 toggle 一次——那次不是用户主导，不该让路。click.isTrusted 精确区分。
    // capture 阶段挂，抢在 React 合成事件之前，避免被 stopPropagation 吃掉。
    const USER_TOGGLE_GRACE_MS = 400 // details 展开动画 0.32s + 余量
    let userToggleAt = 0
    const isUserToggling = (): boolean =>
      Date.now() - userToggleAt < USER_TOGGLE_GRACE_MS
    const onViewportClick = (e: Event): void => {
      if (!e.isTrusted) return
      const t = e.target
      if (t instanceof Element && t.closest('summary, [aria-expanded]')) {
        userToggleAt = Date.now()
      }
    }

    const recompute = (): void => {
      const vp = viewportRef.current
      if (!vp) {
        // Not overflowing (no viewport found) ⇒ nothing to scroll ⇒ at bottom.
        setAtBottom(true)
        return
      }
      setAtBottom(distanceToBottom(vp) <= TOLERANCE)
    }

    const viewport = findViewport()
    viewportRef.current = viewport
    recompute()
    if (!viewport) return

    // 自研跟随的开关：到底挂上、向上滚离底解除。初值按 mount 时的真实
    // 位置定——恢复的历史会话可能停在上方，别拽人。
    //
    // 解除必须带方向判断（scrollTop 较上次减小 = 用户向上滚），不能只看
    // 「这个事件没停在底部」：scrollTop 写入同步生效，但 scroll 事件下一
    // 帧才合并派发一次，处理器读到的是【派发时刻】的几何——钉底写入后
    // 同帧内容又长高（流式输出、Read 大内容卡渐进渲染时必现），事件读
    // 到几百 px 的距离，无方向判断就会误判「用户离开了底部」，sticky
    // 熄火跟随死亡（2026-07-13 实测：一直钉底却突然不滚，大内容卡落地
    // 触发）。assistant-ui 原版「向下滚未到底一律忽略」防的正是这个竞
    // 态。「向下滚但停在中途」（从上方往下翻没到底）两个分支都不进：
    // sticky 保持原值 false，不会误挂。
    let sticky = distanceToBottom(viewport) <= TOLERANCE
    let lastScrollTop = viewport.scrollTop

    const onScroll = (): void => {
      const vp = viewportRef.current
      if (!vp) return
      const dist = distanceToBottom(vp)
      if (dist <= TOLERANCE) {
        sticky = true
      } else if (vp.scrollTop < lastScrollTop) {
        sticky = false
      }
      lastScrollTop = vp.scrollTop
      setAtBottom(dist <= TOLERANCE)
    }

    // 几何变化（内容长高 / 视口盒子 resize）：sticky 时钉回底部。收缩
    // （工具卡折叠）无需分支——浏览器先 clamp scrollTop，distance 已是
    // 0，不进 if；prepend 补偿场景用户必在顶部，sticky 为 false 不干扰
    // （EarlierMessagesGate 自管 scrollTop）。钉底写入后同步刷新
    // lastScrollTop：这次位移是程序化的，不能算进下个 scroll 事件的
    // 方向判定（否则 clamp 类回退会被误读成用户上滚）。
    const followIfSticky = (): void => {
      const vp = viewportRef.current
      if (!vp) return
      // 跟随的唯一门槛：这次内容长高【不是用户自己点出来的】(2026-07-17)。
      //
      // 【为什么必须有人跟】turnAnchor="top" 并不像旧注释设想的那样「接管了
      // 这一轮该怎么滚」——读 0.12.24 源码，它只做三件事：把 autoScroll 的
      // 默认值翻成 false（useThreadViewportAutoScroll.js 的
      // `autoScroll = turnAnchor !== "top"`）、注册用户消息高度当 inset、给
      // 最后一条 assistant 消息挂 slack 的 min-height。一次滚动都不执行。
      // 库里唯一的滚动写入是 `div.scrollTo({ top: div.scrollHeight })`，而
      // 驱动它的 scrollingToBottomBehaviorRef 在 handleScroll 判定到底那一拍
      // 就被清成 null——「到达底部」本身就是关掉跟随的开关。于是 autoScroll
      // 为 false 时，runStart 后第一帧到底、开关即关，整轮流式无人跟随
      // （用户实测：滚动条停在原地、↓ 按钮常驻）。这里就是那个缺位的写手。
      //
      // 【怕「怼掉钉顶」是多余的】库的「钉顶」本身就是靠「滚到底」实现的：
      // slack 把最后一条 assistant 消息撑到 viewport-inset-clamp 高，滚到底
      // 时用户消息恰好被顶到视口顶部。钉底与钉顶是同一个动作，抢不起来。
      //
      // 【为什么不用 streaming 当门控】试过 `streamingRef.current &&`，实测
      // 流式收尾掉队 39.5px：streaming 翻 false 的那一刻内容还在长（ActionBar
      // 落地约 40px），门一关就没人跟了。流式与否根本不是这里要问的问题——
      // 要问的是「这次长高是谁引起的」。AI 吐字、ActionBar 落地、图片加载完
      // 都该跟；只有用户自己点开一张卡不该跟（无条件钉底会把他正在看的那张
      // 卡推出视口顶部，实测 −398px，让路后只剩 −1px）。让路期交给 Chromium
      // 的 scroll anchoring（视口 overflow-anchor: auto），它保住的正是
      // 「用户正在看的东西不动」，比我们钉底更对。
      if (
        !isUserToggling() &&
        sticky &&
        distanceToBottom(vp) > TOLERANCE
      ) {
        vp.scrollTop = vp.scrollHeight
        lastScrollTop = vp.scrollTop
      }
      recompute()
    }

    viewport.addEventListener('scroll', onScroll, { passive: true })
    viewport.addEventListener('click', onViewportClick, true)
    const ro = new ResizeObserver(followIfSticky)
    // 视口盒子：窗口/分栏 resize 改变 clientHeight。内容列：流式输出、
    // 消息展开等一切内容增长（视口自身盒子对这些纹丝不动）。
    ro.observe(viewport)
    const content = viewport.firstElementChild
    if (content instanceof HTMLElement) ro.observe(content)
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      viewport.removeEventListener('click', onViewportClick, true)
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
  // 回放会话（replay: 前缀，纯前端 id，无对应真实会话）：标题不可重命名、
  // ··· 菜单（重命名/导出为演示都要真实 sessionId 走 IPC）整个不渲染，
  // 标题旁挂「演示回放」标签——与首页 DemoShowcase 卡片标题同款视觉语言
  // （静态品牌绿点 + 文案，见该组件）。
  const isReplay = isReplaySessionId(sessionId)
  // 新会话（有 sessionId 但还没有任何消息）同样不渲染 ··· 菜单和标题的
  // 重命名入口（2026-07-16 用户实锤，两处同族）：sessionId 在首条消息
  // 之前就已分配，光判 sessionId 挡不住空会话——而重命名/导出对没内容
  // 的会话既无意义又可能因 transcript 未落盘而静默失败。
  const hasMessages = useChatStore((s) => s.messages.length > 0)
  // 标题可重命名 = 真会话 + 非回放 + 已有消息。标题按钮 disabled/title/
  // aria/铅笔与 ··· 菜单五处共用这一个判定，别再各写各的条件。
  // ⚠️ 写法必须是 `sessionId !== null &&`（不能 Boolean(sessionId)）——
  // TS 的 aliased-condition narrowing 才能在 `canRename ?` 分支里把
  // sessionId 收窄成 string（菜单内部拿它当索引/传参）。
  const canRename = sessionId !== null && !isReplay && hasMessages
  // 消息内嵌协议标记（[[sheet-selection]]/[[image-edit]]）剥离在 slash
  // 命令拆分之前——否则表格「框选问 AI」这类消息的 firstPrompt（marker
  // JSON + 提示语 + TSV）会原样顶栏展示，撑成一整行（2026-07-13 事故，
  // 详见 RailSessionList.displayTitle 同款修复的注释）。
  const strippedTitle = title ? stripMessageMarker(title) : title
  // 标题里的 `@"path"` mention 压成 basename——首条消息带内联文件时，
  // 原始标题是一整条绝对路径（「帮我修改@/Users/…/deck.pptx：…」），
  // 头部一行放不下也没人想读；与气泡 chip 同一份识别规则（mentionDisplay）。
  const condensedTitle = strippedTitle ? condenseFileMentions(strippedTitle) : strippedTitle
  const display =
    condensedTitle && condensedTitle.trim()
      ? condensedTitle
      : t('chatHeaderUntitled')

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
  // 已知技能命令（ppt-master/spreadsheets/…）→ 复用消息气泡同一份注册表，
  // 拿彩色图标 + 友好文案（「处理表格」），换掉裸 mono chip 的字面命令名。
  // 命名空间/裸名两种形态都试一遍（注册表本身双注册，见 skillChipRegistry）。
  // 未登记的命令仍走原样 mono chip 兜底，不是每个 / 开头都配得上产品化展示。
  const skillSpec = cmdFull
    ? (findSkillChipSpec(cmdFull) ?? findSkillChipSpec(cmdShort ?? ''))
    : null

  // ── Rename dialog ──
  // 与 rail 会话行同一套交互（2026-07-13 统一：此前是标题原地切换成
  // input 的行内编辑，用户要求改成跟左侧 RailSessionList 一致的弹窗）。
  // 复用同一份 shadcn Dialog 精修档（见 RailSessionList.tsx 的
  // renameTarget 弹窗注释：Notion 风格、440px 卡、48px 输入框、品牌绿
  // 渐变提交按钮）——两处保持像素级同款，改一处记得同步另一处。
  const [renameOpen, setRenameOpen] = useState(false)
  const [draft, setDraft] = useState('')
  // 打开弹窗那一刻的预填值，作为「用户到底改没改」的比较基准。不能拿 store
  // 里的原始 title 当基准——预填的是顶栏显示文字（已剥标记/压路径/拆命令
  // 前缀），跟原始 title 天然不相等，用原始 title 比会把「打开就点保存」
  // 判成真改名，静默把命令前缀和完整路径写没。
  const initialDraftRef = useRef('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  // ··· 菜单选「重命名」时置 true：菜单关闭的 auto-focus 默认把焦点还给
  // trigger 按钮，会跟弹窗聚焦 input 打架（radix 的 restore 也是异步的，
  // 晚一拍就把焦点抢走）。选中重命名的那次关闭用它拦掉 auto-focus。
  const pendingEditRef = useRef(false)

  // 预填 = 顶栏此刻显示的那行文字（restTitle），不是 store 里的原始 title
  // （2026-07-17 用户要求「跟顶部文字保持一致」）。原始 title 是首条消息
  // 原文——带 `/claude-desktop:ppt-master` 命令前缀、整条绝对路径、可能还有
  // [[image-edit]] 协议标记；顶栏早把它剥/压/拆成人话了，弹窗却把没处理的
  // 原文摊开，用户看到的和要编辑的不是同一个东西。
  // 空标题（display 落到「未命名」兜底）预填空串让 placeholder 出场，而不是
  // 让用户对着「未命名」三个字改。
  const startEdit = useCallback((): void => {
    if (!sessionId) return
    const prefill = condensedTitle && condensedTitle.trim() ? restTitle : ''
    setDraft(prefill)
    initialDraftRef.current = prefill
    setRenameOpen(true)
  }, [sessionId, condensedTitle, restTitle])

  // 弹窗开后聚焦全选输入框（等 radix 菜单关闭抢完焦点，与内容挂载对齐；
  // 同 RailSessionList 的 renameTarget 弹窗）。
  useEffect(() => {
    if (!renameOpen) return undefined
    const timer = window.setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [renameOpen])

  // A session switch mid-edit discards the editor — the draft belonged to
  // the PREVIOUS session's title; committing it against the new sessionId
  // would rename the wrong chat.
  useEffect(() => {
    setRenameOpen(false)
  }, [sessionId])

  // ── 拖拽策略：本顶栏只挖 no-drag 洞、不自带 drag——窗口拖拽由根
  //    .window-drag-strip 统一负责（2026-07-14 四改定稿，真因终于见底）─────
  // 「切到工作画布能拖、切回智能助手拖不动」查了四层，前三层全是误诊：
  //  ① 会话切换 region-refresh 脉冲 effect（deps [sessionId,isReplay]）——以为
  //     是「切会话改 no-drag 洞集合没逼重采集」，补脉冲，是竞态源，实测仍复发。删。
  //  ② 本顶栏外层 div 自带 [-webkit-app-region:drag]——以为「纯寄生 strip 缓存」
  //     脆，想像 canvas EntryShell 一样自带 drag。删。
  //  ③ drag 源挪到 SurfaceHost 浅层探条——以为是「ChatHeader 埋 .chat-app 深树、
  //     切回 chat 时 content-visibility 恢复 ~570ms 盒子晚落定、被切面脉冲赛跑
  //     抢先采不到」。删。
  //  ④（真因，现行——2026-07-14 第六版实测见底）以上全错。真因是**隐藏 canvas
  //     面整棵注册了全屏 no-drag、盖穿 strip 的 drag**：SurfaceHost 两个面 DOM 序
  //     chat→canvas，隐藏面标 .surface-inactive，其后代（含铺满 inset-0 的容器、
  //     46px nav）有实布局盒子、computed app-region 继承为 no-drag、DOM 序在 body
  //     首子 .window-drag-strip 之后 → **最后注册、盖过 strip 在内容区那段 drag**
  //     （后注册覆盖先注册）→ 内容区顶部拖不动（rail 区 x<245 没被盖仍能拖）。
  //     曾以为「把 .surface-inactive 中和成 app-region:none」就根治——但 app-region
  //     合法值只有 drag/no-drag，**`none` 非法、被静默忽略、computed 保留 no-drag，
  //     那条规则从未生效过**（这是前五版都栽的错误前提）。真正的修法：中和值用
  //     `initial`（回初始态、才真不注册矩形、computed 才是透明），globals.css 的
  //     `.surface-inactive,.surface-inactive *{app-region:initial !important}`。strip
  //     恒生效，本顶栏回归**纯挖 no-drag 洞**（标题按钮 :1351 / ⋯菜单 :1400 / 输出
  //     按钮），①②③加的东西已全撤。

  const commitEdit = useCallback(async (): Promise<void> => {
    setRenameOpen(false)
    const trimmed = draft.trim()
    // 与「打开时的预填」比而不是与原始 title 比——理由见 initialDraftRef。
    // 没动过内容就当取消：原始 title（连同命令前缀与完整路径）原样留着，
    // 顶栏渲染出来的文字一模一样，用户看不出差别，也没白丢信息。
    if (!sessionId || !trimmed || trimmed === initialDraftRef.current) return
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
    // 本 header **不声明 drag**，只给顶部 46px 内的交互控件挖 no-drag 洞。
    // 窗口拖拽由根 layout 的 .window-drag-strip（body 首子、fixed 全宽 46px 常驻
    // drag）负责——这条一直是对的，「切回智能助手拖不动」的真因不在本顶栏，而在
    // 隐藏 canvas 面容器的全屏 no-drag 盖住了 strip（见上方「拖拽策略」注释④ 与
    // globals.css 的 .surface-inactive 2026-07-14 修正）。那条修好后 strip 恒
    // 生效，本顶栏无需自带任何 drag。
    //
    // 洞在 strip 的 drag 上有效：strip 是 body 首子、DOM 序最靠前 → drag 先注册；
    // 本顶栏的 no-drag 洞（标题按钮 :1351 / ··· 菜单 :1400 / 输出按钮）DOM 序更晚
    // → 后注册的 no-drag 在先注册的 drag 上挖洞，洞生效、三个按钮点得动。点它们
    // 是改名/开菜单/看产出，不是拖窗。`select-none` keeps a press-drag on the
    // chrome from starting a text selection.
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
    // 排右移则同增）。canvas 面 tab 栏的同款净空在 base.css（收起态
    // --app-chrome-traffic-space: 190px，同一 208 基线）——改这里必同步那边，
    // 否则两面顶栏起点分家（2026-07-13 canvas 面漏配被红绿灯压住的教训）。
    <div className="flex h-[46px] shrink-0 select-none items-center border-b border-border/55 [body[data-rail-collapsed]_&]:pl-[208px]">
      {/* 内层容器：标题左贴边（2026-07-08 用户定稿，参考 Claude.ai 顶栏
          「图标 + 标题 + ···」左对齐形态）。此前是 mx-auto max-w-4xl 与
          消息列同参居中——宽窗口时标题漂在中间偏左、与左缘脱节，用户
          否掉。px-4 与 rail 列表的左内边距呼应；「AI 生成」徽标仍 ml-auto
          钉右端。（旧结构在外层+内层各标一份 drag——现在拖拽由根
          .window-drag-strip 负责，声明已摘除。） */}
      <div className="flex h-full w-full min-w-0 items-center gap-2 px-4">
        {/* 会话图标（参考形态的左端锚点）：已知技能命令换成该技能的彩色
            图标（同消息气泡 / composer 「处理表格」按钮那份 skillChipRegistry），
            让标题栏一眼认出「这是张表格会话」而不是读 mono 命令名；未识别
            命令或纯聊天标题回退成纯装饰的 muted 线性图标。编辑态也保留，
            rename 输入框展开时行首不跳。 */}
        {skillSpec ? (
          <SkillChipIcon src={skillSpec.image} size={16} className="size-4" />
        ) : (
          <MessageSquareText
            aria-hidden
            strokeWidth={1.75}
            className="size-4 shrink-0 text-muted-foreground/80"
          />
        )}
        {skillSpec ? (
          <span
            title={cmdFull ?? undefined}
            className="shrink-0 rounded-full border border-border/70 bg-card/70 px-2 py-0.5 text-[11px] font-medium leading-none text-muted-foreground"
          >
            {skillSpec.label}
          </span>
        ) : cmdShort ? (
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
        <h1 className="flex min-w-0 items-center gap-1.5 text-[14px] font-medium leading-tight text-foreground">
          <button
            type="button"
            onClick={startEdit}
            disabled={!canRename}
            title={canRename ? t('renameChat') : undefined}
            aria-label={
              canRename ? `${t('renameChat')}: ${display}` : undefined
            }
            // group/title scopes the pencil reveal to hovering the title
            // itself, not the whole header band.
            className="group/title flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 text-left transition-colors [-webkit-app-region:no-drag] enabled:cursor-pointer enabled:hover:bg-foreground/[0.05] disabled:cursor-default"
          >
            {/* max-w：truncate 本身只在「空间不够」时才省略——宽窗口下这个
                flex 行里没别的东西跟标题抢空间，min-w-0+truncate 从不触发，
                长标题就整条铺满顶栏（用户截图实锤）。加个硬上限，多长的
                标题都不会比这更宽，超出走省略号，参考截图的紧凑宽度对齐。 */}
            <span className="min-w-0 max-w-[320px] truncate" title={display}>
              {restTitle}
            </span>
            {canRename ? (
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
          {/* 演示回放标签——与首页 DemoShowcase 卡片标题旁的同款标签像素级
              一致（bg-brand/[0.09] + text-brand 静态品牌绿，不跟用户主题走，
              见该组件注释）。h1 加 gap-1.5 让它跟标题按钮保持同样间距。 */}
          {isReplay ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand/[0.09] px-2 py-0.5 text-[10.5px] font-medium text-brand">
              <span className="size-[5px] rounded-full bg-current" />
              {t('demoShowcaseTag')}
            </span>
          ) : null}
        </h1>
        {/* ··· 会话操作菜单（2026-07-08 用户要求，Notion 顶栏样式）：
           紧跟截断标题右侧，超长标题省略后菜单钮仍然贴着可见文本。
           目前只有「重命名」（与点击标题打开同一个弹窗）；后续
           会话级操作（删除/移动工作区…）往这里加。无会话时不渲染
           ——菜单里全是会话操作，空态挂个禁用按钮只是噪音。回放会话
           同样不渲染：菜单项（重命名/导出为演示）全部要真实 sessionId
           走 IPC，对 replay: 前缀的假 id 调用只会静默失败或报错。
           新会话（有 id 没消息）也不渲染——见 hasMessages 注释。
           Content portal 到 body、脱离 .chat-app 豁免，但 shadcn 原语
           自带 data-slot，天然逃逸 canvas 裸元素 reset（CLAUDE.md）。 */}
        {canRename ? (
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
              <DropdownMenuItem
                onSelect={() => {
                  // 成功反馈 = Finder 定位导出文件；取消静默、失败记日志
                  // （与 rail 行菜单的同名动作一致，见 RailSessionList）。
                  // slides 会话带 mode 标记——回放端据此撑开双分栏。
                  const mode = useComposerModeStore.getState().slidesSessions[
                    sessionId
                  ]
                    ? ('slides' as const)
                    : undefined
                  void window.chatApi
                    .exportReplay({
                      sessionId,
                      title: display,
                      ...(mode ? { mode } : {})
                    })
                    .then((r) => {
                      if (r.ok && r.path) {
                        void window.chatApi.revealPath({ absPath: r.path })
                      } else if (!r.ok) {
                        console.warn('[chat-header] exportReplay failed:', r.error)
                      }
                    })
                    .catch((err: unknown) =>
                      console.warn('[chat-header] exportReplay error:', err)
                    )
                }}
              >
                <Clapperboard strokeWidth={1.75} /> {t('replayExportMenu')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  // main 弹文件选择框 → 解包 + 路径重写 → controller 接管播放。
                  // 取消静默；失败记日志（选择框已给过交互反馈）。
                  void window.chatApi
                    .openReplay({})
                    .then((r) => {
                      if (r.ok) {
                        ReplayController.start(r.meta, r.timeline)
                      } else if (!r.cancelled) {
                        console.warn('[chat-header] openReplay failed:', r.error)
                      }
                    })
                    .catch((err: unknown) =>
                      console.warn('[chat-header] openReplay error:', err)
                    )
                }}
              >
                <Play strokeWidth={1.75} /> {t('replayOpenFile')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {/* 「输出」按钮：本会话所有产出物（幻灯片/文档/表格/生成图片…）的
            聚合入口，见 OutputsPanel.tsx。无会话时数据源为空数组，按钮仍
            渲染（空态弹层）。原「AI 生成」hairline 徽标（chatHeaderAiBadge）
            已按用户要求移除（2026-07-10），i18n key 留存未删——若后续要恢复
            合规声明，直接在这里加回 <span> 即可，不必重新翻译。 */}
        <div className="ml-auto shrink-0">
          <OutputsButton />
        </div>
      </div>

      {/* 重命名弹窗——与 RailSessionList.tsx 的会话行重命名同一套 shadcn
          Dialog 精修档（Notion 风格：440px 圆角卡、19px 大标题、48px 高
          输入框、品牌绿渐变提交按钮）。2026-07-13 从原地 input 行内编辑
          改成弹窗，统一两处的重命名交互。2026-07-19 毛玻璃化（仅这两处重命名
          弹窗，className 局部覆盖，不动共享 DialogContent 基件——避免波及
          删除确认/设置等全 app 其它弹窗）：半透明 bg-background/70 +
          backdrop-blur 让壁纸换肤背景透出来，border-border/50 弱化描边配合
          透明底，inset 顶部高光是玻璃质感的装饰阴影非语义色，两档主题都够看。 */}
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (!open) setRenameOpen(false)
        }}
      >
        <DialogContent className="rounded-2xl border-border/50 bg-background/70 shadow-[0_24px_70px_-18px_rgba(0,0,0,0.35),0_8px_24px_-12px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl backdrop-saturate-150 sm:max-w-[440px]">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void commitEdit()
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-[19px]">
                {t('renameChat')}
              </DialogTitle>
              <DialogDescription className="text-[13px]">
                保持简短且易于识别
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-4">
              <Label htmlFor="chat-header-rename-input" className="sr-only">
                对话名称
              </Label>
              <Input
                id="chat-header-rename-input"
                ref={renameInputRef}
                value={draft}
                maxLength={200}
                name="rename-session-title"
                autoComplete="off"
                placeholder="输入新名称"
                className="h-12 rounded-xl px-4 text-[15px] md:text-[15px]"
                onChange={(e) => setDraft(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameOpen(false)}
              >
                取消
              </Button>
              {/* transition-[opacity,box-shadow] 覆盖基件的 transition-all：
                * disabled↔enabled 的底色是「渐变图像 ↔ 灰底」——background-image
                * 不可过渡会瞬跳，color 却吃 transition-all 慢慢变，中间帧=绿底
                * 半灰字（同 RailSessionList 的重命名按钮注释）。 */}
              <Button
                type="submit"
                className="bg-[linear-gradient(135deg,hsl(var(--brand)),color-mix(in_srgb,hsl(var(--brand))_85%,#000))] text-white shadow-[0_1px_2px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.18)] transition-[opacity,box-shadow] hover:opacity-95 disabled:bg-none disabled:bg-muted disabled:text-muted-foreground/70 disabled:opacity-100 disabled:shadow-none"
                // 只挡空标题，不再挡「没改过」（2026-07-17 用户要求一直可点）：
                // 一个默认就灰、要先改字才亮的主按钮，读起来像功能坏了。没改
                // 内容就点＝commitEdit 里短路成取消，行为上安全。
                disabled={!draft.trim()}
              >
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
 * Empty thread state（2026-07-16 重排，原型 docs/empty-state-composer-
 * prototype.html，参考 WorkBuddy 空态）: a vertically-centered block of
 * hero title (two big lines) → slogan → Composer variant='hero'（自带
 * ScenarioRail 分类 tab + 技能/推荐 prompt chips + 灰壳托盘，见 Composer
 * 的注释）→ demo showcase → promo banner. The composer is rendered HERE
 * (not in the bottom dock) so it sits in the centered group; the bottom
 * dock is hidden while empty (ThreadPrimitive.If empty={false} in the
 * main render) so there's only ever one Composer instance. Once the
 * thread has messages, the dock takes over and the composer pins to the
 * bottom as usual.
 */
function EmptyState(): React.JSX.Element {
  const t = useT()
  // Hero 标题在全角逗号处断成两行大字（「不止聊天，」/「搞定一切」）。英文
  // 标题没有全角逗号 → parts 只有一个元素，单行渲染，无多余 <br>。
  const titleParts = t('emptyStateTitle').split('，')
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
      <h1 className="text-[clamp(36px,4.5vw,52px)] font-bold leading-[1.18] tracking-tight text-foreground">
        {titleParts.map((part, i) => (
          <span key={i} className="block">
            {i < titleParts.length - 1 ? `${part}，` : part}
          </span>
        ))}
      </h1>
      <p className="mb-8 mt-4 text-[14px] text-muted-foreground/80">
        {t('emptyStateScenarioHint')}
      </p>

      {/* Composer sits inside the centered block (not the bottom dock).
          hero 形态：分类 tab + 技能 chips 的 ScenarioRail 由它自己渲染在
          卡片上方，工作目录/权限行收进灰壳托盘的延伸条。 */}
      <Composer variant="hero" />

      {/* 「看看它能做什么」演示区：内置演示录像的卡片入口（点卡片就地
          回放）。没有内置录像时自渲染 null，页面与旧版完全一致。 */}
      <DemoShowcase />

      {/* Promo banner (figure 26) — VISUAL-ONLY placeholder; the desktop app
          has no credits/PRO system behind it.
          暂时下线（2026-07-16 用户要求）：积分/PRO 体系尚未接入，占位横幅
          先注释掉；等真实系统落地后恢复下面这段并接上真实数据与链接。
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
      */}
    </motion.div>
  )
}
