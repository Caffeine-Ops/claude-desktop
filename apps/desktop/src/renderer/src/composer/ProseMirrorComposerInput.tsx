import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, splitBlock } from 'prosemirror-commands'
import { useAuiState, useComposerRuntime } from '@assistant-ui/react'

import { composerSchema, serializeDoc, parseText } from './pmSchema'
import { createChipNodeView } from './chipNodeView'
import {
  createSuggestionPlugin,
  insertSuggestion,
  type SuggestionItem,
  type SuggestionState
} from './suggestionPlugin'

/**
 * The ProseMirror-backed composer input. Replaces assistant-ui's
 * `ComposerPrimitive.Input` (which renders react-textarea-autosize)
 * with a contenteditable ProseMirror editor whose slash/mention tokens
 * are real atom nodes (pills), not overlay-drawn text.
 *
 * --- Route A integration (validated in the Spike) ---------------------
 * This is a *controlled* editor bridged to assistant-ui's composer
 * store, so Send / Cancel / Attachment / Dictation keep working
 * untouched (they only read `composer.text` and the store, not the DOM):
 *
 *   - doc edited → `serializeDoc(doc)` → `runtime.setText(text)`
 *     // PROSEMIRROR-MIGRATION: composer.text writeback via setText
 *   - external `composer.text` change (EmptyState prefill, draft
 *     restore, send-clears-to-'') → re-parse into a doc and replace,
 *     but only when it diverges from what we last serialized (so our
 *     own writes don't loop).
 *
 * The `@`/`/` popover is rendered here in React (it lives *outside* the
 * editor's contenteditable, so React is safe), driven by the
 * suggestion plugin's onChange. Keyboard nav (↑↓/Enter/Esc) is handled
 * on the editor via a high-priority keymap that reads this component's
 * live popover state — no stale-closure bug like assistant-ui's
 * tapEffectEvent had, because highlightedIndex is React state read at
 * event time.
 */

export interface SuggestionAdapter {
  /** Items to show for an empty / non-empty query. Synchronous. */
  search: (query: string) => SuggestionItem[]
}

interface Props {
  placeholder: string
  slashAdapter: SuggestionAdapter
  mentionAdapter: SuggestionAdapter
  /** Submit the current composer (Enter with no open popover). */
  onSubmit: () => void
}

