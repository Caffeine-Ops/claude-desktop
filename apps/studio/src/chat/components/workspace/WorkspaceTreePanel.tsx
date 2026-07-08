import { useCallback, useEffect, useMemo, useState } from 'react'

import { useT, useTFormat } from '../../i18n'
import { useChatStore } from '../../stores/chat'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * Tools whose completion means "files on disk probably changed".
 * Seeing one of these in a `tool_result` bumps the refresh tick.
 *
 * Bash is included because it's a catch-all shell escape hatch — `mv`,
 * `rm`, `touch`, `mkdir`, `echo > file`, `npm install`, `git checkout`
 * all mutate files. That creates a few false-positive refreshes when
 * the user runs a read-only command (e.g. `ls`, `git status`), but
 * debounce + git-ls-files cache warmth keep the cost negligible.
 */
const FILE_MUTATING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash'
])

/**
 * How long to wait after the last bump before actually re-scanning the
 * workspace. A single turn can produce a burst of tool_results (e.g.
 * MultiEdit → Write → Write → Bash "git status"); coalescing them into
 * one IPC keeps the main-side git-ls-files count down and avoids
 * flicker from incremental tree renders.
 */
const FETCH_DEBOUNCE_MS = 400

/**
 * Polling backstop interval. The chat stream gives us a high-fidelity
 * signal when *Claude* touches files; this timer catches everything
 * else (user saving a file in their editor, `git pull` from a
 * terminal, a background build emitting new assets).
 */
const POLL_FALLBACK_MS = 15_000

/**
 * WorkspaceTreePanel
 * ------------------
 * Bottom half of the right rail: a collapsible directory tree of the
 * current workspace. Consumes the same `chatApi.listFileSuggestions`
 * IPC that powers the composer's `@`-mention popover, so main only
 * has to scan the workspace once per 5s TTL window.
 *
 * Tradeoff vs. a dedicated "workspace-tree" IPC:
 *   - Pro: zero new main-side code, reuses the existing git-ls-files
 *     → readdir fallback + cache in fileSuggestions.ts
 *   - Con: the flat list only surfaces *files* (empty directories are
 *     invisible — readdir fallback pushes leaves only, and git ls-files
 *     by definition lists tracked/untracked files). For a quick glance
 *     at what's in the workspace this is fine; if we later want empty
 *     dirs too, add a second IPC that walks readdir with
 *     `withFileTypes: true` and emits directories as well.
 *
 * Data flow
 * ---------
 *   chatApi.listFileSuggestions()
 *     → flat string[]  (e.g. ["src/main/core/engine.ts", "package.json"])
 *     → buildTree()    → nested TreeNode[] with dirs + files sorted
 *     → <Node> recursive render
 *
 * Refresh cadence
 * ---------------
 * Same as the composer: re-fetch on mount and whenever `streaming`
 * flips false (one turn ended). Main's 5s TTL cache de-dupes rapid
 * re-fetches, so this is cheap.
 */
