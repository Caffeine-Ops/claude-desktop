import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Images,
  PencilLine,
  X
} from 'lucide-react'

import { Button } from '@/src/components/ui/button'
import type { ShellStatFileInfo } from '@desktop-shared/ipc-channels'
import { useT } from '../../../i18n'
import { isEditableImageExt } from '../../../lib/imageKinds'
import { useChatStore } from '../../../stores/chat'
import {
  closeRightPanel,
  openRightPanel,
  selectGalleryOpen,
  useRightPanelStore,
  useSplitWorkspaceBusy
} from '../../../stores/filePreview'
import { extOf } from '../FileTypeIcon'
import { basename } from '../ToolFormatters/helpers'
import { useSessionGeneratedImages } from './OutputsPanel'
import { useWorkflowScriptPanelOpen } from './WorkflowScriptPanel'

/* ─────────────────── 会话图库面板（右栏） + 顶栏入口按钮 ─────────────────── */

/**
 * 「本次会话生成过的所有图」的看图面板（2026-09-07，设计定稿见
 * scratch/image-gallery-panel-design.md）。此前生成图只以 ImageGenCard 内嵌
 * 在对话流里、点开直接进标记改图编辑器——没有一个「纯看图 / 回看全部」
 * 的地方。
 *
 * 数据源：useSessionGeneratedImages（OutputsPanel.tsx）——复用成果弹层那套
 * 「扫会话 → statFiles 核实存在」的管线，只留 AI 生成图。**不要在这里另起
 * 一套扫描**，两处看到的必须是同一份事实。
 *
 * 结构：上方缩略图网格（点击选中）→ 下方大图（←/→ 翻页）→ 底部操作栏
 * （另存为 / 改这张 / 在文件夹中显示）。「改这张」直接调
 * openRightPanel({ kind: 'image' }) 切到已有的 ImageEditPanel——右栏占用者
 * store 天然「后开的赢」，图库随之让位。
 *
 * 布局照抄 SpreadsheetPreviewPanel：chat 列收窄成持久化 chatColWidth rail
 * 在左、本面板 flex-1 在右；顶栏 46px 与 ChatHeader 同高同 hairline；
 * 窗口拖拽由根 layout 的 .window-drag-strip 统一负责，本栏不声明 drag。
 */

/* ── 两级图片缓存 ──
 * CSP 禁止 file: 作 img src，字节只能经 IPC 拿。两条通道各司其职：
 *   - 缩略格走 KB_IMAGE_THUMBS（main 用 nativeImage 缩到 160px，一次最多 60 张，
 *     名字带 kb 但通道本身是通用的「路径 → 小图」）。此前缩略格也读全分辨率
 *     原图：40 张 3MB 的图 = 上百 MB base64 过 IPC、40 次全尺寸解码只为填
 *     84px 的格子（第二轮 code review 抓到）。
 *   - 大图走 readImageFile 拿原始字节，只给当前选中那一张；在途 promise 记忆化，
 *     快速翻页不会对同一张重复发读。
 * 两级都是模块级 Map，关面板不清（会话里反复开关图库是常态）。
 *
 *   - 键 = path + mtime + size，不能只按路径：image_gen.py 对目录输出用固定
 *     文件名（image_1.png…），--force 会原地覆盖，只按路径缓存会一直显示
 *     旧图、与聊天里新落的卡片打架。stat 信息 store 里已经带着。
 *   - 大图缓存双上限：条数 40 + 总字节 64MB（base64 长度近似），FIFO 淘汰——
 *     全分辨率图一张几 MB，只限条数会把几百 MB 钉在渲染进程里。缩略图一张
 *     十几 KB，只限条数（400）。 */
const DATA_URL_CACHE_CAP = 40
const DATA_URL_CACHE_BYTES = 64 * 1024 * 1024
const dataUrlCache = new Map<string, string>()
let dataUrlCacheBytes = 0
const inflightReads = new Map<string, Promise<string | null>>()

const THUMB_CACHE_CAP = 400
const thumbCache = new Map<string, string>()
const THUMB_BATCH = 60

function cacheKey(file: ShellStatFileInfo): string {
  return `${file.path}:${file.mtimeMs}:${file.size}`
}

