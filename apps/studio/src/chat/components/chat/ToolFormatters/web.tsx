import React from 'react'

import type { Lang } from '../../../i18n'
import { AssistantMarkdown } from '../AssistantMarkdown'
import { extractText, getNumberArg, getStringArg } from '../toolHelpers'
import { isObj, pick } from './helpers'
import type { FormatterCtx, FriendlyView } from './types'

export function formatWebFetch({
  args,
  result,
  lang
}: FormatterCtx): FriendlyView | null {
  const url = getStringArg(args, 'url')
  if (!url) return null
  const prompt = getStringArg(args, 'prompt')
  const resultText = extractText(result).replace(/\s+$/, '')

  return {
    headline: (
      <span>
        {pick(lang, '抓取网页', 'Fetch')}{' '}
        <code className="break-all font-mono text-[11.5px] text-brand">
          {url}
        </code>
      </span>
    ),
    input: prompt
      ? {
          label: pick(lang, '提问', 'Prompt'),
          content: (
            <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-foreground/85">
              {prompt}
            </pre>
          ),
          copyText: prompt
        }
      : null,
    output: resultText
      ? {
          label: pick(lang, '回答', 'Response'),
          content: (
            <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-foreground/85">
              {resultText}
            </pre>
          ),
          copyText: resultText
        }
      : undefined
  }
}

/**
 * WebSearch (网页搜索) — the raw result is engineer-speak: an English
 * "Web search results for query: …" preamble, a one-line `Links: [...]`
 * JSON array, boilerplate, then a markdown digest. Regular users saw a
 * wall of JSON-in-monospace (the exact complaint that prompted this
 * formatter). Rebuilt as:
 *   - headline/input: none — the query already rides in the card header
 *     (summarizeArgs picks `query`), so repeating it twice is noise.
 *   - output: a clean SOURCES list (numbered title + domain, opens in
 *     the system browser) + the markdown digest rendered as rich text +
 *     the untouched raw text tucked under a 查看原始输出 toggle.
 * Parsing is best-effort: if the result doesn't match the known shape,
 * we fall back to plain readable text (never the raw JSON pane).
 */
function parseWebSearchResult(text: string): {
  links: { title: string; url: string }[]
  summary: string
} {
  let links: { title: string; url: string }[] = []
  // The Links array lives on a single line: `Links: [{"title":…}]`.
  const linksMatch = /^Links:\s*(\[.*\])\s*$/m.exec(text)
  if (linksMatch) {
    try {
      const parsed = JSON.parse(linksMatch[1]) as unknown
      if (Array.isArray(parsed)) {
        links = parsed
          .map((l) =>
            isObj(l)
              ? {
                  title: getStringArg(l, 'title') ?? '',
                  url: getStringArg(l, 'url') ?? ''
                }
              : { title: '', url: '' }
          )
          .filter((l) => l.url.length > 0)
      }
    } catch {
      // malformed Links JSON — keep links empty, summary still renders
    }
  }
  // Digest = everything after the Links line, minus the boilerplate
  // lead-ins the search tool prepends in both languages.
  let summary = linksMatch
    ? text.slice(linksMatch.index + linksMatch[0].length)
    : text
  summary = summary
    .replace(/^Web search results for query:.*$/m, '')
    .replace(/^现在为你提供关于搜索查询的信息[:：]\s*$/m, '')
    .replace(/^I'll provide.*information.*$/m, '')
    .trim()
  return { links, summary }
}

/** Hostname sans www — the quiet "source" tag on each link row. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function formatWebSearch({
  args,
  result,
  lang
}: FormatterCtx): FriendlyView | null {
  const query = getStringArg(args, 'query')
  if (!query) return null

  const raw = extractText(result).replace(/\s+$/, '')
  if (!raw) {
    // Still running / result not back yet — hide the raw {query} JSON
    // (the header shows the query), let the default running hint show.
    return { input: null }
  }

  const { links, summary } = parseWebSearchResult(raw)

  return {
    input: null,
    output: {
      label:
        links.length > 0
          ? pick(lang, `搜索结果 · ${links.length} 个来源`, `Results · ${links.length} sources`)
          : pick(lang, '搜索结果', 'Results'),
      content: (
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {links.length > 0 && (
            <ol className="space-y-0.5">
              {links.map((l, i) => (
                <li key={l.url + i}>
                  {/* hover 色钉死品牌绿 --brand（不跟主题色 --accent 走），
                      同 AssistantMarkdown 的 a 标签一致——这也是条可点外链
                      （2026-07-19 用户实锤）。 */}
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group/link flex items-baseline gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-brand/10"
                  >
                    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/50">
                      {i + 1}
                    </span>
                    <span className="min-w-0 truncate text-[12px] text-foreground/85 transition-colors group-hover/link:text-brand">
                      {l.title || l.url}
                    </span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/60">
                      {domainOf(l.url)}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}
          {summary && (
            <div
              className={
                'text-[12px] leading-relaxed text-foreground/85 ' +
                (links.length > 0 ? 'border-t border-border/40 pt-2' : '')
              }
            >
              <AssistantMarkdown text={summary} />
            </div>
          )}
          <details className="group/ws">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] text-muted-foreground/60 transition hover:text-muted-foreground">
              <span
                aria-hidden
                className="inline-block transition group-open/ws:rotate-90"
              >
                ▸
              </span>
              {pick(lang, '查看原始输出', 'Raw output')}
            </summary>
            <pre className="mt-1 max-h-60 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground/75">
              {raw}
            </pre>
          </details>
        </div>
      ),
      copyText: raw
    }
  }
}