export function ProseMirrorComposerInput({
  placeholder,
  slashAdapter,
  mentionAdapter,
  onSubmit
}: Props): React.JSX.Element {
  const runtime = useComposerRuntime()
  const composerText = useAuiState((s) => ((s as { composer?: { text?: string } }).composer?.text as string | undefined) ?? '')

  const editorHostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // The last text we pushed into the store, so the external-sync effect
  // can tell our own writes apart from genuine external changes.
  const lastSerializedRef = useRef<string>('')

  // Popover state lives in React; the plugin only reports the trigger.
  const [suggestion, setSuggestion] = useState<SuggestionState | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  // Keep the freshest values reachable from the (stable) keymap closure.
  const liveRef = useRef<{
    suggestion: SuggestionState | null
    items: SuggestionItem[]
    highlighted: number
  }>({ suggestion: null, items: [], highlighted: 0 })

  const items = useMemo<SuggestionItem[]>(() => {
    if (!suggestion) return []
    const adapter = suggestion.kind === 'slash' ? slashAdapter : mentionAdapter
    return adapter.search(suggestion.query)
  }, [suggestion, slashAdapter, mentionAdapter])

  // Reset / clamp the highlighted index whenever the candidate list
  // changes, so ArrowDown→Enter always lands on a real item.
  useEffect(() => {
    setHighlighted((h) => (h >= items.length ? 0 : h))
  }, [items])

  useEffect(() => {
    liveRef.current = { suggestion, items, highlighted }
  }, [suggestion, items, highlighted])

  // --- mount the editor once -----------------------------------------
  useLayoutEffect(() => {
    const host = editorHostRef.current
    if (!host) return

    const submitOrSelect = (): boolean => {
      const { suggestion: sug, items: list, highlighted: hi } = liveRef.current
      if (sug && list.length > 0) {
        const item = list[hi] ?? list[0]!
        insertSuggestion(viewRef.current!, sug, item)
        return true
      }
      // No open popover → submit. assistant-ui's Send reads composer.text.
      onSubmit()
      return true
    }

    const navKeymap = keymap({
      ArrowDown: () => {
        if (!liveRef.current.suggestion) return false
        setHighlighted((h) => Math.min(h + 1, Math.max(0, liveRef.current.items.length - 1)))
        return true
      },
      ArrowUp: () => {
        if (!liveRef.current.suggestion) return false
        setHighlighted((h) => Math.max(h - 1, 0))
        return true
      },
      // Plain Enter: pick the highlighted suggestion if a popover is
      // open, otherwise submit (ChatGPT/Claude.ai convention).
      Enter: () => submitOrSelect(),
      // Shift+Enter: insert a soft newline (a new paragraph in our
      // schema). Without this the only Enter binding above would
      // submit and you could never add a line.
      'Shift-Enter': (state, dispatch) => splitBlock(state, dispatch),
      Escape: () => {
        if (!liveRef.current.suggestion) return false
        // Close the popover without inserting: collapse trigger by
        // moving caret (a no-op selection set re-runs detectTrigger).
        setSuggestion(null)
        return true
      },
      'Mod-z': undo,
      'Mod-y': redo,
      'Shift-Mod-z': redo
    })

    const state = EditorState.create({
      schema: composerSchema,
      doc: parseText(composerText),
      plugins: [
        history(),
        navKeymap,
        keymap(baseKeymap),
        createSuggestionPlugin({ onChange: setSuggestion })
      ]
    })

    const view = new EditorView(host, {
      state,
      nodeViews: {
        slash: createChipNodeView('slash'),
        mention: createChipNodeView('mention')
      },
      attributes: {
        // `focus:outline-none` kills the browser's default focus ring
        // on the contenteditable (the orange box). `whitespace-pre-wrap`
        // + `break-words` make long words wrap instead of overflowing.
        class:
          'pm-composer-input min-h-[24px] w-full whitespace-pre-wrap break-words text-foreground focus:outline-none [&_p]:m-0',
        'aria-label': placeholder,
        role: 'textbox',
        'aria-multiline': 'true'
      },
      // Pasted images go to assistant-ui attachments, not into the doc.
      // The old ComposerPrimitive.Input did this via its built-in
      // `addAttachmentOnPaste`; since we replaced that component we
      // re-implement it here. Returning `true` consumes the event so
      // ProseMirror doesn't also try to paste the image as text/HTML —
      // that double-handling was what made the screen flicker (PM
      // rebuilt the doc → setText → external sync → rebuild, in a loop).
      handlePaste(_view, event) {
        const files = Array.from(event.clipboardData?.files ?? [])
        const images = files.filter((f) => f.type.startsWith('image/'))
        if (images.length === 0) return false
        event.preventDefault()
        void Promise.all(images.map((file) => runtime.addAttachment(file))).catch((err) => {
          console.error('[ProseMirrorComposerInput] addAttachment failed', err)
        })
        return true
      },
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr)
        view.updateState(newState)
        if (tr.docChanged) {
          const text = serializeDoc(newState.doc)
          lastSerializedRef.current = text
          // PROSEMIRROR-MIGRATION: composer.text writeback via setText
          runtime.setText(text)
        }
      }
    })
    viewRef.current = view
    lastSerializedRef.current = serializeDoc(state.doc)

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Mount once. composerText is synced via the separate effect below;
    // adapters/onSubmit are read through liveRef so they don't remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- external composer.text → doc sync ------------------------------
  // Fires when something outside the editor changes the text (prefill,
  // draft restore, or send clearing it to ''). We skip the round-trip
  // when the incoming text equals our own last write to avoid a loop.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (composerText === lastSerializedRef.current) return
    // Belt-and-braces: if the incoming text already matches what the
    // editor currently holds, skip the rebuild. This stops a feedback
    // loop where our own setText echoes back as a composerText change
    // and would otherwise replace the doc (blowing away the selection
    // and causing a visible flicker).
    if (composerText === serializeDoc(view.state.doc)) {
      lastSerializedRef.current = composerText
      return
    }
    const doc = parseText(composerText)
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)
    tr.setMeta('addToHistory', false)
    view.dispatch(tr)
    lastSerializedRef.current = composerText
  }, [composerText])

  // Placeholder is rendered by CSS (`.pm-composer-input.is-empty::before`,
  // see index.css) reading the `data-placeholder` attr off the editor.
  // This shares the editor's own box model so it lines up with the caret
  // exactly — no absolute-positioned overlay that drifts (the old bug).
  // We toggle an `is-empty` class on the editor DOM imperatively so the
  // ::before only shows when there's truly no content.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const empty = view.state.doc.textContent.length === 0
    view.dom.classList.toggle('is-empty', empty)
    view.dom.setAttribute('data-placeholder', placeholder)
  }, [composerText, placeholder])

  return (
    <div className="relative w-full">
      <div ref={editorHostRef} className="w-full" />
      {suggestion && items.length > 0 && (
        <SuggestionPopover
          items={items}
          highlighted={highlighted}
          coords={suggestion.coords}
          onPick={(item) => {
            insertSuggestion(viewRef.current!, suggestion, item)
          }}
          onHover={setHighlighted}
        />
      )}
    </div>
  )
}

function SuggestionPopover({
  items,
  highlighted,
  coords,
  onPick,
  onHover
}: {
  items: SuggestionItem[]
  highlighted: number
  coords: { left: number; bottom: number }
  onPick: (item: SuggestionItem) => void
  onHover: (index: number) => void
}): React.JSX.Element {
  // Anchor above the caret (composer sits near the bottom of the
  // window). Fixed positioning against the caret's viewport coords.
  return (
    <div
      className="fixed z-30 max-h-72 w-72 overflow-y-auto rounded-2xl bg-popover/95 py-1.5 ring-1 ring-black/[0.08] backdrop-blur-2xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.22)] dark:ring-white/[0.08]"
      style={{ left: coords.left, bottom: window.innerHeight - coords.bottom + 24 }}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-[13px] ${
            i === highlighted ? 'bg-accent/[0.12]' : ''
          }`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown (not click) so we insert before the editor
            // loses focus / selection.
            e.preventDefault()
            onPick(item)
          }}
        >
          <span className="font-medium text-foreground">{item.label}</span>
          {item.description && (
            <span className="truncate text-muted-foreground/70">{item.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}
