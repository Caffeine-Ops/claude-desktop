import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantMarkdown } from './AssistantMarkdown'
import type { WrittenFile } from '../../stores/chat'

/**
 * OutlinePanel
 * ------------
 * The 大纲 tab's design_spec.md reader. design_spec has a FIXED 11-chapter
 * structure (ppt-master strategist.md §6.2: I. Project Information … XI.
 * Technical Constraints Reminder), which makes it a real *document* — so
 * instead of piping the whole file through one AssistantMarkdown (endless
 * scroll, no wayfinding), we:
 *
 *   - split the markdown into chapters on H2 headings (code fences respected),
 *   - render a sticky chapter TOC with scrollspy + click-to-jump,
 *   - show per-chapter write status while the AI is still streaming the spec
 *     (done / writing / pending — pending names come from the §6.2 skeleton),
 *   - give each chapter a roman-numeral badge header, with its BODY still
 *     rendered by AssistantMarkdown (tables/lists/code keep their styling).
 *
 * Parsing is a thin structural layer over markdown we don't control (the AI
 * writes the spec), so it must never make things worse than the old flat
 * rendering: if no H2 chapters are found, we fall back to exactly that.
 *
 * What we deliberately do NOT parse: the per-slide entries inside IX. Content
 * Outline. Their markdown shape (Part headings / Slide H3s / bullets) isn't
 * contractual, and a wrong card-ification reads worse than plain markdown.
 */

/** §6.2's fixed chapter skeleton — used only to name not-yet-written chapters
 *  while the spec is still streaming. */
const EXPECTED_CHAPTERS: readonly string[] = [
  'Project Information',
  'Canvas Specification',
  'Visual Theme',
  'Typography System',
  'Layout Principles',
  'Icon Usage Spec',
  'Visualization Reference List',
  'Image Resource List',
  'Content Outline',
  'Speaker Notes Requirements',
  'Technical Constraints Reminder'
]

const ROMANS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'] as const

/** 1-based ordinal for a roman numeral (I → 1); null when not I–XII. */
function romanOrdinal(roman: string | null): number | null {
  if (!roman) return null
  const i = (ROMANS as readonly string[]).indexOf(roman.toUpperCase())
  return i === -1 ? null : i + 1
}

interface SpecChapter {
  key: string
  /** 'I'…'XII' when the heading starts with one, else null. */
  roman: string | null
  /** Heading text with the roman prefix stripped. */
  title: string
  /** Chapter markdown body (heading line excluded). */
  body: string
}

/**
 * Split markdown into an H2-per-chapter list. Fence-aware: a `## ` line inside
 * a ``` / ~~~ block is content, not a heading (specs embed SVG/code samples).
 * `preamble` is anything before the first H2 (usually the H1 title line).
 */
function parseSpecChapters(content: string): { preamble: string; chapters: SpecChapter[] } {
  const lines = content.split('\n')
  const chapters: SpecChapter[] = []
  const preambleLines: string[] = []
  let cur: { roman: string | null; title: string; body: string[] } | null = null
  let inFence = false

  const push = (): void => {
    if (!cur) return
    chapters.push({
      key: `${chapters.length}-${cur.title}`,
      roman: cur.roman,
      title: cur.title,
      body: cur.body.join('\n').trim()
    })
  }

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const h2 = !inFence && /^##\s+(.+?)\s*$/.exec(line)
    // `###` also matches /^##\s?/ patterns if written sloppily — require the
    // char after ## to not be another # via the capture not starting with #.
    if (h2 && !h2[1].startsWith('#')) {
      push()
      // "VII. Visualization Reference List" / "VII、…" / "VII Visualization …"
      const m = /^([IVXLCDM]+)\s*[.、:：]?\s+(.+)$/i.exec(h2[1])
      const roman = m && romanOrdinal(m[1]) !== null ? m[1].toUpperCase() : null
      cur = { roman, title: roman && m ? m[2] : h2[1], body: [] }
      continue
    }
    if (cur) cur.body.push(line)
    else preambleLines.push(line)
  }
  push()
  return { preamble: preambleLines.join('\n').trim(), chapters }
}

