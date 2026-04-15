import React from 'react'

import type { Lang } from '../../i18n'
import { AssistantMarkdown } from './AssistantMarkdown'
import { extractText, getNumberArg, getStringArg } from './toolHelpers'

/**
 * Friendly (human-readable) renderings for the tool-call cards in
 * ThreadView. Each formatter converts a tool's raw JSON args / result
 * into a short headline plus optional replacement panes that are
 * understandable by a non-engineer.
 *
 * The dispatcher is keyed by tool name. Tools without a formatter
 * (notably every MCP tool, plus obscure built-ins) fall through to the
 * default raw-JSON view in `ToolCallCard`, which stays intact.
 *
 * Per-pane semantics:
 *   - `undefined`  ⇒ let ToolCallCard render its default pane
 *   - `null`       ⇒ suppress the default pane (nothing is shown)
 *   - ToolPaneSpec ⇒ render the friendly pane in place of the default
 *
 * Keeping the contract symmetric for `input` and `output` means each
 * formatter can mix-and-match — e.g. Read returns only a headline and
 * leaves both default panes alone, while Bash replaces both.
 */

export type ToolPaneSpec = {
  label: string
  content: React.ReactNode
  copyText: string
}

export type FriendlyView = {
  headline?: React.ReactNode
  input?: ToolPaneSpec | null
  output?: ToolPaneSpec | null
}

type FormatterCtx = {
  args: unknown
  /** Raw streaming JSON text — present while the tool call is still
   *  being generated and `args` is not yet parsed. Formatters can
   *  regex out partial fields here to render a preview instead of
   *  falling through to the default raw-JSON pane. */
  argsText?: string
  result: unknown
  running: boolean
  lang: Lang
}

type Formatter = (ctx: FormatterCtx) => FriendlyView | null

/** Two-lang string picker. Kept tiny so each formatter stays readable. */
function pick(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Entry point used by ToolCallCard. Swallows formatter errors so a bug
 * in a friendly renderer never crashes the whole card — the caller
 * falls through to the raw JSON view in that case.
 */
export function friendlyToolView(
  toolName: string,
  ctx: FormatterCtx
): FriendlyView | null {
  const fn = FORMATTERS[toolName]
  if (!fn) return null
  try {
    return fn(ctx)
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn(`[ToolFormatters] ${toolName} formatter threw`, err)
    }
    return null
  }
}

/* ──────────────────────── formatters ─────────────────────── */