/** 全分辨率读取，按 key 记忆化在途 promise；失败回 null（不缓存失败）。 */
function readFullImage(key: string, path: string): Promise<string | null> {
  const hit = dataUrlCache.get(key)
  if (hit) return Promise.resolve(hit)
  const inflight = inflightReads.get(key)
  if (inflight) return inflight
  const p = window.chatApi
    .readImageFile({ absPath: path })
    .then((r) => {
      if (r.ok && r.dataUrl) {
        rememberDataUrl(key, r.dataUrl)
        return r.dataUrl
      }
      return null
    })
    .catch(() => null)
    .finally(() => {
      inflightReads.delete(key)
    })
  inflightReads.set(key, p)
  return p
}

/**
 * 给一批文件拉缩略图（只拉缓存里没有的），完成后 bump 版本号触发重渲染。
 * 结果按 key 进 thumbCache；读不出的路径（损坏/被挪走）静默缺席，格子留占位。
 */
function useGalleryThumbs(files: readonly ShellStatFileInfo[]): ReadonlyMap<string, string> {
  const [, bump] = useState(0)
  const missingKeys = files.filter((f) => !thumbCache.has(cacheKey(f)))
  const missingSig = missingKeys.map(cacheKey).join('\n')
  useEffect(() => {
    if (missingKeys.length === 0) return
    let cancelled = false
    ;(async () => {
      for (let i = 0; i < missingKeys.length; i += THUMB_BATCH) {
        const batch = missingKeys.slice(i, i + THUMB_BATCH)
        const r = await window.chatApi
          .getKbImageThumbs({ paths: batch.map((f) => f.path) })
          .catch(() => ({ thumbs: {} as Record<string, string> }))
        if (cancelled) return
        for (const f of batch) {
          const url = r.thumbs[f.path]
          if (!url) continue
          if (thumbCache.size >= THUMB_CACHE_CAP) {
            const oldest = thumbCache.keys().next().value
            if (oldest !== undefined) thumbCache.delete(oldest)
          }
          thumbCache.set(cacheKey(f), url)
        }
        bump((n) => n + 1)
      }
    })()
    return () => {
      cancelled = true
    }
    // missingKeys 由 missingSig 完全决定。
  }, [missingSig])
  return thumbCache
}

function rememberDataUrl(key: string, dataUrl: string): void {
  while (
    dataUrlCache.size > 0 &&
    (dataUrlCache.size >= DATA_URL_CACHE_CAP ||
      dataUrlCacheBytes + dataUrl.length > DATA_URL_CACHE_BYTES)
  ) {
    const oldest = dataUrlCache.keys().next().value
    if (oldest === undefined) break
    dataUrlCacheBytes -= dataUrlCache.get(oldest)!.length
    dataUrlCache.delete(oldest)
  }
  dataUrlCache.set(key, dataUrl)
  dataUrlCacheBytes += dataUrl.length
}

type ImageLoad =
  | { phase: 'loading' }
  | { phase: 'ready'; dataUrl: string }
  | { phase: 'error' }

/**
 * 读一张图的 dataUrl。状态里记着它属于哪个 key：切到未缓存的新图时，effect
 * 要到提交后才把状态翻成 loading，渲染那一帧若直接回旧状态，大图区会先画一帧
 * 「上一张的像素 + 新一张的文件名」再淡出重进（第二轮 code review 抓到）。
 * 所以渲染期按 key 判：不匹配就看缓存，缓存没有即 loading。
 */
function useImageDataUrl(file: ShellStatFileInfo | null): ImageLoad {
  const key = file ? cacheKey(file) : null
  const path = file?.path ?? null
  const [state, setState] = useState<{ key: string | null; load: ImageLoad }>(() => {
    const hit = key !== null ? dataUrlCache.get(key) : undefined
    return { key, load: hit ? { phase: 'ready', dataUrl: hit } : { phase: 'loading' } }
  })
  useEffect(() => {
    if (key === null || path === null) return
    const hit = dataUrlCache.get(key)
    if (hit) {
      setState({ key, load: { phase: 'ready', dataUrl: hit } })
      return
    }
    let cancelled = false
    setState({ key, load: { phase: 'loading' } })
    void readFullImage(key, path).then((dataUrl) => {
      if (cancelled) return
      setState({
        key,
        load: dataUrl ? { phase: 'ready', dataUrl } : { phase: 'error' }
      })
    })
    return () => {
      cancelled = true
    }
  }, [key, path])
  if (state.key === key) return state.load
  const hit = key !== null ? dataUrlCache.get(key) : undefined
  return hit ? { phase: 'ready', dataUrl: hit } : { phase: 'loading' }
}

