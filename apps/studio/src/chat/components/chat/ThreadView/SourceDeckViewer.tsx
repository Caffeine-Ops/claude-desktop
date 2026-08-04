/**
 * 「预览幻灯片」tab 在源 PPT / template-fill 成品场景下的内容体：用户首条消息带了
 * 一个已有的 .pptx 路径（改/美化一份既有 deck），在 ppt-creator 还没产出任何
 * svg_output/ 页面之前，先把这份源文件本身转成可视预览摆出来——PPT_SOURCE_PREVIEW
 * IPC 离线跑技能自带的 pptx_to_svg.py（不起任何常驻服务，一次性转换，结果按
 * (路径, mtime) 缓存在磁盘），返回每页原始 SVG 文本；这里做 href 改写（相对
 * `../assets/*` → `pptasset://`，复用 live-preview 同一套 rewriteAssetHrefs）后
 * **内联注入**大图。
 *
 * Executor 写出 svg_output/ 后 LivePreviewEditor 就绪的瞬间，SlidesWorkspace
 * 会切走这个组件——两者互斥，从不同时挂载（见该文件的 tab 内容分支）。
 *
 * 双职组件：`variant` 决定文案。'source'（默认）= 用户带来的原稿，改动前的参考图。
 * 'exported' = ppt-creator template-fill 工作流 apply 成功后落盘的成品 .pptx
 * （见 stores/chat.ts 的 useExportedPptx）——数据链路完全同一条 PPT_SOURCE_PREVIEW，
 * 只是这次喂给它的是导出文件而不是源文件。
 *
 * ── 元素级标注（2026-07-27）─────────────────────────────────────────────
 * 成品预览过去是纯静态 `<img>`，于是 template-fill 这条工作流**根本无法标注**：
 * 标注交互整套只长在 LivePreviewEditor 上，而它读的是项目的 svg_output/，
 * template-fill 从头到尾不产 SVG（产物只有一个 .pptx），showSlidesTab 恒 false，
 * 永远落到本组件的只读分支。
 *
 * 现在成品预览的交互与 live-preview 对齐：点选 / 框选多个 / ⌘ 加选 / ⌥ 选父级 /
 * 空格平移 / 滚轮缩放 / 浮层写标注 / dock 汇总 / 应用。靠的是两条 id 同源：
 * pptx_to_svg 产出的 `<g id="shape-N">` 与 template-fill 的 slot_id
 * （`s{源页:02d}_sh{N}`）里的 N **都取自 OOXML 的 `p:cNvPr/@id`**
 * （`pptx_to_svg/shape_walker.py` ↔ `template_fill_pptx/ooxml.py`），克隆成成品后
 * 也原样保留。配合 IPC 顺带回传的 fill_plan（成品页序 → 源页码），选中的任意元素
 * 都能精确还原成 AI 认识的 slot_id。实测 16/16 页命中。
 *
 * 四个刻意的取舍：
 * - **标注不落盘**，只活在下面这个 module store 里。LivePreviewEditor 的标注要写进
 *   svg_output/ 的 SVG 文件（AI 回头去读那些文件），而这里的预览 SVG 是 userData
 *   缓存里的一次性产物——写进去下次重转就没了，AI 也不会去读那个目录。所以标注的
 *   归宿是「汇总成一条带 slot_id 的指令发给 AI」，AI 改 fill_plan.json 再 re-apply，
 *   零新增落盘契约。
 * - **一条标注记一组元素**（`elementIds: string[]`）而不是每个元素各记一条：多选一次
 *   写的是一句共享指令，拆成 N 条会让 dock 铺开一整排重复徽标（live-preview 那边
 *   2026-07-18 踩过并改成了聚合视图，这里直接按聚合存，省掉同一个坑）。
 * - **大图统一内联 SVG**（连 'source' 也是），而不是给两个 variant 分两套渲染。
 *   `<img>` 里的 SVG 是一张不透明的图，DOM 里没有子元素，elementFromPoint 命中不到
 *   任何 `<g>`——要点选就必须内联。两条渲染路径只会让 bug 各长一半。
 * - 没有 fill_plan（用户随手拖进来的源 deck、别的工作流产物）时**自动退回只读**：
 *   映射不出 slot_id 的标注对 AI 毫无意义，不如不给。
 *
 * 覆盖层坐标系与 live-preview 有意不同：那边用屏幕 px + 每次 transform 后重量（它的
 * 框选拿的是屏幕坐标），这里用**相对舞台的百分比**——覆盖层与 SVG 同在缩放子树内，
 * 放大缩小时百分比不变，选中框/徽标天然贴着元素走，不必重算。只有浮层卡片需要反缩放
 * 保持固定屏幕尺寸。
 */
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useComposerRuntime } from '@assistant-ui/react'
import { useDrag } from '@use-gesture/react'
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch'

import { Button } from '@/src/components/ui/button'
import { Textarea } from '@/src/components/ui/textarea'
import { cn } from '@/src/lib/utils'
import type { PptFillPlan } from '@desktop-shared/ipc-channels'
import { PPT_STAGE_ZOOM_PROPS, ZoomControls, useSpacePanning } from '../PptStageZoom'
import { rewriteAssetHrefs } from '../../../lib/pptPreview/slidePipeline'
import { useChatStore } from '../../../stores/chat'
import { useMessageQueueStore } from '../../../stores/messageQueue'

