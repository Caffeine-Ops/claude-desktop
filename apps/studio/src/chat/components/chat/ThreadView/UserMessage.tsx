import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessagePrimitive, useMessage } from '@assistant-ui/react'
import { AnimatePresence, motion } from 'motion/react'

import { useI18n, useT } from '../../../i18n'
import { findSkillChipSpec } from '../../../composer/skillChipRegistry'
import { FileTypeIcon, fileIconPathsByKey } from '../FileTypeIcon'
import {
  parseImageEditMessage,
  parseSheetSelectionMessage,
  useImageEditStore,
  useSheetPreviewStore,
  type ImageEditMeta,
  type SheetSelectionMeta
} from '../../../stores/filePreview'

/* ─────────────────────── User message ──────────────────────── */

export function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-6 flex w-full flex-col items-end gap-2">
      {/* User bubble — text content. `components.Image` overrides the
          default renderer with our own, and `components.Text` (implicit
          default) just returns the raw string, which is then wrapped by
          the bubble's whitespace-pre-wrap styling.
          Image parts render OUTSIDE the bubble so the blue pill stays
          clean — thumbnails sit above the text bubble, right-aligned,
          matching how messaging apps (iMessage, WhatsApp) stack an
          image caption. */}
      <MessagePrimitive.Parts
        unstable_showEmptyOnNonTextEnd={false}
        components={{
          Image: UserImagePart,
          // Text is set to null so the outer Parts renders only
          // images. The bubble below renders the text instead — this
          // split avoids text flowing "through" the image thumb gap.
          Text: () => null
        }}
      />
      {/* Apple iMessage-style user bubble. rounded-[22px] is the
          softer inner curve iMessage/Messages uses. Pure `bg-accent`
          (Apple Blue, no alpha) is DESIGN.md §2's mandate: Apple Blue
          is the singular interactive accent and should never be
          diluted. 15px body with apple-body tracking gives the
          signature tight-but-readable Apple rhythm.

          ClampedUserBubble caps the height of a very long message so one
          giant paste can't fill the whole transcript — it clamps to
          USER_BUBBLE_MAX_PX and fades the overflow out at the bottom. */}
      <ClampedUserBubble />
    </MessagePrimitive.Root>
  )
}

/**
 * Max rendered height (px) of a user bubble before it clamps. ~6 lines at
 * the bubble's 15px/1.47 rhythm plus its py-2.5 padding. A long paste gets
 * cut here so it can't dominate the transcript; shorter messages render in
 * full and never clamp.
 */
const USER_BUBBLE_MAX_PX = 150

/** Join a user message's text parts into the full raw string (for the
 *  full-text modal + copy). */
function useUserMessageText(): string {
  const message = useMessage()
  return useMemo(() => {
    const content = (message as { content?: readonly unknown[] }).content
    if (!Array.isArray(content)) return ''
    let text = ''
    for (const part of content) {
      const p = part as { type?: string; text?: string }
      if (p.type === 'text' && typeof p.text === 'string') {
        text += (text ? '\n' : '') + p.text
      }
    }
    return text
  }, [message])
}

/**
 * The user bubble body, height-clamped when it overflows. We measure the
 * content's natural scrollHeight against USER_BUBBLE_MAX_PX (re-measuring on
 * resize) and only then apply the max-height + a bottom fade mask — so a
 * short message keeps clean edges and only a genuinely long one gets the
 * truncation + fade.
 *
 * When clamped, the bubble becomes clickable: a click opens a modal showing
 * the full message text (scrollable) with a copy button and close affordances
 * (✕ / backdrop / Esc). Short, un-clamped bubbles aren't clickable.
 */
