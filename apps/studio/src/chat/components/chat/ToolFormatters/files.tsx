import { AssistantMarkdown } from '../AssistantMarkdown'
import { extractText, getNumberArg, getStringArg } from '../toolHelpers'
import { basename, isObj, pick, unescapeJsonString } from './helpers'
import { DiffView } from './sharedComponents'
import type { FormatterCtx, FriendlyView, ToolPaneSpec } from './types'

export function formatRead({
  args,
  result,
  lang
}: FormatterCtx): FriendlyView | null {
  const filePath =
    getStringArg(args, 'file_path') ?? getStringArg(args, 'path')
  if (!filePath) return null
  const offset = getNumberArg(args, 'offset')
  const limit = getNumberArg(args, 'limit')

  let rangeLabel: string | null = null
  if (offset !== undefined && limit !== undefined) {
    rangeLabel = pick(
      lang,
      `第 ${offset}–${offset + limit - 1} 行`,
      `lines ${offset}–${offset + limit - 1}`
    )
  } else if (offset !== undefined) {
    rangeLabel = pick(lang, `第 ${offset} 行起`, `from line ${offset}`)
  } else if (limit !== undefined) {
    rangeLabel = pick(lang, `前 ${limit} 行`, `first ${limit} lines`)
  }

  // Decide what to do with the result. Three branches:
  //   1. No numbered lines — probably an error payload (e.g.
  //      `<tool_use_error>...</tool_use_error>`), not file content.
  //      Render as a red error pane; CodeFileView would otherwise
  //      try to syntax-highlight the error text as source code.
  //   2. Numbered lines + markdown file — strip the `cat -n` gutter
  //      and hand the plain text to AssistantMarkdown so users see a
  //      rendered document instead of raw `**bold**` / `## heading`
  //      noise. Non-technical users reading docs care about the
  //      document, not line numbers.
  //   3. Numbered lines + anything else — leave `output` undefined
  //      so ToolCallCard falls through to CodeFileView with its
  //      existing highlight.js pipeline.
  const resultText = extractText(result)
  const hasNumberedLines = /^\s*\d+\t/m.test(resultText)
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(filePath)

  let outputPane: ToolPaneSpec | undefined
  if (resultText && !hasNumberedLines) {
    outputPane = {
      label: pick(lang, '错误', 'Error'),
      content: (
        <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-red-400/90">
          {resultText.replace(/<\/?tool_use_error>/g, '').trim()}
        </pre>
      ),
      copyText: resultText
    }
  } else if (hasNumberedLines && isMarkdown) {
    const plain = stripCatNumberedGutter(resultText)
    outputPane = {
      label: pick(lang, '内容', 'Content'),
      content: (
        <div className="max-h-96 max-w-full overflow-auto px-1 py-1">
          <AssistantMarkdown text={plain} />
        </div>
      ),
      copyText: plain
    }
  }
  // else: leave outputPane undefined → CodeFileView default path.

  return {
    headline: (
      <span className="inline-flex max-w-full items-baseline gap-1 align-middle">
        <span className="shrink-0">
          {pick(lang, '读取文件', 'Read file')}
        </span>
        <code
          className="min-w-0 truncate font-mono text-[11.5px] text-accent"
          title={filePath}
        >
          {basename(filePath)}
        </code>
        {rangeLabel && (
          <span className="shrink-0 text-muted-foreground/60">
            · {rangeLabel}
          </span>
        )}
      </span>
    ),
    // Suppress the default input pane (args are just {file_path,
    // offset, limit} which the headline already surfaces).
    input: null,
    output: outputPane
  }
}

/**
 * Strip the `     1\t`, `     2\t`, … prefix that Read returns in
 * `cat -n` format, leaving the raw file contents behind. Non-matching
 * lines pass through unchanged so a partial / mixed result still
 * degrades gracefully.
 */
function stripCatNumberedGutter(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^\s*\d+\t(.*)$/.exec(line)
      return m ? m[1]! : line
    })
    .join('\n')
}

