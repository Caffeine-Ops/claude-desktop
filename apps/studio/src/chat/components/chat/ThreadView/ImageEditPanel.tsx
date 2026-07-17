import { useEffect, useRef, useState } from 'react'
import { useComposerRuntime } from '@assistant-ui/react'
import { motion } from 'motion/react'
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef
} from 'react-zoom-pan-pinch'
import {
  FolderOpen,
  ImageIcon,
  Minus,
  PanelRight,
  Plus,
  Square,
  Trash2,
  X
} from 'lucide-react'

import { useI18n } from '../../../i18n'
import { useChatStore } from '../../../stores/chat'
import {
  IMAGE_EDIT_MARKER,
  useImageEditStore,
  type ImageEditMeta
} from '../../../stores/filePreview'
import { dispatchChatTurn } from '../../../lib/dispatchChatTurn'
import { removeComposerAttachmentsByPath } from '../../../runtime/imageAttachmentAdapter'
import {
  registerImageEditDemoHandle,
  unregisterImageEditDemoHandle,
  type ImageEditDemoHandle
} from '../../../replay/imageEditDemoRegistry'
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
  // 面板直发（dispatchChatTurn）绕过 composer.send()，输入框里同一张图
  // 的附件 chip 不会被正常发送路径消费——send() 里手动清（只清 path
  // 匹配的那颗，见 removeComposerAttachmentsByPath 注释）。
  const composerRuntime = useComposerRuntime()

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
  /** 当前缩放倍率。react-zoom-pan-pinch 掌管真正的 transform（transform 只做
   *  视觉缩放、布局尺寸不变，故 getBoundingClientRect 换算百分比仍天然正确）；
   *  这里镜像一份 scale 仅供顶栏百分比 chip 与框标记线宽 1/scale 补偿用，由
   *  onTransform 回调同步。ref 供非渲染路径同步读，state 驱动 UI。 */
  const [scale, setScale] = useState(1)
  const scaleRef = useRef(1)
  /** 空格按住：库靠 panning.activationKeys 自行判定平移，此标记只用于
   *  ①图区 cursor 视觉 ②空格按下时点图不落标记（见 onImageMouseDown）。 */
  const [spaceDown, setSpaceDown] = useState(false)
  /** 正在平移拖拽中（接库的 onPanningStart/Stop）：cursor 由 grab → grabbing。 */
  const [panningNow, setPanningNow] = useState(false)
  /** 右侧标记列表栏显隐（默认藏，图区占满；顶栏按钮拉出总览）。 */
  const [showMarkerList, setShowMarkerList] = useState(false)
  /** 列表↔图上徽章 hover 联动高亮的 marker id（null=无）。 */
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  /** 拖拽图片文件进面板中（显示「松手添加素材」遮罩）。dragenter/leave 会
   *  在子元素间反复冒泡，用计数器抵消进出对，避免遮罩闪烁。 */
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const spaceRef = useRef(false)
  const nextId = useRef(1)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  /** react-zoom-pan-pinch 控制句柄：顶栏「适应窗口」经它 resetTransform。 */
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null)

  // 换图（或首开）即整体重置：标记/草稿/素材/视图都属于上一张图。
  useEffect(() => {
    setDataUrl(null)
    setLoadErr(null)
    setMarkers([])
    setActiveId(null)
    setDraft('')
    setExtra('')
    setFusion([])
    setScale(1)
    scaleRef.current = 1
    setHoveredId(null)
    setDragActive(false)
    dragDepth.current = 0
    // showMarkerList 刻意不复位：栏的展开/收起是用户界面偏好，换图应保持。
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

  // 缩放/平移由 react-zoom-pan-pinch 掌管（wheel 非 passive、以光标为锚点、
  // 惯性、触控板 pinch 都由库内部处理）。空格平移经 panning.activationKeys=[' ']；
  // 图片本体/标记经 panning.excluded 排除，左键在图上拖拽保持为「框选」语义。
  // 顶栏「适应窗口」/百分比 chip 经 transformRef.resetTransform；scale 由
  // TransformWrapper.onTransform 镜像到 state（chip 与标记反缩放共用）。

  if (path === null) return null
  const name = path.split('/').pop() ?? path

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

  // ── 回放演示驱动接口（.claudereplay ui 轨）──
  // ReplayController 经 imageEditDemoRegistry 命令式驱动面板重演一次真实
  // 编辑：标记弹出→输入条逐字→提交→按下发送。方法体直接调本组件的现有
  // setState/闭包，交互路径与手工操作完全一致；demoPressed 只负责发送按钮
  // 的按压视觉——回放里的「发送」绝不走 send()/dispatchChatTurn（后续的
  // 消息由录像 chat 轨提供）。commitDraft 每渲染重建，经 ref 转发取最新。
  const [demoPressed, setDemoPressed] = useState(false)
  const demoRef = useRef({ commitDraft })
  demoRef.current = { commitDraft }
  useEffect(() => {
    // dataUrl 就绪才注册：controller 以 handle 出现为「面板可表演」信号
    //（buffering 等待的就是这一刻），提前注册会在空画布上落标记。
    if (!dataUrl) return
    const handle: ImageEditDemoHandle = {
      addMarker: (x, y, w, h) => {
        demoRef.current.commitDraft()
        const id = nextId.current++
        setMarkers((ms) => [
          ...ms,
          w !== undefined && h !== undefined
            ? { id, x, y, w, h, note: '' }
            : { id, x, y, note: '' }
        ])
        setActiveId(id)
        setDraft('')
      },
      setDraftText: (text) => setDraft(text),
      commitDraft: () => demoRef.current.commitDraft(),
      setExtraText: (text) => setExtra(text),
      pressSend: () => {
        setDemoPressed(true)
        window.setTimeout(() => {
          setDemoPressed(false)
          // closeEditor 是 zustand action（终身稳定），卸载后调用也无害。
          useImageEditStore.getState().closeEditor()
        }, 280)
      }
    }
    registerImageEditDemoHandle(handle)
    return () => unregisterImageEditDemoHandle(handle)
  }, [dataUrl])

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
      // 只收图片：<input> 有 accept 门控，但拖放（onDrop）没有——统一在此
      // 按 MIME 过滤，非图片文件直接跳过。
      if (!file.type.startsWith('image/')) continue
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

  // ── 拖放添加融合素材 ──
  // 从 Finder 把图片拖进面板任意处即可添加（等价于点 + 选文件）。用
  // dataTransfer.types 含 'Files' 判定「拖的是文件」——拖面板内元素（标记
  // 等）不含 Files，不会误触发遮罩。dragenter/dragleave 会在子元素边界反复
  // 冒泡，用 dragDepth 计数抵消进出对，避免遮罩在子元素间移动时闪烁。
  const isFileDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')
  const onDragEnter = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault() // 必须——否则浏览器默认「打开文件」，drop 收不到
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragActive(false)
    }
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    addFusionFiles(e.dataTransfer.files)
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
    // 图片路径已随本消息发出，composer 里同源的附件 chip 使命结束。
    removeComposerAttachmentsByPath(composerRuntime, path)
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
    <div
      // @container/imgedit：面板住在可拖分栏里，视口媒体查询探不到面板实际
      // 宽度（窗口很宽但面板可以被拖窄）——顶栏元素的响应显隐必须按容器宽
      // 而不是视口宽（同 LivePreviewEditor 的 @container/editor 先例；此前
      // 提示组用 lg:flex 视口断点，分栏拖窄后被压成逐字竖排，2026-07-16）。
      className="@container/imgedit relative flex min-w-0 flex-1 flex-col bg-card"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 拖放添加素材遮罩：拖图片文件进面板时覆盖全面板，提示可松手。
          pointer-events-none 让底下的 drag 事件继续冒泡到根 div 的 onDrop
          （遮罩自己不能截走 drop）。 */}
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-brand/[0.06] backdrop-blur-[1px]">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-brand/50 bg-popover/95 px-10 py-8 shadow-xl">
            <span className="grid size-12 place-items-center rounded-xl bg-brand/[0.12] text-brand">
              <ImageIcon className="size-6" />
            </span>
            <p className="text-[13.5px] font-medium text-foreground">
              {zh ? '松手添加为融合素材' : 'Drop to add as fusion source'}
            </p>
          </div>
        </div>
      ) : null}
      {/* 顶栏（重设计 2026-07-16）：文件名 chip + 分段操作提示 + 缩放 chip +
          标记栏开关 + 图标钮组。窗口拖拽由根 layout 的 .window-drag-strip 统一
          负责（46px），本栏 h-12 与之重叠、不声明 drag；交互元素要显式 no-drag
          在 strip 上挖洞（同 SpreadsheetPreviewPanel 纪律）——漏挖会被 macOS 当
          窗口拖拽区截走点击。整栏都是交互元素，故 no-drag 提到最外层。 */}
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border/55 px-3 [-webkit-app-region:no-drag]">
        {/* 文件名 chip：截断 + title 显全名，图标暗示这是图片文件。 */}
        <span
          title={name}
          className="flex min-w-0 max-w-[260px] shrink items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 @max-2xl/imgedit:max-w-[150px]"
        >
          <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground">
            {name}
          </span>
        </span>

        {/* 操作提示：分段小标签，滚轮/空格用键帽样式，替代原来一行长文字。 */}
        {/* 面板容器 < 48rem 时整组隐藏（操作提示是辅助信息，窄面板首先牺牲）；
            shrink-0 + nowrap 兜底：任何挤压下都不允许逐字竖排折行。 */}
        <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] text-muted-foreground @max-3xl/imgedit:hidden">
          <span className="rounded-md px-1.5 py-0.5">
            {zh ? '点选 · 框选' : 'Click · Box'}
          </span>
          <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5">
            <kbd className="rounded border border-border bg-muted px-1 py-px text-[10px] font-medium text-foreground">
              {zh ? '滚轮' : 'Wheel'}
            </kbd>
            {zh ? '缩放' : 'zoom'}
          </span>
          <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5">
            <kbd className="rounded border border-border bg-muted px-1 py-px text-[10px] font-medium text-foreground">
              {zh ? '空格' : 'Space'}
            </kbd>
            {zh ? '拖移' : 'pan'}
          </span>
        </span>

        <span className="flex-1" />

        {/* 缩放 chip：−/百分比/+ 一体。百分比点击复位（resetTransform），±按钮
            走库的 zoomIn/zoomOut。scale 由 onTransform 同步。 */}
        <span className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
          <button
            type="button"
            onClick={() => transformRef.current?.zoomOut()}
            aria-label={zh ? '缩小' : 'Zoom out'}
            // 面板极窄（<36rem）时 ± 钮让位，缩放 chip 只留百分比（点击可复位；
            // 滚轮/pinch 缩放不受影响）。
            className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground @max-xl/imgedit:hidden"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => transformRef.current?.resetTransform()}
            title={zh ? '重置视图' : 'Reset view'}
            className="min-w-[42px] rounded-md px-1 py-0.5 text-[11.5px] tabular-nums text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            onClick={() => transformRef.current?.zoomIn()}
            aria-label={zh ? '放大' : 'Zoom in'}
            className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground @max-xl/imgedit:hidden"
          >
            <Plus className="size-3.5" />
          </button>
        </span>

        {/* 「适应窗口」独立钮已去掉（2026-07-16 用户要求）——复位入口保留在
            缩放 chip：点中间的百分比即 resetTransform，功能不丢。 */}

        {/* 标记列表栏开关：拉出/收起右侧总览。有标记时 active 态高亮。 */}
        <Button
          variant="ghost"
          size="icon"
          className={
            'size-7 shrink-0 ' +
            (showMarkerList ? 'bg-secondary text-foreground' : '')
          }
          onClick={() => setShowMarkerList((v) => !v)}
          aria-label={zh ? '标记列表' : 'Marker list'}
          title={zh ? '标记列表' : 'Marker list'}
        >
          <PanelRight className="size-4" />
        </Button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" />

        {/* 在文件夹中显示：走 SHELL_REVEAL_PATH IPC（同 ImageLightbox）。 */}
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
      </div>

      {/* 主体：图区 + 可收起的右侧标记栏并列。 */}
      <div className="flex min-h-0 flex-1">
      {/* 图区：react-zoom-pan-pinch 掌管缩放/平移（惯性 + 触控板 pinch + 以光
          标为锚点，均库内实现）。key={path} 换图即重挂，视图回到初始适配态。
          panning.activationKeys=[' ']：仅空格拖拽平移；panning.excluded 排除
          img 与标记 → 图上左键拖拽保持「框选」语义（见 onImageMouseDown）。
          smooth + wheel.step 平滑缩放，velocityAnimation 给平移加惯性。
          底色继承面板根的 bg-card（纯白，对齐左侧 chat 内容区，2026-07-16
          用户要求整面板与 chat 一个系统）——点阵纹理已去除，白底上无意义。 */}
      <div
        className={
          // p-6 留白放在这里（不放 TransformComponent 的 content 上——padding
          // 会被算进 centerOnInit 的填充尺寸，把初始 scale 顶成 >1、图被放大
          // 且溢出视口，点选落点全乱，2026-07-16 真机 CDP 实测过）。
          'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-6 ' +
          (spaceDown ? (panningNow ? 'cursor-grabbing' : 'cursor-grab') : '')
        }
      >
        {loadErr ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
            {loadErr}
          </div>
        ) : dataUrl === null ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
            {zh ? '加载中…' : 'Loading…'}
          </div>
        ) : (
          <TransformWrapper
            key={path}
            ref={transformRef}
            minScale={0.5}
            maxScale={8}
            initialScale={1}
            centerOnInit
            smooth
            // 触控板两指滑动一次手势会触发几十个 wheel 事件，同一 per-event
            // step 会累积成过猛的跳变（库无独立触控板灵敏度旋钮，只能压低
            // step）。0.05 让鼠标滚轮仍够用、又驯住触控板——与同项目
            // LivePreviewEditor 的 0.04 同源经验（那里更保守未开 smooth）。
            wheel={{ step: 0.05 }}
            pinch={{ step: 6 }}
            doubleClick={{ disabled: true }}
            // 只用 activationKeys 门控平移：空格按住才平移，松开则库根本不
            // 启动平移（isPressingKeys=false 时 onPanningStart 直接 return），
            // 图上左键拖拽自然落到我们的框选。不要再把 img/marker 塞进
            // excluded——那会让「空格+在图上拖拽」既不落标记（handler 里
            // spaceRef 时 return）又不平移（excluded 拒绝库平移）＝死区
            // （2026-07-16 真机 CDP 实测 panned:false）。activationKeys 一个
            // 机制就同时管住两种场景。
            panning={{ activationKeys: [' '] }}
            velocityAnimation={{ disabled: false }}
            onPanningStart={() => setPanningNow(true)}
            onPanningStop={() => setPanningNow(false)}
            onTransform={(_ref, s) => {
              // 镜像 scale 给顶栏 chip 与标记反缩放。只在变化时 setState，避免
              // 每帧重渲整棵标记树（惯性/缩放的连续帧里 scale 大量重复）。
              scaleRef.current = s.scale
              setScale((prev) => (prev === s.scale ? prev : s.scale))
            }}
          >
            <TransformComponent
              wrapperClass="!h-full !w-full"
              contentClass="!h-full !w-full !flex !items-center !justify-center"
            >
            {/* 单击落点、拖拽框选（阈值二选一见 onImageMouseDown）。相对定位
                容器承载标记的百分比绝对定位；随 content 一起被 transform 缩放。 */}
            <div className="relative inline-block">
            {/* pointerEvents 必须内联恢复：react-zoom-pan-pinch 的
                `.transform-component-module_content__FBWxo img { pointer-events:
                none }`（特异性 0,1,1）会关掉图片命中测试（库默认图片不接事件、
                只当被平移的画布），但本面板正靠 img 的 mousedown 落标记。用
                Tailwind 的 `pointer-events-auto`（0,1,0）压不过它——必须内联
                style（内联恒胜，库那条非 !important），否则真实鼠标穿透、点选/
                框选全失效（2026-07-16 真机 CDP 实测 imgPE=none、elementFromPoint
                命中外层 div 而非 img；先试 class 覆盖仍 none，改内联才生效）。 */}
            <img
              ref={imgRef}
              src={dataUrl}
              alt={name}
              draggable={false}
              onMouseDown={onImageMouseDown}
              style={{ pointerEvents: 'auto' }}
              className={
                // 空格模式下 cursor 跟着平移态走（grab/grabbing），否则十字（落
                // 标记）。图片自身的 cursor 会盖过外层图区容器的，故这里也要判。
                'block max-h-[calc(100vh-220px)] max-w-full select-none rounded-xl shadow-[0_8px_32px_-8px_hsl(240_20%_15%/0.35),0_0_0_1px_hsl(var(--foreground)/0.06)] ' +
                (spaceDown
                  ? panningNow
                    ? 'cursor-grabbing'
                    : 'cursor-grab'
                  : 'cursor-crosshair')
              }
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
                  borderWidth: `${2 / scale}px`
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
                  // 容器即矩形区域。pointer-events 全关（别挡住底下图片的再次
                  // 点选/框选），只有编号徽章与浮条恢复可点。平移门控靠库的
                  // activationKeys（空格）——标记上没按空格拖拽不会平移。
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
                        随 1/scale 补偿——矩形跟画布缩放（区域语义），线宽不跟。 */}
                    <div
                      className="pointer-events-none absolute inset-0 rounded-[3px] border-solid border-white shadow-[0_0_0_1.5px_rgba(17,17,17,0.6),inset_0_0_0_1px_rgba(17,17,17,0.35)]"
                      style={{ borderWidth: `${2 / scale}px` }}
                    />
                    {/* 编号徽章骑在框左上角。translate 在 wrapper 上，motion
                        只管缩放（transform 分层，理由同点标记）。 */}
                    <span
                      className="group/marker absolute left-0 top-0"
                      style={{
                        transform: `translate(-50%, -50%) scale(${1 / scale})`
                      }}
                    >
                      <motion.button
                        type="button"
                        initial={{ scale: 0.4, opacity: 0 }}
                        animate={{
                          scale: active || m.id === hoveredId ? 1.12 : 1,
                          opacity: 1
                        }}
                        whileHover={{ scale: 1.12 }}
                        transition={{ type: 'spring', stiffness: 520, damping: 26 }}
                        onMouseEnter={() => setHoveredId(m.id)}
                        onMouseLeave={() => setHoveredId(null)}
                        onClick={(e) => {
                          e.stopPropagation()
                          openMarker(m)
                        }}
                        className={
                          'grid size-[26px] place-items-center rounded-full border-2 border-white bg-black text-[11.5px] font-bold tabular-nums text-white transition-shadow ' +
                          (active || m.id === hoveredId
                            ? 'shadow-[0_0_0_4px_hsl(var(--accent)/0.25),0_1px_4px_rgba(0,0,0,0.4)]'
                            : 'shadow-[0_1px_4px_rgba(0,0,0,0.4)]')
                        }
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
                          transform: `translateY(-50%) scale(${1 / scale})`,
                          transformOrigin: flipLeft ? 'right center' : 'left center'
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <motion.div
                          initial={{ opacity: 0, scale: 0.96 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.16, ease: 'easeOut' }}
                          className="flex w-72 items-center gap-1 rounded-xl border border-border bg-popover py-1.5 pl-3.5 pr-1.5 shadow-[0_8px_28px_-6px_hsl(240_20%_15%/0.3),0_2px_6px_hsl(240_10%_10%/0.12)]"
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
                            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                          />
                          <button
                            type="button"
                            onClick={commitDraft}
                            aria-label={zh ? '确认' : 'Confirm'}
                            className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-accent text-white transition-[filter] hover:brightness-110"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M12 19V5M5 12l7-7 7 7" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => removeMarker(m.id)}
                            aria-label={zh ? '删除标记' : 'Remove marker'}
                            className="grid size-[26px] shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
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
                // 锚点承载 -50% 平移（圆心对准坐标点）+ 1/scale 反缩放（画布
                // 放大时圈与浮条保持屏幕尺寸）；弹跳动画交给 motion 管内层
                // transform——分层放两个元素，否则互相覆盖（原型稿验证过）。
                <div
                  key={m.id}
                  className="group/marker absolute"
                  style={{
                    left: `${m.x}%`,
                    top: `${m.y}%`,
                    transform: `translate(-50%, -50%) scale(${1 / scale})`
                  }}
                >
                  {/* 编号圈：黑底白字（参考图样式），落点弹跳入场。点击重开编辑。
                      active/hover（含列表联动 hoveredId）加主题色光环（2026-07-17
                      从品牌绿改 --accent，跟设置页选的主题色走）。 */}
                  <motion.button
                    type="button"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{
                      scale: active || m.id === hoveredId ? 1.12 : 1,
                      opacity: 1
                    }}
                    whileHover={{ scale: 1.12 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 26 }}
                    onMouseEnter={() => setHoveredId(m.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={(e) => {
                      e.stopPropagation()
                      openMarker(m)
                    }}
                    className={
                      'grid size-[26px] place-items-center rounded-full border-2 border-white bg-black text-[11.5px] font-bold tabular-nums text-white transition-shadow ' +
                      (active || m.id === hoveredId
                        ? 'shadow-[0_0_0_4px_hsl(var(--accent)/0.25),0_1px_4px_rgba(0,0,0,0.4)]'
                        : 'shadow-[0_1px_4px_rgba(0,0,0,0.4)]')
                    }
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
                        className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-white transition-[filter] hover:brightness-110"
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
            </TransformComponent>
          </TransformWrapper>
        )}
      </div>

      {/* ── 右侧标记列表栏（重设计 2026-07-16 新增，默认收起）──
          图上每个 marker 一行：编号 + 描述 + 位置元信息（点/框、坐标）。
          点行→openMarker（跳到编辑）；hover 行↔图上徽章双向高亮（hoveredId）。 */}
      {showMarkerList ? (
        // 底色 bg-card（纯白）与图区连成一片白、只靠 border-l 分隔——整面板对齐
        // 左侧 chat 内容区的白底，成为一个系统（2026-07-16 用户要求，前两版的
        // 灰底/白卡与 chat 冷灰不同源，显得脱节）。
        <aside className="flex w-[280px] shrink-0 flex-col border-l border-border/55 bg-card">
          <div className="flex h-[46px] shrink-0 items-center justify-between border-b border-border/55 px-3.5">
            <span className="text-[12.5px] font-semibold text-foreground">
              {zh ? '标记' : 'Markers'}
            </span>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              {zh ? `${markers.length} 条` : markers.length}
            </span>
          </div>
          {markers.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center text-muted-foreground">
              <span className="grid size-11 place-items-center rounded-xl border border-dashed border-border">
                <Square className="size-5 opacity-60" />
              </span>
              <p className="text-[12px] leading-relaxed">
                {zh
                  ? '在图片上点选或框选，添加标记'
                  : 'Click or drag on the image to add markers'}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-2">
              {markers.map((m, i) => {
                const rowActive = m.id === activeId
                return (
                  <div
                    key={m.id}
                    onClick={() => openMarker(m)}
                    onMouseEnter={() => setHoveredId(m.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    className={
                      // 白栏上用轻量行：透明底 + hover 浅灰 + active 主题色描边淡底
                      //（和 chat 列表行交互一致，白底上不再叠白卡阴影；
                      // 2026-07-17 从品牌绿改 --accent，跟主题色走）。
                      'group/row relative flex cursor-pointer gap-2.5 rounded-lg p-2.5 transition-colors ' +
                      (rowActive
                        ? 'bg-accent/[0.06] shadow-[inset_0_0_0_1px_hsl(var(--accent)/0.35)]'
                        : 'hover:bg-secondary')
                    }
                  >
                    <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-[hsl(240_4%_12%)] text-[11px] font-bold tabular-nums text-white">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className={
                          'line-clamp-2 text-[12.5px] leading-snug ' +
                          (m.note
                            ? 'text-foreground'
                            : 'italic text-muted-foreground')
                        }
                      >
                        {m.note || (zh ? '未填写描述…' : 'No description…')}
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-[10.5px] tabular-nums text-muted-foreground">
                        {m.w !== undefined && m.h !== undefined ? (
                          <>
                            <Square className="size-2.5" />
                            {zh ? '框' : 'Box'} · {m.w}×{m.h}%
                          </>
                        ) : (
                          <>
                            <span className="size-1.5 rounded-full bg-current" />
                            {zh ? '点' : 'Point'} · {m.x}, {m.y}%
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeMarker(m.id)
                      }}
                      aria-label={zh ? '删除标记' : 'Remove marker'}
                      className="absolute right-2 top-2 grid size-[22px] place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/[0.12] hover:text-destructive group-hover/row:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </aside>
      ) : null}
      </div>

      {/* 底栏：融合素材 chips + 计数 + 额外编辑输入 + 发送。 */}
      <div className="shrink-0 border-t border-border/55 px-4 py-3">
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
                  className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground"
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
            className="size-9 shrink-0 rounded-full transition-colors hover:border-accent/60 hover:text-accent"
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
            className="h-9 min-w-0 flex-1 rounded-full border border-border bg-card px-4 text-[13px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-accent/60 focus:ring-[3px] focus:ring-accent/15"
          />
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
            {zh
              ? `${noted.length + (draftCounts ? 1 : 0)} 条标记`
              : `${noted.length + (draftCounts ? 1 : 0)} marks`}
          </span>
          <Button
            className={
              'h-9 shrink-0 rounded-full px-5 transition-[filter,transform,background-color,color] ' +
              // 禁用态变灰（原来禁用仍实心绿，状态不清；2026-07-16 重设计）；
              // 可用态跟主题色（2026-07-17 从品牌绿改 --accent）。用
              // disabled:!... 覆盖 shadcn Button 的默认禁用样式。
              'bg-accent text-white hover:bg-accent hover:brightness-110 ' +
              'disabled:!bg-muted disabled:!text-muted-foreground disabled:!opacity-100 ' +
              // 回放表演的「按下发送」视觉（demoPressed 由 demo handle 置位）。
              (demoPressed ? 'scale-95 brightness-90' : '')
            }
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
