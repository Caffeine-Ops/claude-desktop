/**
 * @open-design/composer —— 聊天 composer 的 ProseMirror 核心（三端共享）。
 *
 * 由 desktop renderer / studio chat / apps/web 三份手工复制分叉合并而来
 * （2026-07-03，见 sessions 记录）：本文件以 desktop 版为基（多 group 字段），
 * 合入 web 版的 coordsAtPos jsdom 容错。三端原路径文件已改为 re-export shim。
 * wire format 不变量在 pmSchema.serializeDoc：对 plain text 无损（/cmd、@path
 * 逐字节不变），fusion-code 与 daemon 两个下游都直接吃这个字符串——动它前先读
 * pmSchema 顶部注释。
 */
import { Plugin, PluginKey, Selection, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

import { composerSchema } from './pmSchema'

/**
 * ProseMirror suggestion plugin — replaces assistant-ui's two nested
 * `Unstable_TriggerPopoverRoot`s. It detects a `/` or `@` trigger at
 * the caret, tracks the query text after it, and surfaces that state
 * through an `onChange` callback so a React popover (rendered *outside*
 * the editor, in `ProseMirrorComposerInput`) can show candidates.
 *
 * Why this is simpler than the old approach: assistant-ui's TriggerRoot
 * carried a stale-closure bug (`tapEffectEvent` captured the previous
 * frame's `highlightedIndex`, so Enter-after-ArrowDown inserted the
 * wrong item). Here the highlighted index lives in *React* state owned
 * by the popover, and the plugin only owns trigger detection + the
 * insert transaction. Enter is handled by the popover reading its own
 * live `highlightedIndex`. No stale closure to work around.
 *
 * Detection rules mirror the old `tokenizeComposer` anchoring:
 *   - trigger char (`/` or `@`) must be at start-of-paragraph or
 *     preceded by whitespace (so `http://x` and `a@b` don't trigger).
 *   - the query is the non-whitespace run after the trigger up to the
 *     caret. A whitespace closes the trigger.
 */

export type SuggestionKind = 'slash' | 'mention'

/** What the popover needs to position + filter. `null` = no active trigger. */
export interface SuggestionState {
  kind: SuggestionKind
  /** Text typed after the trigger char, up to the caret. */
  query: string
  /** doc position of the trigger char itself (the `/` or `@`). */
  from: number
  /** doc position of the caret (end of query). */
  to: number
  /** Viewport coords of the caret, for popover anchoring. */
  coords: { left: number; bottom: number }
}

export const suggestionPluginKey = new PluginKey<SuggestionState | null>('composer-suggestion')

/**
 * An item the popover can insert. Decoupled from assistant-ui types so
 * the adapters can be re-pointed at this without depending on
 * `@assistant-ui/core`'s `Unstable_*` surface.
 */
export interface SuggestionItem {
  id: string
  /** The literal text inserted (`/skill`, `@src/foo.ts`, `@"a b.ts"`). */
  value: string
  /** Display text in the popover row (usually same as value). */
  label: string
  description?: string
  /**
   * Optional group heading the item belongs to (e.g. `技能` / `命令`). The
   * popover inserts a non-selectable heading row whenever this changes between
   * consecutive items. Purely visual — items stay a flat list so keyboard nav
   * (which indexes into the array) is untouched. Items must already be ordered
   * so that same-group entries are contiguous.
   */
  group?: string
}

interface SuggestionPluginOptions {
  /** Called whenever the active trigger state changes (open / close / requery). */
  onChange: (state: SuggestionState | null) => void
}

function detectTrigger(state: EditorState): SuggestionState | null {
  const { selection } = state
  if (!selection.empty) return null
  const $pos = selection.$from
  // Only inside a paragraph's text content.
  const parentStart = $pos.start()
  const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '￼')

  // Find the last trigger char that is at offset 0 or preceded by WS,
  // with only non-whitespace after it up to the caret.
  // Scan back from the caret.
  let i = textBefore.length - 1
  // Bail if the char right before caret is whitespace (query closed).
  for (; i >= 0; i--) {
    const ch = textBefore[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '￼') {
      // Whitespace or an atom placeholder before reaching a trigger →
      // no open trigger.
      return null
    }
    if (ch === '/' || ch === '@') {
      const prev = i === 0 ? '' : textBefore[i - 1]!
      const anchored = i === 0 || prev === ' ' || prev === '\t'
      if (!anchored) return null
      const kind: SuggestionKind = ch === '/' ? 'slash' : 'mention'
      const query = textBefore.slice(i + 1)
      const from = parentStart + i
      const to = parentStart + textBefore.length
      return { kind, query, from, to, coords: { left: 0, bottom: 0 } }
    }
  }
  return null
}

export function createSuggestionPlugin(options: SuggestionPluginOptions): Plugin<SuggestionState | null> {
  return new Plugin<SuggestionState | null>({
    key: suggestionPluginKey,
    state: {
      init: () => null,
      apply(_tr, _value, _old, newState): SuggestionState | null {
        // Re-detect on every transaction that touched doc or selection.
        return detectTrigger(newState)
      }
    },
    view(view: EditorView) {
      // Push the initial + coords-resolved state to React.
      const publish = (): void => {
        const raw = suggestionPluginKey.getState(view.state)
        if (!raw) {
          options.onChange(null)
          return
        }
        // coords 容错来自 web 版分叉：jsdom（vitest）没有 layout，
        // coordsAtPos 会抛——回退 (0,0)，测试环境不关心真实坐标。
        let coords = { left: 0, bottom: 0 }
        try {
          const c = view.coordsAtPos(raw.to)
          coords = { left: c.left, bottom: c.bottom }
        } catch {
          /* no layout (jsdom) — keep the (0,0) fallback */
        }
        options.onChange({ ...raw, coords })
      }
      publish()
      return {
        update: () => publish(),
        destroy: () => options.onChange(null)
      }
    }
  })
}

/**
 * Replace the trigger token (`/query` or `@query`) with the chosen
 * item's atom node, then insert a trailing space and put the caret
 * after it — matching the old "insert directive + trailing space, no
 * auto-submit" behavior. One transaction; the popover closes naturally
 * because the next `detectTrigger` sees whitespace before the caret.
 */
export function insertSuggestion(
  view: EditorView,
  trigger: SuggestionState,
  item: SuggestionItem
): void {
  const nodeType = trigger.kind === 'slash' ? composerSchema.nodes.slash! : composerSchema.nodes.mention!
  const atom = nodeType.create({ value: item.value })
  const space = composerSchema.text(' ')
  const tr = view.state.tr.replaceWith(trigger.from, trigger.to, [atom, space])
  // Caret after the trailing space.
  const after = trigger.from + 2 // atom (size 1) + space (size 1)
  tr.setSelection(Selection.near(tr.doc.resolve(after)))
  view.dispatch(tr.scrollIntoView())
  view.focus()
}