function formatBash({ args, result, lang }: FormatterCtx): FriendlyView | null {
  const command = getStringArg(args, 'command')
  if (!command) return null
  const description = getStringArg(args, 'description')
  const bg = isObj(args) && Boolean(args.run_in_background)
  const rawOutput = extractText(result).replace(/\s+$/, '')

  // Treat "no meaningful output" as no output at all. Claude's Bash
  // tool returns a stringified `(Bash completed with no output)`
  // diagnostic for commands that didn't print anything; regular users
  // don't need to see that — success is already indicated by the DONE
  // pill at the top of the card.
  const trimmed = rawOutput.trim()
  const isEmptyOutput =
    trimmed.length === 0 ||
    /^\(?\s*bash completed with no output\s*\)?$/i.test(trimmed) ||
    /^\(no output\)$/i.test(trimmed)

  // Pattern-match the command into a plain-language action. This is
  // best-effort; common verbs cover 80% of what Claude runs for a
  // typical task. Unknown commands fall back to "执行命令".
  const plainAction = describeCommand(command, lang)

  // `ls` gets a custom grid renderer that groups directories and
  // files, dims hidden entries, and uses a multi-column layout.
  // Regular users scan "what's in this folder" ten times easier off
  // a grid than off a 40-line monospace column.
  const lsPane = isEmptyOutput
    ? null
    : isLsCommand(command)
      ? renderLsOutput(trimmed, lang)
      : null

  // Try to summarize long output into a one-liner (npm install,
  // package counts, curl status, …). When we have a summary we show
  // it as the primary content and tuck the full log under a
  // `<details>`, so the first-read stays compact.
  const summary = isEmptyOutput || lsPane
    ? null
    : summarizeBashOutput(command, trimmed, lang)

  return {
    headline: (
      <div className="flex items-baseline gap-2 text-[13px] font-medium text-foreground/90">
        <span>{description ?? plainAction}</span>
        {bg && (
          <span className="text-[10px] font-normal text-muted-foreground/60">
            {pick(lang, '后台运行', 'background')}
          </span>
        )}
      </div>
    ),
    // Keep the command visible (users can verify what ran) but make
    // it compact — it's a reference, not the focus.
    input: {
      label: pick(lang, '命令', 'Command'),
      content: (
        <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-foreground/80">
          <span aria-hidden className="select-none text-muted-foreground/50">
            ${' '}
          </span>
          {command}
        </pre>
      ),
      copyText: command
    },
    // Empty output → no pane. `ls` → grid renderer. Summarized
    // output → friendly one-liner + raw details toggle. Plain log
    // → raw pre.
    output: isEmptyOutput
      ? null
      : lsPane
        ? {
            label: lsPane.label,
            content: (
              <div className="space-y-1.5">
                {lsPane.content}
                <details className="group/bash">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] text-muted-foreground/60 transition hover:text-muted-foreground">
                    <span
                      aria-hidden
                      className="inline-block transition group-open/bash:rotate-90"
                    >
                      ▸
                    </span>
                    {pick(lang, '查看原始输出', 'Raw output')}
                  </summary>
                  <pre className="mt-1 max-h-60 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground/75">
                    {trimmed}
                  </pre>
                </details>
              </div>
            ),
            copyText: trimmed
          }
        : summary
          ? {
              label: pick(lang, '结果', 'Result'),
              content: (
                <div className="space-y-1.5">
                  <div className="text-[12px] text-foreground/85">
                    {summary}
                  </div>
                  <details className="group/bash">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] text-muted-foreground/60 transition hover:text-muted-foreground">
                      <span
                        aria-hidden
                        className="inline-block transition group-open/bash:rotate-90"
                      >
                        ▸
                      </span>
                      {pick(lang, '查看完整输出', 'Full output')}
                    </summary>
                    <pre className="mt-1 max-h-60 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground/75">
                      {trimmed}
                    </pre>
                  </details>
                </div>
              ),
              copyText: trimmed
            }
          : {
              label: pick(lang, '输出', 'Output'),
              content: (
                <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-foreground/85">
                  {trimmed}
                </pre>
              ),
              copyText: trimmed
            }
  }
}

/**
 * Map a shell command to a plain-language verb phrase. Covers the
 * handful of commands Claude actually runs for a regular user's
 * workflow (create dirs, install deps, move files, git, curl, …).
 * Returns the fallback "执行命令" label for anything unknown —
 * callers can still see the raw command in the input pane.
 */
