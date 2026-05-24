import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, splitBlock } from 'prosemirror-commands';

import { composerSchema, serializeDoc, parseTextWithEntities } from './pmSchema';
import { createChipNodeView } from './chipNodeView';
import {
  createSuggestionPlugin,
  insertSuggestion,
  type SuggestionItem,
  type SuggestionState,
} from './suggestionPlugin';

/**
 * The ProseMirror-backed *visible* composer editor for the web app.
 * Replaces the old transparent `<textarea>` + absolutely-positioned
 * overlay (which mirrored `@`-mention highlights as text and drifted off
 * the caret) with a contenteditable ProseMirror editor whose slash /
 * mention tokens are real atom nodes (pills), not overlay-drawn text.
 *
 * --- Controlled, single source of truth ------------------------------
 * This editor is *controlled* by `value` (the parent ChatComposer's
 * `draft` state). It does NOT own the draft and does NOT own mention /
 * slash detection — the parent keeps a hidden, controlled
 * `<textarea data-testid="chat-composer-input">` mirror that still runs
 * the existing `handleChange` regex detection + popovers + IME wiring,
 * and the test suite drives that textarea unchanged. This editor's job
 * is purely:
 *   - render `value` as a doc with chips,
 *   - emit edits (typing, chip insert/delete) back via `onChange`,
 *   - own the chip-aware Backspace + suggestion-trigger keymap.
 *
 * `lastSerializedRef` tells our own writes apart from genuine external
 * `value` changes so the doc rebuild doesn't loop (ported from desktop).
 */

export interface SuggestionAdapter {
  /** Items to show for an empty / non-empty query. Synchronous. */
  search: (query: string) => SuggestionItem[];
}

export interface ProseMirrorComposerHandle {
  focus: () => void;
}

interface Props {
  /** The controlled draft text (the single source of truth, owned by parent). */
  value: string;
  placeholder: string;
  slashAdapter: SuggestionAdapter;
  mentionAdapter: SuggestionAdapter;
  /** Tokens (`@<label>`) that should render as chips even when multi-word. */
  knownMentionTokens: string[];
  /** Called on every PM edit with the new serialized plain text. */
  onChange: (text: string) => void;
  /** Submit the current composer (Enter with no open popover). */
  onSubmit: () => void;
  /**
   * Called after a suggestion is inserted into the doc, so the parent can
   * run the same side effects its textarea-path insert helpers do (stage
   * the skill/mcp/connector, apply the project skill, etc.). The text
   * insertion itself is already handled by the editor.
   */
  onPickItem?: (item: SuggestionItem) => void;
  /** Pasted files (images etc.) — routed to the parent's upload flow. */
  onPasteFiles?: (files: File[]) => void;
  className?: string;
  /** Slot rendered after the editor (e.g. the mention/slash popovers). */
  children?: ReactNode;
}

