import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useDrag } from '@use-gesture/react'
import { useComposerRuntime } from '@assistant-ui/react'
import { create } from 'zustand'
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch'

import { Button } from '@/src/components/ui/button'
import { Textarea } from '@/src/components/ui/textarea'
import { cn } from '@/src/lib/utils'
import { useChatStore } from '../../stores/chat'
import { useMessageQueueStore, useSessionQueue } from '../../stores/messageQueue'

/**
 * The instruction we send when the user clicks 应用标注到我的 PPT. Kept as a
 * single constant because it's used in TWO places that must never drift: the
 * composer text we send, and the queue-dedup comparison (matching a queued
 * turn's `text` so we don't stack the same instruction N times).
 */
const APPLY_ANNOTATION_TEXT = '应用我的标注'

/**
 * 就绪进度（N/M 张已就绪）的跨组件出口：2026-07-07 工作区重设计
 * （docs/ui-prototype-ppt-workspace.html）删掉了 56px 的「幻灯片预览」
 * 标题头——它唯一的有效信息是这个进度，上移到 SlidesWorkspace tab 栏
 * 右端的胶囊里。editor 挂载期间持续写入、卸载清空，所以胶囊只在
 * 「预览幻灯片」tab 活跃（= 本组件挂着）时出现，切走即消失。
 */
export const usePreviewReadinessStore = create<{
  readiness: { ready: number; total: number } | null
  setReadiness: (v: { ready: number; total: number } | null) => void
}>((set) => ({
  readiness: null,
  setReadiness: (v) => set({ readiness: v })
}))

/**
 * apply turn 生命周期，keyed by 发起会话 id。为什么是 module store 而不是组
 * 件 state：切换聊天会话时 SlidesWorkspace 可能卸载本组件（新会话没有
 * preview server）或原地换绑 sessionId（无 key 复用实例），组件 state 要么
 * 归零（切回来按钮忘了 AI 还在修改）、要么带着旧会话的 phase 去对新会话的
 * streaming/队列信号（空闲双灭 → 1.5s 后误报「已完成」解锁）。store 里
 * phase 按 sid 存，组件只读写「当前显示会话」那一格——phase 与它的判定信
 * 号永远同源同 sid；组件卸载期间 phase 不被推进也没关系，按钮不在屏上，重
 * 挂后状态机 effect 幂等接手。会话删除后残留的空格子无人再读，量级可忽略。
 */
const useApplyPhaseStore = create<{
  bySid: Record<string, 'sent' | 'active'>
  set: (sid: string, phase: 'sent' | 'active') => void
  clear: (sid: string) => void
}>((set) => ({
  bySid: {},
  set: (sid, phase) => set((s) => ({ bySid: { ...s.bySid, [sid]: phase } })),
  clear: (sid) =>
    set((s) => {
      if (!(sid in s.bySid)) return s
      const { [sid]: _dropped, ...rest } = s.bySid
      return { bySid: rest }
    })
}))

/* SVG 标签 → 大白话名。已选芯片/标注 tooltip 用它替代裸 _edit_15
 * （普通用户产品原始 ID 一律收进 title，文案直白原则）。 */
const TAG_LABEL: Record<string, string> = {
  text: '文本',
  tspan: '文本',
  image: '图片',
  g: '组',
  rect: '形状',
  circle: '形状',
  ellipse: '形状',
  polygon: '形状',
  path: '形状',
  line: '线条',
  polyline: '线条'
}

/**
 * LivePreviewEditor
 * -----------------
 * Native React replication of the ppt-master svg_editor live-preview editor
 * (skills/ppt-master/scripts/svg_editor/static/app.js), rendered inside the
 * 「幻灯片」canvas tab instead of iframing localhost:5050. It fetches the same
 * Flask server's `/api/slides` + `/api/slide/<name>`, lets the user select SVG
 * elements and attach edit instructions (annotations), and POSTs the SAME
 * contract back — the server is unchanged.
 *
 * Architecture (per the reference's design): the editor does NOT use a virtual
 * DOM for the slide. The server returns an SVG string with a stable `id` on
 * every element (backend assign_temp_ids); we inject it via innerHTML into a
 * ref'd container and operate the REAL SVG DOM imperatively — selection,
 * highlight classes, geometry — because geometry depends on the browser's live
 * layout (getBBox/getCTM/DOMMatrix). React state holds only METADATA: which ids
 * are selected, the annotation map, the slide list, the current page. We never
 * let React re-render the SVG internals (that would fight the imperative ops).
 *
 * MODULE 1 (this file, current scope): slide list + nav, element pick (click +
 * Ctrl/Cmd multi-select) with highlight, a bottom dock (选中 chip 列表 + 本页标注
 * 记录) that replaced the old right-hand panel, on-canvas FloatingInstruction for
 * editing an element's note, annotation list + delete, and 应用标注到我的 PPT
 * (save-all — the sole dock action; 撤销/退出预览 were removed). These cover the
 * flow the ppt-master pipeline actually uses (annotations are read by the AI to
 * redo a page).
 *
 * LATER MODULES (not here yet — marked `MODULE N:`): direct attribute editing
 * (X/Y/FILL/STROKE → /edit with the CTM/matrix geometry engine), marquee
 * rubber-band selection, drag/resize on canvas, tspan promotion.
 *
 * All fetches are absolute against `baseUrl` (the server's real origin from
 * usePreviewServer's stdout parse); CSP connect-src + the server's CORS hook
 * already permit the cross-origin calls.
 */

export interface LiveSlide {
  name: string
  annotated?: boolean
  annotation_count?: number
  ok?: boolean
  error?: string | null
  mtime?: number
}

interface SlideAnnotation {
  element_id: string
  tag?: string
  annotation: string
}

/** Rewrite a fetched slide's relative image refs to absolute server URLs so
 *  they load cross-origin. Mirror of the old SlidesLivePreview helper. */