export function formatWrite({
  args,
  argsText,
  running,
  lang
}: FormatterCtx): FriendlyView | null {
  // Parsed-args path (the tool call is complete).
  let filePath = getStringArg(args, 'file_path')
  let content = getStringArg(args, 'content')

  // Streaming path: `args` is undefined until the JSON finishes
  // parsing at the very end, but the raw argsText is growing
  // character-by-character. Best-effort regex both fields out of
  // whatever partial JSON we have so the user sees an actual file
  // path + code preview instead of `{"content":"const x = ...\n`
  // with visible escape sequences.
  if ((!filePath || !content) && typeof argsText === 'string' && argsText) {
    if (!filePath) {
      const m = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(argsText)
      if (m) filePath = unescapeJsonString(m[1]!)
    }
    if (!content) {
      // Content may still be mid-stream (no closing quote yet), so
      // we capture greedily up to either an unescaped closing quote
      // or the very end of argsText.
      const m = /"content"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|$)/.exec(argsText)
      if (m) content = unescapeJsonString(m[1]!)
    }
  }

  if (!filePath && !content) return null

  const lineCount = content ? content.split('\n').length : 0
  const codeLanguage = filePath ? languageHintFromPath(filePath) : undefined

  return {
    headline: (
      <span className="inline-flex max-w-full items-baseline gap-1 align-middle">
        <span className="shrink-0">
          {pick(lang, '写入文件', 'Write file')}
        </span>
        {filePath && (
          <code
            className="min-w-0 truncate font-mono text-[11.5px] text-accent"
            title={filePath}
          >
            {basename(filePath)}
          </code>
        )}
        {running ? (
          <span className="shrink-0 text-muted-foreground/60">
            · {pick(lang, '写入中…', 'writing…')}
          </span>
        ) : (
          lineCount > 0 && (
            <span className="shrink-0 text-muted-foreground/60">
              · {pick(lang, `${lineCount} 行`, `${lineCount} lines`)}
            </span>
          )
        )}
      </span>
    ),
    input: content
      ? {
          label: codeLanguage
            ? pick(lang, `内容（${codeLanguage}）`, `Content (${codeLanguage})`)
            : pick(lang, '内容', 'Content'),
          content: (
            <pre className="max-h-80 max-w-full overflow-auto whitespace-pre font-mono text-[11.5px] leading-snug text-foreground/85">
              {content}
            </pre>
          ),
          copyText: content
        }
      : null,
    // Hide default output — its confirmation message is redundant with
    // the headline ("写入文件 foo.ts · 120 行" already tells the story).
    output: null
  }
}

/**
 * One-line language hint from a file extension — used purely as a
 * decorative label next to the Content pane so users know "this is
 * TypeScript / Python / …". Subset of languageFromPath in
 * ThreadView; we don't need the full highlight.js language map, just
 * a friendly display label.
 */
function languageHintFromPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop() ?? path
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    mjs: 'JavaScript',
    cjs: 'JavaScript',
    py: 'Python',
    rs: 'Rust',
    go: 'Go',
    rb: 'Ruby',
    java: 'Java',
    kt: 'Kotlin',
    swift: 'Swift',
    c: 'C',
    h: 'C',
    cc: 'C++',
    cpp: 'C++',
    cs: 'C#',
    sh: 'Shell',
    bash: 'Shell',
    zsh: 'Shell',
    yml: 'YAML',
    yaml: 'YAML',
    toml: 'TOML',
    json: 'JSON',
    html: 'HTML',
    css: 'CSS',
    md: 'Markdown',
    sql: 'SQL',
    php: 'PHP',
    lua: 'Lua'
  }
  return map[ext]
}

export function formatEdit({ args, lang }: FormatterCtx): FriendlyView | null {
  const filePath = getStringArg(args, 'file_path')
  if (!filePath) return null
  const oldString = getStringArg(args, 'old_string') ?? ''
  const newString = getStringArg(args, 'new_string') ?? ''
  const replaceAll = isObj(args) && Boolean(args.replace_all)

  return {
    headline: (
      <span>
        {pick(lang, '编辑文件', 'Edit file')}{' '}
        <code className="font-mono text-[11.5px] text-accent">{filePath}</code>
        {replaceAll && (
          <span className="ml-1 text-muted-foreground/60">
            · {pick(lang, '替换全部匹配', 'replace all')}
          </span>
        )}
      </span>
    ),
    input: {
      label: pick(lang, '改动', 'Change'),
      content: <DiffView oldText={oldString} newText={newString} />,
      copyText: `- ${oldString}\n+ ${newString}`
    },
    output: null
  }
}

type MultiEdit = {
  old_string?: unknown
  new_string?: unknown
  replace_all?: unknown
}

export function formatMultiEdit({
  args,
  lang
}: FormatterCtx): FriendlyView | null {
  const filePath = getStringArg(args, 'file_path')
  if (!filePath) return null
  const rawEdits = isObj(args) && Array.isArray(args.edits) ? args.edits : []
  const edits: { oldText: string; newText: string }[] = rawEdits
    .filter((e): e is MultiEdit => isObj(e))
    .map((e) => ({
      oldText: typeof e.old_string === 'string' ? e.old_string : '',
      newText: typeof e.new_string === 'string' ? e.new_string : ''
    }))

  return {
    headline: (
      <span>
        {pick(lang, '批量编辑', 'Multi-edit')}{' '}
        <code className="font-mono text-[11.5px] text-accent">{filePath}</code>
        <span className="ml-1 text-muted-foreground/60">
          · {pick(lang, `${edits.length} 处改动`, `${edits.length} edits`)}
        </span>
      </span>
    ),
    input: {
      label: pick(lang, '改动', 'Changes'),
      content: (
        <div className="space-y-2">
          {edits.map((edit, i) => (
            <div key={i}>
              <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                {pick(lang, `第 ${i + 1} 处`, `edit ${i + 1}`)}
              </div>
              <DiffView oldText={edit.oldText} newText={edit.newText} />
            </div>
          ))}
        </div>
      ),
      copyText: edits
        .map((e) => `- ${e.oldText}\n+ ${e.newText}`)
        .join('\n\n')
    },
    output: null
  }
}