export function WorkspaceTreePanel(): React.JSX.Element {
  const t = useT()
  const tf = useTFormat()
  const sessionId = useChatStore((s) => s.sessionId)
  const streaming = useChatStore((s) => s.streaming)
  // 前台会话的有效工作区（统一会话管理）：已锁定归属 → 预选 → 默认
  // （桌面）。与 main 侧 FILE_SUGGESTIONS 的 cwd 决策同口径 —— 路径
  // chip 显示什么，文件树就扫什么。selector 返回原始 string，无
  // useShallow 顾虑。
  const workspace = useWorkspaceStore((s) =>
    sessionId
      ? (s.sessionWorkspaces[sessionId] ??
        s.pendingChoices[sessionId] ??
        s.current)
      : s.current
  )

  const [files, setFiles] = useState<readonly string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // Monotonic "please re-scan" counter. Multiple bump sources (streaming
  // edge, tool_result, poll) all just increment it; one effect below
  // watches it and debounces the actual IPC. Keeps the refresh sources
  // loosely coupled and trivially testable.
  const [tick, setTick] = useState(0)

  // ── Bump source #1: streaming edge ──────────────────────────────────
  // Fire whenever `streaming` is false. On mount this runs once with
  // the initial `false` value (giving us our first fetch), and it
  // runs again every time a turn finishes. We deliberately skip the
  // `streaming → true` edge: the start of a turn doesn't tell us the
  // filesystem has changed, only that Claude is thinking.
  useEffect(() => {
    if (!streaming) setTick((n) => n + 1)
  }, [streaming])

  // ── Bump source #2: file-mutating tool completed ────────────────────
  // Subscribe to the chat event stream and bump on `tool_result` for
  // tools that might have touched the disk. This is how the tree
  // updates mid-turn while Claude is still running other tools — no
  // waiting until the whole turn ends. Skipped when no session is
  // active (the tree has nothing to react to).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    if (sessionId === null) return
    const unsub = window.chatApi.onEvent(sessionId, (event) => {
      if (
        event.type === 'tool_result' &&
        FILE_MUTATING_TOOLS.has(event.toolName)
      ) {
        setTick((n) => n + 1)
      }
    })
    return unsub
  }, [sessionId])

  // ── Bump source #3: polling fallback ────────────────────────────────
  // Cover out-of-band changes the chat stream can't tell us about
  // (editor saves, git pull, build outputs). 15s is a tradeoff between
  // "feels fresh" and "don't burn CPU on idle windows".
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), POLL_FALLBACK_MS)
    return () => clearInterval(id)
  }, [])

  // ── Bump source #4: 前台会话的工作区变了 ───────────────────────────
  // 统一会话管理后每个会话有自己的工作区：切会话 / composer 预选目录都
  // 会换扫描根，立即重拉（main 的 fileSuggestions 缓存按 cwd 键控，换
  // 目录必 miss，不会拿到旧树）。
  useEffect(() => {
    setTick((n) => n + 1)
  }, [workspace])

  // ── Fetch effect: debounced, force-refresh ─────────────────────────
  // `force: true` bypasses main's 5s TTL cache so we actually see the
  // latest files — without it, the tree would be pinned to whatever
  // snapshot the composer warmed at mount time. Debounce coalesces
  // bursts of bumps (e.g. a single turn running Write, Write, Bash
  // "git status" in ~200ms) into one IPC.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    let cancelled = false
    const timer = setTimeout(() => {
      window.chatApi
        .listFileSuggestions({ force: true })
        .then((result) => {
          if (cancelled) return
          setFiles(result.files)
          setTruncated(result.truncated)
          setError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, FETCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [tick])

  // Memoize the tree so toggling `expanded` doesn't re-build it. The
  // tree itself is pure over `files`; expanded state lives separately
  // so Node can stay purely derived.
  const tree = useMemo(() => buildTree(files), [files])

  const toggle = useCallback((path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const empty = !loading && !error && tree.length === 0

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-foreground/[0.03] dark:bg-white/[0.04]"
      style={{ letterSpacing: '-0.01em' }}
    >
      {/* Header — mirrors the Todos header above for visual symmetry.
          The count shows trailing '+' when the scan hit MAX_ENTRIES
          in main so the user knows the tree is truncated. A second
          line shows the active workspace path (home-shortened, full
          path on hover) so the user always knows which folder the
          tree below is rooted at. */}
      <div className="flex flex-col gap-1.5 px-3.5 pb-2 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-[18px] shrink-0 items-center justify-center text-muted-foreground">
              <FilesHeaderIcon />
            </span>
            <span
              className="font-semibold text-foreground"
              style={{ fontSize: '13px', letterSpacing: '-0.012em' }}
            >
              {t('filesTitle')}
            </span>
          </div>
          {files.length > 0 && (
            <span
              className="rounded-full bg-foreground/[0.08] px-2 py-[2px] text-[10.5px] font-medium tabular-nums text-muted-foreground dark:bg-white/[0.1]"
              title={
                truncated
                  ? tf('filesCountTruncated', { count: files.length })
                  : tf('filesCountLabel', { count: files.length })
              }
              style={{ letterSpacing: '-0.01em' }}
            >
              {files.length}
              {truncated && '+'}
            </span>
          )}
        </div>
        {workspace && <WorkspacePathChip path={workspace} />}
      </div>

      {/* Scroll region — independent from the Todo scroll above. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-0.5">
        {loading && files.length === 0 && (
          <div
            className="flex items-center gap-2 px-4 py-2 text-muted-foreground"
            style={{ fontSize: '11px', letterSpacing: '-0.01em' }}
          >
            <span className="inline-flex size-3 animate-pulse rounded-full bg-muted-foreground/40" />
            {t('filesLoading')}
          </div>
        )}

        {error && (
          <div
            className="mx-3 my-2 rounded-lg bg-red-500/[0.12] px-3 py-2 text-red-500"
            style={{ fontSize: '11px', lineHeight: 1.47, letterSpacing: '-0.01em' }}
          >
            {error}
          </div>
        )}

        {empty && (
          <div
            className="mx-2 my-2 flex flex-col items-center gap-2.5 rounded-xl px-3 py-6 text-center text-muted-foreground"
            style={{ fontSize: '11.5px', letterSpacing: '-0.01em' }}
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground/80 dark:bg-white/[0.08]">
              <FilesHeaderIcon />
            </span>
            <div className="font-medium text-foreground/75">
              {t('filesEmpty')}
            </div>
          </div>
        )}

        {!loading && !error && tree.length > 0 && (
          <ul className="select-none px-1">
            {tree.map((node) => (
              <Node
                key={node.path}
                node={node}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
                onOpen={openFile}
                openHint={(p) => tf('filesOpenHint', { path: p })}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/**
 * Replace the `/Users/<name>` (or `/home/<name>`) prefix with `~` so
 * the workspace path subline reads more like a shell prompt and saves
 * horizontal room in the narrow rail. Renderer has no access to
 * `os.homedir()`, so we sniff the prefix from the path itself.
 */
function abbreviateHome(p: string): string {
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/)
  if (m) return '~' + p.slice(m[1].length)
  return p
}

/**
 * Workspace path chip rendered under the "Files" header. Clicking the
 * chip asks main to open the workspace folder in the OS file manager
 * (Finder / Explorer) via `shell.openPath`. Goals:
 *  - basename pops (foreground, medium weight) — that's the part the
 *    user actually scans for when verifying "am I in the right repo"
 *  - parent fades back so it reads as breadcrumb context, not noise
 *  - overflow truncates from the *left* (the parent end) so the
 *    basename is always visible even on long monorepo paths
 */
function WorkspacePathChip({ path }: { path: string }): React.JSX.Element {
  const display = abbreviateHome(path)
  const lastSlash = display.lastIndexOf('/')
  const parent = lastSlash >= 0 ? display.slice(0, lastSlash + 1) : ''
  const basename = lastSlash >= 0 ? display.slice(lastSlash + 1) : display

  const onOpen = useCallback(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    window.chatApi
      .openWorkspace()
      .then((result) => {
        if (result.error) {
          console.warn('[workspace-tree] openWorkspace failed:', result.error)
        }
      })
      .catch((err: unknown) => {
        console.error('[workspace-tree] openWorkspace threw:', err)
      })
  }, [])

  return (
    <button
      type="button"
      onClick={onOpen}
      title={path}
      className="group/path ml-[26px] flex max-w-[calc(100%-1.75rem)] items-center gap-1.5 self-start rounded-lg bg-foreground/[0.05] px-2 py-1 text-left transition-colors hover:bg-foreground/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
    >
      <span className="flex size-3 shrink-0 items-center justify-center text-muted-foreground/70 group-hover/path:text-muted-foreground">
        <HomeMiniIcon />
      </span>
      <span
        className="min-w-0 flex-1 truncate leading-tight"
        dir="rtl"
        style={{
          textAlign: 'left',
          unicodeBidi: 'plaintext',
          fontSize: '10.5px',
          letterSpacing: '-0.01em'
        }}
      >
        <span className="text-muted-foreground/60">{parent}</span>
        <span className="font-semibold text-foreground/90">{basename}</span>
      </span>
    </button>
  )
}

function HomeMiniIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 7.5 8 3l5.5 4.5" />
      <path d="M4 7v5.5a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V7" />
    </svg>
  )
}

function FilesHeaderIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[13px]"
      aria-hidden
    >
      <path d="M2.5 5a1 1 0 0 1 1-1h2.5l1 1.2H12.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5Z" />
    </svg>
  )
}

