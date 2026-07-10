import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { FolderOpen, Maximize2, Plus, X } from 'lucide-react'

import { useI18n } from '../../../i18n'
import { useChatStore } from '../../../stores/chat'
import {
  IMAGE_EDIT_MARKER,
  useImageEditStore,
  type ImageEditMeta
} from '../../../stores/filePreview'
import { dispatchChatTurn } from '../../../lib/dispatchChatTurn'
import { Button } from '@/src/components/ui/button'

/* ─────────────── 图片标记编辑面板（右栏） ─────────────── */

/**
 * 标记式改图面板（2026-07-09，对齐用户给的 Gemini/Whisk 式参照图）：
 *
 *   点成果卡片里的图片 → useImageEditStore.openEditor(path) → ThreadView
 *   分栏 → 本面板 readImageFile 读原图显示 → 用户在图上点选落编号标记、
 *   逐点填「描述改动」，可再添加素材图（融合）与全图级额外要求 → 发送。
 *
 * 发送走 dispatchChatTurn：display 是 [[image-edit]] 协议短卡片（见
 * UserMessage 的 ImageEditCard），CLI 文本是完整编辑指令——标记坐标以
 * 图内百分比表述，让 agent 翻译成画面区域后调 imagegen skill 的 edit
 * 子命令。API 本身没有坐标概念（prompt-guided），百分比 + 区域描述是
 * v1 的定位手段；蒙版精确定位留待后续（前端 canvas 生成 alpha PNG）。
 *
 * 布局与表格预览面板同构：chat 列收窄成 rail 在左、本面板 flex-1 在右；
 * 两面板经 store 交叉互斥（见 stores/filePreview.ts）。
 */

/** 一个标记：点选或框选。id 只在面板内自增。
 *  点：x/y 为圆心（0~100 百分比，原点左上），w/h 不存在。
 *  框：x/y 为框左上角，w/h 为框宽高百分比（拖拽产生，见 onImageMouseDown）。 */
type Marker = {
  id: number
  x: number
  y: number
  w?: number
  h?: number
  note: string
}

/** 拖拽预览态：起点固定、终点跟随鼠标（都是百分比）。null = 没在拖。 */
type DragRect = { x0: number; y0: number; x1: number; y1: number }

/** 融合素材：绝对路径 + 缩略 dataUrl（FileReader 本地读，不走 IPC）。 */
type FusionImage = {
  path: string
  name: string
  thumb: string
}

/**
 * 把编号标记「烧」进原图，产出标记示意图（jpeg dataUrl）随消息附给 agent。
 *
 * 为什么：视觉模型的坐标算术不可靠——2026-07-09 实测，密集布局（一列三个
 * 头像）下 agent 拿 (83.6%, 56.7%) 去推算位置，把第一位嘉宾认成了第三位。
 * 但「看图上编号圈指着谁」是它的强项。所以定位以这张烧录图为准，百分比
 * 坐标降级为次要参考。任一步失败返回 null，发送降级为纯文本坐标模式。
 */