/* ─────────────────────────── 缩略图格 ─────────────────────────── */

function GalleryThumb({
  file,
  thumb,
  selected,
  isNew,
  onSelect
}: {
  file: ShellStatFileInfo
  /** 160px 缩略图 dataUrl；还没拉到 / 读不出为 undefined（留占位 glyph）。 */
  thumb: string | undefined
  selected: boolean
  isNew: boolean
  onSelect: () => void
}): React.JSX.Element {
  const name = basename(file.path)
  return (
    <motion.button
      type="button"
      layout
      initial={isNew ? { opacity: 0, scale: 0.9 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.36, ease: [0.34, 1.56, 0.64, 1] }}
      onClick={onSelect}
      title={name}
      aria-pressed={selected}
      className={
        'group/gthumb relative aspect-square overflow-hidden rounded-lg bg-muted/50 outline-none transition-shadow ' +
        (selected
          ? 'ring-2 ring-brand ring-offset-2 ring-offset-card'
          : 'hover:ring-1 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring')
      }
    >
      {thumb ? (
        <img
          src={thumb}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="grid h-full w-full place-items-center text-muted-foreground/60">
          <Images className="size-4" />
        </span>
      )}
      {isNew ? (
        <span aria-hidden className="absolute right-1 top-1">
          <motion.span
            initial={{ scale: 0, opacity: 1 }}
            animate={{ scale: 1, opacity: 0 }}
            transition={{
              scale: { type: 'spring', stiffness: 500, damping: 22 },
              opacity: { duration: 0.42, ease: 'easeIn', delay: 1.9 }
            }}
            className="block size-[7px] rounded-full bg-brand ring-2 ring-card"
          />
        </span>
      ) : null}
    </motion.button>
  )
}

/* ─────────────────────────── 面板本体 ─────────────────────────── */