/**
 * 发送给 AI 的指令首行。同 LivePreviewEditor 的 APPLY_ANNOTATION_TEXT 一样，抽成
 * 常量是因为它同时用于「发出去的文本」和「队列去重比对」，两处一旦漂移，去重就会
 * 静默失效、把同一批标注排两遍。这里的正文带 slot_id 明细，所以去重比对首行即可。
 */
const APPLY_HEADLINE = '应用我的标注（模板填充成品）'

/** 浮层卡片的固定屏幕高度（rounded-xl 卡 ≈ 128px）+ 与选区的间隙。 */
const CARD_H = 128
const CARD_GAP = 10

/** 框选命中测试要跳过的非绘制标签（同 live-preview 的 SKIP_TAGS）。 */
const SKIP_TAGS = ['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'mask', 'symbol']

/** 一条标注：一组元素共享一句指令。 */
type DeckAnnotation = { id: string; page: number; elementIds: string[]; text: string }

/**
 * 标注 store —— 按 .pptx 路径分格。
 *
 * 为什么是 module store 而不是组件 state：用户在「预览幻灯片 / 大纲 / 文件 / 图片」
 * 几个 tab 之间切来切去时本组件会卸载，标注是用户手打的内容，不能因为看了一眼别的
 * tab 就没了。按 pptxPath 分格则天然隔离不同成品（apply 一次换一个带时间戳的新文件名，
 * 旧标注不会串到新成品上）。
 */
const useDeckAnnotationStore = create<{
  byPptx: Record<string, DeckAnnotation[]>
  upsert: (pptx: string, a: DeckAnnotation) => void
  remove: (pptx: string, id: string) => void
  clear: (pptx: string) => void
}>((set) => ({
  byPptx: {},
  upsert: (pptx, a) =>
    set((s) => {
      const cur = s.byPptx[pptx] ?? []
      const i = cur.findIndex((x) => x.id === a.id)
      const next = i >= 0 ? cur.map((x) => (x.id === a.id ? a : x)) : [...cur, a]
      return { byPptx: { ...s.byPptx, [pptx]: next } }
    }),
  remove: (pptx, id) =>
    set((s) => {
      const cur = s.byPptx[pptx]
      if (!cur) return s
      return { byPptx: { ...s.byPptx, [pptx]: cur.filter((x) => x.id !== id) } }
    }),
  clear: (pptx) =>
    set((s) => {
      if (!s.byPptx[pptx]) return s
      const { [pptx]: _dropped, ...rest } = s.byPptx
      return { byPptx: rest }
    })
}))

type Slide = { url: string; svg: string }

type ViewerState =
  | { status: 'loading' }
  | { status: 'ready'; slides: Slide[]; fillPlan?: PptFillPlan }
  | { status: 'error'; message: string }

type Variant = 'source' | 'exported'

/**
 * 覆盖层几何——相对舞台的百分比（见文件头注释的坐标系说明）。`hostH` 是量这一下时
 * 舞台的像素高度，只服务于浮层「上方放不放得下」的判断：卡片高度是固定的屏幕 px，
 * 得有个长度单位才能和百分比比较。
 */
type Box = { left: number; top: number; width: number; height: number; hostH: number }

/** 已标注元素在当前页上的角标位置（同一条标注的每个成员都挂同一个序号）。 */
type Mark = { annotationId: string; elementId: string; index: number; box: Box }

const VARIANT_COPY: Record<
  Variant,
  { loading: string; caption: string; thumbAria: string; errorBody: (msg: string) => string }
> = {
  source: {
    loading: '正在生成原稿预览…',
    caption: '原稿预览（未修改）',
    thumbAria: '原稿',
    errorBody: (msg) => `原稿暂时无法预览（${msg}）。AI 处理完成后将在此处展示幻灯片。`
  },
  exported: {
    loading: '正在生成成品预览…',
    caption: '成品预览（模板填充导出）',
    thumbAria: '成品',
    errorBody: (msg) => `成品暂时无法预览（${msg}）。可直接打开导出的 .pptx 文件查看。`
  }
}

/** `<g id="shape-7">` / `<g id="layout-shape-4">` → 7 / 4；其它 id 一律不认。 */
function shapeNumOf(elementId: string): string | null {
  const m = /^(?:layout-)?shape-(\d+)/.exec(elementId)
  return m ? m[1]! : null
}

/** 元素相对舞台的百分比包围盒。 */
function boxOf(el: Element, host: HTMLElement): Box | null {
  const h = host.getBoundingClientRect()
  if (h.width <= 0 || h.height <= 0) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 && r.height <= 0) return null
  return {
    left: ((r.left - h.left) / h.width) * 100,
    top: ((r.top - h.top) / h.height) * 100,
    width: (r.width / h.width) * 100,
    height: (r.height / h.height) * 100,
    hostH: h.height
  }
}