export function formatToolSearch({
  args,
  result,
  lang
}: FormatterCtx): FriendlyView | null {
  const query = getStringArg(args, 'query')
  if (!query) return null
  const maxResults = getNumberArg(args, 'max_results')

  // Result shape: array of { type: 'tool_reference', tool_name: '…' }.
  // ToolCallCard hands us the parsed value when the SDK already parsed
  // it, but we also fall back to parsing the stringified form because
  // streaming runs sometimes deliver the raw text.
  const collectNames = (val: unknown): string[] => {
    if (!Array.isArray(val)) return []
    return val
      .map((r) => (isObj(r) ? getStringArg(r, 'tool_name') : undefined))
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
  }

  let tools: string[] = collectNames(result)
  if (tools.length === 0) {
    const text = extractText(result).trim()
    if (text.startsWith('[')) {
      try {
        tools = collectNames(JSON.parse(text))
      } catch {
        // not JSON — fall through with empty array
      }
    }
  }

  // `select:A,B,…` is exact-name loading, not a search — translate the
  // syntax instead of showing it. Knowing the requested names also
  // lets us flag the ones that did NOT come back (schema failed to
  // load), which is the actually-useful signal of this tool.
  const selectNames = query.startsWith('select:')
    ? query
        .slice('select:'.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null
  const found = new Set(tools)
  const missing = selectNames?.filter((n) => !found.has(n)) ?? []

  return {
    headline: selectNames ? (
      <span>
        {pick(lang, '加载工具', 'Load tools')}{' '}
        <span className="text-muted-foreground/60">
          ·{' '}
          {pick(
            lang,
            `按名称选取 ${selectNames.length} 个`,
            `${selectNames.length} by name`
          )}
        </span>
      </span>
    ) : (
      <span>
        {pick(lang, '搜索工具', 'Tool search')}{' '}
        <span className="text-brand">
          “
          <span className="font-mono text-[11.5px]">
            {query.replace(/^\+/, '')}
          </span>
          ”
        </span>
        {maxResults !== undefined && (
          <span className="ml-1 text-muted-foreground/60">
            · {pick(lang, `上限 ${maxResults}`, `max ${maxResults}`)}
          </span>
        )}
      </span>
    ),
    input: null,
    output: {
      label:
        tools.length > 0
          ? pick(
              lang,
              `已加载 ${tools.length} 个工具`,
              `${tools.length} tools loaded`
            )
          : pick(lang, '结果', 'Result'),
      content:
        tools.length > 0 || missing.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <ToolChip key={t} name={t} />
            ))}
            {missing.map((t) => (
              <ToolChip key={t} name={t} missing lang={lang} />
            ))}
          </ul>
        ) : (
          <span className="font-mono text-[11.5px] text-muted-foreground/60">
            {pick(lang, '无结果', 'No results')}
          </span>
        ),
      copyText: tools.join(', ')
    }
  }
}

/**
 * One loaded-tool pill. MCP names encode their server as
 * `mcp__<server>__<tool>` — split that into a dimmed server prefix and
 * the tool proper so the eye lands on the part that matters. A
 * `missing` pill (requested via select: but absent from the result)
 * renders dashed + muted: the schema did not load.
 */
function ToolChip({
  name,
  missing = false,
  lang
}: {
  name: string
  missing?: boolean
  lang?: Lang
}): React.JSX.Element {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  const server = mcp?.[1]
  const tool = mcp?.[2] ?? name
  return (
    <li
      className={
        'inline-flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pl-2 pr-2.5 text-[11px] leading-4 ' +
        (missing
          ? 'border border-dashed border-border text-muted-foreground/50'
          : 'border border-border bg-muted/40 text-foreground/85')
      }
      title={name}
    >
      <WrenchGlyph
        className={missing ? 'text-muted-foreground/40' : 'text-brand/70'}
      />
      {server && (
        <>
          <span className="max-w-32 truncate font-sans text-[10px] text-muted-foreground/60">
            {server}
          </span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
        </>
      )}
      <span className="min-w-0 truncate font-mono">{tool}</span>
      {missing && lang && (
        <span className="font-sans text-[9.5px] text-amber-500/90">
          {pick(lang, '未找到', 'not found')}
        </span>
      )}
    </li>
  )
}

function WrenchGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={'shrink-0 ' + (className ?? '')}
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}