export function ImageGalleryPanel(): React.JSX.Element {
  const t = useT()
  const closeGallery = (): void => closeRightPanel('gallery')
  const { images, freshlyAdded, arrival } = useSessionGeneratedImages()
  const thumbs = useGalleryThumbs(images)

  // 选中态存路径而不是下标：新图落盘会把列表整体往后推一位，存下标会让
  // 用户正看着的那张「跳」成别的图。
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const selectedIndex = useMemo(() => {
    if (selectedPath === null) return -1
    return images.findIndex((f) => f.path === selectedPath)
  }, [images, selectedPath])
  const effectiveIndex = selectedIndex >= 0 ? selectedIndex : images.length > 0 ? 0 : -1
  const current = effectiveIndex >= 0 ? images[effectiveIndex] : undefined

  // 刚落盘的新图自动成为当前大图——用户刚让 AI 出的图，就是此刻最想看的。
  // 只在真正的「本会话新增」时跳（arrival 语义见 useSessionGeneratedImages），
  // 切会话/首次打开不跳。
  const sessionId = useChatStore((s) => s.sessionId)
  useEffect(() => {
    if (arrival && arrival.sessionId === sessionId) setSelectedPath(arrival.path)
  }, [arrival, sessionId])

  const goTo = useCallback(
    (delta: number) => {
      if (images.length === 0) return
      const base = effectiveIndex >= 0 ? effectiveIndex : 0
      const next = (base + delta + images.length) % images.length
      setSelectedPath(images[next].path)
    },
    [effectiveIndex, images]
  )

  // ←/→ 翻页。本面板是常驻侧栏而非独占焦点的弹窗，window 级监听必须让位：
  //   - 别的控件已处理（e.defaultPrevented）就不管——Radix Tabs / Slider 等
  //     方向键控件会 preventDefault，不判会两边同时响应（code review 抓到）；
  //   - composer（ProseMirror contentEditable）和任何输入框里的方向键是在编辑
  //     文字，必须放行。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.isContentEditable ||
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT')
      ) {
        return
      }
      e.preventDefault()
      goTo(e.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo])

  const currentPath = current?.path ?? null
  const mainLoad = useImageDataUrl(current ?? null)
  const currentName = currentPath ? basename(currentPath) : ''
  const editable = currentPath !== null && isEditableImageExt(extOf(currentPath))

  // 「已保存到 xxx」/「保存失败」的瞬时提示：没有全局 toast，就在操作栏原地
  // 闪 2.6s。三种结果要分开：path 有值 = 成功；path 空且 error 空 = 用户按了
  // 取消（不提示）；error 有值 = 真失败（源文件被挪走、目标目录只读…），
  // 必须显示出来——吞掉会让用户以为存成了（code review 抓到）。
  const [saveNotice, setSaveNotice] = useState<
    { kind: 'ok'; name: string } | { kind: 'error'; message: string } | null
  >(null)
  const saveTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    },
    []
  )
  const flashSaveNotice = (notice: NonNullable<typeof saveNotice>): void => {
    setSaveNotice(notice)
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => setSaveNotice(null), 2600)
  }
  const saveAs = (): void => {
    if (currentPath === null) return
    void window.chatApi
      .saveImageFileAs({ absPath: currentPath })
      .then((r) => {
        if (r.path) flashSaveNotice({ kind: 'ok', name: basename(r.path) })
        else if (r.error) flashSaveNotice({ kind: 'error', message: r.error })
      })
      .catch((err: unknown) => {
        flashSaveNotice({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      })
  }

  return (
    <div className="workspace-split-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[4px] bg-card">
      {/* 顶栏 —— 46px 与 ChatHeader 同高同 hairline。 */}
      <div className="flex h-[46px] shrink-0 select-none items-center gap-2.5 border-b border-border/55 px-3.5">
        <Images className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[13px] font-medium text-foreground">
          {t('galleryTitle')}
        </span>
        {images.length > 0 ? (
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand/12 px-[5px] text-[11px] font-bold text-brand">
            {images.length}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('galleryClose')}
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={closeGallery}
          >
            <X className="size-4" />
          </Button>
        </span>
      </div>

      {images.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
            <Images className="size-5" />
          </span>
          <span className="text-[13px] font-medium text-foreground/85">
            {t('galleryEmpty')}
          </span>
          <span className="max-w-[28ch] text-[12px] leading-relaxed text-muted-foreground">
            {t('galleryEmptyHint')}
          </span>
        </div>
      ) : (
        <>
          {/* 缩略图网格：自适应列宽（最小 84px），最多占面板高度的 ~1/3，
              超出内部滚动——大图区才是主角。 */}
          <div className="max-h-[32%] shrink-0 overflow-y-auto border-b border-border/55 p-3">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
              {images.map((f) => (
                <GalleryThumb
                  key={f.path}
                  file={f}
                  thumb={thumbs.get(cacheKey(f))}
                  selected={f.path === currentPath}
                  isNew={freshlyAdded.has(f.path)}
                  onSelect={() => setSelectedPath(f.path)}
                />
              ))}
            </div>
          </div>

          {/* 大图区：object-contain 居中，左右悬浮翻页钮（单张时不出）。 */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
            {mainLoad.phase === 'ready' ? (
              <AnimatePresence mode="wait" initial={false}>
                <motion.img
                  key={currentPath ?? ''}
                  src={mainLoad.dataUrl}
                  alt={currentName}
                  draggable={false}
                  initial={{ opacity: 0, scale: 0.985 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                  className="max-h-full max-w-full rounded-lg object-contain shadow-[0_8px_30px_-12px_rgba(0,0,0,0.35)]"
                />
              </AnimatePresence>
            ) : mainLoad.phase === 'error' ? (
              <span className="text-[12.5px] text-muted-foreground">
                {t('galleryLoadError')}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <span
                  aria-hidden
                  className="tc-breathe inline-block size-1.5 rounded-full bg-brand"
                />
              </span>
            )}
            {images.length > 1 ? (
              <>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={t('galleryPrev')}
                  title={t('galleryPrev')}
                  onClick={() => goTo(-1)}
                  className="absolute left-3 top-1/2 size-8 -translate-y-1/2 rounded-full bg-background/80 shadow-sm backdrop-blur hover:bg-background"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={t('galleryNext')}
                  title={t('galleryNext')}
                  onClick={() => goTo(1)}
                  className="absolute right-3 top-1/2 size-8 -translate-y-1/2 rounded-full bg-background/80 shadow-sm backdrop-blur hover:bg-background"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </>
            ) : null}
          </div>

          {/* 操作栏：文件名 + 序号 在左，动作在右。 */}
          <div className="flex h-[46px] shrink-0 items-center gap-2 border-t border-border/55 px-3.5">
            <span
              title={currentPath ?? undefined}
              className="min-w-0 truncate text-[12.5px] font-medium text-foreground"
            >
              {currentName}
            </span>
            <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
              {effectiveIndex + 1} / {images.length}
            </span>
            <AnimatePresence>
              {saveNotice ? (
                <motion.span
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  title={saveNotice.kind === 'error' ? saveNotice.message : undefined}
                  className={
                    'min-w-0 truncate text-[11.5px] ' +
                    (saveNotice.kind === 'ok' ? 'text-brand' : 'text-destructive')
                  }
                >
                  {saveNotice.kind === 'ok'
                    ? t('gallerySaved').replaceAll('{name}', saveNotice.name)
                    : t('gallerySaveFailed').replaceAll('{reason}', saveNotice.message)}
                </motion.span>
              ) : null}
            </AnimatePresence>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('galleryReveal')}
                title={t('galleryReveal')}
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  if (currentPath) void window.chatApi.revealPath({ absPath: currentPath })
                }}
              >
                <FolderOpen className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-[12px] text-muted-foreground hover:text-foreground"
                onClick={saveAs}
              >
                <Download className="size-3.5" />
                {t('gallerySaveAs')}
              </Button>
              {/* gif 不进标记改图编辑器（编辑器只吃静态位图）——按钮直接不出。 */}
              {editable ? (
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 px-2.5 text-[12px]"
                  onClick={() => {
                    if (currentPath) openRightPanel({ kind: 'image', path: currentPath })
                  }}
                >
                  <PencilLine className="size-3.5" />
                  {t('galleryEdit')}
                </Button>
              ) : null}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/* ─────────────────────────── 顶栏入口按钮 ─────────────────────────── */

/**
 * ChatHeader 里 OutputsButton 旁的「图库」按钮。
 *
 *   - 亮/灭：本会话产出过 ≥1 张生成图就亮——**不绑**「用户点没点过『生成
 *     图片』技能按钮」，直接打字让 AI 出图很常见，绑技能模式会漏。
 *   - 自动弹开一次：第一张图落盘（freshlyAdded 里出现生成图）时调
 *     autoOpenGalleryOnce，同一会话只弹这一次；用户关掉后不再自动弹。
 *   - 分栏忙（slides / proposal / 写作占着右栏）时禁用：ThreadView 那边
 *     isSplitMode 为真不会渲染图库，这里若照常写 open=true 就是「点击死、
 *     零报错 + 退出分栏后突然弹出」——filePreview.ts 头注释里的那条坑。
 *     判定沿用 useSplitWorkspaceBusy，不新造。
 */
export function ImageGalleryButton(): React.JSX.Element {
  const t = useT()
  const sessionId = useChatStore((s) => s.sessionId)
  const open = useRightPanelStore(selectGalleryOpen)
  const splitBusy = useSplitWorkspaceBusy()
  const { images, arrival } = useSessionGeneratedImages()
  const hasImages = images.length > 0
  const workflowPanelOpen = useWorkflowScriptPanelOpen()

  // 一张生成图刚在本会话落盘并进入列表（arrival 语义与为什么不直接用
  // freshlyAdded，见 useSessionGeneratedImages 头注释）→ 自动弹一次。
  //   - arrival.sessionId 必须等于当前会话：切会话那一帧 store 还没重置，
  //     拿到的是旧会话的事件，不比对会同时误开面板 + 烧掉新会话的额度；
  //   - workflow 脚本面板开着时不弹（也不记账）：它的开关是 React 派生态
  //     （流式 id / 运行 id / 手动 id 三合一），store 层的 autoOpenGalleryOnce
  //     拿不到，所以在这里挡——与右栏其他占用者同一条规则：用户正在看的
  //     面板永远优先于自动弹出。
  useEffect(() => {
    if (sessionId === null || arrival === null) return
    if (arrival.sessionId !== sessionId) return
    if (workflowPanelOpen) return
    useRightPanelStore.getState().autoOpenGalleryOnce(sessionId)
  }, [arrival, sessionId, workflowPanelOpen])

  const toggle = (): void => {
    if (open) closeRightPanel('gallery')
    else if (!splitBusy) openRightPanel({ kind: 'gallery' })
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('galleryButton')}
      aria-pressed={open}
      title={t('galleryButton')}
      disabled={!hasImages || (splitBusy && !open)}
      onClick={toggle}
      className={
        'relative shrink-0 [-webkit-app-region:no-drag] ' +
        (open
          ? 'bg-accent/15 text-foreground'
          : 'text-muted-foreground hover:text-foreground')
      }
    >
      <Images className="size-4" />
    </Button>
  )
}