/** 多个盒子的并集——多选时浮层锚在整组的包围盒上。 */
function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  let l = Infinity
  let t = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const x of boxes) {
    l = Math.min(l, x.left)
    t = Math.min(t, x.top)
    r = Math.max(r, x.left + x.width)
    b = Math.max(b, x.top + x.height)
  }
  return { left: l, top: t, width: r - l, height: b - t, hostH: boxes[0]!.hostH }
}

/**
 * 命中点 → 可选元素 id。
 *
 * 默认取**最内层**的 `g[id]`（pptx_to_svg 的可选单位全是 g）；⌥ 再往上一层，用来选
 * 中「组合」这类父级分组。与 live-preview 的 resolvePickedId 语义一致（那边默认
 * `[id]`、⌥ 才 `g[id]`，是因为它的 svg_output 结构里带 id 的可能直接是 rect/text；
 * 这里 SVG 形状不同，但对用户而言「⌥ = 往上选一层」是同一件事）。
 */
function resolvePickedId(target: Element, opts: { alt: boolean }): string | null {
  if (target.closest('defs, style, title, desc')) return null
  const g = target.closest('g[id]')
  if (!g) return null
  if (!opts.alt) return g.getAttribute('id')
  const parent = g.parentElement?.closest('g[id]')
  return (parent ?? g).getAttribute('id')
}