export function OutlinePanel({ file }: { file: WrittenFile }): React.JSX.Element {
  const { preamble, chapters } = useMemo(() => parseSpecChapters(file.content), [file.content])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<(HTMLElement | null)[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  // Follow-bottom while streaming (same contract as WrittenFileContent): pin
  // to the end as content grows; a manual scroll-up releases the pin.
  const followBottomRef = useRef(true)
  const spyRafRef = useRef(0)
  // Hide the TOC when the canvas pane is too narrow for a two-column layout.
  // Viewport media queries can't see the pane's width, so measure it.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 640))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // scrollspy: the last chapter whose top has passed the viewport's upper
  // band is "current". rAF-throttled; also maintains the follow-bottom flag.
  const spy = useCallback((): void => {
    spyRafRef.current = 0
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop + 80
    let idx = 0
    sectionRefs.current.forEach((sec, i) => {
      if (sec && sec.offsetTop <= top) idx = i
    })
    setActiveIdx((prev) => (prev === idx ? prev : idx))
    followBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const onScroll = useCallback((): void => {
    if (!spyRafRef.current) spyRafRef.current = requestAnimationFrame(spy)
  }, [spy])
  useEffect(() => {
    return () => {
      if (spyRafRef.current) cancelAnimationFrame(spyRafRef.current)
    }
  }, [])

  // Streaming growth: keep pinned to the bottom while following, so the
  // freshly written lines (and newly appearing chapters) stay in view.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (file.streaming && followBottomRef.current) el.scrollTop = el.scrollHeight
  }, [file.content, file.streaming])

  const jumpTo = useCallback((i: number): void => {
    const el = scrollRef.current
    const sec = sectionRefs.current[i]
    // scrollIntoView would fight the outer layout; scroll the container.
    if (el && sec) el.scrollTo({ top: sec.offsetTop - 8, behavior: 'smooth' })
  }, [])

  // Not-yet-written chapters (TOC only, greyed): shown only while streaming
  // AND only when the written chapters track the §6.2 roman sequence — if the
  // AI numbers differently we don't guess at what's next.
  const pendingNames = useMemo(() => {
    if (!file.streaming || chapters.length === 0) return []
    const last = romanOrdinal(chapters[chapters.length - 1]?.roman ?? null)
    if (last === null || last >= EXPECTED_CHAPTERS.length) return []
    if (last !== chapters.length) return [] // sequence doesn't line up — don't guess
    return EXPECTED_CHAPTERS.slice(last)
  }, [chapters, file.streaming])

  const lineCount = useMemo(() => file.content.split('\n').length, [file.content])
  const totalSlots = chapters.length + pendingNames.length

  // ── fallback: no H2 chapters (unexpected spec shape) → old flat render ──
  if (chapters.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <OutlineHeader file={file} lineCount={lineCount} done={0} total={0} />
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <AssistantMarkdown text={file.content} />
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <OutlineHeader
        file={file}
        lineCount={lineCount}
        done={file.streaming ? chapters.length - 1 : chapters.length}
        total={file.streaming ? Math.max(totalSlots, EXPECTED_CHAPTERS.length) : chapters.length}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── chapter TOC ── */}
        {!narrow && (
          <nav className="w-[196px] shrink-0 overflow-y-auto border-r border-border/60 px-2 py-2.5">
            <div className="px-2.5 pb-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              章节
            </div>
            {chapters.map((ch, i) => {
              const on = i === activeIdx
              const writing = file.streaming && i === chapters.length - 1
              return (
                <button
                  key={ch.key}
                  type="button"
                  onClick={() => jumpTo(i)}
                  title={ch.title}
                  className={
                    'relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ' +
                    (on
                      ? 'bg-accent/10 font-medium text-accent'
                      : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground')
                  }
                >
                  {on && (
                    <span className="absolute bottom-[7px] left-0 top-[7px] w-[2.5px] rounded-full bg-accent" />
                  )}
                  <span
                    className={
                      'w-[24px] shrink-0 text-[10px] font-semibold tabular-nums ' +
                      (on ? 'text-accent' : 'text-muted-foreground/60')
                    }
                  >
                    {ch.roman ?? String(i + 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{ch.title}</span>
                  {writing ? (
                    <span className="size-[6px] shrink-0 animate-pulse rounded-full bg-accent" />
                  ) : (
                    <span className="size-[5px] shrink-0 rounded-full bg-accent/60" />
                  )}
                </button>
              )
            })}
            {pendingNames.map((name, i) => (
              <div
                key={name}
                title={name}
                className="flex w-full cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-muted-foreground/40"
              >
                <span className="w-[24px] shrink-0 text-[10px] font-semibold tabular-nums">
                  {ROMANS[chapters.length + i] ?? ''}
                </span>
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </div>
            ))}
          </nav>
        )}

        {/* ── document ── */}
        <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[780px] px-6 pb-16 pt-4">
            {preamble && (
              <div className="pb-2">
                <AssistantMarkdown text={preamble} />
              </div>
            )}
            {chapters.map((ch, i) => {
              const writing = file.streaming && i === chapters.length - 1
              return (
                <section
                  key={ch.key}
                  ref={(el) => {
                    sectionRefs.current[i] = el
                  }}
                  className="pb-9 pt-2"
                >
                  <div className="mb-3.5 flex items-center gap-2.5">
                    <span className="grid h-6 min-w-[34px] shrink-0 place-items-center rounded-[7px] bg-accent/10 px-2 text-[11.5px] font-bold tracking-wide text-accent">
                      {ch.roman ?? String(i + 1)}
                    </span>
                    <h2 className="text-[16px] font-bold tracking-tight text-foreground">
                      {ch.title}
                    </h2>
                  </div>
                  <AssistantMarkdown text={ch.body} />
                  {writing && (
                    <div className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground/70">
                      <span className="h-[15px] w-[2px] animate-pulse rounded-sm bg-accent" />
                      AI 正在写入本章…
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Doc header: badge + filename + live status, and a per-chapter progress
 *  strip while the spec is still being written. */
function OutlineHeader({
  file,
  lineCount,
  done,
  total
}: {
  file: WrittenFile
  lineCount: number
  done: number
  total: number
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-border/60 px-4 py-2">
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
          <path d="M14 2v6h6M9 13h6M9 17h4" />
        </svg>
      </div>
      <code className="min-w-0 truncate font-mono text-[12.5px] font-semibold text-foreground" title={file.path}>
        {file.name}
      </code>
      {file.streaming ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-[10.5px] font-semibold text-accent">
          <span className="size-[5px] animate-pulse rounded-full bg-accent" />
          写入中
        </span>
      ) : (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">
          {total > 0 ? `${total} 章 · ${lineCount} 行` : `${lineCount} 行`}
        </span>
      )}
      <div className="flex-1" />
      {/* Chapter progress only reads meaningfully mid-write; once the spec is
          done the count in the subtitle says it all. */}
      {file.streaming && total > 0 && (
        <div className="flex shrink-0 items-center gap-2" title="章节写入进度">
          <div className="flex gap-[3px]">
            {Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                className={
                  'h-[4px] w-[11px] rounded-full ' +
                  (i < done ? 'bg-accent' : i === done ? 'animate-pulse bg-accent/40' : 'bg-muted-foreground/20')
                }
              />
            ))}
          </div>
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {done} / {total} 章
          </span>
        </div>
      )}
    </div>
  )
}