function describeCommand(command: string, lang: Lang): string {
  const cmd = command.trim()
  // Strip leading `sudo` / env prefixes so pattern matches keep working.
  const body = cmd.replace(/^sudo\s+/, '').replace(/^[A-Z_]+=\S+\s+/, '')
  const firstWord = body.split(/\s+/)[0] ?? ''

  // mkdir [-p] <path> → "创建文件夹"
  if (/^mkdir\b/.test(body)) {
    return pick(lang, '创建文件夹', 'Create folder')
  }
  // rm -rf / rm <path>
  if (/^rm\b/.test(body)) {
    return pick(lang, '删除文件', 'Delete file')
  }
  // cp / mv
  if (/^cp\b/.test(body)) return pick(lang, '复制文件', 'Copy file')
  if (/^mv\b/.test(body)) return pick(lang, '移动文件', 'Move file')
  // cd
  if (/^cd\b/.test(body)) return pick(lang, '切换目录', 'Change directory')
  // ls
  if (/^ls\b/.test(body)) return pick(lang, '列出文件', 'List files')
  // cat / head / tail — Claude normally uses Read, but fall back gracefully
  if (/^(cat|head|tail)\b/.test(body)) {
    return pick(lang, '查看文件', 'View file')
  }
  // touch
  if (/^touch\b/.test(body)) {
    return pick(lang, '创建空文件', 'Create empty file')
  }
  // echo … > file
  if (/^echo\b.*>/.test(body)) {
    return pick(lang, '写入文件', 'Write file')
  }
  // Package managers
  if (/^(npm|pnpm|yarn|bun)\s+i(nstall)?\b/.test(body)) {
    return pick(lang, '安装依赖', 'Install dependencies')
  }
  if (/^(npm|pnpm|yarn|bun)\s+run\b/.test(body)) {
    return pick(lang, '运行脚本', 'Run script')
  }
  if (/^(npm|pnpm|yarn|bun)\s+(add|uninstall|remove)\b/.test(body)) {
    return pick(lang, '管理依赖', 'Manage dependencies')
  }
  if (/^(pip|pip3|poetry|uv)\s+install\b/.test(body)) {
    return pick(lang, '安装依赖', 'Install dependencies')
  }
  // git
  if (firstWord === 'git') {
    const sub = body.split(/\s+/)[1]
    const gitLabels: Record<string, [string, string]> = {
      status: ['查看 Git 状态', 'Git status'],
      log: ['查看 Git 历史', 'Git log'],
      diff: ['查看 Git 改动', 'Git diff'],
      add: ['暂存改动', 'Git add'],
      commit: ['提交改动', 'Git commit'],
      push: ['推送到远端', 'Git push'],
      pull: ['拉取更新', 'Git pull'],
      checkout: ['切换分支', 'Git checkout'],
      branch: ['管理分支', 'Git branch'],
      merge: ['合并分支', 'Git merge'],
      rebase: ['变基', 'Git rebase'],
      clone: ['克隆仓库', 'Git clone'],
      fetch: ['抓取更新', 'Git fetch'],
      stash: ['暂存工作区', 'Git stash']
    }
    const entry = sub ? gitLabels[sub] : undefined
    if (entry) return pick(lang, entry[0], entry[1])
    return pick(lang, '运行 Git 命令', 'Run git command')
  }
  // curl / wget → HTTP
  if (/^(curl|wget)\b/.test(body)) {
    return pick(lang, '下载或请求', 'HTTP request')
  }
  // Search / find
  if (/^(find|rg|ripgrep|ack|ag)\b/.test(body)) {
    return pick(lang, '查找', 'Search')
  }
  // Python / node scripts
  if (/^(python|python3|node|bun)\b/.test(body)) {
    return pick(lang, '运行脚本', 'Run script')
  }
  // Docker / kubectl
  if (/^docker\b/.test(body)) return pick(lang, '运行 Docker', 'Run docker')
  if (/^kubectl\b/.test(body)) {
    return pick(lang, '运行 Kubernetes 命令', 'Run kubectl')
  }

  return pick(lang, '执行命令', 'Run command')
}

/**
 * Extract a plain-language one-liner from a noisy shell output. Only
 * a small set of common commands are summarized — everything else
 * returns `null` so the caller renders the raw log. The goal is "make
 * the first glance informative", not "hide information".
 */