/**
 * Ask main to open a workspace-relative file in the OS default handler.
 * Surfaces failures (missing handler, permission denied, invalid path)
 * to the console — the tree itself has no toast slot and I don't want
 * to add one just for this edge. If the user reports "nothing happens",
 * devtools → console is where they'll find the reason.
 */
async function openFile(relPath: string): Promise<void> {
  if (typeof window === 'undefined' || !window.chatApi) return
  try {
    const result = await window.chatApi.openFile({ relPath })
    if (result.error) {
      console.warn('[workspace-tree] openFile failed:', relPath, result.error)
    }
  } catch (err) {
    console.error('[workspace-tree] openFile threw:', err)
  }
}

/* ─────────────────── Tree node (recursive) ─────────────────── */

interface TreeNode {
  /** Basename only — e.g. "engine.ts". */
  name: string
  /** Workspace-relative path, forward-slash normalized. */
  path: string
  /** True for directories (possibly empty children in the list case). */
  isDir: boolean
  /** Already sorted: directories first, then files, each alphabetical. */
  children: TreeNode[]
}

function Node({
  node,
  depth,
  expanded,
  onToggle,
  onOpen,
  openHint
}: {
  node: TreeNode
  depth: number
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  /** Fired on dbl-click of a file node. Ignored for directories. */
  onOpen: (path: string) => void
  /** Resolves the localized "<path> — double-click to open" hint. */
  openHint: (path: string) => string
}): React.JSX.Element {
  const isOpen = expanded.has(node.path)

  // Indentation via inline style — Tailwind's padding scale doesn't go
  // fine-grained enough for the "14px per depth" we want and I don't
  // want to pollute tailwind.config with custom utilities.
  const indentStyle = { paddingLeft: `${6 + depth * 14}px` }

  return (
    <li>
      <div
        className={
          'group/tree flex items-center gap-1.5 rounded-lg py-[3px] pr-2 transition-colors ' +
          (node.isDir
            ? 'cursor-pointer text-foreground/90 hover:bg-foreground/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]'
            : 'cursor-default text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]')
        }
        style={{ ...indentStyle, fontSize: '12.5px', letterSpacing: '-0.012em' }}
        onClick={node.isDir ? () => onToggle(node.path) : undefined}
        onDoubleClick={
          !node.isDir
            ? (e) => {
                // Prevent the browser's text-selection behavior on
                // double-click (the default click target is the
                // filename span, which would otherwise get selected
                // right as the OS opens the file — minor, but ugly).
                e.preventDefault()
                onOpen(node.path)
              }
            : undefined
        }
        role={node.isDir ? 'button' : undefined}
        aria-expanded={node.isDir ? isOpen : undefined}
        title={node.isDir ? node.path : openHint(node.path)}
      >
        {/* Chevron slot — single rotating chevron so the open/close
            transition reads as motion instead of a glyph swap. Files
            get an invisible placeholder of the same width so their
            name column aligns with sibling dirs. */}
        <span className="flex size-[10px] shrink-0 items-center justify-center text-muted-foreground/60">
          {node.isDir ? (
            <span
              className={
                'inline-flex transition-transform duration-150 ' +
                (isOpen ? 'rotate-90' : 'rotate-0')
              }
            >
              <ChevronRight />
            </span>
          ) : null}
        </span>

        {/* Icon slot — amber folder for dirs, ext-colored document
            icon for files so you can eyeball file types at a glance. */}
        <span className="flex size-[14px] shrink-0 items-center justify-center">
          {node.isDir ? (
            <span className="text-amber-400/85">
              <FolderIcon />
            </span>
          ) : (
            <FileIcon name={node.name} />
          )}
        </span>

        {/* Name — single line, truncate on overflow. The full path is
            in the `title` attribute on the row above so hover still
            discloses it. */}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>

        <CopyNameButton name={node.name} />
      </div>

      {node.isDir && isOpen && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpen={onOpen}
              openHint={openHint}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/* ─────────────────── Tree construction ─────────────────── */

/**
 * Turn a flat list of workspace-relative file paths into a sorted tree.
 * Dirs-first, alphabetical within each group, depth-first recursion.
 *
 * Empty-directory caveat: `paths` only contains files (see component
 * doc for why), so empty dirs never appear. Directories materialize
 * only as the *parents* of at least one listed file.
 *
 * Performance: O(total path segments) once per `files` change. With
 * MAX_ENTRIES = 5000 and an average depth of ~5, that's ~25k Map ops,
 * well under a frame budget.
 */
function buildTree(paths: readonly string[]): TreeNode[] {
  type Partial = {
    name: string
    path: string
    isDir: boolean
    children: Map<string, Partial>
  }
  const root: Partial = {
    name: '',
    path: '',
    isDir: true,
    children: new Map()
  }

  for (const p of paths) {
    const parts = p.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let cursor = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isLast = i === parts.length - 1
      let child = cursor.children.get(part)
      if (!child) {
        child = {
          name: part,
          // Rebuild the prefix instead of joining with `/` from scratch
          // each iteration — marginally cheaper and keeps slashes stable.
          path: parts.slice(0, i + 1).join('/'),
          isDir: !isLast,
          children: new Map()
        }
        cursor.children.set(part, child)
      }
      cursor = child
    }
  }

  // Recursive Map → sorted array.
  const bake = (node: Partial): TreeNode[] => {
    const arr: TreeNode[] = []
    for (const child of node.children.values()) {
      arr.push({
        name: child.name,
        path: child.path,
        isDir: child.isDir,
        children: child.isDir ? bake(child) : []
      })
    }
    arr.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return arr
  }
  return bake(root)
}

/* ─────────────────── Per-row copy-name button ─────────────────── */

/**
 * Hover-revealed icon button that copies a tree node's basename to the
 * clipboard. Lives inside the row's `group/tree` so it fades in on
 * row-hover, and stops click/dblclick propagation so it never triggers
 * the row's own toggle/open handlers.
 *
 * Layout-stable: the button always occupies its slot (opacity-0 when
 * idle), so revealing it on hover doesn't reflow the filename column.
 */
function CopyNameButton({ name }: { name: string }): React.JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(
    async (e: React.MouseEvent) => {
      // Stop the row's onClick (dir toggle). The row's onDoubleClick
      // is handled by the button's own onDoubleClick below.
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(name)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      } catch (err) {
        console.error('[workspace-tree] clipboard copy failed', err)
      }
    },
    [name]
  )

  return (
    <button
      type="button"
      onClick={onCopy}
      onDoubleClick={(e) => e.stopPropagation()}
      title={copied ? t('filesCopyNameCopied') : t('filesCopyName')}
      aria-label={t('filesCopyName')}
      className={
        'inline-flex size-[16px] shrink-0 items-center justify-center rounded ' +
        'transition-opacity ' +
        'opacity-0 group-hover/tree:opacity-100 focus-visible:opacity-100 ' +
        'hover:bg-muted/60 ' +
        (copied
          ? 'text-emerald-500 opacity-100'
          : 'text-muted-foreground/70 hover:text-foreground')
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

/* ─────────────────── Icons (inline SVG, zero deps) ─────────────────── */

function CopyIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ChevronRight(): React.JSX.Element {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

/**
 * File icon colored by extension. Uses the same document outline for
 * every file but swaps stroke + fold fill color by category, so the
 * eye can triangulate "that's a code file" / "that's a PPT" / "that's
 * an image" without reading the name.
 *
 * Not as precise as something like `vscode-icons`, but zero runtime
 * dependency and consistent with the stroke aesthetic of the rest of
 * the panel. If we ever want per-ext SVG art, this is the place to
 * swap — callers just pass `name` and never see the color logic.
 */
function FileIcon({ name }: { name: string }): React.JSX.Element {
  const color = extColor(name)
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* Document body. The `fill` on the fold triangle is the same
          stroke color at 15% alpha so the corner feels "filled" and
          reads as a paper fold instead of an empty line. */}
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline
        points="14 2 14 8 20 8"
        fill={color}
        fillOpacity={0.18}
      />
    </svg>
  )
}

/**
 * Map the trailing extension of `name` to a category color.
 *
 * Categories (in priority order):
 *   - code       (TypeScript, JavaScript, Python, Go, Rust, Java, …)
 *   - web        (HTML, CSS, SCSS, Less)
 *   - config     (JSON, YAML, TOML, env)
 *   - markup     (MD, MDX, RST)
 *   - office     (PPT/DOC/XLS + CSV/PDF)
 *   - image      (PNG/JPG/GIF/WEBP/SVG)
 *   - archive    (ZIP/TAR/GZ)
 *   - default    (zinc-500 — "no strong signal")
 *
 * Colors are chosen to be visually distinct on the #0a0a0c panel
 * background without being so saturated that they scream. Most come
 * straight from the "GitHub Linguist" palette GitHub uses for the
 * language bar on repo pages, normalized to avoid near-duplicates.
 */
function extColor(name: string): string {
  // Handle hidden files like ".gitignore" cleanly — the leading dot is
  // also the ext separator, so `"gitignore"` is the right basename.
  const lower = name.toLowerCase()
  const lastDot = lower.lastIndexOf('.')
  const ext =
    lastDot <= 0 ? lower.replace(/^\./, '') : lower.slice(lastDot + 1)

  // code
  if (ext === 'ts' || ext === 'tsx') return '#3178c6'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs')
    return '#f7df1e'
  if (ext === 'py') return '#3572a5'
  if (ext === 'go') return '#00add8'
  if (ext === 'rs') return '#dea584'
  if (ext === 'java' || ext === 'kt' || ext === 'kts') return '#b07219'
  if (ext === 'c' || ext === 'h') return '#555555'
  if (ext === 'cpp' || ext === 'cc' || ext === 'hpp') return '#f34b7d'
  if (ext === 'rb') return '#cc342d'
  if (ext === 'php') return '#777bb4'
  if (ext === 'swift') return '#fa7343'
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return '#89e051'

  // web
  if (ext === 'html' || ext === 'htm') return '#e34c26'
  if (ext === 'css') return '#563d7c'
  if (ext === 'scss' || ext === 'sass') return '#c6538c'
  if (ext === 'less') return '#1d365d'
  if (ext === 'vue') return '#41b883'
  if (ext === 'svelte') return '#ff3e00'

  // config / data
  if (ext === 'json' || ext === 'json5' || ext === 'jsonc') return '#f1c40f'
  if (ext === 'yml' || ext === 'yaml') return '#cb171e'
  if (ext === 'toml') return '#9c4121'
  if (ext === 'xml') return '#0060ac'
  if (ext === 'env' || lower === '.env' || lower.startsWith('.env.'))
    return '#ecd53f'
  if (ext === 'ini' || ext === 'conf' || ext === 'cfg') return '#6d8086'
  if (lower === 'dockerfile' || ext === 'dockerfile') return '#2496ed'
  if (lower === 'makefile' || ext === 'mk') return '#6d7b8d'

  // markup
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return '#083fa1'
  if (ext === 'rst') return '#141414'
  if (ext === 'txt') return '#9ca3af'

  // office
  if (ext === 'pdf') return '#ec1c24'
  if (ext === 'doc' || ext === 'docx' || ext === 'rtf') return '#2b579a'
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv' || ext === 'tsv')
    return '#217346'
  if (ext === 'ppt' || ext === 'pptx' || ext === 'key') return '#d24726'

  // images
  if (
    ext === 'png' ||
    ext === 'jpg' ||
    ext === 'jpeg' ||
    ext === 'gif' ||
    ext === 'webp' ||
    ext === 'avif' ||
    ext === 'bmp' ||
    ext === 'ico'
  )
    return '#c084fc'
  if (ext === 'svg') return '#ffb13b'

  // audio / video
  if (ext === 'mp3' || ext === 'wav' || ext === 'flac' || ext === 'ogg')
    return '#2dd4bf'
  if (ext === 'mp4' || ext === 'mov' || ext === 'webm' || ext === 'mkv')
    return '#f472b6'

  // archives
  if (
    ext === 'zip' ||
    ext === 'tar' ||
    ext === 'gz' ||
    ext === 'tgz' ||
    ext === 'bz2' ||
    ext === 'xz' ||
    ext === '7z' ||
    ext === 'rar'
  )
    return '#fb923c'

  // fallback — zinc-500, same as the folder outline neutral
  return '#71717a'
}
