import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'

import type { WrittenFile } from '../../../stores/chat'
import { AssistantMarkdown } from '../AssistantMarkdown'
import { escapeHtml, languageFromPath } from './codeViewUtils'

/**
 * Per-type glyph text for the file-list rows: a tiny mono badge standing in
 * for a real icon set. Deliberately neutral (no per-type colours) — the only
 * colour channel in the list is accent = selected, so state stays readable.
 */
function fileGlyph(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return 'MD'
  if (ext === 'json' || ext === 'jsonc') return '{}'
  return (ext || '?').slice(0, 2).toUpperCase()
}

/**
 * 文件 canvas tab body: every file written this session in a two-pane layout
 * (file list left, selected file's content right), mirroring SlidesLivePreview's
 * shape. Until the user manually picks a file it follows the newest write, so
 * each Write surfaces its content immediately; a manual pick pins the view.
 *
 * The content is the same text the inline Write card would have shown — but in
 * slides mode that inline preview is suppressed (writeHandledByCanvas), so this
 * is the one place it renders. Streaming writes show a live, growing preview.
 *
 * Visual language (files-panel-prototype-v2.html): the content sits on a
 * "sheet of paper" floating over the dot-grid stage — the same paper-on-stage
 * metaphor the slides canvas uses — instead of filling the pane edge-to-edge.
 */