function summarizeBashOutput(
  command: string,
  output: string,
  lang: Lang
): React.ReactNode | null {
  const body = command.trim().replace(/^sudo\s+/, '')

  // npm / pnpm / yarn / bun install → "装了 N 个包" + vuln / funding
  if (/^(npm|pnpm|yarn|bun)\s+(i|install|add)\b/.test(body)) {
    // Covers "added 16 packages" / "added 3 packages, and audited 1304"
    const addedMatch =
      /added\s+(\d+)\s+package/i.exec(output) ||
      /installed\s+(\d+)\s+package/i.exec(output)
    const auditedMatch = /audited\s+(\d+)\s+package/i.exec(output)
    const vulnMatch =
      /(\d+)\s+vulnerabilit(?:y|ies)/i.exec(output) ||
      /found\s+(\d+)\s+vulnerabilit/i.exec(output)
    const fundingMatch = /(\d+)\s+packages? are looking for funding/i.exec(
      output
    )
    const upToDate = /up to date/i.test(output)

    const parts: React.ReactNode[] = []
    if (addedMatch) {
      parts.push(
        pick(
          lang,
          `新增 ${addedMatch[1]} 个依赖包`,
          `Added ${addedMatch[1]} packages`
        )
      )
    } else if (upToDate) {
      parts.push(pick(lang, '依赖已是最新', 'Dependencies up to date'))
    } else if (auditedMatch) {
      parts.push(
        pick(
          lang,
          `审计了 ${auditedMatch[1]} 个依赖包`,
          `Audited ${auditedMatch[1]} packages`
        )
      )
    }
    if (vulnMatch && parseInt(vulnMatch[1]!, 10) > 0) {
      parts.push(
        <span key="vuln" className="ml-1 text-amber-400">
          {pick(
            lang,
            `· ${vulnMatch[1]} 个安全警告`,
            `· ${vulnMatch[1]} vulnerabilities`
          )}
        </span>
      )
    }
    if (fundingMatch) {
      parts.push(
        <span key="fund" className="ml-1 text-muted-foreground/60">
          {pick(
            lang,
            `· ${fundingMatch[1]} 个包征求赞助`,
            `· ${fundingMatch[1]} packages seek funding`
          )}
        </span>
      )
    }
    if (parts.length > 0) {
      return (
        <span className="inline-flex flex-wrap items-baseline gap-1">
          {parts.map((p, i) => (
            <React.Fragment key={i}>{p}</React.Fragment>
          ))}
        </span>
      )
    }
  }

  // git status → porcelain line count
  if (/^git\s+status\b/.test(body)) {
    const modified = (output.match(/^\s*modified:/gm) ?? []).length
    const added = (output.match(/^\s*new file:/gm) ?? []).length
    const deleted = (output.match(/^\s*deleted:/gm) ?? []).length
    const untracked = output.includes('Untracked files:')
    if (
      modified + added + deleted === 0 &&
      /nothing to commit|clean/.test(output)
    ) {
      return pick(lang, '工作区干净', 'Working tree clean')
    }
    const bits: string[] = []
    if (modified > 0)
      bits.push(pick(lang, `${modified} 个文件已修改`, `${modified} modified`))
    if (added > 0)
      bits.push(pick(lang, `${added} 个新增`, `${added} added`))
    if (deleted > 0)
      bits.push(pick(lang, `${deleted} 个删除`, `${deleted} deleted`))
    if (untracked) bits.push(pick(lang, '有未跟踪文件', 'untracked files'))
    if (bits.length > 0) return bits.join(' · ')
  }

  // git commit → "Committed to <branch>: <msg>"
  if (/^git\s+commit\b/.test(body)) {
    const m = /\[(.*?)\s+([0-9a-f]+)\]\s+(.*)$/m.exec(output)
    if (m) {
      return pick(
        lang,
        `已提交到 ${m[1]}：${m[3]}`,
        `Committed to ${m[1]}: ${m[3]}`
      )
    }
  }

  // No pattern matched — caller will render the raw output.
  return null
}

/* ───────────────────── ls → directory grid ───────────────────── */

function isLsCommand(command: string): boolean {
  const body = command.trim().replace(/^sudo\s+/, '')
  return /^ls(\s|$)/.test(body)
}

// Names that are definitely directories even without a `/` suffix.
// Covers the usual suspects in a project root so users don't see
// `node_modules` mis-classified as a file.
const KNOWN_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'src',
  'lib',
  'public',
  'static',
  'docs',
  'doc',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  'assets',
  'images',
  'img',
  'fonts',
  'styles',
  'components',
  'pages',
  'app',
  'views',
  'routes',
  'api',
  'scripts',
  'config',
  'types',
  'utils',
  'helpers',
  'hooks',
  'stores',
  'store',
  'server',
  'client',
  'packages',
  'examples',
  'example',
  'demo',
  'vendor',
  'bin',
  'target',
  '.git',
  '.github',
  '.vscode',
  '.idea',
  '.claude',
  '.output',
  '.cache',
  '.wxt',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.husky'
])

