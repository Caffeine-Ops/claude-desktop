import { Plugin, PluginKey, Selection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { composerSchema } from './pmSchema';

/**
 * ProseMirror suggestion plugin — ported from the desktop app. It detects
 * a `/` or `@` trigger at the caret, tracks the query text after it, and
 * surfaces that state through an `onChange` callback so a React popover
 * (rendered *outside* the editor) can show candidates.
 *
 * Detection rules (mirror the web overlay's anchoring + desktop's
 * detectTrigger):
 *   - trigger char (`/` or `@`) must be at start-of-paragraph or preceded
 *     by whitespace (so `http://x` and `a@b` don't trigger).
 *   - the query is the non-whitespace run after the trigger up to the
 *     caret. A whitespace closes the trigger.
 */

export type SuggestionKind = 'slash' | 'mention';

/** What the popover needs to position + filter. `null` = no active trigger. */
export interface SuggestionState {
  kind: SuggestionKind;
  /** Text typed after the trigger char, up to the caret. */
  query: string;
  /** doc position of the trigger char itself (the `/` or `@`). */
  from: number;
  /** doc position of the caret (end of query). */
  to: number;
  /** Viewport coords of the caret, for popover anchoring. */
  coords: { left: number; bottom: number };
}

export const suggestionPluginKey = new PluginKey<SuggestionState | null>('composer-suggestion');

/** An item the popover can insert. */
export interface SuggestionItem {
  id: string;
  /** The literal text inserted (`/skill`, `@src/foo.ts`, `@Slack MCP`). */
  value: string;
  /** Display text in the popover row (usually same as value). */
  label: string;
  description?: string;
}

interface SuggestionPluginOptions {
  /** Called whenever the active trigger state changes (open / close / requery). */
  onChange: (state: SuggestionState | null) => void;
}

function detectTrigger(state: EditorState): SuggestionState | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  const parentStart = $pos.start();
  const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '￼');

  // Scan back from the caret for the last trigger char that is at offset
  // 0 or preceded by WS, with only non-whitespace after it.
  let i = textBefore.length - 1;
  for (; i >= 0; i--) {
    const ch = textBefore[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '￼') {
      // Whitespace or an atom placeholder before reaching a trigger →
      // no open trigger.
      return null;
    }
    if (ch === '/' || ch === '@') {
      const prev = i === 0 ? '' : textBefore[i - 1]!;
      const anchored = i === 0 || prev === ' ' || prev === '\t';
      if (!anchored) return null;
      const kind: SuggestionKind = ch === '/' ? 'slash' : 'mention';
      const query = textBefore.slice(i + 1);
      const from = parentStart + i;
      const to = parentStart + textBefore.length;
      return { kind, query, from, to, coords: { left: 0, bottom: 0 } };
    }
  }
  return null;
}

export function createSuggestionPlugin(
  options: SuggestionPluginOptions,
): Plugin<SuggestionState | null> {
  return new Plugin<SuggestionState | null>({
    key: suggestionPluginKey,
    state: {
      init: () => null,
      apply(_tr, _value, _old, newState): SuggestionState | null {
        return detectTrigger(newState);
      },
    },
    view(view: EditorView) {
      const publish = (): void => {
        const raw = suggestionPluginKey.getState(view.state);
        if (!raw) {
          options.onChange(null);
          return;
        }
        // coordsAtPos relies on DOM layout (getClientRects), which jsdom
        // does not implement. Fall back to (0,0) so the trigger still
        // opens the popover under test; real browsers report real coords.
        let coords = { left: 0, bottom: 0 };
        try {
          const c = view.coordsAtPos(raw.to);
          coords = { left: c.left, bottom: c.bottom };
        } catch {
          /* no layout (jsdom) — keep the (0,0) fallback */
        }
        options.onChange({ ...raw, coords });
      };
      publish();
      return {
        update: () => publish(),
        destroy: () => options.onChange(null),
      };
    },
  });
}

/**
 * Replace the trigger token (`/query` or `@query`) with the chosen item's
 * atom node, then insert a trailing space and put the caret after it —
 * matching the old "insert directive + trailing space, no auto-submit"
 * behavior. One transaction; the popover closes naturally because the
 * next `detectTrigger` sees whitespace before the caret.
 */
export function insertSuggestion(
  view: EditorView,
  trigger: SuggestionState,
  item: SuggestionItem,
): void {
  const nodeType =
    trigger.kind === 'slash' ? composerSchema.nodes.slash! : composerSchema.nodes.mention!;
  const atom = nodeType.create({ value: item.value });
  const space = composerSchema.text(' ');
  const tr = view.state.tr.replaceWith(trigger.from, trigger.to, [atom, space]);
  // Caret after the trailing space (atom size 1 + space size 1).
  const after = trigger.from + 2;
  tr.setSelection(Selection.near(tr.doc.resolve(after)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
