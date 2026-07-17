import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ListChecks, MoreHorizontal } from 'lucide-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/src/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { Button } from '@/src/components/ui/button'
import type { ShellStatFileInfo } from '@desktop-shared/ipc-channels'
import { useI18n, useT } from '../../../i18n'
import { useChatStore } from '../../../stores/chat'
import {
  useImageEditStore,
  useSheetPreviewStore,
  useSplitWorkspaceBusy
} from '../../../stores/filePreview'
import { deliverableKind, DELIVERABLE_PATH_RE } from './AssistantMessage'
import { detectImageGen } from './ImageGenCard'

/* ─────────────────────── session outputs popover ─────────────────────── */

function extOfPath(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
}

/** 「大小 · 时间」元信息行的两个格式化器（v2 方案 C 定稿，
 *  docs/ui-prototype-outputs-panel-v2.html）。相对时间不做活刷新：
 *  PopoverContent 关闭即卸载，每次打开都是新渲染，误差最多是面板
 *  开着不动的那几十秒，不值得为此挂 interval。 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`
  const gb = mb / 1024
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`
}

function relTime(mtimeMs: number, zh: boolean): string {
  const mins = Math.floor((Date.now() - mtimeMs) / 60_000)
  if (mins < 1) return zh ? '刚刚' : 'just now'
  if (mins < 60) return zh ? `${mins} 分钟前` : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return zh ? `${days} 天前` : `${days}d ago`
  return new Date(mtimeMs).toLocaleDateString()
}

/**
 * Every deliverable-looking path the foreground session has produced, newest
 * first, plus `freshlyAdded` — the subset that just landed *while this hook
 * stayed mounted* (drives the row entrance/accent-bar and the trigger's ring
 * pulse). Two detection sources, mirroring what already renders inline so the
 * panel never surprises the user with a file they haven't seen a card for:
 *
 *   - Prose mentions (AssistantDeliverables' contract): any assistant text
 *     matching DELIVERABLE_PATH_RE — the "here are your files" moment at the
 *     end of a ppt-master / spreadsheets run.
 *   - Generated images (ImageGenCard's contract): imagegen/gpt-image-2 Bash
 *     calls, whose result stdout carries the output paths — these rarely get
 *     re-mentioned in prose, so the text scan alone would miss them.
 *
 * Candidates are deduped by path and verified against disk via statFiles in
 * one batch (same pattern as AssistantDeliverables) — a path the model only
 * *mentioned* never earns a row.
 *
 * `freshlyAdded` semantics (why this needs its own tracking, not just a
 * files.length diff): switching to a session that already has 5 outputs must
 * NOT play the "just arrived" animation — nothing just happened, you just
 * looked at it. Only a genuine same-session growth counts as fresh. The seed
 * baseline is captured inside the SAME statFiles resolution that first
 * populates `files` for a given sessionId — seeding it any earlier (e.g. off
 * a bare sessionId-changed effect) would race the async fetch and seed off
 * the PREVIOUS session's stale path list.
 */