export function SourceDeckViewer({
  pptxPath,
  variant = 'source'
}: {
  pptxPath: string
  variant?: Variant
}): React.JSX.Element {
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  const [selected, setSelected] = useState(0)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [selBoxes, setSelBoxes] = useState<Box[]>([])
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [statusMsg, setStatusMsg] = useState('')
  // 当前缩放倍率——只用于把浮层反缩放回固定屏幕尺寸；选中框/徽标是百分比，不需要它。
  const [scale, setScale] = useState(1)
  const scaleRef = useRef(1)
  const hostRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const copy = VARIANT_COPY[variant]
  const composerRuntime = useComposerRuntime()
  const spacePanning = useSpacePanning()

  const annotations = useDeckAnnotationStore((s) => s.byPptx[pptxPath])
  const upsertAnnotation = useDeckAnnotationStore((s) => s.upsert)
  const removeAnnotation = useDeckAnnotationStore((s) => s.remove)
  const clearAnnotations = useDeckAnnotationStore((s) => s.clear)

  const fillPlan = state.status === 'ready' ? state.fillPlan : undefined
  // 能标注的前提：这是 template-fill 成品，且拿得到成品页 → 源页的映射。缺任一条，
  // 选中的元素就换不出 AI 认识的 slot_id，标注只会变成一句 AI 无从下手的空话。
  const canAnnotate = variant === 'exported' && !!fillPlan

  useEffect(() => {
    let cancelled = false
    // Collected so the cleanup below can revoke every blob: URL this run
    // created — otherwise each source-preview open leaks the deck's worth
    // of SVG blobs for the life of the renderer process.
    const blobUrls: string[] = []
    setState({ status: 'loading' })
    setSelected(0)
    setSelectedIds([])
    void window.chatApi
      .previewPptSource({ pptxPath })
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setState({ status: 'error', message: res.error })
          return
        }
        const slides = res.slides.map((s) => {
          const rewritten = rewriteAssetHrefs(s.content, res.outDir)
          const url = URL.createObjectURL(new Blob([rewritten], { type: 'image/svg+xml' }))
          blobUrls.push(url)
          return { url, svg: rewritten }
        })
        setState({ status: 'ready', slides, fillPlan: res.fillPlan })
      })
      .catch((err) => {
        if (cancelled) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
      blobUrls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [pptxPath])

  // 换页：清掉选中态（选中框属于上一页的几何，留着会画在错的位置上）。
  useEffect(() => {
    setSelectedIds([])
    setEditingId(null)
    setDraft('')
  }, [selected])

  const slotIdFor = useCallback(
    (elementId: string, pageIndex: number = selected): string | null => {
      const n = shapeNumOf(elementId)
      if (n == null || !fillPlan) return null
      const src = fillPlan.slides[pageIndex]?.source_slide
      if (!src || src <= 0) return null
      return `s${String(src).padStart(2, '0')}_sh${n}`
    },
    [fillPlan, selected]
  )

  /** 当前页的标注（一条一组）。 */
  const pageAnnotations = useMemo(
    () => (annotations ?? []).filter((a) => a.page === selected),
    [annotations, selected]
  )

  // 覆盖层几何：SVG 注入后 / 选中变化 / 标注增删 / 换页 / 缩放后重量。放 effect 里而
  // 不是渲染期算，是因为必须等内联 SVG 真的进了 DOM 才量得到 bbox。
  useEffect(() => {
    const host = hostRef.current
    if (!host || !canAnnotate) {
      setMarks([])
      setSelBoxes([])
      return
    }
    const qs = (id: string): Element | null => host.querySelector(`#${CSS.escape(id)}`)
    const nextMarks: Mark[] = []
    ;(annotations ?? []).forEach((a, i) => {
      if (a.page !== selected) return
      for (const eid of a.elementIds) {
        const el = qs(eid)
        if (!el) continue
        const box = boxOf(el, host)
        if (box) nextMarks.push({ annotationId: a.id, elementId: eid, index: i + 1, box })
      }
    })
    setMarks(nextMarks)
    const boxes: Box[] = []
    for (const id of selectedIds) {
      const el = qs(id)
      if (!el) continue
      const b = boxOf(el, host)
      if (b) boxes.push(b)
    }
    setSelBoxes(boxes)
  }, [annotations, selected, selectedIds, canAnnotate, state, scale])

  /** 单点选中（tap 分支）。 */
  const pickAt = useCallback(
    (clientX: number, clientY: number, mods: { alt: boolean; additive: boolean }) => {
      const host = hostRef.current
      if (!host) return
      const target = document.elementFromPoint(clientX, clientY)
      if (!target || !host.contains(target)) return
      const id = resolvePickedId(target, { alt: mods.alt })
      if (!id) {
        if (!mods.additive) {
          setSelectedIds([])
          setEditingId(null)
          setDraft('')
        }
        return
      }
      if (!slotIdFor(id)) {
        setStatusMsg('这个元素不是可替换的文本框，换一个试试')
        return
      }
      setStatusMsg('')
      setSelectedIds((prev) => {
        if (mods.additive) {
          return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        }
        return [id]
      })
      if (!mods.additive) {
        // 落在唯一一个已标注元素上 = 编辑它（与点徽标一致）；否则开一条新的。
        const hit = pageAnnotations.find((a) => a.elementIds.includes(id))
        setEditingId(hit?.id ?? null)
        setDraft(hit?.text ?? '')
      }
      window.setTimeout(() => noteRef.current?.focus(), 0)
    },
    [slotIdFor, pageAnnotations]
  )

  // ── 框选（拖拽）+ 点选（tap），走 @use-gesture ──────────────────────────
  // filterTaps 把 <4px 位移判成 tap（单选 / ⌘ 加选 / ⌥ 选父级），更大的位移才是
  // 橡皮筋框选。命中测试放在拖拽**结束**时一次做完，而不是每帧扫一遍全页元素。
  const bindDrag = useDrag(
    ({ first, last, tap, initial: [ix, iy], xy: [cx, cy], event }) => {
      const host = hostRef.current
      if (!host || !canAnnotate) return
      // 起手落在浮层输入框里的手势直接放行：它挂在舞台内（位置要跟着选区走），
      // 但在里面按下鼠标绝不能被当成「点了非元素区域 → 清空选中」，那会把正在输入的
      // 框从用户手底下抽走。React 的 stopPropagation 拦不住 use-gesture 的 pointer
      // 通道，只能在这里按真实 target 判。
      const gestureTarget = event?.target as Element | null
      if (gestureTarget?.closest?.('[data-floating-input]')) return
      const me = event as MouseEvent | undefined
      const mods = {
        alt: me?.altKey ?? false,
        additive: (me?.ctrlKey ?? false) || (me?.metaKey ?? false)
      }
      if (tap) {
        pickAt(cx, cy, mods)
        return
      }
      // 框选矩形画在缩放子树内的 div 上，所以要换算成舞台本地坐标（除以当前倍率），
      // 否则一旦放大，橡皮筋就会偏离鼠标实际划过的路径。
      const base = host.getBoundingClientRect()
      const s = scaleRef.current || 1
      const toHost = (px: number, py: number): { x: number; y: number } => ({
        x: (px - base.left) / s,
        y: (py - base.top) / s
      })
      const a = toHost(ix, iy)
      const b = toHost(cx, cy)
      const box = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x),
        h: Math.abs(a.y - b.y)
      }
      if (first) setMarquee(box)
      if (last) {
        setMarquee(null)
        // 命中测试在屏幕坐标里做（getBoundingClientRect 本来就是屏幕空间），
        // 与框选矩形的本地坐标各算各的，互不换算。
        const mx1 = Math.min(ix, cx)
        const my1 = Math.min(iy, cy)
        const mx2 = Math.max(ix, cx)
        const my2 = Math.max(iy, cy)
        const hits: string[] = []
        host.querySelectorAll<SVGGraphicsElement>('g[id]').forEach((el) => {
          const tag = el.tagName.toLowerCase()
          if (SKIP_TAGS.indexOf(tag) !== -1) return
          const id = el.getAttribute('id')
          if (!id || !slotIdFor(id)) return
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return
          if (r.left < mx2 && r.right > mx1 && r.top < my2 && r.bottom > my1) hits.push(id)
        })
        // 框到嵌套组时父子会一起命中，留最内层的那个（父级用 ⌥ 单选拿）——否则
        // 一个「组合」会把它内部每个成员都算进选区，slot_id 列表里全是重复的祖先。
        const inner = hits.filter(
          (id) =>
            !hits.some((other) => {
              if (other === id) return false
              const a2 = host.querySelector(`#${CSS.escape(id)}`)
              const b2 = host.querySelector(`#${CSS.escape(other)}`)
              return !!a2 && !!b2 && a2.contains(b2)
            })
        )
        setSelectedIds((prev) => {
          if (mods.additive) {
            const set = new Set(prev)
            inner.forEach((h) => set.add(h))
            return Array.from(set)
          }
          return inner
        })
        if (!mods.additive) {
          setEditingId(null)
          setDraft('')
        }
        if (inner.length > 0) window.setTimeout(() => noteRef.current?.focus(), 0)
        return
      }
      setMarquee(box)
    },
    // 按住空格时整个手势让位给平移。
    { filterTaps: true, threshold: 4, pointer: { touch: true }, enabled: !spacePanning && canAnnotate }
  )

  const saveDraft = useCallback(() => {
    const text = draft.trim()
    if (!text || selectedIds.length === 0) return
    upsertAnnotation(pptxPath, {
      id: editingId ?? `${selected}:${selectedIds.join(',')}`,
      page: selected,
      elementIds: selectedIds,
      text
    })
    setSelectedIds([])
    setEditingId(null)
    setDraft('')
  }, [draft, selectedIds, editingId, pptxPath, selected, upsertAnnotation])

  const annotationList = useMemo(() => annotations ?? [], [annotations])

  /** 点徽标 / dock 芯片 → 回到那组元素继续编辑。 */
  const editAnnotation = useCallback(
    (a: DeckAnnotation) => {
      if (a.page !== selected) setSelected(a.page)
      setStatusMsg('')
      setSelectedIds(a.elementIds)
      setEditingId(a.id)
      setDraft(a.text)
      window.setTimeout(() => noteRef.current?.focus(), 0)
    },
    [selected]
  )

  // 选区并集：浮层锚在整组的包围盒上（单选时就是那个元素自己）。
  const anchor = useMemo(() => unionBox(selBoxes), [selBoxes])

  // 浮层放上方还是下方：上方装得下就放上方（不遮挡元素），否则翻到选区**下沿**。
  // 判断必须用像素而不是百分比阈值——选中整页那种元素时 top≈0、height≈100%，
  // 百分比阈值会把卡片甩到 top:100%（画布外，被 dock 吃掉半张，2026-07-27 用户实锤）。
  const anchorTopPx = anchor ? (anchor.top / 100) * anchor.hostH : 0
  const cardAbove = !!anchor && anchorTopPx >= CARD_H + CARD_GAP
  // 下沿分支再用 CSS min() 钳一道：整页元素的下沿就是舞台下沿，+GAP 会伸出画布。
  // 100% 指舞台高度，浮层最多贴底 4px——盖住选区下沿也比被裁掉强（同 live-preview）。
  const cardStyle: React.CSSProperties = anchor
    ? {
        // 左缘同样钳进舞台内：靠右的元素会把 300px 宽的卡片顶出去。
        left: `clamp(0px, ${anchor.left}%, calc(100% - 308px))`,
        top: cardAbove
          ? `calc(${anchor.top}% - ${CARD_GAP}px)`
          : `min(calc(${anchor.top + anchor.height}% + ${CARD_GAP}px), calc(100% - ${CARD_H + 4}px))`,
        // 卡片是 chrome 不是内容：舞台放大时它得保持原尺寸，否则一放大就变成巨型输入框。
        // transformOrigin 钉在锚点角（left/top 定位的就是这个角），免得反缩放把锚点也拽走。
        transformOrigin: 'top left',
        transform: `scale(${1 / (scale || 1)})`
      }
    : {}

  const applyAnnotations = useCallback(() => {
    if (annotationList.length === 0) {
      setStatusMsg('还没有标注')
      return
    }
    const sid = useChatStore.getState().sessionId
    // 队列去重，与 LivePreviewEditor 同款：读 LIVE 队列（getState 而不是渲染期快照），
    // 让抢在重渲染之前的连点也塞不进第二条。
    const dup =
      !!sid &&
      (useMessageQueueStore.getState().queues[sid] ?? []).some((q) =>
        q.text.startsWith(APPLY_HEADLINE)
      )
    if (dup) {
      setStatusMsg('已在队列中，无需重复添加')
      return
    }
    const lines = annotationList.map((a) => {
      const slots = a.elementIds
        .map((eid) => slotIdFor(eid, a.page) ?? eid)
        .map((s) => `\`${s}\``)
        .join('、')
      return `- 成品第 ${a.page + 1} 页 · ${slots}\n  → ${a.text}`
    })
    const body = [
      `${APPLY_HEADLINE}：`,
      '',
      ...lines,
      '',
      '请据此修改 `analysis/fill_plan.json` 里对应页的 replacements（按 slot_id 精确匹配），',
      '然后重新运行 template_fill_pptx 的 apply 重新导出成品。'
    ].join('\n')
    const willQueue = useChatStore.getState().streaming
    composerRuntime.setText(body)
    composerRuntime.send()
    clearAnnotations(pptxPath)
    setSelectedIds([])
    setEditingId(null)
    setDraft('')
    setStatusMsg(willQueue ? '会话进行中，已加入队列' : '已发送，AI 正在修改')
  }, [annotationList, slotIdFor, composerRuntime, clearAnnotations, pptxPath])

  if (state.status === 'loading') {
    return (
      <div className="grid flex-1 place-items-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <span className="size-5 animate-spin rounded-full border-2 border-[hsl(var(--brand)/0.25)] border-t-[hsl(var(--brand))]" />
          <span className="text-[13px]">{copy.loading}</span>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <div className="text-[14px] font-medium text-foreground">预览准备中</div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {copy.errorBody(state.message)}
          </div>
        </div>
      </div>
    )
  }

  const current = state.slides[selected]

  return (
    <div className="flex min-h-0 flex-1">
      {/* 缩略列 —— 与 ReplaySlidesViewer 同款布局，纯静态无揭示动画。缩略图不需要
          交互，继续用 blob:<img>，省掉几十份内联 SVG 的解析开销。 */}
      <div className="flex w-[132px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-border/40 p-3">
        {state.slides.map((s, i) => {
          const count = annotationList.filter((a) => a.page === i).length
          return (
            <button
              key={s.url}
              type="button"
              onClick={() => setSelected(i)}
              aria-label={`${copy.thumbAria}第 ${i + 1} 页`}
              className={
                'relative shrink-0 overflow-hidden rounded-md border bg-white transition-[border-color,box-shadow] ' +
                (i === selected
                  ? 'border-[hsl(var(--brand))] shadow-[0_0_0_1px_hsl(var(--brand))]'
                  : 'border-border/60 hover:border-border')
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.url} alt="" className="aspect-video w-full object-contain" />
              <span className="absolute left-1 top-1 rounded bg-black/45 px-1 text-[9px] tabular-nums text-white">
                {String(i + 1).padStart(2, '0')}
              </span>
              {count > 0 && (
                <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-amber-500 text-[9px] font-bold tabular-nums text-white">
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* 大图 + 页标题行 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-baseline gap-2 px-6 pt-4">
          <span className="text-[13px] font-semibold tabular-nums text-muted-foreground">
            {String(selected + 1).padStart(2, '0')}
          </span>
          <span className="truncate text-[12px] text-muted-foreground">{copy.caption}</span>
        </div>

        <div
          className={cn(
            'relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-6 pt-3',
            spacePanning && 'cursor-grab'
          )}
        >
          {/* 舞台底部的静态操作提示，与 live-preview 的同款提示行一致。 */}
          {canAnnotate && (
            <div className="pointer-events-none absolute bottom-1.5 left-0 z-10 flex w-full flex-wrap items-center justify-center gap-1.5 text-[11.5px] text-muted-foreground/70">
              点击元素选择 · 拖拽框选多个 ·
              <kbd className="grid h-[17px] min-w-[17px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">⌘</kbd>
              加选 ·
              <kbd className="grid h-[17px] min-w-[17px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">⌥</kbd>
              选父级 · 按住
              <kbd className="grid h-[17px] min-w-[17px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">空格</kbd>
              拖拽平移 · 滚轮缩放
            </div>
          )}
          {current && (
            <TransformWrapper
              {...PPT_STAGE_ZOOM_PROPS}
              // 左键拖拽留给框选，平移只在按住空格时——与 live-preview 同一套肌肉记忆，
              // 两边的 enabled 互斥（bindDrag 的 `enabled: !spacePanning`）。
              panning={{ disabled: !spacePanning, velocityDisabled: true }}
              onTransform={(_ref, s) => {
                scaleRef.current = s.scale
                setScale(s.scale)
              }}
            >
              <ZoomControls />
              <TransformComponent
                wrapperClass="!w-full !h-full"
                contentClass="!w-full !h-full flex items-center justify-center"
              >
                <div className="relative max-h-full max-w-full" {...(canAnnotate ? bindDrag() : {})}>
                  <div
                    ref={hostRef}
                    // 内联 SVG 是元素级点选的前提（`<img>` 里的 SVG 在 DOM 里没有子节点）。
                    // 内容来自本地 pptx_to_svg 的离线转换产物 + rewriteAssetHrefs，与
                    // LivePreviewEditor 注入 svg_output 的做法同源。
                    dangerouslySetInnerHTML={{ __html: current.svg }}
                    className={cn(
                      'max-h-full max-w-full overflow-hidden rounded-lg border border-border/50 bg-white shadow-sm [&>svg]:block [&>svg]:h-auto [&>svg]:max-h-full [&>svg]:w-full',
                      canAnnotate && 'cursor-crosshair select-none',
                      spacePanning && 'cursor-grab'
                    )}
                  />
                  {/* 覆盖层：已标注徽标 + 选中框 + 框选橡皮筋。整层 pointer-events-none，
                      免得挡住下面的手势；徽标自己再把 pointer-events 开回来（同
                      LivePreviewEditor 的 HighlightOverlay 做法）。
                      配色分工照搬 live-preview 并且必须保持一致：**选中用品牌绿、
                      已标注用琥珀**，两个概念在色彩上彻底分开；琥珀是固定色不随主题，
                      任何幻灯片配色上都读得出。 */}
                  {canAnnotate && (
                    <div className="pointer-events-none absolute inset-0">
                      {marks.map((m) => (
                        <span
                          key={`${m.annotationId}:${m.elementId}`}
                          className="absolute"
                          style={{
                            left: `${m.box.left}%`,
                            top: `${m.box.top}%`,
                            width: `${m.box.width}%`,
                            height: `${m.box.height}%`
                          }}
                        >
                          <span className="absolute inset-0 rounded-[2px] border border-amber-500/50" />
                          <button
                            type="button"
                            title="编辑此标注"
                            data-slot="deck-annotation-badge"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation()
                              const a = (annotations ?? []).find((x) => x.id === m.annotationId)
                              if (a) editAnnotation(a)
                            }}
                            className="pointer-events-auto absolute -left-2.5 -top-2.5 grid size-5 cursor-pointer place-items-center rounded-full bg-amber-500 text-[11px] font-semibold tabular-nums text-white shadow-sm ring-2 ring-background transition-transform hover:scale-110 hover:bg-amber-600 active:scale-95"
                          >
                            {m.index}
                          </button>
                        </span>
                      ))}

                      {selBoxes.map((b, i) => (
                        <span
                          key={`sel-${i}`}
                          className="absolute rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-[hsl(var(--brand)/0.06)]"
                          style={{
                            left: `${b.left}%`,
                            top: `${b.top}%`,
                            width: `${b.width}%`,
                            height: `${b.height}%`
                          }}
                        >
                          {/* 四角 Figma 式手柄（白底 + 品牌绿描边）。纯视觉 affordance，
                              与 live-preview 的选中框逐像素同款。多选时每个成员都画。 */}
                          <span className="absolute -left-[4.5px] -top-[4.5px] size-[7px] rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-background" />
                          <span className="absolute -right-[4.5px] -top-[4.5px] size-[7px] rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-background" />
                          <span className="absolute -bottom-[4.5px] -left-[4.5px] size-[7px] rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-background" />
                          <span className="absolute -bottom-[4.5px] -right-[4.5px] size-[7px] rounded-[2px] border-[1.5px] border-[hsl(var(--brand))] bg-background" />
                        </span>
                      ))}

                      {/* 框选橡皮筋：本地坐标 px（与 toHost 换算一致）。 */}
                      {marquee && (
                        <span
                          className="absolute rounded-[2px] border border-[hsl(var(--brand))] bg-[hsl(var(--brand)/0.1)]"
                          style={{
                            left: marquee.x,
                            top: marquee.y,
                            width: marquee.w,
                            height: marquee.h
                          }}
                        />
                      )}

                      {/* 浮动指令卡：贴着选区，而不是缩在页面底部——这是 live-preview
                          的核心手感（改哪儿就在哪儿写）。样式与 FloatingInstruction 同款：
                          中性卡面 + 品牌绿只落在色点/焦点环/提交钮上。 */}
                      {anchor && (
                        <div
                          data-floating-input
                          className="pointer-events-auto absolute z-10 w-[300px] max-w-[calc(100%-8px)]"
                          style={cardStyle}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* 上翻的 translateY(-100%) 挂在内层：外层已经把坐标系反缩放回
                              真实屏幕 px，这里的 -100% 才正好是卡片自己的渲染高度；挂外层
                              会连位移距离一起被缩放，任何非 1 的倍率下都会偏。 */}
                          <div
                            className="rounded-xl border border-border bg-popover/95 p-2.5 shadow-[0_10px_30px_-6px_rgba(20,30,50,0.22)] ring-1 ring-black/[0.02] backdrop-blur-md"
                            style={cardAbove ? { transform: 'translateY(-100%)' } : undefined}
                          >
                            <div className="flex items-center gap-1.5 px-0.5 text-[11.5px] text-muted-foreground">
                              <span className="size-2 shrink-0 rounded-[3px] bg-[hsl(var(--brand))]" />
                              {editingId ? (
                                <span>编辑标注</span>
                              ) : (
                                <span>
                                  修改所选{' '}
                                  <span className="font-semibold tabular-nums text-foreground">
                                    {selectedIds.length}
                                  </span>{' '}
                                  个元素
                                </span>
                              )}
                            </div>
                            <Textarea
                              ref={noteRef}
                              rows={2}
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault()
                                  if (draft.trim()) saveDraft()
                                } else if (e.key === 'Escape') {
                                  e.preventDefault()
                                  setSelectedIds([])
                                  setEditingId(null)
                                  setDraft('')
                                }
                              }}
                              placeholder="描述希望如何修改…"
                              data-slot="deck-annotation-input"
                              className={cn(
                                'mt-2 max-h-32 min-h-[38px] resize-none rounded-lg bg-background px-2.5 py-1.5 text-[12px] leading-relaxed shadow-none',
                                'focus-visible:border-[hsl(var(--brand)/0.7)] focus-visible:ring-[hsl(var(--brand)/0.25)]'
                              )}
                            />
                            <div className="mt-2 flex items-center gap-1.5">
                              {editingId ? (
                                <button
                                  type="button"
                                  data-slot="deck-annotation-remove"
                                  onClick={() => {
                                    removeAnnotation(pptxPath, editingId)
                                    setSelectedIds([])
                                    setEditingId(null)
                                    setDraft('')
                                  }}
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
                                data-slot="deck-annotation-save"
                                disabled={!draft.trim()}
                                onClick={saveDraft}
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
                      )}
                    </div>
                  )}
                </div>
              </TransformComponent>
            </TransformWrapper>
          )}
        </div>

        {/* ── bottom dock：已选 + 本页标注 + 应用。三簇布局、留白分区、毛玻璃底，
            与 LivePreviewEditor 的 dock 同一套视觉（那边的定稿理由见其注释：
            竖线分隔读作表格、已选簇定宽 260px 防止选中/取消时整条 dock 左右抖）。
            两处 dock 必须保持一致——用户在同一个「预览幻灯片」tab 里会在 SVG 项目
            与 template-fill 成品之间来回切，dock 长得不一样会读作两个功能。 ── */}
        {canAnnotate && (
          <div className="flex min-h-[62px] shrink-0 items-center gap-5 border-t border-border/60 bg-background/65 px-4 py-2.5 backdrop-blur-xl backdrop-saturate-150">
            {/* 已选元素 */}
            <section className="flex w-[260px] shrink-0 flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
                  已选元素
                </span>
                {selectedIds.length > 0 && (
                  <>
                    <span className="grid h-[15px] min-w-[15px] place-items-center rounded-full bg-[hsl(var(--brand)/0.12)] px-1 text-[9.5px] font-bold tabular-nums text-[hsl(var(--brand))]">
                      {selectedIds.length}
                    </span>
                    <button
                      type="button"
                      data-slot="deck-annotation-clear"
                      onClick={() => {
                        setSelectedIds([])
                        setEditingId(null)
                        setDraft('')
                      }}
                      className="rounded px-1 text-[10.5px] text-muted-foreground/70 transition-colors hover:bg-hover hover:text-foreground"
                    >
                      清空
                    </button>
                  </>
                )}
              </div>
              {/* 定高单行 + 溢出横滚：芯片折行会让 dock 纵向无上限、把舞台挤没
                  （live-preview 2026-07-07 窄屏实锤）。 */}
              <div className="flex h-[26px] w-full min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {selectedIds.length === 0 ? (
                  <span className="text-[11.5px] text-muted-foreground/60">
                    在画布上点击元素开始标注
                  </span>
                ) : (
                  selectedIds.map((id) => (
                    <span
                      key={id}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[hsl(var(--brand)/0.1)] py-1 pl-2 pr-1 text-[11px] font-medium text-[color-mix(in_srgb,hsl(var(--brand))_82%,#000)] ring-1 ring-inset ring-[hsl(var(--brand)/0.3)] dark:text-[hsl(var(--brand))]"
                      title={id}
                    >
                      <span className="max-w-[120px] truncate">{slotIdFor(id) ?? id}</span>
                      <button
                        type="button"
                        data-slot="deck-annotation-deselect"
                        onClick={() => setSelectedIds((prev) => prev.filter((x) => x !== id))}
                        className="grid size-3.5 place-items-center rounded-sm text-current/70 transition-colors hover:bg-black/10 hover:text-current"
                        aria-label="取消选中"
                      >
                        ✕
                      </button>
                    </span>
                  ))
                )}
              </div>
            </section>

            {/* 本页标注 */}
            <section className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
                  本页标注
                </span>
                {pageAnnotations.length > 0 && (
                  <span className="grid h-[15px] min-w-[15px] place-items-center rounded-full bg-amber-500/15 px-1 text-[9.5px] font-bold tabular-nums text-amber-600 dark:text-amber-400">
                    {pageAnnotations.length}
                  </span>
                )}
              </div>
              <div className="flex h-[26px] min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {pageAnnotations.length === 0 ? (
                  <span className="text-[11.5px] text-muted-foreground/60">暂无标注</span>
                ) : (
                  pageAnnotations.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      data-slot="deck-annotation-goto"
                      title={a.text}
                      onClick={() => editAnnotation(a)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 py-1 pl-1 pr-2 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-500/30 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
                    >
                      <span className="grid size-[15px] shrink-0 place-items-center rounded-full bg-amber-500 text-[9px] font-bold tabular-nums text-white">
                        {annotationList.indexOf(a) + 1}
                      </span>
                      {a.elementIds.length > 1 && (
                        <span className="shrink-0 tabular-nums opacity-70">
                          ×{a.elementIds.length}
                        </span>
                      )}
                      <span className="max-w-[160px] truncate">{a.text}</span>
                    </button>
                  ))
                )}
              </div>
            </section>

            {/* 应用 */}
            <section className="flex w-[220px] shrink-0 flex-col gap-1">
              <button
                type="button"
                data-slot="deck-annotation-apply"
                disabled={annotationList.length === 0}
                onClick={applyAnnotations}
                className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-[linear-gradient(135deg,hsl(var(--brand)),color-mix(in_srgb,hsl(var(--brand))_85%,#000))] px-3 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_-4px_hsl(var(--brand)/0.55),inset_0_1px_0_rgba(255,255,255,0.22)] transition-all hover:shadow-[0_6px_20px_-4px_hsl(var(--brand)/0.55),inset_0_1px_0_rgba(255,255,255,0.22)] active:scale-[0.98] disabled:opacity-45 disabled:shadow-none disabled:active:scale-100"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                应用标注到我的 PPT
              </button>
              <div className="truncate text-center text-[10.5px] text-muted-foreground/70">
                {statusMsg || (annotationList.length > 0 ? `共 ${annotationList.length} 条标注` : '')}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
