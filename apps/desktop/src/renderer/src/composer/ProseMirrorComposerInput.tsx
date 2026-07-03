import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, splitBlock } from 'prosemirror-commands'
import { useAuiState, useComposerRuntime } from '@assistant-ui/react'

import { composerSchema, serializeDoc, parseText } from './pmSchema'
import { createChipNodeView } from './chipNodeView'
import { findSkillChipSpec } from './skillChipRegistry'
import { fileIconPathsByKey } from '../components/chat/FileTypeIcon'
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
      // Backspace on a chip (or its auto-inserted trailing space):
      // delete it in ONE keypress.
      //
      // Two distinct two-step deletes were conflated as "have to press
      // delete twice":
      //
      //   1. baseKeymap's default Backspace chain ends in
      //      `selectNodeBackward`, which for a `selectable` atom (our
      //      slash/mention pills) merely turns it into a NodeSelection on
      //      the first press — a SECOND Backspace then deletes the now-
      //      selected node. PM's safety net against fat-fingering a node,
      //      but for a single-glyph pill it reads as a bug.
      //   2. `insertSuggestion` appends a trailing space after the chip
      //      (so you can keep typing). Right after inserting, the caret
      //      sits AFTER that space, so the first Backspace eats the space
      //      — the green chip stays put and *looks* unchanged — and only
      //      the second Backspace reaches the chip. THIS is what the user
      //      actually hit (#2 masking #1); the chip's own colour, not a
      //      selection highlight, is why "it just changed style".
      //
      // Fix both: when the caret is right after a chip, delete the chip;
      // when it's right after the single trailing space that follows a
      // chip, delete the space AND the chip together. Everything else
      // (plain text, multi-char runs) falls through to baseKeymap.
      Backspace: (state, dispatch) => {
        const { selection } = state
        if (!selection.empty) return false
        const { $from } = selection
        const before = $from.nodeBefore
        if (!before) return false

        const isChip = (n: PMNode | null | undefined): boolean =>
          !!n && (n.type.name === 'slash' || n.type.name === 'mention')

        // Case 1: caret directly after a chip → delete the chip.
        if (isChip(before)) {
          if (dispatch) {
            const pos = $from.pos
            dispatch(state.tr.delete(pos - before.nodeSize, pos).scrollIntoView())
          }
          return true
        }

        // Case 2: caret after the lone trailing space that
        // `insertSuggestion` adds, and the node before that space is a
        // chip → delete space + chip in one go. We only special-case a
        // *single* space (the inserter's exact output); a longer text
        // run means the user typed more, so we don't swallow the chip.
        if (before.isText && before.text === ' ') {
          // Resolve the position just before the space to inspect what
          // precedes it.
          const beforeSpace = state.doc.resolve($from.pos - before.nodeSize).nodeBefore
          if (isChip(beforeSpace)) {
            if (dispatch) {
              const pos = $from.pos
              dispatch(
                state.tr
                  .delete(pos - before.nodeSize - beforeSpace!.nodeSize, pos)
                  .scrollIntoView()
              )
            }
            return true
          }
        }

        return false
      },
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
      {/* Portal 到 body：弹层是 position:fixed、坐标按视口算，但 CSS 里任何祖先带
          transform/translate/filter/backdrop-filter 都会把 fixed 的包含块劫持成该
          祖先——空态 hero 的 -translate-y 包装曾让弹层整体飞出视口上沿（「新对话
          敲 / 没反应」，commit 2e411f4f 点修过一处）。挂到 body 后包含块恒为视口，
          不再依赖「composer 树上游永远不加 transform」的隐性约定（仓库里
          .proposal-anim-pop 等 transform 动画容器是现成的复发向量，终审 finding #6）。
          事件仍走 React 合成事件树（portal 不影响），键盘导航状态在本组件里不变。 */}
      {suggestion &&
        items.length > 0 &&
        createPortal(
          <SuggestionPopover
            items={items}
            highlighted={highlighted}
            coords={suggestion.coords}
            onPick={(item) => {
              insertSuggestion(viewRef.current!, suggestion, item)
            }}
            onHover={setHighlighted}
          />,
          document.body
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
      {items.map((item, i) => {
        // A known skill (e.g. /claude-desktop:gpt-image-2) shows its coloured
        // icon + friendly label here, mirroring the inserted chip — same
        // registry, so the popover row and the chip stay in lockstep. Unknown
        // items keep the raw value label.
        const skill = findSkillChipSpec(item.value)
        // Group heading: drawn when this item's group differs from the previous
        // one. It is NOT a selectable row — keyboard nav still indexes into
        // `items` (the heading carries no index), so ↑↓/Enter behaviour is
        // unchanged. Items are pre-grouped contiguously by the adapter.
        const showHeading = !!item.group && item.group !== items[i - 1]?.group
        return (
          <div key={item.id}>
            {showHeading && (
              <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60 first:pt-0.5">
                {item.group}
              </div>
            )}
            <button
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${
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
              {skill && (
                <svg
                  width={18}
                  height={18}
                  viewBox="0 0 48 48"
                  aria-hidden="true"
                  className="shrink-0"
                >
                  {fileIconPathsByKey(skill.icon).map((p, pi) => (
                    <path key={pi} d={p.d} fill={p.fill} />
                  ))}
                </svg>
              )}
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <span className="font-medium text-foreground">{skill?.label ?? item.label}</span>
                {item.description && (
                  <span className="truncate text-muted-foreground/70">{item.description}</span>
                )}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
