import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import type { BuiltinTemplateEntry, BuiltinTemplateKind } from '@desktop-shared/ipc-channels'
import { toPptAssetUrl } from '../../../lib/pptAssetUrl'

/**
 * ppt-master 内置模版库的下拉选择器（2026-07-22）——`templatePlaceholderPlugin`
 * 的「【选择模版】」pill 被点击后弹出的 popover，带缩略图预览。选中一项后由
 * `ProseMirrorComposerInput.tsx` 的 `onTemplatePicked` 把占位区间原位替换成
 * 一个 `mention` chip，value 是该模版目录的绝对路径（不带 `@` 前缀，理由见
 * 那段代码的注释）。
 *
 * 骨架抄 Composer.tsx 的 SkillPickerButton popover（毛玻璃 + AnimatePresence
 * + createPortal 到 document.body），内容从「单行文字列表」换成「缩略图卡片
 * 列表」：deck/layout 用 templates/<kind>/<id>/01_cover.svg（走 pptasset://），
 * brand 没有整页预览，退化成 primaryColor 色块。
 */

const KIND_LABEL: Record<BuiltinTemplateKind, string> = {
  brand: '品牌 · 色彩字体',
  layout: '结构 · 页面骨架',
  deck: '整套 · 完整复刻'
}

const KIND_ORDER: BuiltinTemplateKind[] = ['deck', 'layout', 'brand']

/**
 * 模块级缓存——模版库是随 skill 一起发布的静态数据，不随会话变化，同 Composer.tsx
 * 里 modelCache 的取舍：只缓存成功结果，失败不缓存（下次打开照常重试）。
 */
let templatesCache: BuiltinTemplateEntry[] | null = null

export function TemplateGalleryPopover({
  open,
  anchorRect,
  onPick,
  onClose
}: {
  open: boolean
  /** 点击占位 pill 那一刻的 `getBoundingClientRect()`——一次性定位基准。 */
  anchorRect: DOMRect | null
  onPick: (entry: BuiltinTemplateEntry) => void
  onClose: () => void
}): React.JSX.Element | null {
  const [templates, setTemplates] = useState<BuiltinTemplateEntry[] | null>(templatesCache)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // 打开即清空搜索、重置高亮、聚焦搜索框——同 SkillPickerButton。
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlighted(0)
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  // 首次打开且缓存为空才拉取；成功才写缓存，失败下次重试。
  useEffect(() => {
    if (!open || templatesCache !== null) return
    let cancelled = false
    window.chatApi
      ?.listBuiltinTemplates()
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          templatesCache = res.templates
          setTemplates(res.templates)
        } else {
          setLoadError(res.error ?? '模版列表加载失败')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const filtered = useMemo(() => {
    const list = templates ?? []
    const q = query.trim().toLowerCase()
    const matched = q
      ? list.filter(
          (t) => t.id.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)
        )
      : list
    // 按 deck/layout/brand 排序分组，组内保持索引里的原始顺序。
    return [...matched].sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    )
  }, [templates, query])

  useEffect(() => {
    setHighlighted((h) => (h >= filtered.length ? 0 : h))
  }, [filtered])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
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
      if (entry) onPick(entry)
    }
  }

  // 定位：优先在 anchor 下方展开（占位 pill 多半在正文中上部），下方空间
  // 不够且上方更宽裕时翻上去——与 ProseMirrorComposerInput 里 SuggestionPopover
  // 的 above/below 翻转同一套算法，只是基准从「实时量测的 anchorEl」换成「点击
  // 那一刻捕获的 anchorRect」（占位 pill 选中后会被替换掉，无法持续量测）。
  const pos = useMemo(() => {
    if (!anchorRect) return null
    const WIDTH = 380
    const GAP = 8
    const MAX_H = 420
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - WIDTH - 8))
    const spaceBelow = window.innerHeight - anchorRect.bottom - GAP
    const spaceAbove = anchorRect.top - GAP
    const below = spaceBelow >= Math.min(MAX_H, 240) || spaceBelow >= spaceAbove
    return below
      ? { placement: 'below' as const, left, top: anchorRect.bottom + GAP, maxH: Math.min(MAX_H, Math.max(160, spaceBelow)) }
      : { placement: 'above' as const, left, bottom: window.innerHeight - anchorRect.top + GAP, maxH: Math.min(MAX_H, Math.max(160, spaceAbove)) }
  }, [anchorRect])

  if (!open || !pos) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={rootRef}
        initial={{ opacity: 0, y: 4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.98 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        style={{
          left: pos.left,
          width: 380,
          ...(pos.placement === 'below' ? { top: pos.top } : { bottom: pos.bottom })
        }}
        className="fixed z-[9999] flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-card/55 shadow-[0_24px_80px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-100 dark:backdrop-brightness-125"
        role="listbox"
      >
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
            data-slot="template-picker-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="搜索模版"
            className="w-full min-w-0 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/50"
          />
        </div>

        <div className="max-h-[360px] overflow-y-auto py-1.5" style={{ maxHeight: pos.maxH - 52 }}>
          {loadError ? (
            <div className="px-3.5 py-6 text-center text-[13px] text-muted-foreground/60">
              {loadError}
            </div>
          ) : templates === null ? (
            <div className="px-3.5 py-6 text-center text-[13px] text-muted-foreground/60">
              加载中…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3.5 py-6 text-center text-[13px] text-muted-foreground/60">
              没有匹配的模版
            </div>
          ) : (
            filtered.map((entry, i) => {
              const showHeading = entry.kind !== filtered[i - 1]?.kind
              return (
                <div key={`${entry.kind}:${entry.id}`}>
                  {showHeading && (
                    <div className="px-3.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60 first:pt-1">
                      {KIND_LABEL[entry.kind]}
                    </div>
                  )}
                  <button
                    type="button"
                    data-slot="template-picker-item"
                    role="option"
                    aria-selected={i === highlighted}
                    onMouseEnter={() => setHighlighted(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      onPick(entry)
                    }}
                    className={
                      'flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors ' +
                      (i === highlighted ? 'bg-muted' : '')
                    }
                  >
                    <TemplateThumbnail entry={entry} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[13.5px] font-medium text-foreground">
                        {entry.id}
                      </span>
                      <span className="line-clamp-1 text-[12px] text-muted-foreground/70">
                        {entry.summary}
                      </span>
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}

/** 左侧缩略图：deck/layout 用真实 01_cover.svg 预览；brand 没有整页预览，退化成色块。 */
function TemplateThumbnail({ entry }: { entry: BuiltinTemplateEntry }): React.JSX.Element {
  if (entry.previewAbsPath) {
    return (
      <span className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted">
        <img
          src={toPptAssetUrl(entry.previewAbsPath)}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      </span>
    )
  }
  return (
    <span
      className="h-10 w-16 shrink-0 rounded-md border border-border/60"
      style={{ background: entry.primaryColor ?? 'hsl(var(--muted))' }}
    />
  )
}