function useSessionOutputs(): {
  files: readonly ShellStatFileInfo[]
  freshlyAdded: ReadonlySet<string>
} {
  const sessionId = useChatStore((s) => s.sessionId)
  const messages = useChatStore((s) => s.messages)
  const candidatesKey = useMemo(() => {
    const seen = new Set<string>()
    for (const m of messages) {
      const running =
        (m as { status?: { type?: string } }).status?.type === 'running'
      const content = (m as { content?: readonly unknown[] }).content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const p = part as { type?: string; text?: string; [k: string]: unknown }
        if (!running && p.type === 'text' && typeof p.text === 'string') {
          for (const match of p.text.matchAll(DELIVERABLE_PATH_RE)) {
            seen.add(match[0])
          }
        }
        if (p.type === 'tool-call' && p.toolName === 'Bash') {
          const settled = typeof p.endedAt === 'number'
          if (!settled) continue
          const info = detectImageGen(p.args, p.result, false)
          if (info) for (const path of info.paths) seen.add(path)
        }
      }
    }
    return [...seen].slice(0, 40).join('\n')
  }, [messages])

  const [files, setFiles] = useState<readonly ShellStatFileInfo[]>([])
  const [freshlyAdded, setFreshlyAdded] = useState<ReadonlySet<string>>(new Set())
  // 累积"已见过"的路径，按 sessionId 隔离——每次 statFiles resolve 都在
  // 这同一个回调里既 setFiles 又做新增 diff，两者共享同一份新鲜数据，
  // 避免用单独的 effect 追 sessionId 变化时跟异步 fetch 产生竞态。
  const seenRef = useRef<{ sessionId: string | null; seen: Set<string> }>({
    sessionId: null,
    seen: new Set()
  })

  useEffect(() => {
    if (!candidatesKey) {
      setFiles([])
      return
    }
    let cancelled = false
    void window.chatApi
      .statFiles({ paths: candidatesKey.split('\n') })
      .then((r) => {
        if (cancelled) return
        // infos 与 files 同序同长（main 同一次 stat 双写）；倒序 = 最新在前。
        const next = [...r.infos].reverse()
        setFiles(next)
        if (seenRef.current.sessionId !== sessionId) {
          // 这个会话第一次拿到数据——当作"历史已有"，不触发新增动效。
          seenRef.current = { sessionId, seen: new Set(next.map((f) => f.path)) }
          return
        }
        const fresh = next.filter((f) => !seenRef.current.seen.has(f.path))
        next.forEach((f) => seenRef.current.seen.add(f.path))
        if (fresh.length > 0) setFreshlyAdded(new Set(fresh.map((f) => f.path)))
      })
      .catch(() => {
        /* transient IPC failure — keep the previous list */
      })
    return () => {
      cancelled = true
    }
  }, [candidatesKey, sessionId])

  // "刚新增"标记只活 2.6s（陪着行入场的强调条 + 触发按钮的提示环一起
  // 播完），到点自动清空——不清的话下一次任意重渲染都会把这批路径
  // 继续当"新"的，强调条会诡异地常驻。
  useEffect(() => {
    if (freshlyAdded.size === 0) return
    const timer = window.setTimeout(() => setFreshlyAdded(new Set()), 2600)
    return () => window.clearTimeout(timer)
  }, [freshlyAdded])

  return { files, freshlyAdded }
}

/** One row in the outputs popover（v2 方案 C 的「文件」组，
 *  docs/ui-prototype-outputs-panel-v2.html 定稿）: type badge + filename +
 *  「类型 · 大小 · 时间」meta line (click = smart open, same branching as
 *  DeliverableCard), plus hover-revealed direct 「打开」(system app) /
 *  「在文件夹中显示」buttons — 旧 ⋯ 菜单里恰好只有这两项，拆成直达钮省一跳。
 *  图像不再走这个行：它们进 OutputImageCell 的三列网格。
 *
 *  `isNew` drives the "just landed" treatment (docs/ui-prototype-outputs-panel
 *  .html 定稿的「左侧强调条」方案): a slide+fade entrance plus a brand-colored
 *  left accent bar that draws in then fades — no full-row color wash, no
 *  inline text tag next to the filename (both were the rejected first pass:
 *  a flat brand/16% background read as a warning flash, and an inline "刚
 *  生成" tag made the filename's truncation width jump twice). `layout`
 *  gives every row (new or not) a free FLIP-style reposition animation when
 *  a fresh row lands above it and pushes it down. */
