import type { SuggestionItem } from './suggestionPlugin'
import type { SuggestionAdapter } from './ProseMirrorComposerInput'

/**
 * File-mention adapter for the composer's `@` autocomplete popover.
 *
 * Mirrors the role slashAdapter plays for `/`. The data comes from the
 * main process (via chatApi.listFileSuggestions); the renderer hook
 * that owns this adapter reloads the file list before calling
 * buildFileMentionAdapter(). Search is synchronous substring matching,
 * same as free-code's terminal: the list is loaded up-front and each
 * keystroke does a sync filter.
 *
 * Ranking:
 *   - filename starts-with match  →  score 3
 *   - filename contains match     →  score 2
 *   - path contains match         →  score 1
 *   - no match                    →  filtered out
 *
 * Ties broken by shorter paths first. Capped at MAX_RESULTS.
 *
 * Picking an item inserts a `mention` atom node carrying the literal
 * `@path` value (quoted if the path has spaces). The doc serializes
 * that back to the verbatim `@path` string, which fusion-code's
 * `extractAtMentionedFiles` parses downstream.
 */

const MAX_RESULTS = 25

export function buildFileMentionAdapter(files: readonly string[]): SuggestionAdapter {
  const indexed = files.map((path) => {
    // `basename` without node's path module — this runs in the renderer.
    const slashIdx = path.lastIndexOf('/')
    const name = slashIdx >= 0 ? path.slice(slashIdx + 1) : path
    return {
      path,
      pathLower: path.toLowerCase(),
      nameLower: name.toLowerCase()
    }
  })

  // Default list when the popover opens with an empty query: top N
  // shortest-path files. Shortest-first matches the intuition that
  // root-level files are the most commonly @-mentioned.
  const defaultItems = indexed.slice(0, MAX_RESULTS).map(({ path }) => toItem(path))

  return {
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
        if (scored.length >= MAX_RESULTS * 10) break
      }

      scored.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score
        if (a.length !== b.length) return a.length - b.length
        return a.path.localeCompare(b.path)
      })

      return scored.slice(0, MAX_RESULTS).map((entry) => toItem(entry.path))
    }
  }
}

function toItem(path: string): SuggestionItem {
  const value = fileMentionValue(path)
  return {
    id: `file-${path}`,
    value,
    label: value,
    description: path
  }
}

/**
 * Path → the literal mention `value` a mention atom carries. The value
 * includes the `@` prefix and any quoting so it serializes back to exactly
 * what fusion-code's extractAtMentionedFiles expects:
 *   - bare:   @src/foo.ts   (regularAtMentionRegex = /@([^\s]+)/)
 *   - quoted: @"path with space.txt"  (quotedAtMentionRegex)
 * 单一真源：`@` 菜单（toItem）与附件内联化（insertFileMention，2026-07-16
 * 起上传/拖拽的有路径附件直接插 mention chip）共用，两边格式永远一致。
 */
export function fileMentionValue(path: string): string {
  return needsQuoting(path) ? `@"${path}"` : `@${path}`
}

function needsQuoting(path: string): boolean {
  // 空格是 fusion-code bare 解析的硬边界；中文标点是【展示层】识别
  // （mentionDisplay 的 bare 截断集）的边界——文件名里带「（）：」等
  // 时裸形式会被展示层截错，quoted 形式两边都稳。
  return /[\s，。：:；;、！？（）【】「」]/.test(path)
}
