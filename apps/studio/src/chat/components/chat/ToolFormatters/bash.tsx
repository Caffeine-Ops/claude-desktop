import React from 'react'

import type { Lang } from '../../../i18n'
import { extractText, getStringArg } from '../toolHelpers'
import { isObj, pick } from './helpers'
import type { FormatterCtx, FriendlyView } from './types'

/* ──────────────────────── formatters ─────────────────────── */

export function formatBash({ args, result, lang }: FormatterCtx): FriendlyView | null {
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

  // Outputs that are mostly file paths (du sizes, find results, the
  // "list what got exported" checks skills love to run) render as a
  // Finder-ish file list: basename + size badge + shortened parent
  // dir. A raw absolute path hard-wraps across 4 lines in the pane
  // and reads as noise to a non-engineer.
  const pathList = isEmptyOutput || lsPane || summary
    ? null
    : renderPathListOutput(trimmed, lang)

  // Last resort for plain logs: a 40-line progress dump (image gen
  // ticks, build spew, …) is pure noise to a non-engineer, but the
  // TAIL is where CLIs put their conclusion — the [DONE] / error /
  // summary line. So long logs collapse to the last few lines with
  // the full text one click away; short logs still render whole.
  const logLines = trimmed.split('\n').filter((l) => l.trim().length > 0)
  const isLongLog =
    !isEmptyOutput &&
    !lsPane &&
    !summary &&
    !pathList &&
    (logLines.length > 12 || trimmed.length > 800)
  const logTail = logLines.slice(-5)

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
    // Simplified design: the command itself already rides inline in the
    // card header (summarizeArgs picks `command`), so a dedicated
    // `$ cmd` input box would just repeat it. Suppress the input pane
    // entirely (null) and let the header carry the command — matching
    // the reference "已执行命令 ls -la" single-row layout.
    input: null,
    // Empty output → no pane. `ls` → grid renderer. Summarized
    // output → friendly one-liner + raw details toggle. Path-heavy
    // output → file-row list. Plain log → raw pre.
    output: isEmptyOutput
      ? null
      : lsPane
        ? {
            label: lsPane.label,
            content: (
              <div className="space-y-1.5">
                {lsPane.content}
                <RawOutputDetails
                  raw={trimmed}
                  label={pick(lang, '查看原始输出', 'Raw output')}
                />
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
                  <RawOutputDetails
                    raw={trimmed}
                    label={pick(lang, '查看完整输出', 'Full output')}
                  />
                </div>
              ),
              copyText: trimmed
            }
          : pathList
            ? {
                label: pathList.label,
                content: (
                  <div className="space-y-1.5">
                    {pathList.content}
                    <RawOutputDetails
                      raw={trimmed}
                      label={pick(lang, '查看原始输出', 'Raw output')}
                    />
                  </div>
                ),
                copyText: trimmed
              }
            : isLongLog
              ? {
                  label: pick(lang, '输出', 'Response'),
                  content: (
                    <div className="space-y-1.5">
                      <div className="text-[11px] text-muted-foreground/70">
                        {pick(
                          lang,
                          `输出共 ${logLines.length} 行，这里只显示最后 ${logTail.length} 行`,
                          `${logLines.length} lines of output — showing the last ${logTail.length}`
                        )}
                      </div>
                      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-foreground/85">
                        {logTail.join('\n')}
                      </pre>
                      <RawOutputDetails
                        raw={trimmed}
                        label={pick(lang, '查看完整输出', 'Full output')}
                      />
                    </div>
                  ),
                  copyText: trimmed
                }
              : {
                  label: pick(lang, '输出', 'Response'),
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
 * Shared "查看原始输出" toggle. Every friendly rendering (ls grid,
 * one-line summary, path list) is a lossy heuristic, so the untouched
 * text must stay one click away as ground truth.
 */
function RawOutputDetails({
  raw,
  label
}: {
  raw: string
  label: string
}): React.JSX.Element {
  return (
    <details className="group/bash">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] text-muted-foreground/60 transition hover:text-muted-foreground">
        <span
          aria-hidden
          className="inline-block transition group-open/bash:rotate-90"
        >
          ▸
        </span>
        {label}
      </summary>
      <pre className="mt-1 max-h-60 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground/75">
        {raw}
      </pre>
    </details>
  )
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
        {items.map((name, i) => {
          const hidden = name.startsWith('.')
          // key 必须带 index：items 是 ls 输出裸名字（无路径），递归列目录时
          // 不同子目录下的同名文件（如两个 _index.md）会重复出现，裸 name
          // 做 key 会撞。列表是一次性静态渲染（不重排不增删），index 安全。
          if (kind === 'dir') {
            return (
              <div
                key={`${i}-${name}`}
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
              key={`${i}-${name}`}
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

/* ───────────── path-heavy output → file-row list ───────────── */

type PathLogLine =
  | { kind: 'section'; text: string }
  | { kind: 'path'; path: string; size?: string }
  | { kind: 'text'; text: string }

/** `13M` / `4.0K` / `512B` / plain block counts — the size column
 *  `du -h` / `ls -s` print in front of each path. */
function isSizeToken(tok: string): boolean {
  return /^\d+(?:[.,]\d+)?\s?(?:[KMGTPE]i?)?B?$/i.test(tok)
}

/** Absolute or ~-relative and at least two levels deep. Deliberately
 *  loose — a mis-parsed line keeps its full text in the tooltip and
 *  the raw log stays one click away. */
function isPathToken(tok: string): boolean {
  return /^(?:\/|~\/)/.test(tok) && tok.split('/').length >= 3
}

function classifyPathLogLine(line: string): PathLogLine {
  const t = line.trim()
  // `=== title ===` / `--- title ---` banner rows scripts print to
  // separate blocks of output.
  const section = /^[=\-—#*─]{2,}\s*(.+?)\s*[=\-—#*─]{2,}$/.exec(t)
  if (section?.[1]) return { kind: 'section', text: section[1] }
  // `13M<TAB>/path/to/file` — size column followed by a path. The
  // path may contain spaces (iCloud dirs!), so match greedily.
  const sized = /^(\S+)\s+(.+)$/.exec(t)
  if (sized && isSizeToken(sized[1]!) && isPathToken(sized[2]!.trim())) {
    return { kind: 'path', path: sized[2]!.trim(), size: sized[1] }
  }
  if (isPathToken(t)) return { kind: 'path', path: t }
  return { kind: 'text', text: line }
}

/** `13M` → `13 MB`, `4.0K` → `4 KB` — du's one-letter units read as
 *  typos to non-engineers. Unknown shapes pass through untouched. */
function humanizeSizeToken(tok: string): string {
  const unit = /^(\d+(?:[.,]\d+)?)\s?([KMGTPE])i?B?$/i.exec(tok)
  if (unit) {
    const num = unit[1]!.replace(/[.,]0$/, '')
    return `${num} ${unit[2]!.toUpperCase()}B`
  }
  const bytes = /^(\d+)B$/.exec(tok)
  if (bytes) return `${bytes[1]} B`
  return tok
}

/**
 * Collapse the home prefix to `~` and fold middle segments so the
 * basename and its nearest parents carry the line. The full path
 * lives in the row tooltip and in copy / raw output.
 */
function shortenDir(dir: string): string {
  const home = dir.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
  const segs = home.split('/').filter((s) => s.length > 0)
  const lead = home.startsWith('/') ? '/' : ''
  if (segs.length <= 4) return lead + segs.join('/')
  return `${lead}${segs[0]}/…/${segs.slice(-2).join('/')}`
}

function PathRow({
  path,
  size
}: {
  path: string
  size?: string
}): React.JSX.Element {
  // Only an explicit trailing `/` marks a directory here — unlike the
  // ls grid, a bare extension-less basename in a path listing is far
  // more likely a file (binaries, exports) than a folder.
  const isDir = path.endsWith('/')
  const clean = path.replace(/\/+$/, '')
  const base = clean.split('/').pop() ?? clean
  const parent = clean.slice(0, clean.length - base.length).replace(/\/+$/, '')
  return (
    <div className="flex min-w-0 items-center gap-1.5" title={path}>
      {isDir ? <FolderGlyph /> : <FileGlyph />}
      {/* shrink-0 + max-w: the basename never gets squeezed by the dir
          column, it only truncates against its own cap. */}
      <span className="min-w-0 max-w-[65%] shrink-0 truncate font-mono text-[11.5px] font-medium text-foreground/85">
        {base}
      </span>
      {size && (
        <span className="shrink-0 rounded-full border border-border bg-muted/40 px-1.5 text-[9.5px] font-medium tabular-nums leading-4 text-muted-foreground">
          {humanizeSizeToken(size)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground/50">
        {shortenDir(parent || '/')}
      </span>
    </div>
  )
}

/**
 * Render outputs dominated by file paths (du, find, "check what got
 * exported" one-liners) as a file list. Returns null unless paths
 * clearly dominate — mixed logs read better untouched.
 */
function renderPathListOutput(
  output: string,
  lang: Lang
): { label: string; content: React.ReactNode } | null {
  const rawLines = output.split('\n')
  // Hard cap so a giant log never becomes thousands of flex rows.
  if (rawLines.length > 200) return null
  const lines = rawLines
    .map(classifyPathLogLine)
    .filter((l) => !(l.kind === 'text' && l.text.trim().length === 0))
  const pathCount = lines.filter((l) => l.kind === 'path').length
  const structured = lines.filter((l) => l.kind !== 'text').length
  if (pathCount === 0 || structured < lines.length * 0.6) return null

  return {
    label: pick(lang, `${pathCount} 个文件`, `${pathCount} files`),
    content: (
      <div className="space-y-1">
        {lines.map((l, i) => {
          if (l.kind === 'section') {
            return (
              <div
                key={i}
                className="pt-1.5 font-sans text-[10.5px] uppercase tracking-wider text-muted-foreground/60 first:pt-0"
              >
                {l.text}
              </div>
            )
          }
          if (l.kind === 'path') {
            return <PathRow key={i} path={l.path} size={l.size} />
          }
          return (
            <div
              key={i}
              className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-foreground/75"
            >
              {l.text}
            </div>
          )
        })}
      </div>
    )
  }
}
