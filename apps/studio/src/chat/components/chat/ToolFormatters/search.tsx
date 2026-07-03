import React from 'react'

import type { Lang } from '../../../i18n'
import { extractText, getStringArg } from '../toolHelpers'
import { basename, isObj, pick } from './helpers'
import type { FormatterCtx, FriendlyView } from './types'

export function formatGrep({
  args,
  result,
  lang
}: FormatterCtx): FriendlyView | null {
  const pattern = getStringArg(args, 'pattern')
  if (!pattern) return null
  const path = getStringArg(args, 'path')
  const glob = getStringArg(args, 'glob')
  const type = getStringArg(args, 'type')
  const outputMode = getStringArg(args, 'output_mode') ?? 'files_with_matches'
  const caseInsensitive =
    isObj(args) && Boolean((args as Record<string, unknown>)['-i'])

  // Compact the headline scope: a full absolute path trashes the card
  // layout when the user ran a repo-wide search, so we surface only
  // the glob / type / basename and stash the full path in `title`.
  const scopeLabel = glob ?? type ?? (path ? basename(path) : undefined)
  const scopeTitle = path

  const resultText = extractText(result).replace(/\s+$/, '')

  // Empty result → short "no matches" pane.
  if (!resultText) {
    return {
      headline: renderGrepHeadline(
        pattern,
        scopeLabel,
        scopeTitle,
        lang
      ),
      input: null,
      output: {
        label: pick(lang, '结果', 'Result'),
        content: (
          <span className="font-mono text-[11.5px] text-muted-foreground/60">
            {pick(lang, '无匹配', 'No matches')}
          </span>
        ),
        copyText: ''
      }
    }
  }

  // output_mode: files_with_matches → one file per line.
  // output_mode: count              → `file:N` per line.
  // output_mode: content            → ripgrep `file:line:text` / context.
  // We render files_with_matches / count as a plain file list, and
  // content through the structured match grouper.
  if (outputMode === 'files_with_matches') {
    const files = resultText.split('\n').filter(Boolean)
    return {
      headline: renderGrepHeadline(pattern, scopeLabel, scopeTitle, lang),
      input: null,
      output: {
        label: pick(
          lang,
          `文件（${files.length}）`,
          `Files (${files.length})`
        ),
        content: (
          <ul className="max-h-80 space-y-0.5 overflow-auto font-mono text-[11.5px] text-foreground/85">
            {files.map((f, i) => (
              <li key={i} className="truncate" title={f}>
                {f}
              </li>
            ))}
          </ul>
        ),
        copyText: files.join('\n')
      }
    }
  }

  if (outputMode === 'count') {
    const rows = resultText
      .split('\n')
      .map((l) => {
        const m = /^(.+):(\d+)$/.exec(l)
        return m ? { file: m[1]!, count: parseInt(m[2]!, 10) } : null
      })
      .filter((r): r is { file: string; count: number } => r !== null)
    const total = rows.reduce((acc, r) => acc + r.count, 0)
    return {
      headline: renderGrepHeadline(pattern, scopeLabel, scopeTitle, lang),
      input: null,
      output: {
        label: pick(lang, `共 ${total} 处`, `${total} matches`),
        content: (
          <ul className="max-h-80 space-y-0.5 overflow-auto font-mono text-[11.5px] text-foreground/85">
            {rows.map((r, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-10 shrink-0 text-right tabular-nums text-accent">
                  {r.count}
                </span>
                <span className="min-w-0 flex-1 truncate" title={r.file}>
                  {r.file}
                </span>
              </li>
            ))}
          </ul>
        ),
        copyText: resultText
      }
    }
  }

  // output_mode === 'content' — structured render.
  const groups = parseRipgrepContent(resultText)
  const matchCount = groups.reduce(
    (acc, g) => acc + g.lines.filter((l) => l.isMatch).length,
    0
  )

  // Markdown-aware line rendering: when the match comes from a `.md`
  // file (either detected on the per-group file path, or on the
  // overall glob / path arg), strip out the inline markdown tokens
  // (**bold**, `code`, | tables |, …) so the snippet reads like prose
  // instead of raw source. Non-markdown files render verbatim. Since
  // markdown files are the common case for this UI (docs / guides /
  // README) we tolerate some false negatives on files without an
  // extension rather than false-positives on real code.
  const globIsMarkdown =
    typeof glob === 'string' && /\.(md|mdx|markdown)\b/i.test(glob)
  const pathIsMarkdown =
    typeof path === 'string' && /\.(md|mdx|markdown)$/i.test(path)
  const fileIsMarkdown = (file: string | undefined): boolean => {
    if (typeof file === 'string' && /\.(md|mdx|markdown)$/i.test(file)) {
      return true
    }
    return globIsMarkdown || pathIsMarkdown
  }

  // Pre-compile the highlight terms from the raw pattern once so
  // every line renders off the same list (literal for plain patterns,
  // split on top-level `|` for simple alternations).
  const terms = patternTerms(pattern)

  return {
    headline: renderGrepHeadline(pattern, scopeLabel, scopeTitle, lang),
    input: null,
    output: {
      label: pick(lang, `匹配（${matchCount}）`, `Matches (${matchCount})`),
      content: (
        <div className="max-h-96 max-w-full space-y-3 overflow-auto pr-1 text-[12px] leading-relaxed">
          {groups.map((group, i) => {
            const md = fileIsMarkdown(group.file)
            return (
              <div key={i}>
                {group.file && (
                  <div
                    className="mb-1 truncate font-mono text-[10.5px] text-muted-foreground/70"
                    title={group.file}
                  >
                    {group.file}
                  </div>
                )}
                <div>
                  {group.lines.map((line, j) => {
                    const displayText = md
                      ? cleanMarkdownSnippet(line.content)
                      : line.content
                    return (
                      <div
                        key={j}
                        className="flex gap-3"
                        title={line.content || undefined}
                      >
                        <span
                          className={
                            'w-10 shrink-0 select-none text-right font-mono tabular-nums ' +
                            (line.isMatch
                              ? 'text-accent'
                              : 'text-muted-foreground/40')
                          }
                        >
                          {line.lineNo ?? ''}
                        </span>
                        <span
                          className={
                            'min-w-0 flex-1 truncate ' +
                            (md ? '' : 'font-mono ') +
                            (line.isMatch
                              ? 'text-foreground/90'
                              : 'text-muted-foreground/55')
                          }
                        >
                          {line.isMatch
                            ? highlightTerms(
                                displayText,
                                terms,
                                caseInsensitive
                              )
                            : displayText || '\u200b'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      ),
      copyText: resultText
    }
  }
}

function renderGrepHeadline(
  pattern: string,
  scopeLabel: string | undefined,
  scopeTitle: string | undefined,
  lang: Lang
): React.ReactNode {
  return (
    <span>
      {pick(lang, '搜索', 'Search')}{' '}
      <code className="font-mono text-[11.5px] text-accent">{pattern}</code>
      {scopeLabel && (
        <span
          className="ml-1 text-muted-foreground/60"
          title={scopeTitle}
        >
          · {pick(lang, `在 ${scopeLabel}`, `in ${scopeLabel}`)}
        </span>
      )}
    </span>
  )
}

type RipgrepLine = {
  file?: string
  lineNo?: number
  content: string
  isMatch: boolean
}

type RipgrepGroup = {
  file?: string
  lines: RipgrepLine[]
}

/**
 * Parse ripgrep `output_mode: content` output into groups. Handles:
 *   - single-file mode: `265:  matched text`, `266-  context text`
 *   - multi-file mode:  `src/foo.ts:265:  matched text`
 *   - group separator lines of only dashes (`--`, `---`, …)
 *
 * Separator between `lineNo` and `content` is `:` for match lines and
 * `-` for context lines — that's what lets us colour them differently
 * in the rendered output.
 */
function parseRipgrepContent(text: string): RipgrepGroup[] {
  const groups: RipgrepGroup[] = []
  let current: RipgrepGroup = { lines: [] }

  const flush = (): void => {
    if (current.lines.length > 0) {
      groups.push(current)
      current = { lines: [] }
    }
  }

  for (const raw of text.split('\n')) {
    // Separator: a line of only dashes (ripgrep uses `--`, we also
    // accept `---` etc. for safety).
    if (/^-+$/.test(raw)) {
      flush()
      continue
    }

    // Multi-file: `<file><sep><lineNo><sep><content>` where sep is
    // `:` (match) or `-` (context) and both separators must match.
    let m = /^(.+?)([:-])(\d+)\2(.*)$/.exec(raw)
    if (m && !/^\d+$/.test(m[1]!)) {
      const file = m[1]!
      const sep = m[2] as ':' | '-'
      const lineNo = parseInt(m[3]!, 10)
      const content = m[4]!
      if (current.file && current.file !== file) flush()
      if (!current.file) current.file = file
      current.lines.push({ file, lineNo, content, isMatch: sep === ':' })
      continue
    }

    // Single-file: `<lineNo><sep><content>`.
    m = /^(\d+)([:-])(.*)$/.exec(raw)
    if (m) {
      const lineNo = parseInt(m[1]!, 10)
      const sep = m[2] as ':' | '-'
      const content = m[3]!
      current.lines.push({ lineNo, content, isMatch: sep === ':' })
      continue
    }

    // Unparseable (blank line, summary footer, etc.) — keep as raw
    // text so nothing is silently dropped.
    if (raw.length > 0) {
      current.lines.push({ content: raw, isMatch: false })
    }
  }
  flush()
  return groups
}

/**
 * Parse a Grep pattern into the set of literal terms we should
 * highlight. Three rules:
 *   1. Empty / whitespace → []
 *   2. Plain literal (no regex metachars) → [pattern]
 *   3. Simple alternation `a|b|c` (only `|` as metachar) → split
 *      into each branch
 *   4. Anything else (parens, classes, escapes, quantifiers, …) →
 *      [pattern] verbatim, and the highlighter does its best-effort
 *      literal match (a regex pattern may not literally appear in
 *      the match text, which is fine — we just won't highlight).
 */
function patternTerms(pattern: string): string[] {
  if (!pattern) return []
  const hasComplexMeta = /[()[\]\\.+?{}^$*]/.test(pattern)
  if (hasComplexMeta) return [pattern]
  if (pattern.includes('|')) {
    return pattern
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return [pattern]
}

/**
 * Highlight each literal term as a `<mark>` span inside a line. Used
 * by the Grep renderer so a search like `foo|bar` puts an accent
 * background on both words. All terms are escaped and OR-joined into
 * a single regex pass so a line with multiple hits renders in order.
 */
function highlightTerms(
  text: string,
  terms: string[],
  caseInsensitive: boolean
): React.ReactNode {
  if (!text || terms.length === 0) return text
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter((t) => t.length > 0)
  if (escaped.length === 0) return text
  let re: RegExp
  try {
    re = new RegExp(`(${escaped.join('|')})`, caseInsensitive ? 'gi' : 'g')
  } catch {
    return text
  }
  const parts: React.ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <mark
        key={key++}
        className="rounded-sm bg-accent/25 px-[1px] text-accent"
      >
        {m[1]}
      </mark>
    )
    last = re.lastIndex
    // Guard against zero-length matches that would otherwise spin.
    if (m.index === re.lastIndex) re.lastIndex++
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length > 0 ? parts : text
}

/**
 * Strip inline markdown tokens from a single line so a Grep match
 * snippet reads as prose instead of source. Targets the noisy stuff
 * that shows up in doc-style markdown files (headings, emphasis,
 * code spans, table pipes, list markers, links, images).
 *
 * Intentionally single-pass and best-effort: nested formatting or
 * multi-line constructs aren't handled (a Grep snippet is by
 * definition one line), and we'd rather leak a stray `*` than
 * strip user content.
 */
function cleanMarkdownSnippet(text: string): string {
  let out = text
  // ATX headings: "## text" → "text"
  out = out.replace(/^\s*#{1,6}\s+/, '')
  // Blockquote marker
  out = out.replace(/^\s*>\s?/, '')
  // Unordered list markers → bullet
  out = out.replace(/^(\s*)[-*+]\s+/, '$1• ')
  // Ordered list markers → strip
  out = out.replace(/^(\s*)\d+\.\s+/, '$1')
  // Images: ![alt](url) → alt  (must run before link rule)
  out = out.replace(/!\[([^\]\n]*)\]\([^)\n]+\)/g, '$1')
  // Links: [text](url) → text
  out = out.replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
  // Bold: **text** / __text__
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '$1')
  out = out.replace(/__([^_\n]+?)__/g, '$1')
  // Italic: *text* / _text_ with basic boundary guards so stray
  // asterisks inside prose don't trip the replacement.
  out = out.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1')
  out = out.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, '$1')
  // Inline code: `text` → text
  out = out.replace(/`([^`\n]+)`/g, '$1')
  // Table pipes: strip leading/trailing, collapse inner to " · ".
  out = out.replace(/^\s*\|\s?/, '')
  out = out.replace(/\s?\|\s*$/, '')
  out = out.replace(/\s*\|\s*/g, ' · ')
  // Double-space cleanup from earlier strips.
  out = out.replace(/  +/g, ' ')
  return out
}

export function formatGlob({
  args,
  result,
  lang
}: FormatterCtx): FriendlyView | null {
  const pattern = getStringArg(args, 'pattern')
  if (!pattern) return null
  const path = getStringArg(args, 'path')
  const resultText = extractText(result).replace(/\s+$/, '')
  const files = resultText
    ? resultText.split('\n').map((l) => l.trim()).filter(Boolean)
    : []

  return {
    headline: (
      <span className="inline-flex max-w-full items-baseline gap-1 align-middle">
        <span className="shrink-0">
          {pick(lang, '查找文件', 'Find files')}
        </span>
        <code className="min-w-0 truncate font-mono text-[11.5px] text-accent">
          {pattern}
        </code>
        {path && (
          <span
            className="min-w-0 shrink truncate text-muted-foreground/60"
            title={path}
          >
            · {pick(lang, `在 ${basename(path)}`, `in ${basename(path)}`)}
          </span>
        )}
      </span>
    ),
    input: null,
    output:
      files.length > 0
        ? {
            label: pick(
              lang,
              `文件（${files.length}）`,
              `Files (${files.length})`
            ),
            content: (
              <ul className="max-h-80 space-y-0.5 overflow-auto font-mono text-[11.5px] text-foreground/85">
                {files.map((f, i) => (
                  <li key={i} className="whitespace-pre">
                    {f}
                  </li>
                ))}
              </ul>
            ),
            copyText: files.join('\n')
          }
        : {
            label: pick(lang, '结果', 'Result'),
            content: (
              <span className="font-mono text-[11.5px] text-muted-foreground/60">
                {pick(lang, '无匹配文件', 'No files found')}
              </span>
            ),
            copyText: ''
          }
  }
}