// Names that look extension-less but are files.
const KNOWN_FILES = new Set([
  'LICENSE',
  'README',
  'CHANGELOG',
  'CONTRIBUTING',
  'AUTHORS',
  'NOTICE',
  'VERSION',
  'INSTALL',
  'TODO',
  'CODEOWNERS',
  'Makefile',
  'Dockerfile',
  'Procfile',
  'Jenkinsfile',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.npmignore',
  '.eslintignore',
  '.prettierignore',
  '.gitkeep',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.eslintrc',
  '.prettierrc',
  '.editorconfig',
  '.nvmrc',
  '.DS_Store',
  '.oxfmtrc.json',
  '.oxlintrc.json'
])

function classifyLsEntry(rawName: string): 'dir' | 'file' {
  // `ls -F` appends `/` `*` `@` `|` `=` — use them as ground truth.
  if (rawName.endsWith('/')) return 'dir'
  if (/[*@|=]$/.test(rawName)) return 'file'

  const name = rawName
  if (KNOWN_DIRS.has(name)) return 'dir'
  if (KNOWN_FILES.has(name)) return 'file'

  // Any dot after the leading dot(s) → file (e.g. `.oxlintrc.json`,
  // `package.json`, `pnpm-lock.yaml`, `PRIVACY.md`).
  const withoutLeading = name.replace(/^\.+/, '')
  if (withoutLeading.includes('.')) return 'file'

  // All-uppercase names without an extension are usually files
  // (LICENSE, README, NOTICE). We also allow mixed case like
  // `Makefile` via KNOWN_FILES above.
  if (/^[A-Z][A-Z_]+$/.test(name)) return 'file'

  // Default: directory. Most project roots have more known dirs than
  // extension-less files, and a wrong "dir" guess is less confusing
  // than a wrong "file" guess (you can still see the name either way).
  return 'dir'
}