function absolutizeSlideImages(svg: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return svg
    .replace(/(["'(])\.\.\/images\//g, `$1${base}/images/`)
    .replace(/(["'(])\.\.\/assets\//g, `$1${base}/assets/`)
    .replace(/(xlink:href|href)=("|')(?!https?:|data:|#|\/)([^"')]+\.(?:png|jpe?g|gif|webp|svg|bmp))\2/gi,
      (_m, attr, q, file) => `${attr}=${q}${base}/${file}${q}`)
}

/**
 * Warm the browser cache for every image an (absolutized) slide references,
 * BEFORE its innerHTML is swapped in. The swap rebuilds the whole SVG DOM,
 * so every `<image>` re-fetches from scratch — without warming, each swap
 * blanks all the photos for a network round-trip and the deck visibly
 * flashes on every regeneration (worst while the assistant is editing pages
 * in a loop). Warm cache = the rebuilt tree paints images synchronously.
 *
 * Missing images (still generating in the background → 404) settle fast and
 * resolve like everything else — the swap then shows the same blank spot it
 * showed before, i.e. no NEW flash. A slow straggler is capped by
 * `timeoutMs`: better to swap with one image late than hold the page on a
 * stale slide.
 */
function preloadSlideImages(svg: string, timeoutMs: number): Promise<void> {
  const urls = new Set<string>()
  const attrRe =
    /(?:xlink:href|href)=["'](https?:\/\/[^"']+\.(?:png|jpe?g|gif|webp|svg|bmp))["']/gi
  const cssRe =
    /url\((['"]?)(https?:\/\/[^)'"]+\.(?:png|jpe?g|gif|webp|svg|bmp))\1\)/gi
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(svg))) urls.add(m[1])
  while ((m = cssRe.exec(svg))) urls.add(m[2])
  if (urls.size === 0) return Promise.resolve()
  const loads = [...urls].map(
    (u) =>
      new Promise<void>((resolve) => {
        const img = new Image()
        img.onload = () => resolve()
        img.onerror = () => resolve()
        img.src = u
      })
  )
  return Promise.race([
    Promise.all(loads).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs))
  ])
}

/** Strip the retry cache-buster off a probed image URL so failure bookkeeping
 *  always keys on the canonical URL. */
function canonicalImageUrl(url: string): string {
  return url.replace(/[?&]v=\d+$/, '')
}

const SKIP_TAGS = ['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'mask', 'symbol']

/** A highlight box in stage-relative CSS px, plus the element id it tracks.
 *  `badge` is the 1-based annotation number shown as a corner chip (①②③…)
 *  when this element already carries an annotation; undefined = no chip. */
interface OverlayRect {
  id: string
  x: number
  y: number
  w: number
  h: number
  badge?: number
}

/**
 * Resolve which element id a pointer landed on, mirroring the reference
 * editor's rules: alt → nearest ancestor group; otherwise the nearest
 * data-icon group (preview expands <use> into inner nodes) or nearest [id].
 * Returns null for the svg root / non-selectable defs. Pure so both the
 * click-tap path and marquee hit-test can share it.
 */
function resolvePickedId(
  target: Element,
  svg: SVGSVGElement,
  opts: { alt: boolean }
): string | null {
  if (target === svg) return null
  if (target.closest && target.closest('defs, style, title, desc')) return null
  let picked: Element | null = opts.alt && target.closest ? target.closest('g[id]') : null
  picked = picked || (target.closest && target.closest('[data-icon][id]')) || target.closest('[id]')
  if (!picked || picked === svg) return null
  return picked.id || null
}

export function LivePreviewEditor({
  baseUrl,
  onServerDownChange
}: {
  baseUrl: string
  // Reported up whenever reachability flips. The parent (SlidesWorkspace) uses
  // it to hide the 幻灯片 tab once the server is gone, so a stale launch URL in
  // the transcript no longer leaves a dead tab behind. The component keeps
  // polling while mounted, so it also reports recovery (false) if the URL comes
  // back to life before the parent unmounts it.
  onServerDownChange?: (down: boolean) => void
}): React.JSX.Element {
  const api = useCallback((p: string) => baseUrl.replace(/\/$/, '') + p, [baseUrl])
  // The chat composer, so 应用修改 can prefill an instruction for the user to
  // send (LivePreviewEditor renders inside ThreadView's provider, so this is in
  // scope — same runtime the ProseMirror input drives via setText).
  const composerRuntime = useComposerRuntime()

  // Dedup guard for the apply button. save-all writes ALL annotations into
  // svg_output, so a single 应用我的标注 turn already tells the AI to redo the
  // whole page — a second identical turn just makes it do the same work twice.
  // We subscribe to this session's queue and, when an 应用我的标注 turn is
  // already waiting, disable the button (and short-circuit applyChanges below).
  // Keyed by the exact text we send, so the two never drift.
  const chatSessionId = useChatStore((s) => s.sessionId)
  const applyQueued = useSessionQueue(chatSessionId).some(
    (q) => q.text === APPLY_ANNOTATION_TEXT
  )
  /**
   * 本次 apply turn 的生命周期（存在 useApplyPhaseStore，按 sid 取当前会话
   * 那格——为什么不是组件 state 见 store 声明处注释）。ppt-master 侧的
   * 「修改完成」定义是 AI 重写页面时清掉 data-edit-* 标记
   * （check_annotations.py 扫不到即完成），但 /api/slides 的
   * annotation_count 把磁盘标记和内存里未保存的新标注混在一个数里——AI 修
   * 改期间用户新加一条标注它就不归零，绑它判完成会死锁。所以完成判定挂聊天
   * 侧：send 之后跟踪发起会话的 streaming/队列，apply turn 真正结束（两个信
   * 号都灭）才解锁按钮。
   *   'sent'   = send() 已发出，但 onNew 还没把 streaming 翻 true / 还没入队
   *              （async 空窗，此窗口内两个信号都是 false）；
   *   'active' = AI 正在修改，或 apply turn 还在队列里等前一个 turn 收尾。
   * streaming 订阅 per-session 槽而不是顶层 mirror——与 phase/队列检查严格
   * 同源于 chatSessionId（ProposalDocPanel 同款读法）。
   */
  const applyPhase: 'idle' | 'sent' | 'active' = useApplyPhaseStore((s) =>
    chatSessionId ? (s.bySid[chatSessionId] ?? 'idle') : 'idle'
  )
  const chatStreaming = useChatStore((s) =>
    chatSessionId ? (s.perSession[chatSessionId]?.streaming ?? false) : false
  )

  const [slides, setSlides] = useState<LiveSlide[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-slide SVG thumbnails for the rail. Keyed by slide name; each holds the
  // (image-absolutized) SVG string + the mtime it was fetched at, so we only
  // re-fetch a page when its mtime advances. SVG scales to the tiny thumb frame
  // by its own viewBox (vector, lossless), so this is a cheap real preview.
  const [thumbs, setThumbs] = useState<Record<string, { svg: string; mtime: number }>>({})

  // 已选芯片条的溢出量（被定高单行裁掉的芯片数）。2026-07-07 定稿：芯片
  // 条固定 26px 单行——多选折行会让 dock 纵向无上限、把舞台挤没（窄屏
  // 实锤），溢出改为右端 +N 角标 + hover 上浮面板显示全量。由 effect 量
  // 测（scrollWidth vs clientWidth + 逐芯片 offset），ResizeObserver 跟
  // 面板宽度联动。
  const chipsStripRef = useRef<HTMLDivElement | null>(null)
  const [chipsHidden, setChipsHidden] = useState(0)
  // 标注序号钮的 hover 提示（标注内容预览，2026-07-07 用户要求——原生
  // title 延迟 1s 且不可控）。序号钮住在 overflow-x-auto 横滚带里，绝对
  // 定位的提示卡放带内会被滚动容器裁掉，所以卡渲染在簇（section）层级，
  // 锚点 x 在 mouseenter 时换算到簇坐标系并钳制，横滚时直接清掉。
  const annSectionRef = useRef<HTMLElement | null>(null)
  const [annTip, setAnnTip] = useState<{ eid: string; left: number } | null>(null)
  // 提示卡带删除入口（2026-07-07 用户要求）→ 卡必须可进入：钮和卡之间
  // 有 8px 空隙，mouseleave 立即关卡鼠标永远走不进去。离开钮/卡都只
  // 「预约」160ms 后关，进入另一方即取消预约——标准 hover-card 宽限期。
  const annTipCloseTimer = useRef<number | null>(null)
  const cancelAnnTipClose = useCallback(() => {
    if (annTipCloseTimer.current !== null) {
      window.clearTimeout(annTipCloseTimer.current)
      annTipCloseTimer.current = null
    }
  }, [])
  const closeAnnTipSoon = useCallback(() => {
    cancelAnnTipClose()
    annTipCloseTimer.current = window.setTimeout(() => setAnnTip(null), 160)
  }, [cancelAnnTipClose])
  useEffect(() => () => cancelAnnTipClose(), [cancelAnnTipClose])

  // Selection + annotations are METADATA (React state). The SVG DOM itself is
  // the source of truth for geometry; we only track ids here.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [annotations, setAnnotations] = useState<Record<string, string>>({})
  const [annotationText, setAnnotationText] = useState('')
  const [undoDepth, setUndoDepth] = useState(0)
  // ── interaction layer (hover / marquee) ──────────────────────────────────
  // The element under the cursor (drives the faint hover highlight box).
  const [hoverId, setHoverId] = useState<string | null>(null)
  // The rubber-band selection rectangle while dragging on the stage, in
  // stage-relative CSS px. Null when not marquee-dragging.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // Bumped to force the highlight overlay to re-measure element boxes: on page
  // change, container resize, image load, and scroll. Selection/hover changes
  // recompute on their own (they're effect deps), this is for geometry shifts
  // that don't change React state.
  const [geomVersion, setGeomVersion] = useState(0)
  const bumpGeom = useCallback(() => setGeomVersion((v) => v + 1), [])
  const reduceMotion = useReducedMotion()
  // Current TransformWrapper scale, kept in a ref (written from onTransform)
  // so measureRects can un-scale getBoundingClientRect() deltas back to the
  // LOCAL coordinate space that HighlightOverlay's CSS left/top/w/h live in.
  // HighlightOverlay is a sibling of svgHost INSIDE the same transformed
  // subtree — its own box gets scaled by the wrapper too, so feeding it
  // already-scaled screen-space px would double-apply the zoom (a selection
  // box would drift further from its element the more you zoom). marquee's
  // hit-test stays screen-space-vs-screen-space (both sides read live rects)
  // so it's unaffected; only these CSS-positioned overlay boxes need the
  // divide-by-scale correction.
  const scaleRef = useRef(1)
  // The scrollable stage that hosts the SVG + overlay. Overlay boxes and
  // marquee coords are all measured relative to THIS element's rect — that
  // stays true even inside the zoom/pan wrapper because it only applies a
  // CSS transform: every getBoundingClientRect()/elementFromPoint() call in
  // this file already reads screen space, so the transformed (zoomed/panned)
  // position falls out for free with zero coordinate-math changes. The ONE
  // exception is HighlightOverlay/FloatingInstruction, which are positioned
  // via CSS inside the same transformed subtree — see scaleRef above.
  const stageRef = useRef<HTMLDivElement | null>(null)
  // The outer overflow-hidden box that actually clips what's visible (the
  // TransformWrapper viewport — see its JSX ~line 1402). Distinct from
  // stageRef: stageRef is INSIDE the zoomed/panned subtree and grows/shrinks
  // with the slide's content, while this one is the fixed on-screen window
  // the user looks through. FloatingInstruction needs both rects to figure
  // out which part of local (pre-zoom) coordinate space is currently
  // visible, so it can keep itself from sliding off-screen when the
  // selected element sits near the edge of a zoomed/panned slide.
  const viewportRef = useRef<HTMLDivElement | null>(null)
  // Space-bar held = pan mode (Figma/PS convention). While held, marquee
  // selection (useDrag below) is disabled so the same left-click-drag
  // gesture unambiguously means "pan the canvas" instead of racing with
  // rubber-band select for the same pointer events.
  const [spacePanning, setSpacePanning] = useState(false)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Ignore repeats + typing contexts (the floating annotation textarea
      // uses space as a normal character).
      if (e.code !== 'Space' || e.repeat) return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      setSpacePanning(true)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpacePanning(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])
  // The floating instruction box's textarea, so a fresh selection can focus it
  // immediately (the user selects → types, no extra click to reach the input).
  const floatingInputRef = useRef<HTMLTextAreaElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  // True once the slide-list poll can't even reach the server (a network-level
  // "Failed to fetch", not an HTTP error). usePreviewServer resolves the URL
  // from the launch command in the transcript, which can outlive the server
  // (idle-timeout / manual stop) — so a dead URL would otherwise leave this tab
  // spinning on "等待幻灯片生成…(Failed to fetch)" forever. Detecting the
  // unreachable server lets us say so plainly instead. Recovers automatically
  // when the server comes back (a later poll succeeds).
  const [serverDown, setServerDown] = useState(false)

  // Refs so the poll closure / delegated handler always see latest values
  // without re-arming. activeRef gates late slide responses.
  const svgHostRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<string | null>(null)
  const mtimesRef = useRef<Record<string, number>>({})
  const followLatestRef = useRef(true)
  const selectedIdsRef = useRef<string[]>([])
  // Latest annotations, so the drag-bound pickAt closure can prefill an already-
  // annotated element's saved text WITHOUT re-arming the gesture on every edit.
  const annotationsRef = useRef<Record<string, string>>({})
  activeRef.current = active
  selectedIdsRef.current = selectedIds
  // Keep the ref in lockstep with state every render, so the drag-bound pickAt
  // closure (and editBadge) read the CURRENT annotations when prefilling — without
  // this the ref stays {} forever and prefill always reads empty ("看不到之前标注").
  annotationsRef.current = annotations
  // Server image URLs that failed to load (canonical URL → probe attempts so
  // far). ppt-master writes SVG pages that reference images STILL BEING
  // generated in the background — those `<image>`s 404 and would stay blank
  // forever, because nothing re-requests them when the file finally lands
  // (the SVG's mtime doesn't change when a sibling PNG appears). The retry
  // loop below probes these and swaps them in place once servable.
  const failedImagesRef = useRef<Map<string, number>>(new Map())

  // Report reachability changes up to the parent (tab visibility).
  useEffect(() => {
    onServerDownChange?.(serverDown)
  }, [serverDown, onServerDownChange])

  // ── load one slide ───────────────────────────────────────────────────────
  const loadSlide = useCallback(
    async (name: string) => {
      try {
        const r = await fetch(api(`/api/slide/${encodeURIComponent(name)}`), { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json()
        if (typeof data?.content !== 'string') throw new Error('no content')
        if (typeof data.mtime === 'number') mtimesRef.current[name] = data.mtime
        if (activeRef.current !== name) return
        const absolutized = absolutizeSlideImages(data.content, baseUrl)
        // Only wait for the warm-up when a slide is already on screen — that's
        // the case where the innerHTML swap would flash. First paint (host not
        // mounted yet) should show content ASAP instead.
        if (svgHostRef.current) {
          await preloadSlideImages(absolutized, 1500)
          // Re-check after the await: the user may have switched pages while
          // we were warming this one's images.
          if (activeRef.current !== name) return
        }
        setContent(absolutized)
        setUndoDepth(typeof data.undo_depth === 'number' ? data.undo_depth : 0)
        // Seed annotations from the server's per-slide list.
        const list: SlideAnnotation[] = Array.isArray(data.annotations) ? data.annotations : []
        const map: Record<string, string> = {}
        list.forEach((a) => {
          if (a && a.element_id) map[a.element_id] = a.annotation
        })
        setAnnotations(map)
        setSelectedIds([])
        setError(null)
      } catch (e) {
        if (activeRef.current === name) setError(e instanceof Error ? e.message : String(e))
      }
    },
    [api, baseUrl]
  )

  // ── fetch per-slide SVG thumbnails for the rail ───────────────────────────
  // Runs whenever the slide list changes. For each slide whose thumbnail is
  // missing or stale (mtime advanced), fetch its SVG once and cache it. We read
  // `thumbs` through a ref so this effect isn't re-armed by its own setState
  // (which would loop). Fetches are fire-and-forget; each resolves into the map
  // independently, so thumbnails fill in as they arrive.
  const thumbsRef = useRef(thumbs)
  thumbsRef.current = thumbs
  useEffect(() => {
    let cancelled = false
    slides.forEach((s) => {
      const cached = thumbsRef.current[s.name]
      // Fetch when uncached, or when the list's mtime is newer than the cached
      // one (a page was regenerated). Slides with no mtime fetch once.
      if (cached && (s.mtime === undefined || cached.mtime >= s.mtime)) return
      void fetch(api(`/api/slide/${encodeURIComponent(s.name)}`), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then(async (data) => {
          if (cancelled || !data || typeof data.content !== 'string') return
          const svg = absolutizeSlideImages(data.content, baseUrl)
          // Same warm-before-swap as loadSlide: a regenerated page replaces
          // its rail thumbnail's innerHTML too, and 15 tiny frames flashing
          // in a row reads worse than the main stage doing it once.
          await preloadSlideImages(svg, 1500)
          if (cancelled) return
          const mtime = typeof data.mtime === 'number' ? data.mtime : (s.mtime ?? 0)
          setThumbs((prev) => {
            const existing = prev[s.name]
            if (existing && existing.mtime >= mtime && existing.svg === svg) return prev
            return { ...prev, [s.name]: { svg, mtime } }
          })
        })
        .catch(() => {
          /* transient — a later slide-list poll re-triggers this effect */
        })
    })
    return () => {
      cancelled = true
    }
  }, [slides, api, baseUrl])

  // ── poll slide list (2s) ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const r = await fetch(api('/api/slides'), { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json()
        const list: LiveSlide[] = Array.isArray(data?.slides) ? data.slides : []
        if (cancelled) return
        setSlides(list)
        setError(null)
        setServerDown(false) // reachable again
        if (list.length === 0) return
        const cur = activeRef.current
        const newest = list[list.length - 1]?.name ?? null
        const want = cur === null || (followLatestRef.current && cur !== newest) ? newest : cur
        if (want && want !== cur) {
          setActive(want)
          activeRef.current = want
          void loadSlide(want)
          return
        }
        if (cur) {
          const entry = list.find((s) => s.name === cur)
          const seen = mtimesRef.current[cur]
          if (entry?.mtime !== undefined && entry.mtime !== seen) void loadSlide(cur)
        }
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        // A network-level failure (TypeError "Failed to fetch") means the URL
        // is unreachable — the server is gone (idle-timeout / stopped) even
        // though usePreviewServer still surfaces its stale launch URL. Flag it
        // so the empty state can say "服务已停止" instead of "等待生成".
        if (e instanceof TypeError) setServerDown(true)
      }
    }
    void poll()
    const id = window.setInterval(poll, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [api, loadSlide])

  const pickSlide = useCallback(
    (name: string): void => {
      followLatestRef.current = false // manual pick pins the view
      setActive(name)
      activeRef.current = name
      void loadSlide(name)
    },
    [loadSlide]
  )

  // ── imperative selection on the real SVG DOM ─────────────────────────────
  const svgRoot = useCallback((): SVGSVGElement | null => {
    return svgHostRef.current?.querySelector('svg') ?? null
  }, [])

  // Sync the .svg-annotated marker class onto the real DOM. (Selection + hover
  // are NOT class-driven anymore — they're painted by the HighlightOverlay from
  // measured bounding boxes, which gives Figma-style fitted boxes + handles and
  // motion transitions that an `outline` class can't. The annotated amber dot
  // stays a class since it's a persistent, non-animated marker.)
  useEffect(() => {
    const svg = svgRoot()
    if (!svg) return
    svg.querySelectorAll('.svg-annotated').forEach((el) => el.classList.remove('svg-annotated'))
    Object.keys(annotations).forEach((id) => {
      const el = svg.querySelector(`#${CSS.escape(id)}`)
      if (el) el.classList.add('svg-annotated')
    })
  }, [annotations, content, svgRoot])

  // Mark every element selectable (visual affordance) on each fresh injection.
  useEffect(() => {
    const svg = svgRoot()
    if (!svg) return
    svg.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase()
      if (SKIP_TAGS.indexOf(tag) !== -1 || el === svg) return
      el.classList.add('svg-selectable')
    })
  }, [content, svgRoot])

  // Tap-select at a screen point (called from the useDrag tap branch). Uses
  // elementFromPoint so it works whether the tap originated on the stage or an
  // overlay — then resolves the real element id and applies the same
  // single/Ctrl-multi/Alt-parent rules the old delegated click had.
  const pickAt = useCallback(
    (clientX: number, clientY: number, mods: { alt: boolean; additive: boolean }): void => {
      const svg = svgRoot()
      if (!svg) return
      const target = document.elementFromPoint(clientX, clientY) as Element | null
      if (!target || !svg.contains(target)) {
        // Clicked outside any element (blank stage) → clear selection + input.
        setSelectedIds([])
        setAnnotationText('')
        return
      }
      const id = resolvePickedId(target, svg, { alt: mods.alt })
      if (!id) {
        setSelectedIds([])
        setAnnotationText('')
        return
      }
      // A NON-additive pick starts a fresh edit. Behave IDENTICALLY to clicking
      // the element's number badge (editBadge): if the picked element already
      // carries an annotation, PREFILL its saved text so the user edits the
      // existing note in place; otherwise clear the box. Without this, clicking
      // the badge (prefill) and clicking its element (clear) diverge — the user
      // gets two conflicting edit surfaces for the same element ("否则会出现两个").
      // Guard (mirrors editBadge): if this element is ALREADY the sole selection
      // the user is likely mid-edit — don't clobber in-progress text back to the
      // saved version; only (re)prefill when jumping in from a different state.
      // Ctrl/Cmd-additive KEEPS whatever's typed: the user is gathering several
      // elements to give ONE shared instruction.
      if (!mods.additive) {
        const cur = selectedIdsRef.current
        const alreadyEditing = cur.length === 1 && cur[0] === id
        if (!alreadyEditing) setAnnotationText(annotationsRef.current[id] ?? '')
      }
      setSelectedIds((prev) => {
        if (mods.additive) {
          return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        }
        return [id]
      })
    },
    [svgRoot]
  )

  // ── highlight geometry: measure selected/hover element boxes ──────────────
  // Every box is stage-relative CSS px (getBoundingClientRect handles the
  // [&>svg]:w-full scaling for free). Recomputed when the selection/hover set,
  // the page content, or `geomVersion` (resize/scroll/image-load) changes.
  //
  // The /scaleRef.current divide: getBoundingClientRect() returns SCREEN px
  // (post-zoom), but HighlightOverlay paints these numbers as CSS left/top/
  // w/h on a div that lives INSIDE the same zoomed subtree — so whatever we
  // hand it gets multiplied by the zoom a second time when the browser lays
  // it out. Dividing back out here cancels that, landing the overlay's local
  // coordinates at their pre-zoom (content-space) values so the ONE zoom the
  // wrapper applies is the only one that ever happens. Without this, boxes
  // drift further from their element the more you zoom (works by coincidence
  // at scale=1, which is why it wasn't caught immediately).
  const measureRects = useCallback(
    (ids: string[]): OverlayRect[] => {
      const svg = svgRoot()
      const host = svgHostRef.current
      if (!svg || !host) return []
      // Base = the SVG host box. The overlay is absolutely positioned to cover
      // exactly this host (inset-0), so element rects measured relative to it
      // land dead-on regardless of stage padding / scroll / flex-centering.
      const base = host.getBoundingClientRect()
      const scale = scaleRef.current || 1
      const out: OverlayRect[] = []
      for (const id of ids) {
        const el = svg.querySelector(`#${CSS.escape(id)}`)
        if (!el) continue
        const r = (el as SVGGraphicsElement).getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        out.push({
          id,
          x: (r.left - base.left) / scale,
          y: (r.top - base.top) / scale,
          w: r.width / scale,
          h: r.height / scale
        })
      }
      return out
    },
    [svgRoot]
  )

  // id → 1-based annotation number, in the order annotations were added
  // (annotations' key insertion order). Drives the corner badge chips (①②③…)
  // so a selected element that's already annotated shows its slot number,
  // matching the reference's numbered-callout look.
  const annotationBadges = useMemo(() => {
    const map: Record<string, number> = {}
    Object.keys(annotations).forEach((id, i) => {
      map[id] = i + 1
    })
    return map
  }, [annotations])

  const selectedRects = useMemo(
    () =>
      measureRects(selectedIds).map((r) => ({
        ...r,
        badge: annotationBadges[r.id]
      })),
    // geomVersion intentionally in deps: a resize/scroll/load must re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedIds, content, geomVersion, measureRects, annotationBadges]
  )
  const hoverRect = useMemo(
    () => {
      // Don't draw a hover box over an already-selected element (avoids a
      // double frame); the selected box already reads as "active".
      if (!hoverId || selectedIds.includes(hoverId)) return null
      return measureRects([hoverId])[0] ?? null
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hoverId, selectedIds, content, geomVersion, measureRects]
  )

  // Persistent numbered callouts: every ANNOTATED element wears a dashed frame
  // + its number chip even when not selected (mirrors the reference, where the
  // ①②③ callouts stay on the page as a running record of what's been marked).
  // Selected elements are drawn by selectedRects, so exclude them here to avoid
  // a double frame — but keep annotated+selected numbers via selectedRects.badge.
  const annotatedRects = useMemo(
    () =>
      measureRects(Object.keys(annotations))
        .filter((r) => !selectedIds.includes(r.id))
        .map((r) => ({ ...r, badge: annotationBadges[r.id] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [annotations, selectedIds, content, geomVersion, measureRects, annotationBadges]
  )

  // The selection's union box (stage-relative px): left x, top y1, AND bottom
  // y2. Anchors the floating instruction box relative to the selection so the
  // input pops up where the user is looking. y2 matters because when the box
  // flips BELOW (no room above), it must sit under the selection's BOTTOM edge
  // — anchoring off y1 there would drop the card straight over the element and
  // hide what the user just selected (the "selection covered" bug).
  const selectionBounds = useMemo(() => {
    if (selectedRects.length === 0) return null
    let x1 = Infinity
    let y1 = Infinity
    let y2 = -Infinity
    for (const r of selectedRects) {
      x1 = Math.min(x1, r.x)
      y1 = Math.min(y1, r.y)
      y2 = Math.max(y2, r.y + r.h)
    }
    return { x: x1, y: y1, y2 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRects])

  // Visible viewport window, expressed in the SAME local (pre-zoom) coordinate
  // space as selectionBounds/measureRects — i.e. "which part of the zoomed/
  // panned slide can the user actually see right now." Needed because
  // FloatingInstruction's left clamp used to only guard against going
  // negative (`Math.max(0, bounds.x)`), which assumed local x=0 was always the
  // visible left edge. That held before pan/zoom existed; now that the stage
  // can be scrolled/zoomed, local x=0 can be panned well off-screen, and an
  // element selected near the (possibly off-screen) left edge of the SLIDE
  // pushed the card past the actually-visible viewport's left edge, hiding it
  // behind the app's own chrome (sidebar etc). Same divide-by-scale idiom as
  // measureRects, just applied to the viewport container's rect instead of a
  // selected element's. (top/bottom are computed too, for a future vertical
  // clamp if that edge turns out to need it, but aren't consumed yet — the
  // reported bug was horizontal only.)
  const visibleLocalBounds = useMemo(() => {
    const viewport = viewportRef.current
    const host = svgHostRef.current
    if (!viewport || !host) return null
    const v = viewport.getBoundingClientRect()
    const base = host.getBoundingClientRect()
    const scale = scaleRef.current || 1
    return {
      left: (v.left - base.left) / scale,
      right: (v.right - base.left) / scale,
      top: (v.top - base.top) / scale,
      bottom: (v.bottom - base.top) / scale
    }
    // geomVersion intentionally in deps: pan/zoom/resize must re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geomVersion])

  // 量测已选芯片条的溢出：条是定高单行 overflow-hidden，溢出时算出「没
  // 完整露出的芯片数」（含被 +N 角标遮住的），驱动渐隐 mask + 角标 +
  // hover 面板的显隐。ResizeObserver 让分栏拖宽/拖窄时数字实时跟手；
  // setChipsHidden 不改条的几何（定高、mask 不参与布局），不会成环。
  useEffect(() => {
    const el = chipsStripRef.current
    if (!el) {
      setChipsHidden(0)
      return
    }
    const measure = () => {
      if (el.scrollWidth <= el.clientWidth + 1) {
        setChipsHidden(0)
        return
      }
      const limit = el.clientWidth - 54 // 给 +N 角标留位
      let hidden = 0
      el.querySelectorAll<HTMLElement>('[data-chip]').forEach((c) => {
        if (c.offsetLeft + c.offsetWidth > limit) hidden += 1
      })
      setChipsHidden(hidden)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [selectedIds])

  // ── geometry sync: bump on resize / scroll / image load / page change ─────
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => bumpGeom())
    ro.observe(stage)
    const svg = svgRoot()
    if (svg) ro.observe(svg)
    // Also observe the outer viewport (the overflow-hidden box viewportRef
    // points at), NOT just the inner stage. The two can drift apart: the
    // stage wrapper is capped at max-w-[900px] (~line 1494) and zoom is a
    // pure CSS transform on TransformComponent's content, so neither changes
    // stageRef's own layout box. Dragging the chat-rail resize handle (or
    // resizing the window) narrows/widens the VIEWPORT without moving
    // stageRef at all once past that cap — without observing viewportRef
    // too, that resize never bumps geomVersion, so visibleLocalBounds keeps
    // FloatingInstruction's left-edge clamp pinned to a stale (usually too
    // wide) viewport rect, and the card can still render partly behind the
    // chat rail even though the clamp math itself is correct (2026-07-10,
    // "input 还是会被挡住" — the clamp was computing against yesterday's
    // width).
    const viewport = viewportRef.current
    if (viewport) ro.observe(viewport)
    const onScroll = (): void => bumpGeom()
    stage.addEventListener('scroll', onScroll, { passive: true })
    // Late-loading <image> tags change bboxes after injection — re-measure on
    // each load. Capture phase so it fires for the descendant images.
    const onLoad = (): void => bumpGeom()
    stage.addEventListener('load', onLoad, true)
    return () => {
      ro.disconnect()
      stage.removeEventListener('scroll', onScroll)
      stage.removeEventListener('load', onLoad, true)
    }
  }, [content, bumpGeom, svgRoot])

  // Fresh page → clear transient hover/marquee so no stale box lingers.
  useEffect(() => {
    setHoverId(null)
    setMarquee(null)
  }, [content])

  // ── missing-image recovery ────────────────────────────────────────────────
  // Collect load failures for THIS server's images. A window capture-phase
  // listener sees resource `error` events (they don't bubble, but capture
  // reaches them — same mechanism as the geometry effect's `load` listener),
  // covering both the main stage and the thumbnail rail with one hook.
  // Filtering on the server origin keeps unrelated app images (avatars etc.)
  // out of the retry set.
  useEffect(() => {
    const base = baseUrl.replace(/\/$/, '')
    const onError = (e: Event): void => {
      const t = e.target
      let url = ''
      if (t instanceof SVGImageElement) url = t.href.baseVal
      else if (t instanceof HTMLImageElement) url = t.currentSrc || t.src
      if (!url || !url.startsWith(base)) return
      const canonical = canonicalImageUrl(url)
      if (!failedImagesRef.current.has(canonical)) {
        failedImagesRef.current.set(canonical, 0)
      }
    }
    window.addEventListener('error', onError, true)
    return () => window.removeEventListener('error', onError, true)
  }, [baseUrl])

  // Probe failed images on a slow tick. On success, repoint every matching
  // `<image>` in the live SVG at a cache-busted URL IN PLACE — no innerHTML
  // rebuild, so the rest of the page doesn't so much as blink while the
  // photo "develops" — and drop any cached rail thumbnails that referenced
  // it (the 2s slide-list poll re-arms the thumbnail effect, which re-fetches
  // them with the image now servable). Attempts are capped per URL so an
  // image that will never exist (generation genuinely failed) doesn't get
  // probed forever.
  useEffect(() => {
    const RETRY_MS = 3000
    const MAX_ATTEMPTS = 400 // × 3s ≈ 20min — beyond any real generation run
    const id = window.setInterval(() => {
      failedImagesRef.current.forEach((attempts, url) => {
        if (attempts >= MAX_ATTEMPTS) {
          failedImagesRef.current.delete(url)
          return
        }
        failedImagesRef.current.set(url, attempts + 1)
        const busted = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`
        const probe = new Image()
        probe.onload = () => {
          failedImagesRef.current.delete(url)
          const host = svgHostRef.current
          if (host) {
            host.querySelectorAll('image').forEach((el) => {
              const cur =
                el.getAttribute('href') ?? el.getAttribute('xlink:href')
              if (cur === url) {
                el.setAttribute('href', busted)
                if (el.hasAttribute('xlink:href')) {
                  el.setAttribute('xlink:href', busted)
                }
              }
            })
          }
          setThumbs((prev) => {
            let changed = false
            const next: typeof prev = {}
            for (const [k, v] of Object.entries(prev)) {
              if (v.svg.includes(url)) {
                changed = true
                continue
              }
              next[k] = v
            }
            return changed ? next : prev
          })
          bumpGeom() // the developed image changes bboxes — re-measure overlay
        }
        probe.src = busted
      })
    }, RETRY_MS)
    return () => window.clearInterval(id)
  }, [bumpGeom])

  // ── hover pre-highlight (rAF-throttled delegated mousemove) ───────────────
  const hoverRafRef = useRef(0)
  const pendingHoverPtRef = useRef<{ x: number; y: number } | null>(null)
  // Set the instant a marquee drag starts (before the `marquee` state commits),
  // so the concurrent mousemove doesn't flicker a hover box mid-drag.
  const draggingRef = useRef(false)
  const onStageMouseMove = useCallback(
    (e: React.MouseEvent): void => {
      // While marquee-dragging, suppress hover (the box is the feedback).
      if (draggingRef.current || marquee) return
      pendingHoverPtRef.current = { x: e.clientX, y: e.clientY }
      if (hoverRafRef.current) return
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = 0
        const pt = pendingHoverPtRef.current
        const svg = svgRoot()
        if (!pt || !svg) return
        const target = document.elementFromPoint(pt.x, pt.y) as Element | null
        const id = target && svg.contains(target) ? resolvePickedId(target, svg, { alt: false }) : null
        setHoverId((prev) => (prev === id ? prev : id))
      })
    },
    [marquee, svgRoot]
  )
  const onStageMouseLeave = useCallback(() => setHoverId(null), [])
  useEffect(() => {
    return () => {
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current)
    }
  }, [])

  // ── marquee selection (drag) + tap-select, via @use-gesture ───────────────
  // filterTaps splits a <3px displacement into a `tap` (single/Ctrl select) vs
  // a drag (rubber-band marquee). Bound to the stage; coords are converted to
  // stage-relative for the marquee box and back to screen for the hit-test.
  const bindDrag = useDrag(
    ({ first, last, tap, initial: [ix, iy], xy: [cx, cy], event }) => {
      const host = svgHostRef.current
      const svg = svgRoot()
      if (!host || !svg) return
      // Ignore gestures that start inside the floating instruction box: it lives
      // within the stage (so its own bounds move with the selection), but a
      // pointer-down there must NOT reach pickAt — that would treat the click as
      // "tap on non-SVG → clear selection" and yank the input out mid-type.
      // React's onMouseDown.stopPropagation can't stop use-gesture's pointer
      // handler, so we gate here on the real event target instead.
      const gestureTarget = event?.target as Element | null
      if (gestureTarget?.closest?.('[data-floating-input]')) return
      const me = event as MouseEvent | undefined
      const mods = {
        alt: me?.altKey ?? false,
        additive: (me?.ctrlKey ?? false) || (me?.metaKey ?? false),
        shift: me?.shiftKey ?? false
      }
      if (tap) {
        // A click, not a drag → single/Ctrl-multi/Alt-parent select.
        draggingRef.current = false
        pickAt(cx, cy, { alt: mods.alt, additive: mods.additive })
        return
      }
      // Marquee coords are host-relative to match the overlay's origin, then
      // divided by the live zoom scale — same reason as measureRects: this
      // box is painted as CSS left/top/w/h on a div INSIDE the zoomed
      // subtree, so it must be expressed in local (pre-zoom) units or the
      // rubber-band rectangle drifts off the actual drag path once zoomed.
      const base = host.getBoundingClientRect()
      const scale = scaleRef.current || 1
      const toHost = (px: number, py: number): { x: number; y: number } => ({
        x: (px - base.left) / scale,
        y: (py - base.top) / scale
      })
      if (first) {
        draggingRef.current = true
        setHoverId(null)
      }
      const a = toHost(ix, iy)
      const b = toHost(cx, cy)
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
      if (last) {
        draggingRef.current = false
        setMarquee(null)
        // Hit-test: screen-space intersection of the marquee with each id'd,
        // selectable element. Kept to the drag END (one pass, not per-frame).
        const mx1 = Math.min(ix, cx)
        const my1 = Math.min(iy, cy)
        const mx2 = Math.max(ix, cx)
        const my2 = Math.max(iy, cy)
        const hits: string[] = []
        svg.querySelectorAll<SVGGraphicsElement>('[id]').forEach((el) => {
          if (el === (svg as unknown as SVGGraphicsElement)) return
          const tag = el.tagName.toLowerCase()
          if (SKIP_TAGS.indexOf(tag) !== -1) return
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return
          const intersects = r.left < mx2 && r.right > mx1 && r.top < my2 && r.bottom > my1
          if (intersects && el.id) hits.push(el.id)
        })
        // Same rule as pickAt: a fresh (non-additive) marquee starts a new edit.
        // If it lands on exactly ONE already-annotated element, prefill that
        // element's saved text (parity with clicking the element/its badge);
        // otherwise clear. additive/shift marquee is extending the set for one
        // shared instruction and keeps whatever's typed.
        if (!mods.additive && !mods.shift) {
          setAnnotationText(hits.length === 1 ? (annotationsRef.current[hits[0]] ?? '') : '')
        }
        setSelectedIds((prev) => {
          if (mods.additive || mods.shift) {
            const set = new Set(prev)
            hits.forEach((h) => set.add(h))
            return Array.from(set)
          }
          return hits
        })
        return
      }
      setMarquee(box)
    },
    // enabled: false while space is held — pan mode owns the left-drag then.
    { filterTaps: true, threshold: 4, pointer: { touch: true }, enabled: !spacePanning }
  )

  // ── annotation actions ───────────────────────────────────────────────────
  const addAnnotation = useCallback(async () => {
    const name = activeRef.current
    const ids = selectedIdsRef.current
    const text = annotationText.trim()
    if (!name || ids.length === 0 || !text) return
    setBusy(true)
    try {
      await Promise.all(
        ids.map((eid) =>
          fetch(api(`/api/slide/${encodeURIComponent(name)}/annotate`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ element_id: eid, annotation: text })
          }).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.json()
          })
        )
      )
      setAnnotations((prev) => {
        const next = { ...prev }
        ids.forEach((eid) => (next[eid] = text))
        return next
      })
      setAnnotationText('')
      setStatusMsg(null)
      // Clear the selection so the floating input dismisses and the just-marked
      // elements settle into their persistent numbered (dashed) callout. The
      // user can re-select to add another note; leaving them selected would keep
      // the input hovering over freshly-annotated elements.
      setSelectedIds([])
    } catch (e) {
      setStatusMsg('添加标注失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [api, annotationText])

  // Click a number badge → edit that element's EXISTING annotation. This is the
  // SAME operation as clicking the element itself in pickAt (single, non-additive
  // select): both select just that element (so the floating box anchors to it)
  // and prefill the input with its saved text — so the badge and its element are
  // one and the same edit surface, never "两个". Submitting overwrites via
  // addAnnotation (POST with the same element_id is a server upsert + local
  // `next[eid] = text`), so no separate "edit" endpoint is needed. Focus lands in
  // the box because a fresh single-selection triggers FloatingInstruction's
  // anchor-keyed focus. Reads annotationsRef (not the `annotations` state) so the
  // callback stays stable — identical to pickAt's prefill source.
  const editBadge = useCallback((elementId: string): void => {
    // Guard (identical to pickAt): if this element is ALREADY the sole selection
    // the user is likely mid-edit — don't clobber their in-progress text back to
    // the saved version. Only prefill when jumping in from a different state.
    const cur = selectedIdsRef.current
    const alreadyEditing = cur.length === 1 && cur[0] === elementId
    setSelectedIds([elementId])
    if (!alreadyEditing) setAnnotationText(annotationsRef.current[elementId] ?? '')
  }, [])

  const removeAnnotation = useCallback(
    async (elementId: string) => {
      const name = activeRef.current
      if (!name) return
      try {
        await fetch(api(`/api/slide/${encodeURIComponent(name)}/annotate/${encodeURIComponent(elementId)}`), {
          method: 'DELETE'
        })
        setAnnotations((prev) => {
          const next = { ...prev }
          delete next[elementId]
          return next
        })
      } catch (e) {
        setStatusMsg('删除标注失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [api]
  )

  const applyChanges = useCallback(async () => {
    // 本会话上一轮 apply 还没走完（AI 修改中）就不再受理。按钮已 disabled，
    // 这里挡的是 disabled 渲染生效前的连点——直接同步读 store 的 live 值
    // （zustand set 同步提交，send 处写入后第二击必被挡），与下面读 live 队
    // 列的 dup 检查同思路。
    {
      const liveSid = useChatStore.getState().sessionId
      if (liveSid && useApplyPhaseStore.getState().bySid[liveSid]) return
    }
    setBusy(true)
    setStatusMsg('正在应用…')
    try {
      const r = await fetch(api('/api/save-all'), { method: 'POST' })
      const data = await r.json()
      if (data.error) {
        setStatusMsg('应用失败：' + data.error)
      } else {
        setUndoDepth(0)
        const name = activeRef.current
        // save-all wrote the annotations into svg_output, so the AI can read
        // them to redo the page. Instead of only prefilling the composer and
        // making the user hit Enter, we SEND the instruction ourselves through
        // the same composer runtime the chat input drives. setText+send lands
        // in FusionRuntimeProvider's onNew, which already owns the "running →
        // enqueue behind the active turn / idle → send now" branch (it reads
        // the LIVE streaming flag via getState). So we don't reimplement that
        // decision here — we just mirror it for the status message, reading the
        // SAME flag onNew will read a beat later, so the feedback matches what
        // actually happens (queued vs sent).
        if (name) {
          void loadSlide(name) // reflect the written state
          // Dedup: if an 应用我的标注 turn is already waiting in this session's
          // queue, don't stack a second identical one — it'd just make the AI
          // redo the whole page twice. Read the LIVE queue (getState, not the
          // render-time `applyQueued` snapshot) so a fast double-click that
          // outruns the re-render still can't slip a duplicate through.
          const sid = useChatStore.getState().sessionId
          const dup =
            !!sid &&
            (useMessageQueueStore.getState().queues[sid] ?? []).some(
              (q) => q.text === APPLY_ANNOTATION_TEXT
            )
          if (dup) {
            setStatusMsg('已在队列中，无需重复添加')
          } else {
            const willQueue = useChatStore.getState().streaming
            composerRuntime.setText(APPLY_ANNOTATION_TEXT)
            composerRuntime.send()
            // 从这一刻起进入 apply 生命周期（见 applyPhase 声明处注释）：按钮
            // 转 loading 并锁死，由下面的状态机 effect 在 turn 结束时解锁。
            // 写进 sid 那格——send 发向的就是这个会话的 composer。
            if (sid) useApplyPhaseStore.getState().set(sid, 'sent')
            setStatusMsg(willQueue ? '会话进行中，已加入队列' : '已发送，AI 正在修改')
          }
        } else {
          setStatusMsg('已应用到 svg_output')
        }
      }
    } catch (e) {
      setStatusMsg('应用失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [api, loadSlide, composerRuntime])

  // apply 生命周期状态机：sent →（见到 streaming 或入队）→ active →（turn
  // 结束且队列已空）→ idle（= 从 store 清掉该 sid）。phase 与两个判定信号都
  // 取自同一个 chatSessionId，切会话时三者一起换格子——不会拿旧会话的
  // phase 去对新会话的信号（那正是「切换 session 后失灵」的根因）。两个转换
  // 各带一个 timer，原因不同：
  // - 'sent' 的 10s 兜底：send() 到 onNew 翻 streaming 是 async 空窗，正常几
  //   百 ms 内闭合；但 onNew 的异常路径（引擎拒发等）既不起 turn 也不入队，
  //   没有兜底按钮就永久锁死。切会话打断兜底计时也没关系，切回来重新起算。
  // - 'active' 的 1.5s 去抖：排队场景里前一个 turn 收尾（streaming=false）
  //   → pump 取走队首（queued=false）→ 重新 send → streaming 再翻 true，
  //   中间存在一个两信号皆灭的异步空窗（React effect 链 + IPC），立即判完成
  //   会在空窗里把按钮闪开又闪关。去抖期内任一信号复燃即取消（依赖变化走
  //   cleanup），真完成时最多晚 1.5s 解锁，感知不到。
  useEffect(() => {
    if (!chatSessionId) return
    const sid = chatSessionId
    if (applyPhase === 'sent') {
      if (chatStreaming || applyQueued) {
        useApplyPhaseStore.getState().set(sid, 'active')
        return
      }
      const t = window.setTimeout(() => {
        useApplyPhaseStore.getState().clear(sid)
      }, 10_000)
      return () => window.clearTimeout(t)
    }
    if (applyPhase === 'active' && !chatStreaming && !applyQueued) {
      const t = window.setTimeout(() => {
        useApplyPhaseStore.getState().clear(sid)
        setStatusMsg('本次修改已完成，可以继续标注')
      }, 1500)
      return () => window.clearTimeout(t)
    }
  }, [applyPhase, chatStreaming, applyQueued, chatSessionId])

  // 撤销 / 退出预览 的 UI 已按需求移除（应用标注是唯一动作），对应的
  // runUndo / exitPreview 回调随之删除。undoDepth state 仍由 loadSlide /
  // applyChanges 维护，仅不再有按钮读它——保留以免牵动应用流程；若确认永久
  // 不再需要撤销入口，可连同 /undo、/shutdown 端点调用一起清理。

  const annotationEntries = useMemo(() => Object.entries(annotations), [annotations])

  // ── deck-level derived state (top bar / breadcrumb / status bar) ──────────
  // Ready count: a slide is "ready" when it rendered without error (ok !== false).
  const readyCount = useMemo(() => slides.filter((s) => s.ok !== false).length, [slides])
  // 就绪进度推给 tab 栏胶囊（见 usePreviewReadinessStore 头注释）。
  useEffect(() => {
    usePreviewReadinessStore
      .getState()
      .setReadiness(slides.length > 0 ? { ready: readyCount, total: slides.length } : null)
  }, [readyCount, slides.length])
  useEffect(() => () => usePreviewReadinessStore.getState().setReadiness(null), [])
  // 元素的大白话名：tag 中文 + id 尾号（`_edit_15` → 「文本 15」）。tag 从
  // 真实 SVG DOM 现读——选中集只存 id，标签是画布上的活信息。
  const friendlyLabel = useCallback((id: string): string => {
    const el = svgHostRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)
    const tag = el?.tagName.toLowerCase() ?? ''
    const num = /(\d+)$/.exec(id)?.[1]
    return (TAG_LABEL[tag] ?? '元素') + (num ? ' ' + num : '')
  }, [])
  const activeIndex = useMemo(
    () => slides.findIndex((s) => s.name === active),
    [slides, active]
  )
  // Page label + display name, stripped of the leading "NN_" and ".svg".
  const activeNo = activeIndex >= 0 ? String(activeIndex + 1).padStart(2, '0') : '—'
  const activeDisplayName = active
    ? active.replace(/\.svg$/i, '').replace(/^\d+[_-]/, '')
    : ''
  // Step to the prev/next slide (drives the breadcrumb arrows + ← → keys).
  const stepSlide = useCallback(
    (delta: number): void => {
      if (activeIndex < 0 || slides.length === 0) return
      const next = activeIndex + delta
      if (next < 0 || next >= slides.length) return
      followLatestRef.current = false
      pickSlide(slides[next].name)
    },
    [activeIndex, slides, pickSlide]
  )

  // ← / → change slides (ignored while typing in the annotation textarea).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return
      if (e.key === 'ArrowLeft') stepSlide(-1)
      else if (e.key === 'ArrowRight') stepSlide(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepSlide])

  // ── empty / loading state ────────────────────────────────────────────────
  if (slides.length === 0) {
    // serverDown: the URL is unreachable (server stopped) — say so plainly
    // (and statically: an inviting "materializing" animation would imply
    // generation is still pending, which is exactly the wrong signal here).
    if (serverDown) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-5">
          <div className="text-center">
            <div className="text-[14px] font-medium text-foreground">预览服务已停止</div>
            <div className="mt-1 text-[13px] text-muted-foreground">
              预览服务已关闭（空闲超时或已退出）。重新生成或重启预览后会再次出现。
            </div>
          </div>
        </div>
      )
    }
    // Server alive, no slides yet → the animated "materializing" empty state.
    return (
      <PreviewEmptyState
        hint={error ? `等待幻灯片生成…（${error}）` : '生成的幻灯片会在这里实时出现'}
      />
    )
  }

  return (
    // @container/editor：工作区住在可拖分栏里，视口媒体查询探不到面板的
    // 真实宽度——所有窄档适配（dock 换行/缩略栏收窄/meta 隐藏）用容器
    // 查询打在这个根上。容器断点：md=448 lg=512 xl=576 2xl=672px。
    <div className="@container/editor flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* 原 56px「幻灯片预览」标题头已删（2026-07-07 重设计）：文案与
          tab 名重复，就绪进度上移为 tab 栏右端胶囊（usePreviewReadinessStore
          → SlidesWorkspace），省出一整行给画布。 */}

      {/* ── body: rail | stage | panel ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── left: thumbnail rail ──
            Redesign: rail recedes to the sunken chrome plane (bg-muted/20, a hair
            lighter than the stage well) so it, the well and the dock read as one
            receding surface framing the elevated slide card. */}
        <aside className="flex w-44 shrink-0 flex-col border-r border-border/60 bg-muted/20 @max-xl/editor:w-[132px]">
          <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              幻灯片
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {activeNo} / {String(slides.length).padStart(2, '0')}
            </span>
          </div>
          <div className="flex-1 space-y-1.5 overflow-y-auto px-2.5 pb-3">
            {slides.map((s, i) => {
              const on = s.name === active
              const ready = s.ok !== false
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => pickSlide(s.name)}
                  className={
                    // 操作色 = 品牌绿（2026-07-07 原型定稿，替换上一轮的
                    // 靛蓝）：激活缩略图与选中态/CTA 同一信号色，且与整个
                    // app 的绿色家族一致。
                    'flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors ' +
                    (on
                      ? 'bg-[hsl(var(--brand)/0.1)] ring-1 ring-inset ring-[hsl(var(--brand)/0.28)]'
                      : 'hover:bg-foreground/[0.04]')
                  }
                  title={s.name}
                >
                  <span
                    className={
                      'w-4 shrink-0 text-right text-[11px] tabular-nums ' +
                      (on
                        ? 'font-semibold text-[hsl(var(--brand))]'
                        : 'text-muted-foreground/60')
                    }
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {/* Real per-slide SVG preview. The SVG scales to this frame by
                      its own viewBox; pointer-events-none + a transparent shield
                      keep it non-interactive (clicks go to the button). Falls
                      back to a light skeleton until the SVG arrives. */}
                  <span className="relative aspect-[16/9] flex-1 overflow-hidden rounded-md border border-border/60 bg-background">
                    {thumbs[s.name] ? (
                      <span
                        className="pointer-events-none absolute inset-0 block [&>svg]:h-full [&>svg]:w-full [&>svg]:object-contain"
                        // eslint-disable-next-line react/no-danger
                        dangerouslySetInnerHTML={{ __html: thumbs[s.name].svg }}
                      />
                    ) : (
                      <span className="absolute inset-0 flex flex-col justify-center gap-[3px] px-1.5">
                        <span className="h-[2px] w-5 rounded-full bg-muted-foreground/30" />
                        <span className="h-[4px] w-[70%] rounded-full bg-muted-foreground/40" />
                        <span className="h-[2px] w-full rounded-full bg-muted-foreground/20" />
                        <span className="h-[2px] w-[45%] rounded-full bg-muted-foreground/20" />
                      </span>
                    )}
                    {/* transparent shield so SVG internals never intercept clicks */}
                    <span className="absolute inset-0" />
                    <span
                      className={
                        'absolute right-1 top-1 size-[7px] rounded-full ring-2 ring-background ' +
                        (ready ? 'bg-emerald-500' : 'bg-muted-foreground/30')
                      }
                    />
                    {/* 标注计数徽标（琥珀 = 标注身份色）：与画布序号徽标、
                        dock 序号钮同族。服务端没给 annotation_count 时退化
                        为无数字的小圆（等价旧的提示点）。 */}
                    {s.annotated && (
                      <span className="absolute bottom-1 right-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-amber-500 px-[3px] text-[9px] font-bold tabular-nums text-white ring-2 ring-background">
                        {s.annotation_count && s.annotation_count > 0
                          ? s.annotation_count
                          : ''}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        {/* ── center: breadcrumb + stage ──
            Redesign「舞台托盘感」: the stage well sits ONE step below the chrome
            (bg-muted/30), so the slide card — the only elevated bright surface —
            reads as the page's single focal point instead of blending into an
            all-white expanse. */}
        <section className="flex min-w-0 flex-1 flex-col bg-muted/30">
          {/* breadcrumb: page no + name + prev/next */}
          <div className="flex items-center gap-2.5 px-5 py-3">
            <span className="rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-semibold tabular-nums tracking-wide text-muted-foreground">
              {activeNo}
            </span>
            <span className="truncate text-[13px] font-semibold text-foreground">
              {activeDisplayName || '未命名'}
            </span>
            {/* 尺寸 meta 从底部状态条上移到这里（离画布更近，状态条只留
                工作区身份 + 快捷键）。 */}
            <span className="text-[11px] text-muted-foreground/60 @max-lg/editor:hidden">16:9 · 1280 × 720</span>
            <div className="flex-1" />
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => stepSlide(-1)}
                disabled={activeIndex <= 0}
                className="grid size-7 place-items-center rounded-[7px] text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                title="上一页"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <button
                type="button"
                onClick={() => stepSlide(1)}
                disabled={activeIndex < 0 || activeIndex >= slides.length - 1}
                className="grid size-7 place-items-center rounded-[7px] text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                title="下一页"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          </div>

          {/* stage: centres the canvas card. The CANVAS CARD is the drag/hover
              surface (not the whole stage) so marquee coords + overlay align to
              the card. select-none: a marquee drag must NOT native-select the
              SVG <text>. onMouseDown here clears the selection when the user
              clicks the empty margin AROUND the card (outside stageRef) — a
              natural "click blank to deselect" that the card's own handler
              can't cover since that whitespace isn't part of the card.
              overflow-hidden (not overflow-auto): the native scrollbar is
              retired in favour of react-zoom-pan-pinch's own viewport — pan
              (space+drag) and wheel-zoom now own all movement in this box. */}
          <div
            ref={viewportRef}
            className={cn(
              'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 pb-6 pt-1 @max-lg/editor:px-3 @max-lg/editor:pb-4',
              spacePanning && 'cursor-grab'
            )}
            onMouseDown={(e) => {
              if (stageRef.current && !stageRef.current.contains(e.target as Node)) {
                setSelectedIds([])
              }
            }}
          >
            {content ? (
              <TransformWrapper
                minScale={0.25}
                maxScale={4}
                initialScale={1}
                centerOnInit
                // Left-drag pans ONLY while space is held (Figma/PS
                // convention) — otherwise it must stay free for marquee
                // select (useDrag above), which is disabled in lockstep via
                // its own `enabled: !spacePanning`.
                panning={{ disabled: !spacePanning, velocityDisabled: true }}
                doubleClick={{ disabled: true }}
                // step 0.12 felt fine for a discrete mouse wheel but way too
                // fast on a trackpad — a two-finger swipe fires dozens of
                // wheel events per gesture, so the same per-event step
                // compounds into a much bigger jump. The library has no
                // separate trackpad sensitivity knob, so lowering step is the
                // only lever; 0.04 keeps mouse-wheel zoom usable (just needs
                // a couple more notches) while taming trackpad swipes.
                wheel={{ step: 0.04 }}
                // The selection/hover/marquee overlay boxes are computed from
                // getBoundingClientRect() (screen space) — correct after a
                // zoom/pan for free, but only once React re-renders them. The
                // library mutates the DOM transform imperatively and does NOT
                // trigger a re-render on its own, so without this the overlay
                // would freeze at its pre-zoom position until some unrelated
                // state change happened to bump geomVersion. Also capture the
                // live scale into scaleRef — measureRects needs it to convert
                // screen-space deltas back to the overlay's local (pre-zoom)
                // coordinate space (see measureRects' comment).
                onTransform={(_ref, state) => {
                  scaleRef.current = state.scale
                  bumpGeom()
                }}
              >
                <ZoomControls />
                <TransformComponent
                  wrapperClass="!w-full !h-full"
                  contentClass="!w-full !h-full flex items-center justify-center"
                >
                  <div className="flex w-full max-w-[900px] flex-col items-center gap-3.5">
                    {/* Two nested layers so the selection overlay is NOT clipped by
                        the card's rounded corners:
                         - outer (stageRef): the drag/hover surface + overlay origin.
                           NO overflow-hidden, so boxes/handles on elements near the
                           edge render fully (they'd otherwise be cut by the round
                           corner — the bug this fixes).
                         - inner (svgHost): rounded-xl + overflow-hidden clips only
                           the SVG itself to the card shape + carries the shadow. */}
                    <div
                      ref={stageRef}
                      {...bindDrag()}
                      onMouseMove={onStageMouseMove}
                      onMouseLeave={onStageMouseLeave}
                      className="relative w-full select-none"
                      style={{ touchAction: 'none' }}
                    >
                      {/* The amber .svg-annotated outline is gone — annotated
                          elements now wear the overlay's dashed indigo frame +
                          number chip (HighlightOverlay), so a class outline here
                          would double-frame them. .svg-selectable keeps the pointer
                          affordance. */}
                      <div
                        ref={svgHostRef}
                        // Redesign「舞台托盘」: a warmer, deeper two-layer shadow lifts
                        // the slide off the sunken well (bg-muted/30 around it) — the
                        // old flat 0.06 shadow left the card visually glued to the bg.
                        className="w-full max-w-full overflow-hidden rounded-xl bg-background shadow-[0_18px_44px_-20px_rgba(30,41,74,0.28),0_4px_12px_-6px_rgba(30,41,74,0.14)] ring-1 ring-black/[0.03] [&_.svg-selectable]:cursor-pointer [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                        // eslint-disable-next-line react/no-danger
                        dangerouslySetInnerHTML={{ __html: content }}
                      />
                      <HighlightOverlay
                        selected={selectedRects}
                        annotated={annotatedRects}
                        hover={hoverRect}
                        marquee={marquee}
                        reduceMotion={!!reduceMotion}
                        onEditBadge={editBadge}
                      />
                  {/* Floating instruction box — pops just above the selection so
                      the user writes the edit right where they're looking,
                      instead of walking over to the side panel. Positioned in
                      stage-relative px from selectionBounds; clamped so it never
                      slips off the top (flips below the selection when there's no
                      room above). pointer-events re-enabled (the overlay layer is
                      pointer-events-none). Enter submits, Shift+Enter newlines,
                      Esc clears the selection (dismiss). */}
                  <FloatingInstruction
                    bounds={selectionBounds}
                    scale={scaleRef.current || 1}
                    visibleBounds={visibleLocalBounds}
                    count={selectedIds.length}
                    value={annotationText}
                    busy={busy}
                    inputRef={floatingInputRef}
                    // 编辑既有标注的判定：恰好单选且该元素已有标注（dock 序号
                    // 钮/画布徽标点进来就是这个形态）。此时浮层换「编辑标注」
                    // 文案并露出删除入口——dock 的标注卡片退役后（只剩序号
                    // 钮），删除唯一的家就在这里。
                    editingId={
                      selectedIds.length === 1 &&
                      annotations[selectedIds[0]] !== undefined
                        ? selectedIds[0]
                        : null
                    }
                    onChange={setAnnotationText}
                    onSubmit={() => void addAnnotation()}
                    onDismiss={() => setSelectedIds([])}
                    onDelete={(id) => {
                      void removeAnnotation(id)
                      setSelectedIds([])
                      setAnnotationText('')
                    }}
                  />
                    </div>
                  </div>
                </TransformComponent>
              </TransformWrapper>
            ) : (
              <div className="text-[13px] text-muted-foreground">
                {error ? `加载失败：${error}` : '加载中…'}
              </div>
            )}
            {/* Static hint row — stays fixed to the viewport (outside the
                zoom/pan transform), otherwise it would shrink/pan away with
                the canvas instead of reading as chrome. */}
            {content && (
              <div className="pointer-events-none absolute bottom-1.5 left-0 flex w-full flex-wrap items-center justify-center gap-1.5 text-[11.5px] text-muted-foreground/70">
                点击元素选择 · 拖拽框选多个 ·
                <kbd className="grid h-[17px] min-w-[17px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">⌘</kbd>
                加选 ·
                <kbd className="grid h-[17px] min-w-[17px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">⌥</kbd>
                选父级 · 按住
                <kbd className="grid h-[17px] min-w-[17px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">空格</kbd>
                拖拽平移 · 滚轮缩放
              </div>
            )}
          </div>
        </section>

      </div>

      {/* ── bottom dock: 已选 + 本页标注 + 应用（2026-07-07 原型定稿，
          docs/ui-prototype-ppt-workspace.html）。三簇靠留白分区——上一版的
          border-l 竖线把 dock 切成表格感，是被毙的主因之一。已选簇定宽
          260px：空态提示与芯片列表天然宽度不同，跟内容走会让整条 dock 在
          选中/取消时左右抖动（2026-07-07 用户实锤）。dock 回到明面
          bg-background，舞台井色只留给 rail 和 stage。 ── */}
      {/* 窄档（容器 ≤672px）：dock 从「三簇一行」变「三条单行带竖排」——
          簇内标签翻到左侧、内容条 flex-1，应用簇整行占满。芯片/序号钮
          永不折行（折行让 dock 纵向无上限、把舞台挤没，2026-07-07 窄屏
          实锤），dock 总高度因此有界。 */}
      <div className="flex min-h-[62px] shrink-0 items-center gap-5 border-t border-border/60 bg-background px-4 py-2.5 @max-2xl/editor:min-h-0 @max-2xl/editor:flex-col @max-2xl/editor:items-stretch @max-2xl/editor:gap-2 @max-2xl/editor:px-3.5">
        {/* 已选元素 */}
        <section className="flex w-[260px] shrink-0 flex-col gap-1.5 @max-2xl/editor:w-auto @max-2xl/editor:flex-row @max-2xl/editor:items-center @max-2xl/editor:gap-2.5">
          <div className="flex items-center gap-1.5 @max-2xl/editor:shrink-0">
            <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
              已选元素
            </span>
            {selectedIds.length > 0 && (
              <span className="grid h-[15px] min-w-[15px] place-items-center rounded-full bg-[hsl(var(--brand)/0.12)] px-1 text-[9.5px] font-bold tabular-nums text-[hsl(var(--brand))]">
                {selectedIds.length}
              </span>
            )}
            {selectedIds.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                className="rounded px-1 text-[10.5px] text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
              >
                清空
              </button>
            )}
          </div>
          {/* 定高芯片区（26px 单行，group/selwrap 是 hover 面板的触发域）：
              溢出时条尾渐隐 + 右端 +N 角标，鼠标移入上浮面板铺开全量芯片
              （可滚动、可逐个移除）。替代早前的 +N 更多点击展开——展开
              同样会把 dock 撑高，与定高目标矛盾。 */}
          <div className="group/selwrap relative h-[26px] w-full min-w-0 @max-2xl/editor:w-auto @max-2xl/editor:flex-1">
            {selectedIds.length === 0 ? (
              <div className="flex h-full items-center text-[11.5px] text-muted-foreground/60">
                在画布上点击元素开始标注
              </div>
            ) : (
              (() => {
                // 芯片与画布选中框、CTA 同穿品牌绿（一条操作色链）；显示
                // 大白话名（friendlyLabel），原始 id 收进 title。亮档文字
                // 压深 18%（亮底上纯 brand 绿对比不足），暗档直接用。
                // 同一渲染函数喂定高条和 hover 面板，两处永不漂移。
                const chip = (id: string): React.JSX.Element => (
                  <span
                    key={id}
                    data-chip
                    className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-md bg-[hsl(var(--brand)/0.1)] py-1 pl-2 pr-1 text-[11px] font-medium text-[color-mix(in_srgb,hsl(var(--brand))_82%,#000)] ring-1 ring-inset ring-[hsl(var(--brand)/0.3)] dark:text-[hsl(var(--brand))]"
                    title={id}
                  >
                    <span className="min-w-0 max-w-[140px] truncate">
                      {friendlyLabel(id)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedIds((prev) => prev.filter((x) => x !== id))
                      }
                      className="grid size-3.5 shrink-0 place-items-center rounded-sm text-[hsl(var(--brand)/0.6)] transition-colors hover:bg-[hsl(var(--brand)/0.15)] hover:text-[hsl(var(--brand))]"
                      title="取消选择"
                    >
                      ✕
                    </button>
                  </span>
                )
                return (
                  <>
                    <div
                      ref={chipsStripRef}
                      className={cn(
                        'relative flex h-[26px] items-center gap-1.5 overflow-hidden',
                        chipsHidden > 0 &&
                          '[mask-image:linear-gradient(90deg,#000_calc(100%-64px),transparent_calc(100%-6px))]'
                      )}
                    >
                      {selectedIds.map(chip)}
                    </div>
                    {chipsHidden > 0 && (
                      <>
                        <span className="pointer-events-none absolute right-0 top-1/2 inline-flex h-[22px] -translate-y-1/2 items-center rounded-full bg-background px-2 text-[11px] font-semibold tabular-nums text-[hsl(var(--brand))] shadow-[inset_0_0_0_1px_hsl(var(--brand)/0.3),0_1px_4px_rgba(0,0,0,0.1)]">
                        +{chipsHidden}
                        </span>
                        <div className="absolute bottom-[calc(100%+6px)] left-0 z-30 hidden max-h-[150px] w-[340px] max-w-[calc(100vw-48px)] flex-wrap content-start gap-1.5 overflow-y-auto rounded-[10px] border border-border bg-popover p-2 shadow-[0_12px_40px_rgba(0,0,0,0.16),0_2px_8px_rgba(0,0,0,0.08)] group-hover/selwrap:flex">
                          {selectedIds.map(chip)}
                        </div>
                      </>
                    )}
                  </>
                )
              })()
            )}
          </div>
        </section>

        {/* 本页标注 — 只露序号圆钮（2026-07-07 用户定稿：不显示文字，点击
            打开）。编号取 annotationBadges，与画布虚线框的徽标同一套，两边
            可互相对照；文字/元素名收进 tooltip。点击 = editBadge：选中对应
            元素并弹出就地编辑浮层——删除入口也在浮层里（原卡片的 ✕ 随卡片
            一起退役）。 */}
        <section
          ref={annSectionRef}
          className="relative flex min-w-0 flex-1 flex-col gap-1.5 @max-2xl/editor:flex-none @max-2xl/editor:flex-row @max-2xl/editor:items-center @max-2xl/editor:gap-2.5"
        >
          <div className="flex items-center gap-1.5 @max-2xl/editor:shrink-0">
            <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
              本页标注
            </span>
            {annotationEntries.length > 0 && (
              <span className="grid h-[15px] min-w-[15px] place-items-center rounded-full bg-amber-500/15 px-1 text-[9.5px] font-bold tabular-nums text-amber-600">
                {annotationEntries.length}
              </span>
            )}
          </div>
          {annotationEntries.length === 0 ? (
            <div className="flex h-[26px] items-center text-[11.5px] text-muted-foreground/60">
              暂无标注
            </div>
          ) : (
            <div
              className="flex h-[26px] items-center gap-1.5 overflow-x-auto pb-0.5 @max-2xl/editor:min-w-0 @max-2xl/editor:flex-1"
              onScroll={() => setAnnTip(null)}
            >
              {annotationEntries.map(([eid]) => (
                <button
                  key={eid}
                  type="button"
                  onClick={() => {
                    setAnnTip(null)
                    editBadge(eid)
                  }}
                  onMouseEnter={(e) => {
                    cancelAnnTipClose()
                    const sec = annSectionRef.current
                    if (!sec) return
                    const b = e.currentTarget.getBoundingClientRect()
                    const s = sec.getBoundingClientRect()
                    // 左对齐锚定：卡的左缘 ≈ 钮左缘 - 9px（卡内 12px padding
                    // + 徽标半径，徽标正好落在钮正上方）。不能用「中心点 ±
                    // 最大宽一半」钳制——卡是 w-max，窄卡会被 260px 的假定
                    // 宽度推到钮右侧老远（2026-07-07 实锤）。右缘按最大宽
                    // 保守钳制，超出簇也只是盖到 dock 同面，无剪裁风险。
                    const bLeft = b.left - s.left
                    const left = Math.max(
                      0,
                      Math.min(bLeft - 9, s.width - 260)
                    )
                    setAnnTip({ eid, left })
                  }}
                  onMouseLeave={closeAnnTipSoon}
                  className="grid h-[22px] min-w-[22px] shrink-0 place-items-center rounded-full bg-amber-500 px-1.5 text-[11px] font-bold tabular-nums text-white shadow-sm transition-all hover:bg-amber-600 active:scale-90"
                >
                  {annotationBadges[eid]}
                </button>
              ))}
            </div>
          )}
          {/* hover 提示卡：序号 + 元素名 + 删除 + 标注全文（超 4 行截断）。
              可交互（带删除入口），进出走 160ms 宽限期（见 closeAnnTipSoon
              注释）。标注刚被删时 eid 可能已失效，渲染前再查一次。 */}
          {annTip && annotations[annTip.eid] !== undefined && (
            <div
              className="absolute bottom-[calc(100%+8px)] z-30 w-max max-w-[260px] rounded-[10px] border border-border bg-popover px-3 py-2 shadow-[0_12px_40px_rgba(0,0,0,0.16),0_2px_8px_rgba(0,0,0,0.08)]"
              style={{ left: annTip.left }}
              onMouseEnter={cancelAnnTipClose}
              onMouseLeave={closeAnnTipSoon}
            >
              <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <span className="grid h-[15px] min-w-[15px] place-items-center rounded-full bg-amber-500 px-1 text-[9px] font-bold tabular-nums text-white">
                  {annotationBadges[annTip.eid]}
                </span>
                {friendlyLabel(annTip.eid)}
                <button
                  type="button"
                  onClick={() => {
                    const eid = annTip.eid
                    setAnnTip(null)
                    void removeAnnotation(eid)
                  }}
                  className="ml-auto rounded px-1 py-0.5 text-[10.5px] text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  删除
                </button>
              </div>
              <div className="line-clamp-4 text-[12px] leading-relaxed text-foreground">
                {annotations[annTip.eid]}
              </div>
            </div>
          )}
        </section>

        {/* apply — the single primary action (撤销/退出预览 removed per ask).
            2026-07-07 原型定稿：CTA 穿登录页/账户菜单同款品牌绿渐变（靛蓝
            是外来色，被毙），深端由 --brand 混黑派生，不硬编码第二套绿。
            状态文案收成小圆点行（绿=成功流转，红=失败）。 */}
        <div className="flex w-52 shrink-0 flex-col justify-center gap-1 @max-2xl/editor:w-full">
          {statusMsg && (
            <div className="flex items-center justify-center gap-1.5 text-[10.5px] text-muted-foreground">
              <span
                className={cn(
                  'size-[5px] shrink-0 rounded-full',
                  statusMsg.includes('失败') ? 'bg-red-500' : 'bg-emerald-500'
                )}
              />
              <span className="truncate">{statusMsg}</span>
            </div>
          )}
          <button
            type="button"
            disabled={busy || applyQueued || applyPhase !== 'idle'}
            onClick={() => void applyChanges()}
            className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-[linear-gradient(135deg,hsl(var(--brand)),color-mix(in_srgb,hsl(var(--brand))_85%,#000))] px-3 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_-4px_hsl(var(--brand)/0.55),inset_0_1px_0_rgba(255,255,255,0.22)] transition-all hover:shadow-[0_6px_20px_-4px_hsl(var(--brand)/0.55),inset_0_1px_0_rgba(255,255,255,0.22)] active:scale-[0.98] disabled:opacity-45 disabled:shadow-none disabled:active:scale-100"
          >
            {applyPhase !== 'idle' && !applyQueued ? (
              <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M20 6L9 17l-5-5" /></svg>
            )}
            {applyQueued
              ? '已在队列中'
              : applyPhase !== 'idle'
                ? 'AI 正在修改…'
                : '应用标注到我的 PPT'}
          </button>
          {/* Subline: while an apply turn is queued, tell the user it'll fire
              automatically — so the greyed-out button doesn't read as "broken".
              While the AI is applying (applyPhase busy), explain when it will
              unlock. Otherwise show how many annotations this click writes. */}
          {applyQueued ? (
            <div className="text-center text-[10.5px] text-muted-foreground/70">
              回复完成后会自动应用
            </div>
          ) : applyPhase !== 'idle' ? (
            <div className="text-center text-[10.5px] text-muted-foreground/70">
              修改完成后可再次应用
            </div>
          ) : (
            annotationEntries.length > 0 && (
              <div className="text-center text-[10.5px] tabular-nums text-muted-foreground/70">
                {annotationEntries.length} 条标注将写回幻灯片
              </div>
            )
          )}
        </div>
      </div>

      {/* ── bottom status bar ── */}
      <footer className="flex h-9 shrink-0 items-center gap-2.5 border-t border-border/60 bg-background px-4 text-[11.5px] text-muted-foreground">
        <span className="text-muted-foreground/80">HTML 幻灯片工作区</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 text-muted-foreground/80">
          <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">←</kbd>
          <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">→</kbd>
          <span>切换页</span>
        </div>
      </footer>
    </div>
  )
}

/**
 * ZoomControls
 * ------------
 * Small floating +/−/reset cluster, bottom-right of the stage. Must be a
 * child of TransformWrapper (not a sibling) — useControls() reads its zoom
 * API from context, there's no other way to reach zoomIn/zoomOut/reset from
 * outside the library's own tree.
 */
function ZoomControls(): React.JSX.Element {
  const { zoomIn, zoomOut, resetTransform } = useControls()
  const btnClass =
    'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground'
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/95 p-1 shadow-sm backdrop-blur-sm">
      <button type="button" title="缩小" className={btnClass} onClick={() => zoomOut()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" title="还原" className={btnClass} onClick={() => resetTransform()}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
      </button>
      <button type="button" title="放大" className={btnClass} onClick={() => zoomIn()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
  )
}

/**
 * HighlightOverlay
 * ----------------
 * The Figma-style selection layer, painted from measured element boxes rather
 * than SVG `outline` classes. Covers the SVG host (inset-0, pointer-events-none
 * so it never eats the drag). Draws:
 *   - selected boxes: 1.5px accent border + 4 corner handles, motion-animated
 *     into position so re-selection / geometry shifts glide instead of jump.
 *   - a hover box: a fainter accent border, no handles (a "will select this"
 *     affordance), suppressed when the hovered element is already selected.
 *   - the marquee: the live rubber-band rectangle while dragging.
 *
 * Motion is skipped under prefers-reduced-motion (boxes snap to position).
 */
function HighlightOverlay({
  selected,
  annotated,
  hover,
  marquee,
  reduceMotion,
  onEditBadge
}: {
  selected: OverlayRect[]
  annotated: OverlayRect[]
  hover: OverlayRect | null
  marquee: { x: number; y: number; w: number; h: number } | null
  reduceMotion: boolean
  // Click a number badge → jump to editing THAT element's existing annotation
  // (parent re-selects it + prefills the floating box with its saved text).
  onEditBadge: (elementId: string) => void
}): React.JSX.Element {
  const transition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 700, damping: 40, mass: 0.6 }
  // 序号徽标（①②③…）：琥珀 = 标注身份色（2026-07-07 原型定稿——选中
  // 用品牌绿、已标注用琥珀，两个概念在色彩上彻底分开；dock 序号钮、缩略
  // 图计数徽标同族）。琥珀是固定色不随主题，任何幻灯片配色上都读得出。
  // 挂框左上角外侧，读作 callout 标签而不是画面的一部分。
  //
  // It's an interactive button: the overlay root is pointer-events-none (so it
  // never eats the marquee drag), so the badge re-enables pointer-events on
  // ITSELF to stay clickable — a tooltip'd "编辑标注" affordance. stopPropagation
  // keeps the click off the stage's select/deselect handler underneath.
  const badgeChip = (n: number, id: string): React.JSX.Element => (
    <button
      type="button"
      title="编辑此标注"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onEditBadge(id)
      }}
      className="pointer-events-auto absolute -left-2.5 -top-2.5 grid size-5 cursor-pointer place-items-center rounded-full bg-amber-500 text-[11px] font-semibold tabular-nums text-white shadow-sm ring-2 ring-background transition-transform hover:scale-110 hover:bg-amber-600 active:scale-95"
    >
      {n}
    </button>
  )
  // 选中框四角的 Figma 式手柄（白底 + 品牌绿描边）。纯视觉 affordance，
  // 不承担拖拽（resize 是后续 MODULE 的事）。
  const cornerHandles = (
    <>
      <span className="absolute -left-[4.5px] -top-[4.5px] size-[7px] rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-background" />
      <span className="absolute -right-[4.5px] -top-[4.5px] size-[7px] rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-background" />
      <span className="absolute -bottom-[4.5px] -left-[4.5px] size-[7px] rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-background" />
      <span className="absolute -bottom-[4.5px] -right-[4.5px] size-[7px] rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-background" />
    </>
  )
  // No overflow-hidden on the root: selection boxes + number chips on elements
  // near the card edge must render in full (clipping them was the cut-corner
  // bug). Chips sit a few px OUTSIDE the element box, so any clip crops them.
  // The marquee can also spill slightly past the edge — that reads as normal
  // drag-select behaviour, not a defect.
  return (
    <div className="pointer-events-none absolute inset-0">
      {/* hover box (behind selection) — 品牌绿细线「将选中」提示。
          操作色 2026-07-07 起 = 品牌绿（原型定稿，替换靛蓝）：brand 只分
          亮/暗档、不跟用户主题色走，在任意幻灯片配色上保持一致的编辑器
          身份色。 */}
      {hover && (
        <motion.div
          className="absolute rounded-[3px] border border-[hsl(var(--brand)/0.45)]"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1, left: hover.x, top: hover.y, width: hover.w, height: hover.h }}
          transition={transition}
        />
      )}
      {/* annotated-but-unselected boxes: 琥珀虚线 callout + 序号（与选中的
          绿实线框在色彩上分属两个概念）。 */}
      {annotated.map((r) => (
        <div
          key={`ann-${r.id}`}
          className="absolute rounded-[3px] border border-dashed border-amber-500/70 bg-amber-500/[0.05]"
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        >
          {r.badge !== undefined && badgeChip(r.badge, r.id)}
        </div>
      ))}
      {/* selected boxes: 品牌绿实线框 + 四角手柄（Figma 语言；原先的虚线
          让「选中」和「已标注」难以区分）。已标注元素被选中时序号徽标
          保持可见。 */}
      <AnimatePresence>
        {selected.map((r) => (
          <motion.div
            key={r.id}
            className="absolute rounded-[3px] border-[1.5px] border-[hsl(var(--brand))]"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, left: r.x, top: r.y, width: r.w, height: r.h }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={transition}
          >
            {cornerHandles}
            {r.badge !== undefined && badgeChip(r.badge, r.id)}
          </motion.div>
        ))}
      </AnimatePresence>
      {/* marquee rubber-band */}
      {marquee && marquee.w > 1 && marquee.h > 1 && (
        <div
          className="absolute rounded-[1px] border border-[hsl(var(--brand)/0.7)] bg-[hsl(var(--brand)/0.08)]"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
    </div>
  )
}

/**
 * FloatingInstruction
 * -------------------
 * The on-canvas "describe a change" box that pops up next to the current
 * selection (replacing the old right-panel 修改说明 form). Rendered inside the
 * overlay layer (which is pointer-events-none), so it re-enables pointer events
 * on itself. Positioned in stage-relative px from the selection's union bounds:
 * sits ABOVE the selection, flipping BELOW when there isn't room up top. Enter
 * submits (→ addAnnotation), Shift+Enter adds a newline, Esc dismisses (clears
 * the selection). Auto-focuses on a fresh selection so the user selects → types.
 *
 * Empty `value` while busy still lets 添加 fire nothing — the parent's
 * addAnnotation no-ops on empty text, and the button is disabled to match.
 */
function FloatingInstruction({
  bounds,
  scale,
  visibleBounds,
  count,
  value,
  busy,
  inputRef,
  editingId,
  onChange,
  onSubmit,
  onDismiss,
  onDelete
}: {
  // y = selection's TOP edge, y2 = its BOTTOM edge (stage-relative px). Both are
  // needed so the flip anchors off the correct edge: above → sit over the top;
  // below → sit under the BOTTOM (never over the element).
  bounds: { x: number; y: number; y2: number } | null
  // Live zoom level (scaleRef.current from the wrapper). This box lives inside
  // the same zoomed/panned subtree as HighlightOverlay (see the scaleRef
  // comment ~line 330), so its left/top need to stay in pre-zoom coordinates
  // for the anchor to track the element — but unlike a selection box, this
  // card's own SIZE/font must stay constant on screen regardless of zoom.
  // The counter-scale below (1/scale) undoes the wrapper's transform for just
  // this element, canceling the "input box balloons when you zoom in" bug.
  scale: number
  // Visible viewport window in the same local coords as `bounds` (see
  // visibleLocalBounds' comment at its definition). Used to keep the card's
  // LEFT edge from sliding past the actually-visible part of a zoomed/panned
  // slide — an element selected near the slide's own left edge can, once
  // zoomed in and panned, have that edge sit well outside the viewport, and
  // `bounds.x` alone doesn't know that. Null before the refs it needs have
  // measured anything (first paint) — falls back to the pre-viewport-aware
  // clamp in that case.
  visibleBounds: { left: number; right: number; top: number; bottom: number } | null
  count: number
  value: string
  busy: boolean
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  // 非空 = 正在编辑该元素的既有标注（单选且已有标注）：文案换「编辑
  // 标注」、提交钮换「更新」、左下角露删除入口。
  editingId: string | null
  onChange: (v: string) => void
  onSubmit: () => void
  onDismiss: () => void
  onDelete: (id: string) => void
}): React.JSX.Element | null {
  // Focus the input when a NEW selection appears (bounds goes null → set, or the
  // anchor jumps). Keyed on the rounded top so re-measures (scroll/resize) that
  // don't move the selection won't steal focus back mid-typing.
  const anchorKey = bounds ? `${Math.round(bounds.x)}:${Math.round(bounds.y)}` : null
  useEffect(() => {
    if (anchorKey) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey])

  if (!bounds) return null

  // Anchor left = selection's left edge (clamped ≥ 0 so it never runs off).
  // Vertical: PREFER above the selection's top edge; flip below its BOTTOM edge
  // when there isn't room up top (box height ≈ 96px + gap). The below branch
  // anchors off y2 (bottom), NOT y (top) — anchoring off the top would drop the
  // card straight over the selected element and hide it (the bug being fixed).
  const GAP = 10
  const BOX_H = 128
  const CARD_W = 300 // matches the w-[300px] below
  const above = bounds.y >= BOX_H + GAP
  let left = Math.max(0, bounds.x)
  // Keep the card's left edge inside the part of the slide that's actually
  // visible right now, not just >= the slide's own local x=0. Without this,
  // an element near the (possibly panned-off-screen) left edge of a zoomed
  // slide drags the card off the left of the viewport with it, hiding it
  // behind whatever chrome sits to the left (sidebar etc — the bug this
  // fixes). EDGE_MARGIN is a constant on-screen gap, converted to local units
  // via /scale (same reasoning as the counter-scale below: a raw local value
  // would grow/shrink on screen as zoom changes, but the margin shouldn't).
  if (visibleBounds) {
    const EDGE_MARGIN = 8
    const s = scale || 1
    const marginLocal = EDGE_MARGIN / s
    const cardWLocal = CARD_W / s
    const minLeft = visibleBounds.left + marginLocal
    const maxLeft = visibleBounds.right - cardWLocal - marginLocal
    // Viewport narrower than the card (heavy zoom-in / very narrow panel):
    // prefer keeping the left edge on-screen over fitting the whole width.
    left = maxLeft >= minLeft ? Math.min(Math.max(left, minLeft), maxLeft) : minLeft
  }
  // below 分支用 CSS min() 钳住下缘：选大元素时 y2+GAP 会伸出画布、被
  // dock 裁掉半张卡（2026-07-07 窄屏实锤）。100% 指定位上下文（stage
  // wrap）的高度，浮层最多贴底 4px——盖住选区下沿也比被裁切强。
  const style: React.CSSProperties = above
    ? { left, top: bounds.y - GAP }
    : { left, top: `min(${bounds.y2 + GAP}px, calc(100% - ${BOX_H + 4}px))` }
  // Counter-scale so the card renders at a constant on-screen size no matter
  // how far the stage is zoomed — only its ANCHOR position (left/top above,
  // in pre-zoom stage px) should track the selected element; the card itself
  // is chrome, not content. Split into two nested divs rather than folding
  // both transforms into one `transform` string: the outer div's
  // `transform-origin` must sit at the anchor corner (top-left, since
  // left/top position that corner) so the 1/scale un-zoom doesn't also drag
  // the anchor away from the element, while the `above` case's flip-up still
  // needs a plain, unscaled translateY(-100%) of the card's own rendered
  // height. Composing that into a single `scale(1/s) translateY(-100%)`
  // would scale the translate distance too (wrong offset); nesting keeps the
  // two transforms independent instead of fighting over one origin/order.
  const counterScale = 1 / (scale || 1)

  return (
    <div
      data-floating-input
      // w-[300px] must match the CARD_W constant above (the horizontal
      // viewport clamp needs to know this box's real width to keep it fully
      // on-screen; Tailwind's arbitrary value can't be parameterized by a JS
      // const, so keep the two in sync by hand if this ever changes).
      className="pointer-events-auto absolute z-10 w-[300px] max-w-[calc(100%-8px)]"
      style={{ ...style, transformOrigin: 'top left', transform: `scale(${counterScale})` }}
      // Clicks inside the box must NOT bubble to the stage's select/deselect
      // handlers (that would clear the selection out from under the input). The
      // [data-floating-input] guard in bindDrag covers use-gesture's pointer
      // path; these stop the React onMouseDown deselect on the outer margin.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Card chrome kept neutral (border-border / bg-popover) so it reads as a
          system surface, not a coloured widget. 品牌绿只落在色点 + 提交钮 +
          输入焦点环上（2026-07-07 原型定稿布局：色点标题行 → 输入区 →
          底部动作行）。选中框（HighlightOverlay）同为品牌绿——操作色全链
          统一，靛蓝已退役。

          The `above` flip's translateY(-100%) lives HERE, not on the outer
          positioned div: by this nesting level the parent's counter-scale
          has already normalized the coordinate space to real screen px, so
          "-100%" shifts by exactly this card's own rendered height — doing
          it on the outer div instead would translate in pre-zoom stage px,
          landing the flip-up offset wrong at any zoom level other than 1. */}
      <div
        className="rounded-xl border border-border bg-popover/95 p-2.5 shadow-[0_10px_30px_-6px_rgba(20,30,50,0.22)] ring-1 ring-black/[0.02] backdrop-blur-md"
        style={above ? { transform: 'translateY(-100%)' } : undefined}
      >
        <div className="flex items-center gap-1.5 px-0.5 text-[11.5px] text-muted-foreground">
          <span className="size-2 shrink-0 rounded-[3px] bg-[hsl(var(--brand))]" />
          {editingId ? (
            <span>编辑标注</span>
          ) : (
            <span>
              修改所选{' '}
              <span className="font-semibold tabular-nums text-foreground">{count}</span>{' '}
              个元素
            </span>
          )}
        </div>
        {/* shadcn Textarea. Two deliberate overrides on top of the primitive:
            - bg-background (not the primitive's bg-transparent): the card is
              translucent w/ backdrop-blur, so a transparent input would let
              the selected SVG element show THROUGH the box (the "green block
              behind the input" the user saw). A solid field fixes that.
            - focus ring recoloured from the theme --ring to --brand, to match
              the rest of this card's brand-green identity. */}
        <Textarea
          ref={inputRef}
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!busy && value.trim()) onSubmit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onDismiss()
            }
          }}
          placeholder="描述希望如何修改…"
          className={cn(
            'mt-2 max-h-32 min-h-[38px] resize-none rounded-lg bg-background px-2.5 py-1.5 text-[12px] leading-relaxed shadow-none',
            'focus-visible:border-[hsl(var(--brand)/0.7)] focus-visible:ring-[hsl(var(--brand)/0.25)]'
          )}
        />
        <div className="mt-2 flex items-center gap-1.5">
          {editingId ? (
            <button
              type="button"
              onClick={() => onDelete(editingId)}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              删除标注
            </button>
          ) : (
            <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground/70">
              <kbd className="rounded border border-border px-1 py-px font-mono text-[9.5px] tracking-wide">
                esc
              </kbd>
              取消
            </span>
          )}
          <span className="flex-1" />
          <Button
            type="button"
            size="sm"
            disabled={busy || !value.trim()}
            onClick={onSubmit}
            className={cn(
              'h-7 gap-1.5 rounded-full bg-[hsl(var(--brand))] px-3 text-[12px] font-medium text-[hsl(var(--brand-foreground))] shadow-[0_2px_8px_-1px_hsl(var(--brand)/0.5)]',
              'hover:bg-[hsl(var(--brand))] hover:brightness-110 active:scale-95',
              'disabled:bg-muted disabled:text-muted-foreground/50 disabled:shadow-none'
            )}
          >
            {editingId ? '更新' : '添加标注'}
            <kbd className="rounded border border-current/35 bg-current/10 px-1 font-mono text-[9px]">
              ↵
            </kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * 空态「幻灯片显影」动画 — live-preview server 已就绪、第一页还没生成时的
 * 等待画面（原型:docs/preview-empty-state.html，用户选定「显影」变体）。
 *
 * 视觉语言与画布卡片一致：点阵展台（中心聚焦渐隐）上浮一叠 16:9 幽灵卡；
 * 主卡内是骨架内容（错峰微光），accent 扫描线周期性自上而下「显影」，
 * 描边彗星沿卡缘巡游，稀疏的生成尘埃自卡片下沿上浮。所有颜色走主题
 * token（hsl(var(--accent)) 等），换肤与深浅色自动跟随；动画类在
 * assets/main.css 的 pes- 段，reduced-motion 那里统一冻结。
 *
 * 尘埃参数（位置/时长/相位）用 useMemo 固定 —— 每次渲染重掷随机数会让
 * 微粒跳位，动画看起来像在闪。
 */
function PreviewEmptyState({ hint }: { hint: string }): React.JSX.Element {
  const sparkles = useMemo(
    () =>
      Array.from({ length: 12 }, () => ({
        left: 6 + Math.random() * 88,
        top: 55 + Math.random() * 50,
        dur: 3.4 + Math.random() * 3.2,
        delay: Math.random() * 6,
        peak: 0.35 + Math.random() * 0.4
      })),
    []
  )
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-11 overflow-hidden">
      {/* 点阵展台：点层 → 四周渐隐罩 → accent 环境光，三层都不挡交互 */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, hsl(var(--foreground) / 0.13) 1px, transparent 1.2px)',
          backgroundSize: '24px 24px',
          backgroundPosition: 'center'
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 62% 55% at 50% 44%, transparent 32%, hsl(var(--background)) 78%)'
        }}
      />
      <div
        aria-hidden
        className="pes-ambient absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 40% 34% at 50% 42%, hsl(var(--accent) / 0.10), transparent 70%)'
        }}
      />

      {/* 幽灵卡组（16:9） */}
      <div className="relative z-[1] h-[169px] w-[300px]">
        <div className="pes-ghost-b absolute inset-0 rounded-[10px] border border-border/70 bg-card opacity-40 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]" />
        <div className="pes-ghost-a absolute inset-0 rounded-[10px] border border-border/70 bg-card opacity-60 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]" />
        <div className="pes-bob absolute inset-0 flex flex-col gap-2.5 overflow-hidden rounded-[10px] border border-border/70 bg-card px-5 py-[18px] shadow-[0_1px_2px_rgba(0,0,0,0.05),0_12px_32px_-8px_rgba(0,0,0,0.16)]">
          <div className="pes-sk h-4 w-[58%]" />
          <div className="pes-sk flex-1" style={{ animationDelay: '.35s' }} />
          <div className="pes-sk h-2 w-[86%]" style={{ animationDelay: '.6s' }} />
          <div className="pes-sk h-2 w-[64%]" style={{ animationDelay: '.75s' }} />
          <div aria-hidden className="pes-scan" />
          <svg
            aria-hidden
            className="pes-comet pointer-events-none absolute -inset-px"
            viewBox="0 0 300 169"
            preserveAspectRatio="none"
          >
            <rect x="1" y="1" width="298" height="167" rx="10" />
          </svg>
        </div>
        {sparkles.map((s, i) => (
          <span
            key={i}
            aria-hidden
            className="pes-sparkle"
            style={
              {
                left: `${s.left}%`,
                top: `${s.top}%`,
                '--pes-dur': `${s.dur.toFixed(2)}s`,
                '--pes-delay': `${s.delay.toFixed(2)}s`,
                '--pes-peak': s.peak.toFixed(2)
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {/* 状态文案：呼吸圆点复用 tab busy dot 的 ping 语言 */}
      <div className="relative z-[1] flex flex-col items-center gap-[7px] text-center">
        <div className="flex items-center gap-2">
          <span aria-hidden className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
          </span>
          <div className="text-[14px] font-medium text-foreground">实时预览已就绪</div>
        </div>
        <div className="text-[13px] text-muted-foreground">{hint}</div>
      </div>
    </div>
  )
}
