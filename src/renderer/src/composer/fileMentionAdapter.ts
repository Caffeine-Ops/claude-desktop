import type {
  Unstable_DirectiveFormatter,
  Unstable_TriggerAdapter,
  Unstable_TriggerItem
} from '@assistant-ui/core'

/**
 * File-mention adapter for the composer's `@` autocomplete popover.
 *
 * Mirrors the role slashAdapter plays for `/`. Two key differences:
 *
 *  1. The data comes from the main process (via chatApi.listFileSuggestions)
 *     rather than from cached SessionMeta. The renderer hook that owns
 *     this adapter is responsible for (re)loading the file list before
 *     calling buildFileMentionAdapter().
 *
 *  2. @assistant-ui/core's Unstable_TriggerAdapter requires a synchronous
 *     `search()` — so we do plain substring matching here on whatever
 *     list the component loaded into state. This is the same approach
 *     free-code takes: the heavy fuzzy index (nucleo) is populated
 *     up-front, and each keystroke does a sync filter.
 *
 * Ranking is intentionally simple:
 *
 *   - filename starts-with match  →  score 3
 *   - filename contains match     →  score 2
 *   - path contains match         →  score 1
 *   - no match                    →  filtered out
 *
 * Ties are broken by shorter paths first (files in the project root
 * beat deeply nested ones of the same name). Capped at MAX_RESULTS
 * so the popover never has to render thousands of rows.
 */

const MAX_RESULTS = 25

export function buildFileMentionAdapter(
  files: readonly string[]
): Unstable_TriggerAdapter {
  // Precompute lowercase filenames once so every keystroke doesn't
  // re-lowercase the whole list. The adapter is rebuilt whenever the
  // file list changes (see Composer useMemo), so this stays cheap.
  const indexed = files.map((path) => {
    // `basename` without needing node's path module. The `@` popover
    // runs in the renderer (browser) so we can't import 'node:path'.
    const slashIdx = path.lastIndexOf('/')
    const name = slashIdx >= 0 ? path.slice(slashIdx + 1) : path
    return {
      path,
      pathLower: path.toLowerCase(),
      nameLower: name.toLowerCase()
    }
  })

  // Default list when the popover opens with an empty query: top N
  // shortest-path files, so the user sees something meaningful without
  // typing. Shortest-first matches the intuition that root-level files
  // are the most commonly @-mentioned.
  const defaultItems = indexed
    .slice(0, MAX_RESULTS)
    .map(({ path }) => toTriggerItem(path))

  return {
    // Empty categories forces the popover directly into search mode —
    // same trick slashAdapter uses. A non-empty array would make the
    // primitive render a category picker first and the items render
    // prop would never fire.
    categories: () => [],
    categoryItems: () => defaultItems,
    search: (query) => {
      const trimmed = query.trim()
      if (!trimmed) return defaultItems

      const q = trimmed.toLowerCase()
      const scored: Array<{ score: number; length: number; path: string }> = []

      for (const entry of indexed) {
        let score = 0
        if (entry.nameLower.startsWith(q)) {
          score = 3
        } else if (entry.nameLower.includes(q)) {
          score = 2
        } else if (entry.pathLower.includes(q)) {
          score = 1
        }
        if (score === 0) continue
        scored.push({ score, length: entry.path.length, path: entry.path })
        // Early-exit heuristic: if we already have 10x MAX_RESULTS
        // candidates, stop scanning. The list is pre-sorted by length
        // in main, so the first matches are typically the best ones.
        if (scored.length >= MAX_RESULTS * 10) break
      }

      scored.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score
        if (a.length !== b.length) return a.length - b.length
        return a.path.localeCompare(b.path)
      })

      return scored.slice(0, MAX_RESULTS).map((entry) => toTriggerItem(entry.path))
    }
  }
}

function toTriggerItem(path: string): Unstable_TriggerItem {
  return {
    id: `file-${path}`,
    type: 'file',
    // Label carries the `@` prefix so:
    //   (a) the popover visually shows `@src/foo.ts` like free-code's terminal
    //   (b) mentionFormatter.serialize → item.label writes the same literal
    //       string back into the composer, which fusion-code's attachment
    //       pipeline then parses via extractAtMentionedFiles.
    //
    // Paths with spaces need to be quoted so the regex on the other
    // side (regularAtMentionRegex = /@([^\s]+)/) doesn't stop at the
    // first space. free-code understands `@"path with space.txt"`
    // via its quotedAtMentionRegex.
    label: needsQuoting(path) ? `@"${path}"` : `@${path}`,
    description: path
  }
}

function needsQuoting(path: string): boolean {
  return /\s/.test(path)
}

/**
 * Directive formatter for file mentions.
 *
 * Same shape as slashFormatter: pick the exact label (which already
 * carries the `@` prefix and any quoting) and insert it verbatim. The
 * popover's `onSelect: { type: 'insertDirective' }` behavior removes
 * the trigger token (`@foo`) from the composer input and writes
 * `serialize(item)` in its place — so selecting a file rewrites
 * `...@foo|...` into `...@src/foo/bar.ts |...`.
 *
 * `parse` returns the text as a single segment because we never want
 * any portion of the composer text re-rendered as a "mention chip".
 * The literal `@path` is what free-code's CLI needs to see in the
 * user message, anything fancier would break extractAtMentionedFiles.
 */
export const mentionFormatter: Unstable_DirectiveFormatter = {
  serialize: (item) => `${item.label} `,
  parse: (text) => (text ? [{ kind: 'text', text }] : [])
}