function OutputRow({
  file,
  isNew
}: {
  file: ShellStatFileInfo
  isNew: boolean
}): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  const path = file.path
  const name = path.split('/').pop() ?? path
  const ext = extOfPath(path)
  const kind = deliverableKind(ext)
  const previewableSheet = ext === 'xlsx' || ext === 'xls' || ext === 'csv'
  const editableImage = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp'
  const splitBusy = useSplitWorkspaceBusy()

  const openExternal = (): void => {
    void window.chatApi.openPath({ absPath: path })
  }

  const open = (): void => {
    if (previewableSheet && !splitBusy) {
      useSheetPreviewStore.getState().openPreview(path)
      return
    }
    if (editableImage && !splitBusy) {
      useImageEditStore.getState().openEditor(path)
      return
    }
    openExternal()
  }

  return (
    <motion.div
      layout
      initial={isNew ? { opacity: 0, y: -12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: [0.34, 1.56, 0.64, 1] }}
      className="group/orow relative flex items-center gap-1.5 rounded-xl px-1.5 py-[7px] transition-colors hover:bg-hover/50"
    >
      {isNew ? (
        <motion.span
          aria-hidden
          initial={{ scaleY: 0, opacity: 1 }}
          animate={{ scaleY: 1, opacity: 0 }}
          transition={{
            scaleY: { duration: 0.38, ease: [0.22, 1, 0.36, 1], delay: 0.06 },
            opacity: { duration: 0.42, ease: 'easeIn', delay: 1.9 }
          }}
          style={{ transformOrigin: 'top' }}
          className="absolute inset-y-[6px] left-0 w-[2.5px] rounded-full bg-brand"
        />
      ) : null}
      {/* data-slot：popover 是 portal，脱离 .chat-app 豁免——没有它，
          canvas 的 button reset 会把整行填成描边卡片（用户截图实锤过，
          曾被误当成"设计如此"）。 */}
      <button
        type="button"
        data-slot="output-row-open"
        onClick={open}
        title={path}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span
          aria-hidden
          className={
            // 34px + 9px 圆角——逐字对齐 docs/ui-prototype-outputs-panel.html
            // 的 .out-row .thumb 尺寸；此前落地时误用了旧版 24px 徽标规格。
            'relative grid size-[34px] shrink-0 place-items-center overflow-hidden rounded-[9px] text-[9px] font-bold text-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)] ' +
            kind.badgeClass
          }
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/28 to-transparent"
          />
          {kind.isImage ? (
            <svg viewBox="0 0 20 20" className="relative size-4 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
              <circle cx="7.2" cy="8" r="1.4" fill="currentColor" stroke="none" />
              <path d="M4 14.5l4-4 3 3 2.5-2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : kind.icon ? (
            <span className="relative">{kind.icon('size-[19px]')}</span>
          ) : (
            <span className="relative">{kind.badge}</span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-foreground group-hover/orow:underline">
            {name}
          </span>
          {/* 元信息行（v2 方案 C）：类型标签从右侧挪进来，和大小/时间合成
              一行——右侧空间腾给悬停直达钮。 */}
          <span className="mt-px block truncate text-[10.5px] text-muted-foreground">
            {`${zh ? kind.zh : kind.en} · ${formatBytes(file.size)} · ${relTime(file.mtimeMs, zh)}`}
          </span>
        </span>
      </button>
      {/* 悬停直达钮组：键盘 Tab 进来时 focus-within 让整组现身，不然
          opacity-0 的钮能聚焦却看不见。 */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/orow:opacity-100">
        <button
          type="button"
          data-slot="output-row-action"
          aria-label={zh ? '打开' : 'Open'}
          title={zh ? '打开' : 'Open'}
          onClick={openExternal}
          className="rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16h12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          data-slot="output-row-action"
          aria-label={zh ? '在文件夹中显示' : 'Reveal in folder'}
          title={zh ? '在文件夹中显示' : 'Reveal in folder'}
          onClick={() => {
            void window.chatApi.revealPath({ absPath: path })
          }}
          className="rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path
              d="M3 5.5h5l1.5 2h7.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11z"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </span>
    </motion.div>
  )
}

/**
 * 图像网格格（v2 方案 C 的「图像」组）：三列正方缩略图。
 *
 *   - 缩略图走 readImageFile（原始字节 dataUrl，与 ImageGenCard /
 *     ImageLightbox 同一 IPC）——面板打开才挂载、关闭即卸载，读的量
 *     可控；将来若图多到吃内存，再加缩略图尺寸参数的 IPC，别在这里
 *     用 file:// 直链（app:// origin 下会被 webSecurity 拦）。
 *   - 悬停浮出底部渐变文件名条——格子太小，常驻文字会切掉缩略图。
 *   - isNew 的网格语言是右上角品牌绿点（行式是左侧强调条）：spring 弹入、
 *     ~1.9s 后淡出，节奏与强调条一致；外层 span 负责 hover 隐藏（motion
 *     写 style.opacity 会压过 class，所以 hover 态交给外层）。
 *   - 点击 = 智能打开（图像编辑器，分栏忙时降级系统应用）；⋯ 菜单保留
 *     显式「打开 / 在文件夹中显示」——格子面积小，放不下行式的两枚直达钮。
 */
function OutputImageCell({
  file,
  isNew
}: {
  file: ShellStatFileInfo
  isNew: boolean
}): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  const path = file.path
  const name = path.split('/').pop() ?? path
  const ext = extOfPath(path)
  // gif 属于图像组但不进标记改图编辑器（编辑器只吃静态位图）——降级系统打开。
  const editableImage = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp'
  const splitBusy = useSplitWorkspaceBusy()
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.chatApi
      .readImageFile({ absPath: path })
      .then((r) => {
        if (!cancelled && r.ok && r.dataUrl) setDataUrl(r.dataUrl)
      })
      .catch(() => {
        /* 文件被挪走/读失败——留占位 glyph，与行式 tile 的降级同观感 */
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const openExternal = (): void => {
    void window.chatApi.openPath({ absPath: path })
  }
  const open = (): void => {
    if (editableImage && !splitBusy) {
      useImageEditStore.getState().openEditor(path)
      return
    }
    openExternal()
  }

  return (
    <motion.div
      layout
      initial={isNew ? { opacity: 0, scale: 0.92 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.42, ease: [0.34, 1.56, 0.64, 1] }}
      className="group/ocell relative aspect-square overflow-hidden rounded-xl bg-muted/50"
    >
      {/* PopoverContent portal 到 document.body，脱离 .chat-app 豁免——
          弹层里的每个裸 <button> 都必须带 data-slot，否则 canvas 的
          button reset（base.css）会填成描边卡片：图片被 padding 挤出
          白边、方角露在圆角容器里（2026-07-13 实测踩中，同 2026-07-04
          打开方式菜单一族）。 */}
      <button
        type="button"
        data-slot="output-image-cell"
        onClick={open}
        title={path}
        className="block h-full w-full"
      >
        {dataUrl ? (
          <img
            src={dataUrl}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover/ocell:scale-[1.04]"
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-muted-foreground">
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
              <circle cx="7.2" cy="8" r="1.4" fill="currentColor" stroke="none" />
              <path d="M4 14.5l4-4 3 3 2.5-2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </button>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 block truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-4 text-[10px] text-white opacity-0 transition-opacity group-hover/ocell:opacity-100">
        {name}
      </span>
      {isNew ? (
        <span
          aria-hidden
          className="absolute right-1.5 top-1.5 transition-opacity group-hover/ocell:opacity-0"
        >
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-slot="output-cell-more"
            aria-label={zh ? '更多' : 'More'}
            title={zh ? '更多' : 'More'}
            className="absolute right-1 top-1 grid size-6 place-items-center rounded-md bg-black/45 text-white opacity-0 transition-opacity hover:bg-black/60 focus-visible:opacity-100 group-hover/ocell:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={openExternal}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16h12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {zh ? '打开' : 'Open'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void window.chatApi.revealPath({ absPath: path })
            }}
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path
                d="M3 5.5h5l1.5 2h7.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11z"
                strokeLinejoin="round"
              />
            </svg>
            {zh ? '在文件夹中显示' : 'Reveal in folder'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </motion.div>
  )
}

/** Chat header entry point: icon button + popover listing every deliverable
 *  the foreground session has produced so far (see useSessionOutputs). */
export function OutputsButton(): React.JSX.Element {
  const t = useT()
  const { files, freshlyAdded } = useSessionOutputs()

  // v2 方案 C 的按类型分组：图像收三列网格、其余走行式。≤40 条纯数组
  // 过滤，不值得 useMemo。
  const images = files.filter((f) => deliverableKind(extOfPath(f.path)).isImage)
  const docs = files.filter((f) => !deliverableKind(extOfPath(f.path)).isImage)

  // 环形提示的播放钥匙：freshlyAdded 每次非空就是一次真实的"到达"，用自增
  // 序号而不是 Set 本身当 key（我们只关心"发生过一次"，序号变化足以让
  // AnimatePresence 里的 motion.span 重新挂载重播）。徽标的 pop 动画共用
  // 同一把钥匙——旧实现用 key={files.length}，切到一个本来就有 N 个产出物
  // 的会话也会让 length 从 0 跳到 N 从而误播"新增"弹跳，这里改成只在真
  // 正的新增事件上才重播。
  const pingSeqRef = useRef(0)
  const [pingKey, setPingKey] = useState(0)
  useEffect(() => {
    if (freshlyAdded.size === 0) return
    pingSeqRef.current += 1
    setPingKey(pingSeqRef.current)
  }, [freshlyAdded])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('chatHeaderOutputs')}
          title={t('chatHeaderOutputs')}
          className="relative shrink-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <ListChecks className="size-4" />
          {/* 双层同心圆提示环——圆形脉冲而非方框描边放大（方框缩放读起来
              像 UI 报错闪烁），面板关着也能被余光注意到"有新东西"。两层
              错峰 90ms，比单环更像 iOS/macOS 系统级通知的语言。 */}
          <AnimatePresence>
            {pingKey > 0 ? (
              <motion.span
                key={`ring-a-${pingKey}`}
                initial={{ opacity: 0.5, scale: 0.7 }}
                animate={{ opacity: 0, scale: 1.7 }}
                transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
                className="pointer-events-none absolute inset-0 rounded-full border-[1.5px] border-brand/50"
              />
            ) : null}
          </AnimatePresence>
          <AnimatePresence>
            {pingKey > 0 ? (
              <motion.span
                key={`ring-b-${pingKey}`}
                initial={{ opacity: 0.5, scale: 0.7 }}
                animate={{ opacity: 0, scale: 1.7 }}
                transition={{ duration: 0.65, delay: 0.09, ease: [0.22, 1, 0.36, 1] }}
                className="pointer-events-none absolute inset-0 rounded-full border-[1.5px] border-brand/50"
              />
            ) : null}
          </AnimatePresence>
          {/* 数量徽标：0 不渲染。key={pingKey} 只在真正的新增事件上重播
              spring pop——切会话时数字照常更新，但不重播弹跳（同上）。 */}
          <AnimatePresence>
            {files.length > 0 ? (
              <motion.span
                key={pingKey}
                initial={pingKey > 0 ? { scale: 0, opacity: 0 } : false}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-brand px-[3px] text-[9px] font-semibold leading-none text-brand-foreground"
              >
                {files.length > 99 ? '99+' : files.length}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </Button>
      </PopoverTrigger>
      {/* 圆角/阴影配方与 AssistantDeliverables 的成果卡片同源（"浮在内容上的
          柔和卡片"语言），比 popover 基件默认的 rounded-md + shadow-md 更贴合
          参考设计的圆润浮层观感；border 淡化到 /50 而非基件默认 border-border，
          浮层本身已靠阴影立起来，粗边框反而显生硬。 */}
      <PopoverContent
        align="end"
        className="w-80 rounded-[20px] border-border/50 p-3.5 shadow-[0_2px_8px_rgba(0,0,0,0.06),0_16px_40px_-20px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-baseline gap-2 px-0.5 pb-2.5">
          <span className="text-[14px] font-semibold text-foreground">
            {t('chatHeaderOutputs')}
          </span>
          {files.length > 0 ? (
            // 品牌色胶囊——原型定稿形态，此前落地时误退化成纯灰文字。
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand/12 px-[5px] text-[11px] font-bold text-brand">
              {files.length}
            </span>
          ) : null}
        </div>
        {files.length === 0 ? (
          // 空态三段式（图标 + 主文案 + 副文案）——原型定稿形态，此前落地
          // 时误退化成单行灰字。
          <div className="flex flex-col items-center gap-2.5 px-3 pb-5 pt-[30px] text-center">
            <span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
              <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h9l7 7v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
                <path d="M13 4v6a1 1 0 0 0 1 1h6" />
              </svg>
            </span>
            <span className="text-[12.5px] font-medium text-foreground/85">
              {t('chatHeaderOutputsEmpty')}
            </span>
            <span className="max-w-[26ch] text-[11.5px] leading-relaxed text-muted-foreground">
              {t('chatHeaderOutputsEmptyHint')}
            </span>
          </div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto">
            {/* 分组标签只在两组并存时出现——只有一种内容时，孤零零一个
                「图像」/「文件」标题是噪音，网格/行式本身已经自明。 */}
            {images.length > 0 ? (
              <>
                {docs.length > 0 ? (
                  <div className="px-1 pb-1.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground/80">
                    {t('outputsGroupImages')}
                  </div>
                ) : null}
                <div className="grid grid-cols-3 gap-1.5">
                  {images.map((f) => (
                    <OutputImageCell
                      key={f.path}
                      file={f}
                      isNew={freshlyAdded.has(f.path)}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {docs.length > 0 ? (
              <>
                {images.length > 0 ? (
                  <div className="px-1 pb-1 pt-2.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground/80">
                    {t('outputsGroupFiles')}
                  </div>
                ) : null}
                <div className="space-y-0.5">
                  {docs.map((f) => (
                    <OutputRow
                      key={f.path}
                      file={f}
                      isNew={freshlyAdded.has(f.path)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