export function WrittenFilesPanel({
  files,
  newestPath
}: {
  files: WrittenFile[]
  newestPath?: string
}): React.JSX.Element {
  const [active, setActive] = useState<string | null>(null)
  // 阅读/源码 toggle, panel-level so it survives file switches. Non-markdown
  // files have no rich rendering — they force the source view at render time
  // WITHOUT overwriting the user's sticky choice for the next .md file.
  const [view, setView] = useState<'read' | 'src'>('read')
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  // Reading-progress bar: scroll fires per frame, so the width update goes
  // straight to the DOM through this ref. Routing it through setState would
  // re-render the whole Markdown subtree on every scroll tick — visibly
  // janky on long documents.
  const progressRef = useRef<HTMLDivElement | null>(null)
  // True until the user clicks a file — while true the view auto-follows the
  // newest write so generation is watchable; a manual pick pins it.
  const followLatestRef = useRef(true)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  // Follow the newest write while unpinned (and seed the initial selection).
  useEffect(() => {
    if (followLatestRef.current && newestPath) setActive(newestPath)
  }, [newestPath])

  // Resolve the selected file; fall back to the newest if the pinned path
  // vanished (shouldn't happen — writes only accumulate — but stay defensive).
  const selected =
    files.find((f) => f.path === active) ?? files[files.length - 1] ?? null

  const pick = (path: string): void => {
    followLatestRef.current = false // manual pick pins the view
    setActive(path)
  }

  // Non-markdown files only have a source rendering; keep the user's sticky
  // `view` untouched and just force the effective view for this file.
  const isMd = selected ? /\.(md|markdown)$/i.test(selected.name) : false
  const effView: 'read' | 'src' = isMd ? view : 'src'

  const meta = useMemo(() => {
    if (!selected) return ''
    const lines = selected.content.split('\n').length
    const chars = selected.content.replace(/\s/g, '').length
    const charLabel = chars > 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars)
    return `${lines} 行 · 约 ${charLabel} 字`
  }, [selected?.content])

  const copySelected = async (): Promise<void> => {
    if (!selected) return
    try {
      await navigator.clipboard.writeText(selected.content)
    } catch {
      // Clipboard denial still flips the button state — the click must feel
      // acknowledged either way.
    }
    setCopied(true)
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400)
  }

  const segBtnCls = (on: boolean): string =>
    'flex h-6 items-center gap-1 rounded-md px-2.5 text-[11.5px] transition-colors ' +
    (on
      ? 'bg-background font-medium text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground')

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* File list */}
      <div className="w-[216px] shrink-0 overflow-y-auto border-r border-border/60 px-2 py-1.5">
        {files.map((f, i) => {
          const on = f.path === selected?.path
          return (
            <button
              key={f.path}
              type="button"
              onClick={() => pick(f.path)}
              className={
                'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors ' +
                (on ? 'bg-brand/10' : 'hover:bg-foreground/[0.04]')
              }
              title={f.path}
            >
              <span className="w-4 shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span
                className={
                  'grid size-[19px] shrink-0 place-items-center rounded-[5px] font-mono text-[7.5px] font-bold transition-colors ' +
                  (on
                    ? 'bg-brand text-brand-foreground'
                    : 'border border-border bg-muted/60 text-muted-foreground')
                }
              >
                {fileGlyph(f.name)}
              </span>
              <span
                className={
                  'min-w-0 truncate ' +
                  (on ? 'font-medium text-foreground' : 'text-muted-foreground')
                }
              >
                {f.name}
              </span>
              {f.streaming && (
                <span
                  aria-hidden
                  className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                />
              )}
            </button>
          )
        })}
      </div>

      {/* Stage: dot-grid backdrop with the document floating as a paper sheet.
          Same pattern CanvasConfirm's style cards use (var(--color-border)
          dots track the theme), scaled up to a full pane. */}
      <div
        className="bg-art-transparent flex min-w-0 flex-1 justify-center overflow-hidden bg-muted/30 p-5"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, var(--color-border, rgba(0,0,0,0.12)) 1px, transparent 0)',
          backgroundSize: '14px 14px'
        }}
      >
        {selected ? (
          // 毛玻璃质感（2026-07-18，跟 workspace 面同一批 /70 + blur-xl）：
          // 这张"纸片卡"承载源码/JSON 正文，优先保证可读性，透明度跟大块
          // 阅读区（workspace 容器、问题卡）同档而不是更透的 chrome 档位。
          <div className="flex min-h-0 w-full max-w-[880px] flex-col overflow-hidden rounded-xl border border-border/60 bg-card/70 shadow-[0_1px_2px_rgba(0,0,0,0.05),0_10px_28px_rgba(0,0,0,0.08)] backdrop-blur-xl backdrop-saturate-150 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_14px_36px_rgba(0,0,0,0.45)]">
            <div className="relative flex h-[46px] shrink-0 items-center gap-2.5 border-b border-border/60 px-3.5">
              <div className="grid size-[26px] shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-3.5"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
              </div>
              <div className="flex min-w-0 flex-col">
                <code
                  className="truncate font-mono text-[12.5px] font-semibold leading-tight text-foreground"
                  title={selected.path}
                >
                  {selected.name}
                </code>
                <span className="flex items-center gap-1.5 text-[10.5px] leading-tight text-muted-foreground/70">
                  {selected.streaming ? (
                    <>
                      <span
                        aria-hidden
                        className="size-[5px] animate-pulse rounded-full bg-accent"
                      />
                      写入中…
                    </>
                  ) : (
                    meta
                  )}
                </span>
              </div>
              <div className="flex-1" />

              {/* 阅读 / 源码 — markdown renders rich by default; everything
                  else is source-only so 阅读 is disabled. */}
              <div className="flex gap-0.5 rounded-lg bg-muted/60 p-[3px]">
                <button
                  type="button"
                  disabled={!isMd}
                  onClick={() => setView('read')}
                  className={segBtnCls(effView === 'read')}
                >
                  阅读
                </button>
                <button
                  type="button"
                  onClick={() => setView('src')}
                  className={segBtnCls(effView === 'src')}
                >
                  源码
                </button>
              </div>

              <button
                type="button"
                onClick={() => void copySelected()}
                title="复制内容"
                className={
                  'grid size-7 shrink-0 place-items-center rounded-md transition-colors ' +
                  (copied
                    ? 'text-accent'
                    : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground')
                }
              >
                {copied ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-3.5"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-3.5"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>

              {/* Reading progress: hairline accent fill along the header's
                  bottom edge, width driven imperatively via progressRef. */}
              <div className="pointer-events-none absolute inset-x-0 -bottom-px h-[1.5px]">
                <div ref={progressRef} className="h-full w-0 bg-accent" />
              </div>
            </div>
            {/* Keyed by path so switching files resets the scroll/follow state
                (a fresh mount), while same-file streaming updates re-render in
                place and keep auto-scrolling. */}
            <WrittenFileContent
              key={selected.path}
              file={selected}
              view={effView}
              paper
              progressRef={progressRef}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
            选择左侧文件查看内容
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The selected written file's body, rendered richly rather than as raw text:
 *   - Markdown files (.md) → AssistantMarkdown, so the deck outline reads as a
 *     real document (headings, lists, tables) instead of a `#`/`-` soup.
 *   - Everything else → highlight.js syntax highlighting (same hljs + palette
 *     as CodeFileView, but in a full-height scroll area, no max-h/fade mask).
 *
 * Auto-scroll-to-bottom: while a file is still streaming we follow the tail so
 * the newest lines stay in view — UNLESS the user has scrolled up to read
 * earlier content, in which case we leave them where they are (re-engaging only
 * when they scroll back near the bottom). Mounted with `key={path}` by the
 * parent, so each file starts at the top with follow re-armed.
 */
function WrittenFileContent({
  file,
  view = 'read',
  paper = false,
  progressRef
}: {
  file: WrittenFile
  /** 'read' = rich rendering for .md; 'src' = raw source through hljs. */
  view?: 'read' | 'src'
  /** Paper mode (文件 tab): narrow centered column + streaming caret. */
  paper?: boolean
  /** Optional reading-progress bar; width written imperatively on scroll. */
  progressRef?: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether to keep pinning the view to the bottom as content grows. Starts
  // true; a manual scroll-up turns it off, scrolling back near the bottom
  // turns it on again. A ref (not state) so the scroll handler and the
  // post-render effect share it without extra renders.
  const followBottomRef = useRef(true)

  const isMarkdown = /\.(md|markdown)$/i.test(file.path)
  // Markdown only renders rich in the 阅读 view; the 源码 view routes it
  // through hljs like any other file (md has a 'markdown' language mapping).
  const renderRich = isMarkdown && view === 'read'
  const language = languageFromPath(file.path)

  // hljs highlight (skipped when AssistantMarkdown handles the content).
  const html = useMemo(() => {
    if (renderRich) return ''
    // 流式期间跳过高亮：file.content 每个 delta 都变，对全量内容重跑 hljs
    // 是 O(n²) 主线程开销，尾段单次可达数十 ms，叠加每 delta 的 React 渲染
    // 直接掉帧。跟随尾部滚动时用户本来也看不清着色，纯文本足够；streaming
    // 翻 false 后 memo 依赖变化会自动跑一次完整高亮补上颜色。
    if (file.streaming) return escapeHtml(file.content)
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(file.content, { language, ignoreIllegals: true }).value
      }
      // 未知扩展名不做 highlightAuto——它是 hljs 最贵的路径（对全部语法库
      // 逐一打分），与 AssistantMarkdown 的 detect:false 决策对齐，直接返回
      // 转义后的纯文本。
      return escapeHtml(file.content)
    } catch {
      return escapeHtml(file.content)
    }
  }, [file.content, file.streaming, language, renderRich])

  // Progress goes straight to the bar's DOM node — see progressRef's comment
  // in WrittenFilesPanel for why this must not be React state.
  const reportProgress = useCallback((): void => {
    const el = scrollRef.current
    const bar = progressRef?.current
    if (!el || !bar) return
    const max = el.scrollHeight - el.clientHeight
    bar.style.width = max > 4 ? `${(el.scrollTop / max) * 100}%` : '0%'
  }, [progressRef])

  // Track whether the user is near the bottom; only then do we auto-follow.
  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40
    followBottomRef.current = nearBottom
    reportProgress()
  }, [reportProgress])

  // View toggles swap the whole body without remounting (key is the path),
  // so reset the scroll position and re-sync the progress bar ourselves.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    reportProgress()
  }, [view, reportProgress])

  // After each content update, if we're still following (and the file is
  // actively streaming), stick to the bottom so new lines stay visible.
  // Content growth also moves the progress ratio, so re-sync the bar here.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (file.streaming && followBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
    reportProgress()
  }, [file.content, file.streaming, reportProgress])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={
        'min-h-0 flex-1 overflow-auto ' + (paper ? '' : 'px-4 py-3')
      }
    >
      {/* Paper mode narrows the measure to a readable column; the plain mode
          (大纲 tab) keeps the original edge-to-edge layout. */}
      <div className={paper ? 'mx-auto max-w-[700px] px-10 pb-14 pt-9' : undefined}>
        {renderRich ? (
          <AssistantMarkdown text={file.content} />
        ) : (
          <pre
            className={
              // Paper mode wraps long lines (the narrow column would otherwise
              // force sideways scrolling inside the sheet); plain mode keeps
              // the original pre + horizontal scroll behaviour.
              (paper ? 'whitespace-pre-wrap break-words' : 'whitespace-pre') +
              " font-mono text-[11.5px] leading-[1.55] text-foreground/90 [font-feature-settings:'calt','tnum']"
            }
            // hljs returns escaped HTML with <span class="hljs-*"> wrappers that
            // our highlight.css palette already targets — same as CodeFileView.
            dangerouslySetInnerHTML={{ __html: html || escapeHtml(file.content) }}
          />
        )}
        {paper && file.streaming && (
          <div
            aria-hidden
            className="mt-3 h-[17px] w-[7px] animate-pulse rounded-[2px] bg-accent"
          />
        )}
      </div>
    </div>
  )
}