function ClampedUserBubble(): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [clamped, setClamped] = useState(false)
  const [open, setOpen] = useState(false)
  const fullText = useUserMessageText()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      // scrollHeight is the full content height regardless of max-height;
      // compare against the cap to decide whether to clamp + fade.
      setClamped(el.scrollHeight > USER_BUBBLE_MAX_PX + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 表格预览「框选问 AI」的消息(首行协议标记,见 stores/filePreview):
  // 不走绿气泡,渲染成结构化卡片——文件名 + 范围 + 问题;完整 TSV 只在
  // CLI 侧文本里,不上屏。(hooks 已全部跑完,分支安全。)
  const sheetSel = parseSheetSelectionMessage(fullText)
  if (sheetSel) return <SheetSelectionCard meta={sheetSel} />

  // 图片标记编辑面板发出的消息（同一套首行协议标记）：渲染成紧凑卡片
  // ——图片名 + 各标记点描述 + 素材数；完整指令只在 CLI 侧文本里。
  const imgEdit = parseImageEditMessage(fullText)
  if (imgEdit) return <ImageEditCard meta={imgEdit} />

  return (
    <>
      <div
        ref={ref}
        // data-selectable：放开用户消息气泡文本可选（.chat-app 全局禁选之上）。
        // clamp 态下本 div 是 role=button，但拖选后松手不落在原点不算 click，
        // 选中与"点击展开全文"可共存。
        data-selectable="true"
        onClick={clamped ? () => setOpen(true) : undefined}
        role={clamped ? 'button' : undefined}
        tabIndex={clamped ? 0 : undefined}
        onKeyDown={
          clamped
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpen(true)
                }
              }
            : undefined
        }
        title={clamped ? '点击查看完整内容' : undefined}
        style={
          clamped
            ? {
                maxHeight: `${USER_BUBBLE_MAX_PX}px`,
                // Fade the bottom ~40px to transparent so the cut reads as
                // "there's more" rather than a hard slice. WebkitMaskImage for
                // Chromium (Electron's renderer).
                WebkitMaskImage:
                  'linear-gradient(to bottom, black 0, black calc(100% - 40px), transparent 100%)',
                maskImage:
                  'linear-gradient(to bottom, black 0, black calc(100% - 40px), transparent 100%)'
              }
            : undefined
        }
        className={
          'max-w-[80%] overflow-hidden whitespace-pre-wrap break-words rounded-[22px] bg-accent px-4 py-2.5 text-[15px] leading-[1.47] tracking-apple-body text-white empty:hidden ' +
          (clamped ? 'cursor-pointer transition hover:brightness-[1.06]' : '')
        }
      >
        <MessagePrimitive.Parts
          unstable_showEmptyOnNonTextEnd={false}
          components={{
            // Within the bubble, skip image parts — they're already
            // rendered above. We provide a no-op Image component so
            // nothing appears here, and render Text via UserBubbleText
            // so `@"path"` file mentions become inline file chips
            // instead of raw absolute paths.
            Image: () => null,
            Text: UserBubbleText
          }}
        />
      </div>
      {open ? (
        <UserMessageModal text={fullText} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

/**
 * 表格选区消息(替代绿气泡)。默认收起为「💬 1 条注释」小胶囊,鼠标
 * 移入在上方浮出完整卡片:Excel 徽章 + 文件名(点击重开预览)、
 * 「范围:工作表!A1:B2」、用户的问题——观感对齐文档类应用的注释交互
 * (2026-07-08 用户给的 WPS 风格参照)。
 */
function SheetSelectionCard({
  meta
}: {
  meta: SheetSelectionMeta
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="group/selcard relative">
      {/* 收起态胶囊。hover 反馈只提边框,展开动作由浮层自己接管。 */}
      <div className="flex cursor-default items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-[13.5px] font-medium text-foreground shadow-sm transition-colors group-hover/selcard:border-input">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-muted-foreground"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M8 9h8M8 13h5" />
        </svg>
        {t('sheetSelectionPill')}
      </div>
      {/* hover 浮层:pill 上方右对齐展开。opacity 过渡 + hover 时才接管
          指针(文件名可点击重开预览);离开即收。
          pill 与卡片间的 8px 间隙用容器的 pb-2 透明内边距桥接(不是 mb-2
          外边距)——外边距不在 group 的命中盒里,鼠标穿过缝隙会瞬断 hover
          致卡片抖没(2026-07-08 用户反馈「hover 不上去」)。内边距仍属容器,
          指针全程不脱离 .group/selcard。 */}
      <div className="pointer-events-none absolute bottom-full right-0 z-20 w-[400px] max-w-[72vw] pb-2 opacity-0 transition-opacity duration-150 group-hover/selcard:pointer-events-auto group-hover/selcard:opacity-100">
        <div
          data-selectable="true"
          className="overflow-hidden rounded-2xl border border-border bg-card text-left shadow-[0_2px_6px_rgba(0,0,0,0.06),0_16px_40px_-16px_rgba(0,0,0,0.35)]"
        >
          <div className="px-4 pt-3">
            <button
              type="button"
              disabled={!meta.path}
              onClick={() => {
                if (meta.path) {
                  useSheetPreviewStore.getState().openPreview(meta.path)
                }
              }}
              title={meta.path || undefined}
              className="group/file flex max-w-full items-center gap-2 text-left"
            >
              <span
                aria-hidden
                className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-[#217346] text-[10px] font-bold text-white"
              >
                X
              </span>
              <span className="truncate text-[13.5px] font-medium text-accent group-hover/file:underline">
                {meta.name}
              </span>
            </button>
            <div className="pt-1.5 text-[12.5px] text-muted-foreground">
              {t('sheetSelectionRange')}
              {meta.sheet ? `${meta.sheet}!` : ''}
              {meta.range}
            </div>
          </div>
          {meta.q ? (
            <div className="whitespace-pre-wrap break-words px-4 pb-3 pt-2 text-[14px] leading-[1.5] text-foreground">
              {meta.q}
            </div>
          ) : (
            <div className="pb-3" />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 图片标记编辑消息（替代绿气泡）。结构照抄 SheetSelectionCard：收起为
 * 「🖼 N 处图片修改」胶囊，hover 浮出完整卡片——图片名（点击重开编辑
 * 面板）+ 逐条标记描述 + 额外要求 + 融合素材计数。间隙桥接用 pb-2 内
 * 边距的原因见 SheetSelectionCard 内注释（外边距会瞬断 hover）。
 */
function ImageEditCard({ meta }: { meta: ImageEditMeta }): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  const editCount = meta.edits.length + (meta.extra ? 1 : 0)
  return (
    <div className="group/selcard relative">
      <div className="flex cursor-default items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-[13.5px] font-medium text-foreground shadow-sm transition-colors group-hover/selcard:border-input">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-muted-foreground"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        {zh ? `${editCount} 处图片修改` : `${editCount} image edits`}
      </div>
      <div className="pointer-events-none absolute bottom-full right-0 z-20 w-[400px] max-w-[72vw] pb-2 opacity-0 transition-opacity duration-150 group-hover/selcard:pointer-events-auto group-hover/selcard:opacity-100">
        <div
          data-selectable="true"
          className="overflow-hidden rounded-2xl border border-border bg-card text-left shadow-[0_2px_6px_rgba(0,0,0,0.06),0_16px_40px_-16px_rgba(0,0,0,0.35)]"
        >
          <div className="px-4 pt-3">
            <button
              type="button"
              disabled={!meta.path}
              onClick={() => {
                if (meta.path) {
                  useImageEditStore.getState().openEditor(meta.path)
                }
              }}
              title={meta.path || undefined}
              className="group/file flex max-w-full items-center gap-2 text-left"
            >
              <span
                aria-hidden
                className="grid size-5 shrink-0 place-items-center rounded-[5px] border border-border bg-background"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                  className="text-muted-foreground"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              </span>
              <span className="truncate text-[13.5px] font-medium text-accent group-hover/file:underline">
                {meta.name}
              </span>
            </button>
          </div>
          <div className="px-4 pb-3 pt-2 text-[14px] leading-[1.6] text-foreground">
            {meta.edits.map((e, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 font-semibold tabular-nums">
                  {i + 1}.
                </span>
                <span className="min-w-0 break-words">{e.note}</span>
              </div>
            ))}
            {meta.extra ? (
              <div className="flex gap-2">
                <span className="shrink-0 font-semibold">＋</span>
                <span className="min-w-0 break-words">{meta.extra}</span>
              </div>
            ) : null}
            {meta.fusion.length > 0 ? (
              <div className="pt-1 text-[12.5px] text-muted-foreground">
                {zh
                  ? `融合素材 ${meta.fusion.length} 张`
                  : `${meta.fusion.length} fusion image(s)`}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Full-text modal for a clamped user message. Portal'd to <body> over a
 * blurred backdrop (same lightbox pattern as the image viewer). Dismisses on
 * ✕ / backdrop click / Esc. A copy button lifts the raw text to the clipboard.
 */
function UserMessageModal({
  text,
  onClose
}: {
  text: string
  onClose: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = (): void => {
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-8">
      {/* Backdrop — owns dismiss-on-click. */}
      <div
        className="absolute inset-0 bg-background/78 backdrop-blur-lg"
        onClick={onClose}
        aria-hidden
      />
      {/* Card */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_30px_80px_-20px_rgba(0,0,0,0.4)]"
      >
        {/* Header: copy + close. data-slot 是功能性的：本弹窗 portal 到
            document.body、不在 .chat-app 子树内，缺它会被 canvas 裸 button
            reset 填成描边卡片（同 AssistantMessage 打开方式菜单的泄漏）。 */}
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-3 py-2">
          <button
            type="button"
            data-slot="modal-action"
            onClick={copy}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <CopyGlyph />
            {copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            data-slot="modal-action"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <CloseGlyph />
          </button>
        </div>
        {/* Full text — scrollable, preserves wrapping. */}
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-5 py-4 text-[14px] leading-[1.6] text-foreground">
          {text}
        </div>
      </div>
    </div>,
    document.body
  )
}

function CopyGlyph(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  )
}

function CloseGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

/**
 * Render the user bubble's text, turning `@"/abs/path"` / `@/abs/path`
 * file mentions into inline chips (document glyph + file name) instead
 * of dumping the raw absolute path into the blue bubble.
 *
 * Why here and not upstream: the wire format sent to fusion-code MUST
 * stay `@"path"` (extractAtMentionedFiles parses it), and the chat
 * store keeps that verbatim text so a reload re-renders identically.
 * The chip is a pure *display* transform applied at render time — the
 * stored/sent string is untouched, exactly like the composer's own
 * mention chips (chipNodeView) are a view layer over the same text.
 *
 * Matching mirrors fusion-code's own regexes (and pmSchema's TOKEN_RE):
 *   - quoted:  @"path with spaces.pdf"
 *   - bare:    @src/foo.ts   (runs to the next whitespace)
 * A mention is only recognized at start-of-string or after whitespace,
 * so `a@b` / `http://x` don't false-trigger.
 */
const USER_MENTION_RE = /(^|\s)(@"[^"]+"|@\S+)/g

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return name || path
}

/**
 * A leading slash command, e.g. `/claude-desktop:ppt-master rest...`. Only the
 * command token at the very start is matched — a `/` mid-text is left alone.
 * The command may carry a plugin namespace (`claude-desktop:`) and hyphens.
 */
const USER_SLASH_RE = /^(\/[\w:-]+)(\s|$)/

function UserBubbleText({ text }: { text: string }): React.JSX.Element {
  // Split into alternating plain-text / mention segments. We keep the
  // leading-whitespace capture group so spacing around chips is faithful.
  const nodes: React.ReactNode[] = []
  let last = 0
  let key = 0

  // Leading skill command → friendly chip (icon + 「制作PPT」/「生成图片」),
  // mirroring the composer chip. Pure display transform: the stored/sent text
  // keeps the raw `/claude-desktop:…` verbatim. Only known skills (those in the
  // chip registry) get the treatment; other `/cmd` stays plain text.
  const slashMatch = USER_SLASH_RE.exec(text)
  const slashSkill = slashMatch ? findSkillChipSpec(slashMatch[1]!) : null
  if (slashMatch && slashSkill) {
    nodes.push(
      <span
        key={`sk-${key++}`}
        title={slashMatch[1]}
        className="mr-0.5 inline-flex items-center gap-1 rounded-md bg-white/20 px-1.5 py-0.5 align-baseline text-[13px] font-medium ring-1 ring-white/25"
      >
        <svg width={12} height={12} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
          {fileIconPathsByKey(slashSkill.icon).map((p, pi) => (
            <path key={pi} d={p.d} fill={p.fill} />
          ))}
        </svg>
        <span>{slashSkill.label}</span>
      </span>
    )
    // Skip past the command token (keep the separating space as plain text).
    last = slashMatch[1]!.length
  }

  let m: RegExpExecArray | null
  USER_MENTION_RE.lastIndex = last
  while ((m = USER_MENTION_RE.exec(text)) !== null) {
    const lead = m[1] ?? ''
    const token = m[2]!
    const tokenStart = m.index + lead.length
    // Plain text before this mention (including the captured leading WS).
    if (tokenStart > last) {
      nodes.push(text.slice(last, tokenStart))
    }
    // Strip the `@` and any surrounding quotes to get the raw path.
    const raw = token.slice(1)
    const path =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    nodes.push(
      <span
        key={`fm-${key++}`}
        title={path}
        className="mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-md bg-white/20 px-1.5 py-0.5 align-baseline text-[13px] font-medium ring-1 ring-white/25"
      >
        {/* Per-type glyph, but NOT coloured — the chip sits on the blue
            user bubble where the icon inherits the bubble's white text;
            a type accent colour would read as dirty here. */}
        <FileTypeIcon
          pathOrName={path}
          size={12}
          className="shrink-0 opacity-90"
        />
        <span className="truncate">{basenameOf(path)}</span>
      </span>
    )
    last = tokenStart + token.length
  }
  if (last < text.length) {
    nodes.push(text.slice(last))
  }
  // No mentions → render the string as-is (keeps the common path cheap).
  if (nodes.length === 0) return <>{text}</>
  return <>{nodes}</>
}

/**
 * Render a user-attached image as a thumbnail chip above the message
 * bubble. `image` is the data URL that flowed through:
 *   paste → imageAttachmentAdapter.send → ImageMessagePart.image
 *         → AppendMessage → chat store.appendUserMessage → here
 *
 * We cap the thumbnail at 220×220 (object-cover crops overflow); clicking
 * it opens an in-app lightbox modal — ESC or backdrop click dismisses.
 */
function UserImagePart({
  image,
  filename
}: {
  image: string
  filename?: string
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const altText = filename ?? t('imageAttachedAlt')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-block max-w-[80%] cursor-zoom-in overflow-hidden rounded-xl border border-input bg-card/70 transition hover:border-input"
        title={altText}
      >
        <img
          src={image}
          alt={altText}
          className="max-h-[220px] max-w-full object-cover"
        />
      </button>
      {/* Portal the lightbox into document.body so `position: fixed`
          covers the entire window, not just the ThreadView column.
          Ancestors in the message tree (motion wrappers, assistant-ui
          Viewport) set `transform` / `will-change` which turns them
          into containing blocks for fixed descendants, causing the
          modal to visually clip to the chat column. Portaling escapes
          that chain entirely. */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={filename ?? t('imagePreviewAria')}
              // `WebkitAppRegion: no-drag` on the outer wrapper — the
              // root layout's `.window-drag-strip` keeps the window's
              // top 46px a native drag zone (screen coordinates, not
              // DOM). Without a `no-drag` override on the modal, that
              // strip (overlapping the lightbox top) would swallow
              // clicks there (backdrop dismiss, image click, close
              // button top half) into a window drag. `no-drag`
              // inherits through the subtree so every interactive
              // element in the lightbox is click-safe.
              //
              // No onClick here — dismiss-on-backdrop lives on the blur
              // layer below so the close button's click has a clean
              // path and doesn't need to fight with this wrapper.
              style={
                { WebkitAppRegion: 'no-drag' } as React.CSSProperties
              }
              className="fixed inset-0 z-[100] flex items-center justify-center"
            >
              {/* Blur layer — owns the backdrop dismiss. Static
                  backdrop-filter isolated in its own layer so Chromium
                  doesn't re-run the blur on every frame of the opacity
                  tween (backdrop-filter + animated opacity is the #1
                  cause of laggy modal transitions in Electron).
                  Entry and exit share the same tween duration with
                  entry using easeOutExpo (snappy start, soft stop)
                  and exit using easeInOutQuad (gentle both ends) so
                  the close doesn't feel like it's been yanked away. */}
              <motion.div
                aria-hidden
                onClick={() => setOpen(false)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.28,
                  ease: [0.22, 1, 0.36, 1]
                }}
                style={{ willChange: 'opacity' }}
                className="absolute inset-0 z-0 bg-background/78 backdrop-blur-lg"
              />

              {/* Image wrapper. `z-10` sits above the blur layer; the
                  motion element creates its own stacking context via
                  `willChange: transform` anyway, but the explicit z
                  makes hit-test order unambiguous. Tween with
                  cubic-bezier easeOutExpo — snappier and more
                  predictable than the old bouncy spring. Exit uses a
                  gentler scale-down (0.94, matching the entry) so the
                  reverse motion reads as a true inverse instead of
                  snapping shut. */}
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{
                  opacity: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
                  scale: { duration: 0.36, ease: [0.22, 1, 0.36, 1] }
                }}
                style={{ willChange: 'transform, opacity' }}
                className="relative z-10 flex max-h-[85vh] max-w-[90vw] flex-col items-center transform-gpu"
              >
                <img
                  src={image}
                  alt={altText}
                  onClick={() => setOpen(false)}
                  draggable={false}
                  className="max-h-[85vh] max-w-[90vw] cursor-zoom-out rounded-xl object-contain shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/10"
                />
                {/* Filename caption pill. Only shown when we actually
                    know the name — pasted clipboard images have none. */}
                {filename && (
                  <div className="mt-3 max-w-full truncate rounded-full border border-border/60 bg-card/80 px-3 py-1 font-mono text-[11px] text-muted-foreground">
                    {filename}
                  </div>
                )}
              </motion.div>

              {/* Close button — `motion.button` with **opacity-only**
                  animation. No `scale` / `y` / `rotate`: those would
                  introduce a transform layer and re-trigger the
                  earlier hit-test bug where the button's top half was
                  unclickable (will-change: transform + the image
                  wrapper's transform-gpu layer made Chromium's
                  cross-layer hit-test non-deterministic). Pure
                  opacity fades don't create a transform containing
                  block, so the hit rect stays exactly the layout box.
                  Hit target: `p-2.5` extends the clickable region to
                  60×60 while the visible 40×40 pill is an inner span.
                  `WebkitAppRegion: no-drag` is inherited from the
                  parent wrapper but spelled out here defensively —
                  the app header's drag region would otherwise swallow
                  clicks on the top half of the button. */}
              <motion.button
                type="button"
                // data-slot：portal 到 body、脱离 .chat-app 豁免子树，防
                // canvas 裸 button reset 泄漏（同文件上方全文弹窗同款）。
                data-slot="modal-action"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                }}
                aria-label={t('imagePreviewClose')}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.28,
                  ease: [0.22, 1, 0.36, 1]
                }}
                style={
                  {
                    WebkitAppRegion: 'no-drag',
                    willChange: 'opacity'
                  } as React.CSSProperties
                }
                className="group/close fixed right-4 top-4 z-50 flex items-center justify-center p-2.5"
              >
                <span
                  aria-hidden
                  className="flex size-10 items-center justify-center rounded-full border border-border/70 bg-background/90 text-foreground shadow-lg transition-colors group-hover/close:border-input group-hover/close:bg-muted"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
              </motion.button>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