/** Strip `ls -F` suffix markers from the display name. */
function stripLsSuffix(name: string): string {
  return name.replace(/[/*@|=]$/, '')
}

function renderLsOutput(
  output: string,
  lang: Lang
): { label: string; content: React.ReactNode } | null {
  const entries = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '.' && l !== '..')
  if (entries.length === 0) return null

  const dirs: string[] = []
  const files: string[] = []
  for (const e of entries) {
    const display = stripLsSuffix(e)
    if (classifyLsEntry(e) === 'dir') dirs.push(display)
    else files.push(display)
  }
  dirs.sort((a, b) => a.localeCompare(b))
  files.sort((a, b) => a.localeCompare(b))

  const total = dirs.length + files.length
  const label = pick(
    lang,
    `${total} 项（${dirs.length} 个文件夹 · ${files.length} 个文件）`,
    `${total} items (${dirs.length} dirs · ${files.length} files)`
  )

  return {
    label,
    content: (
      <div className="space-y-2 font-mono text-[11.5px]">
        {dirs.length > 0 && (
          <LsSection
            title={pick(lang, '文件夹', 'Folders')}
            items={dirs}
            kind="dir"
          />
        )}
        {files.length > 0 && (
          <LsSection
            title={pick(lang, '文件', 'Files')}
            items={files}
            kind="file"
          />
        )}
      </div>
    )
  }
}

function LsSection({
  title,
  items,
  kind
}: {
  title: string
  items: string[]
  kind: 'dir' | 'file'
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5 font-sans text-[10.5px] uppercase tracking-wider text-muted-foreground/60">
        <span>{title}</span>
        <span className="tabular-nums">· {items.length}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-4 gap-y-0.5">
        {items.map((name) => {
          const hidden = name.startsWith('.')
          if (kind === 'dir') {
            return (
              <div
                key={name}
                className="flex min-w-0 items-center gap-1.5"
                title={name}
              >
                <FolderGlyph />
                <span
                  className={
                    'min-w-0 truncate ' +
                    (hidden
                      ? 'text-accent/50'
                      : 'font-medium text-accent')
                  }
                >
                  {name}
                </span>
              </div>
            )
          }
          return (
            <div
              key={name}
              className="flex min-w-0 items-center gap-1.5"
              title={name}
            >
              <FileGlyph />
              <span
                className={
                  'min-w-0 truncate ' +
                  (hidden ? 'text-muted-foreground/50' : 'text-foreground/80')
                }
              >
                {name}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FolderGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-accent/80"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}

function FileGlyph(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-muted-foreground/50"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function formatRead({
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

function formatWrite({
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
 * Minimal JSON string unescape. Handles the escapes allowed inside a
 * JSON string literal (`\n` `\r` `\t` `\\` `\"` `\/` `\b` `\f`
 * `\uXXXX`) so streaming-extracted fragments render as the real
 * characters instead of the backslash noise that lives in the
 * underlying JSON blob.
 */
function unescapeJsonString(src: string): string {
  return src.replace(/\\([nrtbf"\\/]|u[0-9a-fA-F]{4})/g, (_, esc: string) => {
    if (esc === 'n') return '\n'
    if (esc === 'r') return '\r'
    if (esc === 't') return '\t'
    if (esc === 'b') return '\b'
    if (esc === 'f') return '\f'
    if (esc === '"') return '"'
    if (esc === '\\') return '\\'
    if (esc === '/') return '/'
    if (esc.startsWith('u')) {
      return String.fromCharCode(parseInt(esc.slice(1), 16))
    }
    return esc
  })
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

function formatEdit({ args, lang }: FormatterCtx): FriendlyView | null {
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

function formatMultiEdit({
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

function formatGrep({
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

/**
 * Last path segment — used to keep long absolute paths out of the
 * one-line headline. `title={fullPath}` on the caller restores access.
 */
function basename(p: string): string {
  if (!p) return p
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed
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

function formatGlob({
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

function formatWebFetch({
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
        <code className="break-all font-mono text-[11.5px] text-accent">
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

function formatToolSearch({
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

  return {
    headline: (
      <span>
        {pick(lang, '搜索工具', 'Tool search')}{' '}
        <code className="font-mono text-[11.5px] text-accent">{query}</code>
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
              `找到 ${tools.length} 个工具`,
              `Found ${tools.length} tools`
            )
          : pick(lang, '结果', 'Result'),
      content:
        tools.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <li
                key={t}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground/85"
              >
                {t}
              </li>
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

type TodoItem = {
  content: string
  status: string
  activeForm?: string
}

function formatTodoWrite({
  args,
  lang
}: FormatterCtx): FriendlyView | null {
  if (!isObj(args) || !Array.isArray(args.todos)) return null
  const todos: TodoItem[] = args.todos
    .filter((t): t is Record<string, unknown> => isObj(t))
    .map((t) => ({
      content: typeof t.content === 'string' ? t.content : '',
      status: typeof t.status === 'string' ? t.status : 'pending',
      activeForm:
        typeof t.activeForm === 'string' ? t.activeForm : undefined
    }))

  const completed = todos.filter((t) => t.status === 'completed').length

  return {
    headline: (
      <span>
        {pick(lang, '更新任务清单', 'Update todos')}
        <span className="ml-1 text-muted-foreground/60">
          · {pick(lang, `${todos.length} 项`, `${todos.length} items`)}
          {completed > 0 &&
            ` · ${pick(lang, `已完成 ${completed}`, `${completed} done`)}`}
        </span>
      </span>
    ),
    input: {
      label: pick(lang, '任务', 'Todos'),
      content: (
        <ul className="space-y-1 text-[12px]">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-[3px] flex size-[12px] shrink-0 items-center justify-center">
                <TodoStatusMark status={t.status} />
              </span>
              <span
                className={
                  t.status === 'completed'
                    ? 'text-muted-foreground/60 line-through'
                    : t.status === 'in_progress'
                      ? 'text-accent'
                      : 'text-foreground/85'
                }
              >
                {t.status === 'in_progress' && t.activeForm
                  ? t.activeForm
                  : t.content}
              </span>
            </li>
          ))}
        </ul>
      ),
      copyText: todos
        .map(
          (t) =>
            `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`
        )
        .join('\n')
    },
    output: null
  }
}

type AskQuestion = {
  question: string
  header?: string
  options: { label: string; description?: string }[]
}

function parseAskUserQuestions(args: unknown): AskQuestion[] {
  if (!isObj(args) || !Array.isArray(args.questions)) return []
  const out: AskQuestion[] = []
  for (const q of args.questions) {
    if (!isObj(q) || typeof q.question !== 'string') continue
    if (!Array.isArray(q.options)) continue
    const options: AskQuestion['options'] = []
    for (const opt of q.options) {
      if (!isObj(opt) || typeof opt.label !== 'string') continue
      options.push({
        label: opt.label,
        description:
          typeof opt.description === 'string' && opt.description.length > 0
            ? opt.description
            : undefined
      })
    }
    if (options.length === 0) continue
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : undefined,
      options
    })
  }
  return out
}

function parseAskUserAnswers(args: unknown): Record<string, string> {
  if (!isObj(args) || !isObj(args.answers)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(args.answers)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Fallback: extract the answers from the tool result string. The tool's
 * `mapToolResultToToolResultBlockParam` formats the payload as
 *   `User has answered your questions: "Q1"="A1", "Q2"="A2". ...`
 * When the assistant-ui state doesn't echo the updated `answers` back
 * into `args`, this regex is our only source of truth for which option
 * the user actually picked.
 */
function parseAnswersFromResult(result: unknown): Record<string, string> {
  const text = extractText(result)
  if (!text) return {}
  const out: Record<string, string> = {}
  const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const q = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const a = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    out[q] = a
  }
  return out
}

function formatAskUserQuestion({
  args,
  result,
  running,
  lang
}: FormatterCtx): FriendlyView | null {
  const questions = parseAskUserQuestions(args)
  if (questions.length === 0) return null
  // Prefer answers from `args` when the broker echoed them back; fall
  // back to scraping the tool result string (that's where AskUserQuestion
  // actually reports the picks in our current wiring).
  const answersFromArgs = parseAskUserAnswers(args)
  const answersFromResult = parseAnswersFromResult(result)
  const answers: Record<string, string> = { ...answersFromResult, ...answersFromArgs }
  const answered = Object.keys(answers).length
  const total = questions.length
  const allAnswered = answered === total && total > 0

  // Split a possibly-comma-separated answer (multiSelect) into the
  // individual picked labels so we can highlight every matching row.
  const pickedLabels = (questionText: string): Set<string> => {
    const raw = answers[questionText]
    if (!raw) return new Set()
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  }

  const headline = (
    <span className="text-foreground/85">
      {running && !allAnswered
        ? pick(lang, '等待你的回答', 'Waiting for your answer')
        : allAnswered
          ? pick(
              lang,
              total === 1 ? '已回答 1 个问题' : `已回答 ${total} 个问题`,
              total === 1 ? 'Answered 1 question' : `Answered ${total} questions`
            )
          : pick(
              lang,
              `${answered}/${total} 个问题已回答`,
              `${answered}/${total} questions answered`
            )}
    </span>
  )

  const content = (
    <div className="space-y-3">
      {questions.map((q, qi) => {
        const picks = pickedLabels(q.question)
        return (
          <div
            key={qi}
            className="space-y-1.5 rounded-md border border-border/60 bg-card/60 p-2.5"
          >
            <div className="flex items-baseline gap-2">
              {q.header && (
                <span className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-[1px] text-[10px] font-medium text-muted-foreground">
                  {q.header}
                </span>
              )}
              <span className="text-[12.5px] leading-snug text-foreground/90">
                {q.question}
              </span>
            </div>
            <ul className="space-y-1 pl-0.5">
              {q.options.map((opt, oi) => {
                const selected = picks.has(opt.label)
                return (
                  <li
                    key={oi}
                    className={
                      'flex items-start gap-2 rounded-sm px-1.5 py-1 text-[12px] ' +
                      (selected
                        ? 'bg-emerald-500/10 text-foreground'
                        : 'text-foreground/70')
                    }
                  >
                    <span
                      aria-hidden
                      className={
                        'mt-[3px] flex size-[12px] shrink-0 items-center justify-center rounded-full border ' +
                        (selected
                          ? 'border-emerald-500 bg-emerald-500 text-white'
                          : 'border-muted-foreground/40')
                      }
                    >
                      {selected && (
                        <svg
                          width="8"
                          height="8"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={
                          selected
                            ? 'font-medium text-foreground'
                            : 'text-foreground/80'
                        }
                      >
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="ml-1.5 text-muted-foreground/75">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </li>
                )
              })}
              {picks.size === 0 && !running && (
                <li className="pl-5 text-[11px] italic text-muted-foreground/60">
                  {pick(lang, '未作答', 'No answer')}
                </li>
              )}
            </ul>
          </div>
        )
      })}
    </div>
  )

  const copyText = questions
    .map((q) => {
      const picked = answers[q.question]
      const head = q.header ? `[${q.header}] ` : ''
      const optsText = q.options
        .map((o) => `  - ${o.label}${o.description ? `: ${o.description}` : ''}`)
        .join('\n')
      return `${head}${q.question}\n${optsText}${picked ? `\n→ ${picked}` : ''}`
    })
    .join('\n\n')

  return {
    headline,
    input: {
      label: pick(lang, '询问', 'Questions'),
      content,
      copyText
    },
    // Tool result is just a "User has answered..." confirmation string —
    // the highlighted selections above already convey it.
    output: extractText(result).length > 0 ? null : undefined
  }
}

function formatSkill({ args, lang }: FormatterCtx): FriendlyView | null {
  const skill = getStringArg(args, 'skill')
  if (!skill) return null
  const skillArgs = getStringArg(args, 'args')
  return {
    headline: (
      <span>
        {pick(lang, '调用技能', 'Launch skill')}{' '}
        <code className="font-mono text-[11.5px] text-accent">{skill}</code>
        {skillArgs && (
          <span className="ml-1 text-muted-foreground/60">
            · {pick(lang, '参数', 'args')}{' '}
            <code className="font-mono text-[11px]">{skillArgs}</code>
          </span>
        )}
      </span>
    ),
    input: null,
    // Skill's stdout is just a "Launching skill: X" confirmation line —
    // the headline already says that, so suppress it.
    output: null
  }
}

const FORMATTERS: Record<string, Formatter> = {
  Bash: formatBash,
  Read: formatRead,
  Write: formatWrite,
  Edit: formatEdit,
  MultiEdit: formatMultiEdit,
  Grep: formatGrep,
  Glob: formatGlob,
  WebFetch: formatWebFetch,
  ToolSearch: formatToolSearch,
  TodoWrite: formatTodoWrite,
  Skill: formatSkill,
  AskUserQuestion: formatAskUserQuestion
}

/* ───────────────────── shared sub-components ─────────────────── */

function DiffView({
  oldText,
  newText
}: {
  oldText: string
  newText: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11.5px] leading-snug">
      {oldText && (
        <pre className="max-h-40 max-w-full overflow-auto whitespace-pre rounded-sm bg-red-500/10 px-2 py-1 text-red-400/90">
          {oldText.split('\n').map((line, i) => (
            <div key={i}>
              <span aria-hidden className="select-none opacity-60">
                -{' '}
              </span>
              {line || '\u200b'}
            </div>
          ))}
        </pre>
      )}
      {newText && (
        <pre className="max-h-40 max-w-full overflow-auto whitespace-pre rounded-sm bg-emerald-500/10 px-2 py-1 text-emerald-400/90">
          {newText.split('\n').map((line, i) => (
            <div key={i}>
              <span aria-hidden className="select-none opacity-60">
                +{' '}
              </span>
              {line || '\u200b'}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

function TodoStatusMark({ status }: { status: string }): React.JSX.Element {
  if (status === 'completed') {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-emerald-500"
        aria-hidden
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <span
        aria-hidden
        className="block size-[7px] rounded-full bg-accent"
      />
    )
  }
  return (
    <span
      aria-hidden
      className="block size-[7px] rounded-full border border-muted-foreground/40"
    />
  )
}