function renderAnnotatedImage(
  dataUrl: string,
  edits: { x: number; y: number; w?: number; h?: number }[]
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const w = img.naturalWidth
        const h = img.naturalHeight
        if (!w || !h) {
          resolve(null)
          return
        }
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0)
        // 圈/徽章尺寸随原图分辨率缩放（短边 2.2%，下限 14px），缩图后仍清晰。
        const r = Math.max(14, Math.round(Math.min(w, h) * 0.022))
        const drawBadge = (cx: number, cy: number, label: string): void => {
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(17,17,17,0.95)'
          ctx.fill()
          ctx.lineWidth = Math.max(2, Math.round(r * 0.18))
          ctx.strokeStyle = '#ffffff'
          ctx.stroke()
          ctx.fillStyle = '#ffffff'
          ctx.font = `bold ${Math.round(r * 1.1)}px -apple-system, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(label, cx, cy)
        }
        edits.forEach((m, i) => {
          if (m.w !== undefined && m.h !== undefined) {
            // 框：先黑粗后白细的双描边矩形（白线带黑边，任何底色可见），
            // 编号徽章骑左上角——与面板 UI 完全同构，agent 看到即所标。
            const bx = (m.x / 100) * w
            const by = (m.y / 100) * h
            const bw = (m.w / 100) * w
            const bh = (m.h / 100) * h
            ctx.lineWidth = Math.max(5, Math.round(r * 0.34))
            ctx.strokeStyle = 'rgba(17,17,17,0.85)'
            ctx.strokeRect(bx, by, bw, bh)
            ctx.lineWidth = Math.max(2.5, Math.round(r * 0.18))
            ctx.strokeStyle = '#ffffff'
            ctx.strokeRect(bx, by, bw, bh)
            drawBadge(bx, by, String(i + 1))
          } else {
            drawBadge((m.x / 100) * w, (m.y / 100) * h, String(i + 1))
          }
        })
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

export function ImageEditPanel(): React.JSX.Element | null {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  const path = useImageEditStore((s) => s.path)
  const closeEditor = useImageEditStore((s) => s.closeEditor)
  const streaming = useChatStore((s) => s.streaming)

  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [markers, setMarkers] = useState<Marker[]>([])
  /** 正在编辑描述的标记 id；null = 没有输入条浮出。 */
  const [activeId, setActiveId] = useState<number | null>(null)
  /** 输入条草稿（提交时写回 marker.note）。 */
  const [draft, setDraft] = useState('')
  const [extra, setExtra] = useState('')
  const [fusion, setFusion] = useState<FusionImage[]>([])
  /** 拖拽框选的实时预览矩形。 */
  const [drag, setDrag] = useState<DragRect | null>(null)
  /** 画布视图：zoom 缩放倍率（1=适配），x/y 平移像素。transform 承担缩放，
   *  布局尺寸不变，故 getBoundingClientRect 换算百分比坐标天然正确。 */
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  /** 空格按住（平移模式）。ref 供事件闭包同步读，state 驱动 cursor。 */
  const [spaceDown, setSpaceDown] = useState(false)
  const [panning, setPanning] = useState(false)
  const spaceRef = useRef(false)
  const nextId = useRef(1)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  // 换图（或首开）即整体重置：标记/草稿/素材/视图都属于上一张图。
  useEffect(() => {
    setDataUrl(null)
    setLoadErr(null)
    setMarkers([])
    setActiveId(null)
    setDraft('')
    setExtra('')
    setFusion([])
    setView({ zoom: 1, x: 0, y: 0 })
    nextId.current = 1
    if (!path) return
    let cancelled = false
    void window.chatApi
      .readImageFile({ absPath: path })
      .then((r) => {
        if (cancelled) return
        if (r.ok && r.dataUrl) setDataUrl(r.dataUrl)
        else setLoadErr(zh ? '图片读取失败' : 'Failed to read image')
      })
      .catch(() => {
        if (!cancelled) setLoadErr(zh ? '图片读取失败' : 'Failed to read image')
      })
    return () => {
      cancelled = true
    }
    // zh 只影响错误文案，不值得为它重读文件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // 空格 = 平移模式。跳过输入场景（浮条/额外编辑/composer 的 contentEditable
  // 里按空格是打字）；窗口失焦补一次复位，防 keyup 丢失后卡在平移模式。
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      )
        return
      e.preventDefault()
      spaceRef.current = true
      setSpaceDown(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      setSpaceDown(false)
    }
    const blur = (): void => {
      spaceRef.current = false
      setSpaceDown(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // 滚轮 / 触控板 pinch 缩放，以光标为锚点。必须原生非 passive 挂载——
  // React 的 onWheel 是 passive 的，preventDefault 拦不住容器滚动。
  // pinch 手势浏览器报成 ctrlKey+wheel，deltaY 小而密，灵敏度单独调高。
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      // 光标相对视口中心（content 布局中心恒在视口中心，flex 居中且缩放
      // 走 transform 不改布局）。
      const sx = e.clientX - rect.left - rect.width / 2
      const sy = e.clientY - rect.top - rect.height / 2
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022))
      setView((v) => {
        const nz = Math.min(8, Math.max(0.5, v.zoom * factor))
        const k = nz / v.zoom
        // 保持光标下的内容点不动：s = x + p·z 不变 ⇒ x' = s − (s − x)·k
        return { zoom: nz, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // stageRef 的宿主节点随 path 非空稳定存在；path 变化时重挂保险。
  }, [path])

  if (path === null) return null
  const name = path.split('/').pop() ?? path

  const resetView = (): void => setView({ zoom: 1, x: 0, y: 0 })
  const viewMoved = view.zoom !== 1 || view.x !== 0 || view.y !== 0

  /** 空格按住时在图区任意处拖拽平移画布。 */
  const onStagePanStart = (e: React.MouseEvent): void => {
    if (!spaceRef.current || e.button !== 0) return
    e.preventDefault()
    setPanning(true)
    const startX = e.clientX
    const startY = e.clientY
    const base = view
    const onMove = (ev: MouseEvent): void => {
      setView({
        zoom: base.zoom,
        x: base.x + (ev.clientX - startX),
        y: base.y + (ev.clientY - startY)
      })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setPanning(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 把当前草稿写回 active 标记；空草稿视为放弃 → 删掉该标记（点错了）。 */
  const commitDraft = (): void => {
    if (activeId === null) return
    const text = draft.trim()
    setMarkers((ms) =>
      text
        ? ms.map((m) => (m.id === activeId ? { ...m, note: text } : m))
        : ms.filter((m) => m.id !== activeId || m.note !== '')
    )
    setActiveId(null)
    setDraft('')
  }

  /** 鼠标事件 → 图内百分比坐标（clamp 到 0~100，拖出图外也能收尾）。 */
  const toPercent = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = imgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const clamp = (v: number): number => Math.max(0, Math.min(100, v))
    return {
      x: Math.round(clamp(((clientX - rect.left) / rect.width) * 100) * 10) / 10,
      y: Math.round(clamp(((clientY - rect.top) / rect.height) * 100) * 10) / 10
    }
  }

  /** 单击落点 / 拖拽框选，mouseup 时按位移阈值二选一（1.2% ≈ 1024px 图上
   *  12px，手抖不至于误触发框）。move/up 挂 window：拖出图外仍能跟踪收尾。 */
  const onImageMouseDown = (e: React.MouseEvent<HTMLImageElement>): void => {
    if (e.button !== 0) return
    // 空格按住 = 平移模式：不落标记，事件冒泡给 stage 的 pan 处理。
    if (spaceRef.current) return
    // 先落定上一个未提交的草稿，再开始新标记——连续操作不丢已输入内容。
    commitDraft()
    const start = toPercent(e.clientX, e.clientY)
    setDrag({ x0: start.x, y0: start.y, x1: start.x, y1: start.y })
    const onMove = (ev: MouseEvent): void => {
      const p = toPercent(ev.clientX, ev.clientY)
      setDrag({ x0: start.x, y0: start.y, x1: p.x, y1: p.y })
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDrag(null)
      const end = toPercent(ev.clientX, ev.clientY)
      const w = Math.round(Math.abs(end.x - start.x) * 10) / 10
      const h = Math.round(Math.abs(end.y - start.y) * 10) / 10
      const id = nextId.current++
      if (w < 1.2 && h < 1.2) {
        setMarkers((ms) => [...ms, { id, x: start.x, y: start.y, note: '' }])
      } else {
        setMarkers((ms) => [
          ...ms,
          {
            id,
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            w,
            h,
            note: ''
          }
        ])
      }
      setActiveId(id)
      setDraft('')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const openMarker = (m: Marker): void => {
    commitDraft()
    setActiveId(m.id)
    setDraft(m.note)
  }

  const removeMarker = (id: number): void => {
    setMarkers((ms) => ms.filter((m) => m.id !== id))
    if (activeId === id) {
      setActiveId(null)
      setDraft('')
    }
  }

  const addFusionFiles = (files: FileList | null): void => {
    if (!files) return
    for (const file of Array.from(files)) {
      const abs = window.chatApi.pathForFile(file)
      if (!abs) continue // 合成/blob File 拿不到盘上路径，融合需要真实文件
      const reader = new FileReader()
      reader.onload = () => {
        const thumb = typeof reader.result === 'string' ? reader.result : ''
        setFusion((fs) =>
          fs.some((f) => f.path === abs)
            ? fs
            : [...fs, { path: abs, name: file.name, thumb }]
        )
      }
      reader.readAsDataURL(file)
    }
  }

  // 已成文的标记数（发送按钮可用性与「N 条评论」计数都看它）。
  const noted = markers.filter((m) => m.note.trim() !== '')
  const draftCounts = activeId !== null && draft.trim() !== ''
  const canSend =
    !streaming &&
    (noted.length > 0 || draftCounts || extra.trim() !== '' || fusion.length > 0)

  const send = async (): Promise<void> => {
    // 面板里可能还挂着未提交的草稿——发送前先落定（参考图的交互：输入完
    // 直接点发送是主路径，不该要求先按 Enter）。
    let edits = markers
    if (activeId !== null) {
      const text = draft.trim()
      edits = text
        ? markers.map((m) => (m.id === activeId ? { ...m, note: text } : m))
        : markers.filter((m) => m.id !== activeId || m.note !== '')
      setMarkers(edits)
      setActiveId(null)
      setDraft('')
    }
    const finalEdits = edits.filter((m) => m.note.trim() !== '')
    const { sessionId, streaming: busy } = useChatStore.getState()
    if (busy || !sessionId) return
    if (finalEdits.length === 0 && extra.trim() === '' && fusion.length === 0)
      return

    const meta: ImageEditMeta = {
      name,
      path,
      edits: finalEdits.map((m) => ({
        x: m.x,
        y: m.y,
        ...(m.w !== undefined && m.h !== undefined ? { w: m.w, h: m.h } : {}),
        note: m.note
      })),
      extra: extra.trim(),
      fusion: fusion.map((f) => f.path)
    }
    const markerLine = IMAGE_EDIT_MARKER + JSON.stringify(meta)

    // 标记示意图：编号圈烧进原图随消息附上。agent 以圈辨位（视觉强项），
    // 不再做坐标推算（视觉弱项，实测会认错对象）。生成失败则降级纯文本。
    const annotated =
      dataUrl && finalEdits.length > 0
        ? await renderAnnotatedImage(dataUrl, finalEdits)
        : null

    const lines: string[] = [
      zh
        ? `用 edit 子命令编辑这张图片，在原图基础上改，不要重新生成整图：`
        : `Edit this image with the edit subcommand, modifying the original rather than regenerating:`,
      (zh
        ? '原图（编辑时用这份，不带任何标记）：'
        : 'Original image (use THIS file for the edit; it has no markers): ') +
        path
    ]
    if (finalEdits.length > 0) {
      lines.push(
        annotated
          ? zh
            ? '随本消息附了一张「标记示意图」：就是原图，只是叠加了编号标记——圆圈是点选（指某个物体），矩形框是框选（框住的整个区域就是编辑范围）。请直接看这张图辨认每个编号落在/框住什么人物/物体/区域——以图上标记为准，不要用坐标数值去推算（括号里的百分比坐标仅作核对参考）。各编号的修改要求：'
            : 'A marked-up copy of the image is attached: numbered circles mark points, numbered rectangles mark regions (the box IS the edit boundary). Identify what each marker lands on / encloses BY LOOKING AT IT — do not derive positions from coordinates (percentages in parentheses are secondary reference only). Edits per marker:'
          : zh
            ? '标记修改（x/y 是图内百分比坐标，原点在左上角；带宽高的是框选区域；请先辨认每个位置落在画面中的什么物体/区域，再据此描述改动位置）：'
            : 'Marked edits (x/y are percentages within the image, origin top-left; entries with w/h are box selections; identify what each lands on, then describe the change by that region):'
      )
      finalEdits.forEach((m, i) => {
        const loc =
          m.w !== undefined && m.h !== undefined
            ? zh
              ? `（框选区域：左上 x ${m.x}%, y ${m.y}%，宽 ${m.w}%，高 ${m.h}%）`
              : ` (box: top-left x ${m.x}%, y ${m.y}%, width ${m.w}%, height ${m.h}%)`
            : zh
              ? `（参考坐标 x ${m.x}%, y ${m.y}%）`
              : ` (reference point x ${m.x}%, y ${m.y}%)`
        lines.push(`${i + 1}. ${m.note}${loc}`)
      })
    }
    if (extra.trim() !== '') {
      lines.push((zh ? '额外要求：' : 'Additional request: ') + extra.trim())
    }
    if (fusion.length > 0) {
      lines.push(
        zh
          ? '融合素材图（作为额外的 --image 输入与原图合成）：'
          : 'Fusion source images (pass as extra --image inputs to composite):'
      )
      for (const f of fusion) lines.push(`- ${f.path}`)
    }
    lines.push(
      zh
        ? '未标记区域尽量保持不变，人物身份与整体构图不得走样。完成后展示结果图片的保存路径。'
        : 'Keep unmarked regions unchanged and preserve identity/composition. Show the output path when done.'
    )

    // slash 领跑强制触发 imagegen skill（只有消息开头的 slash 会被 fusion-code
    // 识别；此前只在正文里"请用 imagegen 技能"靠 agent 自觉，会被跳过）。
    // marker 紧随其后——parseImageEditMessage 已兼容 slash 前缀，历史恢复
    // （transcript 存 CLI 侧文本）照样卡片化。气泡 display 保持纯 marker。
    const cliText = `/claude-desktop:imagegen ${markerLine}\n${lines.join('\n')}`
    const display = markerLine
    closeEditor()
    await dispatchChatTurn({
      sessionId,
      storeContent: [{ type: 'text', text: display }],
      logTag: '[image-edit]',
      payload: {
        sessionId,
        text: cliText,
        // 标记示意图走 vision block：agent 直接「看」编号圈落在谁身上。
        ...(annotated
          ? {
              images: [
                {
                  dataUrl: annotated,
                  filename: 'marked-' + name.replace(/\.\w+$/, '.jpg')
                }
              ]
            }
          : {})
      }
    })
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      {/* 顶栏：文件名 + 关闭。样式对齐表格预览面板的壳。窗口拖拽由根
          layout 的 .window-drag-strip 统一负责（46px），本栏 h-12 与之
          重叠，本栏不声明 drag；末尾按钮组要显式 no-drag 在 strip 上
          挖洞（同 SpreadsheetPreviewPanel 顶栏纪律）——漏挖会被 macOS
          当窗口拖拽区截走点击，reset-view/关闭钮点不动。 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">
          {name}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {zh
            ? '点选 / 拖拽框选 · 滚轮缩放 · 空格拖移'
            : 'Click / drag to mark · scroll to zoom · space to pan'}
        </span>
        <span className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
          {/* 视图偏离适配态时显示当前倍率，点击一键复位（与下面恒显的
              「适应窗口」钮同一个 resetView，只是这个 chip 顺带报百分比）。 */}
          {viewMoved ? (
            <button
              type="button"
              onClick={resetView}
              title={zh ? '重置视图' : 'Reset view'}
              className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground transition-colors hover:border-input hover:text-foreground"
            >
              {Math.round(view.zoom * 100)}%
            </button>
          ) : null}
          {/* 适应窗口：恒显（2026-07-10 用户要求不依赖百分比 chip 间接
              触发的明确入口）。zoom 已在 100% 时点击是无害 no-op。 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={resetView}
            aria-label={zh ? '适应窗口' : 'Fit to window'}
            title={zh ? '适应窗口' : 'Fit to window'}
          >
            <Maximize2 className="size-4" />
          </Button>
          {/* 在文件夹中显示：与 ImagesPanel 的 ImageLightbox 同款能力，
              走同一个 SHELL_REVEAL_PATH IPC。 */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => void window.chatApi.revealPath({ absPath: path })}
            aria-label={zh ? '在 Finder 中显示' : 'Reveal in Finder'}
            title={zh ? '在 Finder 中显示' : 'Reveal in Finder'}
          >
            <FolderOpen className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={closeEditor}
            aria-label={zh ? '关闭' : 'Close'}
          >
            <X className="size-4" />
          </Button>
        </span>
      </div>

      {/* 图区：居中铺图，滚轮/pinch 缩放（wheel 原生挂 stageRef）、空格拖拽
          平移。overflow-hidden——超界内容由 zoom/pan 掌管，不走滚动条。 */}
      <div
        ref={stageRef}
        onMouseDown={onStagePanStart}
        className={
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6 ' +
          (spaceDown ? (panning ? 'cursor-grabbing' : 'cursor-grab') : '')
        }
      >
        {loadErr ? (
          <div className="text-[13px] text-muted-foreground">{loadErr}</div>
        ) : dataUrl === null ? (
          <div className="text-[13px] text-muted-foreground">
            {zh ? '加载中…' : 'Loading…'}
          </div>
        ) : (
          <div
            className="relative inline-block max-h-full max-w-full"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
            }}
          >
            {/* 单击落点、拖拽框选（阈值二选一见 onImageMouseDown）。 */}
            <img
              ref={imgRef}
              src={dataUrl}
              alt={name}
              draggable={false}
              onMouseDown={onImageMouseDown}
              className="block max-h-[calc(100vh-220px)] max-w-full cursor-crosshair select-none rounded-lg"
            />
            {/* 拖拽中的实时预览框（虚线），松手落定为正式框标记。 */}
            {drag ? (
              <div
                className="pointer-events-none absolute rounded-[3px] border-dashed border-white shadow-[0_0_0_1px_rgba(17,17,17,0.55)]"
                style={{
                  left: `${Math.min(drag.x0, drag.x1)}%`,
                  top: `${Math.min(drag.y0, drag.y1)}%`,
                  width: `${Math.abs(drag.x1 - drag.x0)}%`,
                  height: `${Math.abs(drag.y1 - drag.y0)}%`,
                  borderWidth: `${2 / view.zoom}px`
                }}
              />
            ) : null}
            {markers.map((m) => {
              const active = m.id === activeId
              // 输入条落点：标记偏右下（参考图观感）；标记太靠右时翻到左侧，
              // 避免输入条溢出图外被裁。
              const flipLeft = m.x > 55
              // ── 框选标记 ──
              if (m.w !== undefined && m.h !== undefined) {
                return (
                  // 容器即矩形区域。pointer-events 全关（别挡住底下图片的
                  // 再次点选/框选），只有编号徽章与浮条恢复可点。
                  <div
                    key={m.id}
                    className="absolute"
                    style={{
                      left: `${m.x}%`,
                      top: `${m.y}%`,
                      width: `${m.w}%`,
                      height: `${m.h}%`
                    }}
                  >
                    {/* 矩形本体：白描边 + 内外黑晕，任何底色上都可见。描边宽
                        随 1/zoom 补偿——矩形跟画布缩放（区域语义），线宽不跟。 */}
                    <div
                      className="pointer-events-none absolute inset-0 rounded-[3px] border-solid border-white shadow-[0_0_0_1.5px_rgba(17,17,17,0.6),inset_0_0_0_1px_rgba(17,17,17,0.35)]"
                      style={{ borderWidth: `${2 / view.zoom}px` }}
                    />
                    {/* 编号徽章骑在框左上角。translate 在 wrapper 上，motion
                        只管缩放（transform 分层，理由同点标记）。 */}
                    <span
                      className="group/marker absolute left-0 top-0"
                      style={{
                        transform: `translate(-50%, -50%) scale(${1 / view.zoom})`
                      }}
                    >
                      <motion.button
                        type="button"
                        initial={{ scale: 0.4, opacity: 0 }}
                        animate={{ scale: active ? 1.12 : 1, opacity: 1 }}
                        whileHover={{ scale: 1.12 }}
                        transition={{ type: 'spring', stiffness: 520, damping: 26 }}
                        onClick={(e) => {
                          e.stopPropagation()
                          openMarker(m)
                        }}
                        className="grid size-[26px] place-items-center rounded-full border-2 border-white bg-black text-[11.5px] font-bold tabular-nums text-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
                      >
                        {markers.indexOf(m) + 1}
                      </motion.button>
                      {!active && m.note ? (
                        <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 max-w-64 -translate-x-1/2 truncate rounded-lg bg-black/90 px-2.5 py-1 text-[12px] text-white opacity-0 transition-opacity duration-150 group-hover/marker:opacity-100">
                          {m.note}
                        </span>
                      ) : null}
                    </span>
                    {active ? (
                      <div
                        className={
                          'absolute top-0 z-10 ' +
                          (flipLeft ? 'right-[calc(100%+12px)]' : 'left-[22px]')
                        }
                        style={{
                          transform: `translateY(-50%) scale(${1 / view.zoom})`,
                          transformOrigin: flipLeft ? 'right center' : 'left center'
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <motion.div
                          initial={{ opacity: 0, scale: 0.96 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.16, ease: 'easeOut' }}
                          className="flex w-72 items-center gap-1 rounded-full bg-white py-1.5 pl-4 pr-2 shadow-[0_4px_20px_rgba(0,0,0,0.25)]"
                        >
                          <input
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitDraft()
                              if (e.key === 'Escape') removeMarker(m.id)
                            }}
                            placeholder={zh ? '描述改动' : 'Describe the change'}
                            className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-900 outline-none placeholder:text-neutral-400"
                          />
                          <button
                            type="button"
                            onClick={commitDraft}
                            aria-label={zh ? '确认' : 'Confirm'}
                            className="grid size-6 shrink-0 place-items-center rounded-full bg-brand text-white transition-[filter] hover:brightness-110"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M12 19V5M5 12l7-7 7 7" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => removeMarker(m.id)}
                            aria-label={zh ? '删除标记' : 'Remove marker'}
                            className="grid size-6 shrink-0 place-items-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200"
                          >
                            <X className="size-3.5" />
                          </button>
                        </motion.div>
                      </div>
                    ) : null}
                  </div>
                )
              }
              // ── 点标记 ──
              return (
                // 锚点承载 -50% 平移（圆心对准坐标点）+ 1/zoom 反缩放（画布
                // 放大时圈与浮条保持屏幕尺寸）；弹跳动画交给 motion 管内层
                // transform——分层放两个元素，否则互相覆盖（原型稿验证过）。
                <div
                  key={m.id}
                  className="group/marker absolute"
                  style={{
                    left: `${m.x}%`,
                    top: `${m.y}%`,
                    transform: `translate(-50%, -50%) scale(${1 / view.zoom})`
                  }}
                >
                  {/* 编号圈：黑底白字（参考图样式），落点弹跳入场。点击重开编辑。 */}
                  <motion.button
                    type="button"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: active ? 1.12 : 1, opacity: 1 }}
                    whileHover={{ scale: 1.12 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 26 }}
                    onClick={(e) => {
                      e.stopPropagation()
                      openMarker(m)
                    }}
                    className="grid size-[26px] place-items-center rounded-full border-2 border-white bg-black text-[11.5px] font-bold tabular-nums text-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
                  >
                    {markers.indexOf(m) + 1}
                  </motion.button>
                  {/* 已确认标记 hover 浮出描述（自绘黑签，原生 title 延迟太长且样式不可控） */}
                  {!active && m.note ? (
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 max-w-64 -translate-x-1/2 truncate rounded-lg bg-black/90 px-2.5 py-1 text-[12px] text-white opacity-0 transition-opacity duration-150 group-hover/marker:opacity-100">
                      {m.note}
                    </span>
                  ) : null}
                  {active ? (
                    // 外层管定位（对齐圆心、左右翻转），内层 motion 管弹出——
                    // 同样是为了让 motion 的 transform 不打架 CSS translate。
                    <div
                      className={
                        'absolute top-1/2 z-10 -translate-y-1/2 ' +
                        (flipLeft ? 'right-[34px]' : 'left-[34px]')
                      }
                      onClick={(e) => e.stopPropagation()}
                    >
                    <motion.div
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                      className="flex w-72 items-center gap-1 rounded-full bg-white py-1.5 pl-4 pr-2 shadow-[0_4px_20px_rgba(0,0,0,0.25)]"
                    >
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitDraft()
                          if (e.key === 'Escape') removeMarker(m.id)
                        }}
                        placeholder={zh ? '描述改动' : 'Describe the change'}
                        className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-900 outline-none placeholder:text-neutral-400"
                      />
                      <button
                        type="button"
                        onClick={commitDraft}
                        aria-label={zh ? '确认' : 'Confirm'}
                        className="grid size-6 shrink-0 place-items-center rounded-full bg-brand text-white transition-[filter] hover:brightness-110"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeMarker(m.id)}
                        aria-label={zh ? '删除标记' : 'Remove marker'}
                        className="grid size-6 shrink-0 place-items-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200"
                      >
                        <X className="size-3.5" />
                      </button>
                    </motion.div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 底栏：融合素材 chips + 计数 + 额外编辑输入 + 发送。 */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        {fusion.length > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {fusion.map((f) => (
              <span
                key={f.path}
                title={f.path}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card py-1 pl-1 pr-1.5"
              >
                <img
                  src={f.thumb}
                  alt={f.name}
                  className="size-7 rounded-md object-cover"
                />
                <span className="max-w-32 truncate text-[12px] text-foreground">
                  {f.name}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setFusion((fs) => fs.filter((x) => x.path !== f.path))
                  }
                  aria-label={zh ? '移除素材' : 'Remove'}
                  className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          {/* 融合图片入口：原生多选文件框，pathForFile 拿绝对路径。 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              addFusionFiles(e.target.files)
              e.target.value = '' // 允许再次选择同一文件
            }}
          />
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0 rounded-full transition-colors hover:border-brand/60 hover:text-brand"
            onClick={() => fileInputRef.current?.click()}
            title={zh ? '添加图片（与原图融合）' : 'Add images to composite'}
          >
            <Plus className="size-4" />
          </Button>
          <input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSend) void send()
            }}
            placeholder={
              zh ? '（可选）添加额外编辑' : '(Optional) additional edits'
            }
            className="h-9 min-w-0 flex-1 rounded-full border border-border bg-card px-4 text-[13px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-brand/60 focus:ring-[3px] focus:ring-brand/15"
          />
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
            {zh
              ? `${noted.length + (draftCounts ? 1 : 0)} 条标记`
              : `${noted.length + (draftCounts ? 1 : 0)} marks`}
          </span>
          <Button
            className="h-9 shrink-0 rounded-full bg-brand px-5 text-white transition-[filter] hover:bg-brand hover:brightness-110"
            disabled={!canSend}
            onClick={() => void send()}
          >
            {zh ? '发送' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}