export const ProseMirrorComposerInput = forwardRef<ProseMirrorComposerHandle, Props>(
  function ProseMirrorComposerInput(
    {
      value,
      placeholder,
      slashAdapter,
      mentionAdapter,
      knownMentionTokens,
      onChange,
      onSubmit,
      onPickItem,
      onPasteFiles,
      className,
      children,
    },
    ref,
  ) {
    // onSubmit / onPickItem / onPasteFiles are read through refs so the
    // mount-once EditorView always calls the *latest* closures (which
    // capture fresh ChatComposer state like `draft`) without rebuilding
    // the view. Capturing them directly would freeze the first render's
    // closures and e.g. submit a stale/empty draft.
    const onSubmitRef = useRef(onSubmit);
    const onPickItemRef = useRef(onPickItem);
    const onPasteFilesRef = useRef(onPasteFiles);
    useEffect(() => {
      onSubmitRef.current = onSubmit;
      onPickItemRef.current = onPickItem;
      onPasteFilesRef.current = onPasteFiles;
    }, [onSubmit, onPickItem, onPasteFiles]);
    const editorHostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    // The last text we pushed up via onChange (or rebuilt the doc from),
    // so the external-sync effect can tell our own writes apart from
    // genuine external changes.
    const lastSerializedRef = useRef<string>(value);
    const knownTokensRef = useRef<string[]>(knownMentionTokens);
    useEffect(() => {
      knownTokensRef.current = knownMentionTokens;
    }, [knownMentionTokens]);

    // Popover state lives in React; the plugin only reports the trigger.
    const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);
    const [highlighted, setHighlighted] = useState(0);
    const liveRef = useRef<{
      suggestion: SuggestionState | null;
      items: SuggestionItem[];
      highlighted: number;
    }>({ suggestion: null, items: [], highlighted: 0 });

    const items = useMemo<SuggestionItem[]>(() => {
      if (!suggestion) return [];
      const adapter = suggestion.kind === 'slash' ? slashAdapter : mentionAdapter;
      return adapter.search(suggestion.query);
    }, [suggestion, slashAdapter, mentionAdapter]);

    useEffect(() => {
      setHighlighted((h) => (h >= items.length ? 0 : h));
    }, [items]);

    useEffect(() => {
      liveRef.current = { suggestion, items, highlighted };
    }, [suggestion, items, highlighted]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          viewRef.current?.focus();
        },
      }),
      [],
    );

    const emitChange = (doc: PMNode): void => {
      const text = serializeDoc(doc);
      lastSerializedRef.current = text;
      onChange(text);
    };

    // --- mount the editor once -----------------------------------------
    useLayoutEffect(() => {
      const host = editorHostRef.current;
      if (!host) return;

      const submitOrSelect = (): boolean => {
        const { suggestion: sug, items: list, highlighted: hi } = liveRef.current;
        if (sug && list.length > 0) {
          const item = list[hi] ?? list[0]!;
          insertSuggestion(viewRef.current!, sug, item);
          onPickItemRef.current?.(item);
          return true;
        }
        onSubmitRef.current();
        return true;
      };

      const navKeymap = keymap({
        ArrowDown: () => {
          if (!liveRef.current.suggestion) return false;
          setHighlighted((h) => Math.min(h + 1, Math.max(0, liveRef.current.items.length - 1)));
          return true;
        },
        ArrowUp: () => {
          if (!liveRef.current.suggestion) return false;
          setHighlighted((h) => Math.max(h - 1, 0));
          return true;
        },
        Enter: () => submitOrSelect(),
        'Shift-Enter': (state, dispatch) => splitBlock(state, dispatch),
        // Backspace on a chip (or its auto-inserted trailing space):
        // delete it in ONE keypress. Ported verbatim from desktop — the
        // trailing space inserted after a chip would otherwise eat the
        // first Backspace, making the chip look like it needs two presses.
        Backspace: (state, dispatch) => {
          const { selection } = state;
          if (!selection.empty) return false;
          const { $from } = selection;
          const before = $from.nodeBefore;
          if (!before) return false;

          const isChip = (n: PMNode | null | undefined): boolean =>
            !!n && (n.type.name === 'slash' || n.type.name === 'mention');

          // Case 1: caret directly after a chip → delete the chip.
          if (isChip(before)) {
            if (dispatch) {
              const pos = $from.pos;
              dispatch(state.tr.delete(pos - before.nodeSize, pos).scrollIntoView());
            }
            return true;
          }

          // Case 2: caret after the lone trailing space that
          // insertSuggestion adds, and the node before that space is a
          // chip → delete space + chip in one go.
          if (before.isText && before.text === ' ') {
            const beforeSpace = state.doc.resolve($from.pos - before.nodeSize).nodeBefore;
            if (isChip(beforeSpace)) {
              if (dispatch) {
                const pos = $from.pos;
                dispatch(
                  state.tr
                    .delete(pos - before.nodeSize - beforeSpace!.nodeSize, pos)
                    .scrollIntoView(),
                );
              }
              return true;
            }
          }

          return false;
        },
        Escape: () => {
          if (!liveRef.current.suggestion) return false;
          setSuggestion(null);
          return true;
        },
        'Mod-z': undo,
        'Mod-y': redo,
        'Shift-Mod-z': redo,
      });

      const state = EditorState.create({
        schema: composerSchema,
        doc: parseTextWithEntities(value, knownTokensRef.current),
        plugins: [
          history(),
          navKeymap,
          keymap(baseKeymap),
          createSuggestionPlugin({ onChange: setSuggestion }),
        ],
      });

      const view = new EditorView(host, {
        state,
        nodeViews: {
          slash: createChipNodeView('slash'),
          mention: createChipNodeView('mention'),
        },
        attributes: {
          class:
            'pm-composer-input ph-no-capture min-h-[24px] w-full whitespace-pre-wrap break-words focus:outline-none [&_p]:m-0',
          'aria-label': placeholder,
          role: 'textbox',
          'aria-multiline': 'true',
        },
        // Pasted images go to the parent's upload flow, not into the doc.
        handlePaste(_view, event) {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          onPasteFilesRef.current?.(files);
          return true;
        },
        dispatchTransaction(tr) {
          const newState = view.state.apply(tr);
          view.updateState(newState);
          if (tr.docChanged) {
            emitChange(newState.doc);
          }
        },
      });
      viewRef.current = view;
      lastSerializedRef.current = serializeDoc(state.doc);

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Mount once (empty dep array is intentional): `value` is synced via
      // the effect below, and adapters / onSubmit / onPickItem are read
      // through refs so changing them never tears down and rebuilds the
      // EditorView (which would lose selection + undo history).
    }, []);

    // --- external value → doc sync --------------------------------------
    // Fires when the parent changes the draft outside this editor (typed
    // into the hidden mirror textarea, prefill, draft restore, or send
    // clearing to ''). We skip the round-trip when the incoming value
    // equals our own last write to avoid a loop.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      if (value === lastSerializedRef.current) return;
      if (value === serializeDoc(view.state.doc)) {
        lastSerializedRef.current = value;
        return;
      }
      const doc = parseTextWithEntities(value, knownTokensRef.current);
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
      tr.setMeta('addToHistory', false);
      view.dispatch(tr);
      lastSerializedRef.current = value;
    }, [value]);

    // Toggle an `is-empty` class so the CSS placeholder ::before only
    // shows when there's truly no content (shares the editor's box model
    // so it lines up with the caret exactly — no drifting overlay).
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      // Judge emptiness by the serialized `value`, NOT doc.textContent:
      // chip atoms (slash/mention) contribute their `@x` / `/x` to `value`
      // but NOT to doc.textContent (they're leaf atoms). A doc holding only
      // an `@mention` chip has textContent '' yet is clearly non-empty —
      // using textContent here showed the placeholder OVER the chip.
      const empty = value.length === 0;
      view.dom.classList.toggle('is-empty', empty);
      view.dom.setAttribute('data-placeholder', placeholder);
    }, [value, placeholder]);

    return (
      <div className={`pm-composer-wrap relative w-full${className ? ` ${className}` : ''}`}>
        <div ref={editorHostRef} className="w-full" />
        {suggestion && items.length > 0 ? (
          <PmSuggestionPopover
            items={items}
            highlighted={highlighted}
            coords={suggestion.coords}
            onPick={(item) => {
              insertSuggestion(viewRef.current!, suggestion, item);
              onPickItemRef.current?.(item);
            }}
            onHover={setHighlighted}
          />
        ) : null}
        {children}
      </div>
    );
  },
);

/**
 * The `@` / `/` candidate popover, anchored above the caret. Ported from
 * desktop. Used for keystrokes that originate *inside* the PM editor
 * (real users); the parent ChatComposer's own MentionPopover / SlashPopover
 * stay wired to the hidden mirror textarea for the test suite.
 */
function PmSuggestionPopover({
  items,
  highlighted,
  coords,
  onPick,
  onHover,
}: {
  items: SuggestionItem[];
  highlighted: number;
  coords: { left: number; bottom: number };
  onPick: (item: SuggestionItem) => void;
  onHover: (index: number) => void;
}): React.JSX.Element {
  return (
    <div
      className="pm-suggestion-popover"
      role="listbox"
      style={{ left: coords.left, bottom: window.innerHeight - coords.bottom + 24 }}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === highlighted}
          className={`pm-suggestion-item${i === highlighted ? ' is-active' : ''}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown (not click) so we insert before the editor
            // loses focus / selection.
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="pm-suggestion-label">{item.label}</span>
          {item.description ? (
            <span className="pm-suggestion-desc">{item.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
