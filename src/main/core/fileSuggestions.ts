import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * File suggestion cache for the composer's `@`-mention popover.
 *
 * Mirrors free-code's hooks/fileSuggestions.ts strategy at a much smaller
 * scale: cache a list of repo-relative paths in memory, refresh on a 5s
 * TTL (or when the caller forces it), and let the renderer do synchronous
 * fuzzy filtering on its side.
 *
 * Two scan strategies, in priority order:
 *
 *   1. `git ls-files` (tracked + untracked-not-ignored) — fast, respects
 *      .gitignore, and is how free-code does it.
 *   2. Recursive `fs.readdir` fallback with a hardcoded skip list
 *      (node_modules, .git, dist, out, build, …). Used when the cwd
 *      isn't a git repo or git is unavailable.
 *
 * Capped at MAX_ENTRIES so a giant monorepo can't blow up renderer
 * memory — the renderer is going to do O(n) substring matching on
 * every keystroke.
 */

const CACHE_TTL_MS = 5_000
const MAX_ENTRIES = 5_000
const GIT_TIMEOUT_MS = 5_000
const READDIR_SKIP = new Set([
  '.git',
  '.svn',
  '.hg',
  '.DS_Store',
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage'
])

interface CacheEntry {
  cwd: string
  fetchedAt: number
  files: readonly string[]
  truncated: boolean
}

let cache: CacheEntry | null = null
let inflight: Promise<CacheEntry> | null = null

export interface FileSuggestionsResult {
  /** Working directory the list was scanned from (absolute path). */
  cwd: string
  /** Repo-relative paths, forward-slash normalized. */
  files: readonly string[]
  /** True when the full set exceeded MAX_ENTRIES and was cut off. */
  truncated: boolean
}

/**
 * Return the current file list for the given cwd. Uses the 5s TTL cache
 * unless `force` is set. Concurrent calls during an in-flight scan share
 * the same promise — no thundering herd on mount.
 */
export async function listFileSuggestions(
  cwd: string,
  force = false
): Promise<FileSuggestionsResult> {
  const absoluteCwd = isAbsolute(cwd) ? cwd : join(process.cwd(), cwd)

  if (!force && cache && cache.cwd === absoluteCwd) {
    if (Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      return toResult(cache)
    }
  }

  if (inflight) {
    const pending = await inflight
    if (pending.cwd === absoluteCwd) {
      return toResult(pending)
    }
  }

  inflight = scan(absoluteCwd)
  try {
    const entry = await inflight
    cache = entry
    return toResult(entry)
  } finally {
    inflight = null
  }
}

/** Force-drop the cache. Useful if the caller knows the workspace changed. */
export function invalidateFileSuggestions(): void {
  cache = null
}

function toResult(entry: CacheEntry): FileSuggestionsResult {
  return {
    cwd: entry.cwd,
    files: entry.files,
    truncated: entry.truncated
  }
}

async function scan(absoluteCwd: string): Promise<CacheEntry> {
  const started = Date.now()

  // 1) Try git first — it's faster and honors .gitignore for free.
  const gitFiles = await tryGit(absoluteCwd)
  if (gitFiles !== null) {
    const { files, truncated } = capAndNormalize(gitFiles)
    console.log(
      `[fileSuggestions] git scan ${absoluteCwd} → ${files.length} files` +
        (truncated ? ' (truncated)' : '') +
        ` in ${Date.now() - started}ms`
    )
    return { cwd: absoluteCwd, fetchedAt: Date.now(), files, truncated }
  }

  // 2) Fallback: recursive readdir with a skip list.
  const walked = await walkDir(absoluteCwd)
  const { files, truncated } = capAndNormalize(walked)
  console.log(
    `[fileSuggestions] readdir scan ${absoluteCwd} → ${files.length} files` +
      (truncated ? ' (truncated)' : '') +
      ` in ${Date.now() - started}ms`
  )
  return { cwd: absoluteCwd, fetchedAt: Date.now(), files, truncated }
}

async function tryGit(cwd: string): Promise<string[] | null> {
  try {
    // core.quotepath=false → keep non-ASCII filenames readable.
    // --cached lists tracked files, --others --exclude-standard adds
    // untracked-not-ignored. The combination matches what free-code's
    // fileSuggestions does (tracked + background-fetched untracked).
    const { stdout } = await execFileAsync(
      'git',
      [
        '-c',
        'core.quotepath=false',
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard'
      ],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
    )
    const lines = stdout.split('\n').filter(Boolean)
    if (lines.length === 0) {
      // Empty result could mean "not a git repo" or "empty repo". Fall
      // through to the readdir path so we still get something useful.
      return null
    }
    return lines
  } catch (err) {
    // ENOENT → no git binary; exit code 128 → not a repo. Both land here
    // and both mean "fall back to readdir".
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[fileSuggestions] git ls-files unavailable: ${msg}`)
    return null
  }
}

/**
 * Breadth-first directory walker with a hardcoded skip list. Stops once
 * MAX_ENTRIES is reached so a runaway deep tree can't hang the scan.
 */
async function walkDir(root: string): Promise<string[]> {
  const results: string[] = []
  const queue: string[] = [root]

  while (queue.length > 0 && results.length < MAX_ENTRIES) {
    const current = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (READDIR_SKIP.has(entry.name)) continue
      // Skip dotfiles except common-ones the user might want to @-mention.
      if (entry.name.startsWith('.') && !KEEP_DOTFILES.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (entry.isFile()) {
        results.push(relative(root, full))
        if (results.length >= MAX_ENTRIES) break
      }
    }
  }

  return results
}

const KEEP_DOTFILES = new Set([
  '.env.example',
  '.gitignore',
  '.eslintrc',
  '.prettierrc',
  '.editorconfig',
  '.nvmrc'
])

function capAndNormalize(files: string[]): {
  files: readonly string[]
  truncated: boolean
} {
  // Normalize path separators to forward slashes so the renderer never
  // has to deal with Windows backslashes in its fuzzy matcher.
  const normalized =
    sep === '/' ? files : files.map((f) => f.split(sep).join('/'))
  // Deduplicate — git ls-files can emit the same path twice when a file
  // is both staged and modified (uncommon but possible).
  const deduped = Array.from(new Set(normalized))
  // Stable sort by path length ascending so shallower paths float to
  // the top when two entries otherwise tie. The renderer may re-rank.
  deduped.sort((a, b) => a.length - b.length || a.localeCompare(b))
  const truncated = deduped.length > MAX_ENTRIES
  return {
    files: truncated ? deduped.slice(0, MAX_ENTRIES) : deduped,
    truncated
  }
}
