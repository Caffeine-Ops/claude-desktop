import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { Node as PMNodeCls, type Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, splitBlock } from 'prosemirror-commands'
import { useAuiState, useComposerRuntime } from '@assistant-ui/react'

import { composerSchema, serializeDoc, parseText } from './pmSchema'
import { createChipNodeView } from './chipNodeView'
import { findSkillChipSpec } from './skillChipRegistry'
import { fileMentionValue } from './fileMentionAdapter'
import { registerFileMentionInserter } from './composerBridge'
import { attachFilesToComposer } from './attachFiles'
import { autoOpenPreviewPanel } from '../runtime/imageAttachmentAdapter'
import {
  acceptForPlaceholder,
  createFilePlaceholderPlugin,
  filePlaceholderKey
} from './filePlaceholderPlugin'
import { SkillChipIcon } from '../components/chat/SkillChipIcon'
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

/**
 * Imperative handle exposed to parents that need to drive the editor from
 * outside (the toolbar's 技能 button / SkillPickerPopover, and the
 * EmptyState ScenarioRail). Only doc-surgery that must understand PM
 * positions belongs here — anything richer belongs in the composer store.
 */
export interface ProseMirrorComposerInputHandle {
  /**
   * Append a `/value` slash chip at the end of the doc, exactly like
   * picking a row from the inline `/` suggestion popover would
   * (`insertSuggestion` in suggestionPlugin.ts) — same atom node, same
   * trailing space + focus — just without requiring an active trigger
   * state first. Used by SkillPickerPopover so picking a skill there
   * inserts the same coloured chip the inline menu would.
   */
  insertSlashCommand: (value: string) => void
  /**
   * Reset the WHOLE doc to just a `/value` slash chip (+ trailing space).
   * The ScenarioRail's skill chips use this instead of
   * `insertSlashCommand`: picking a skill means "start this skill's flow
   * over" — any previous body (a filled prompt template, half-typed text)
   * is cleared so the rail lands back on the skill's recommended-prompt
   * row（用户明确要求，2026-07-16：chip+正文状态下点技能要清空 input 再进
   * 推荐态，不保留旧正文）. A leading chip is also required for the rail's
   * two-state logic at all — `findSkillChipSpecInText` only matches a
   * LEADING command, so a merely appended chip would never flip the row.
   */
  resetWithSlashCommand: (value: string) => void
  /**
   * Replace everything AFTER the leading slash chip (or the whole doc when
   * there is no chip) with `text`, keeping the chip itself intact. Used by
   * the EmptyState ScenarioRail's recommended-prompt chips: pick a skill →
   * chip goes in via `insertLeadingSlashCommand`; pick a prompt → its
   * template fills the body without blowing the chip away.
   *
   * Why not `runtime.setText(`${slash} ${text}`)`: the external-sync
   * rebuild goes through `parseText`, whose TOKEN_RE doesn't accept `:` —
   * a namespaced command (`/claude-desktop:ppt-master`) would come back as
   * a broken half-chip. Direct doc surgery sidesteps the tokenizer.
   */
  fillBody: (text: string) => void
  /**
   * Append an `@"path"` mention chip at the end of the doc — the inline
   * form of "attach this file"（2026-07-16 附件内联化，对齐 WorkBuddy：有
   * 磁盘路径的上传/拖拽附件不再进输入框上方的 attachments 行，直接以
   * mention chip 混排进正文）. Serialization is the SAME `@"path"` string
   * the attachments pipeline already emitted at send time, so the wire
   * format to fusion-code is untouched — only where the pre-send visual
   * lives changed. Value formatting comes from `fileMentionValue` (the
   * `@` menu's single source of truth for quoting).
   */
  insertFileMention: (path: string) => void
  /**
   * Opaque snapshot of the current doc (PM `doc.toJSON()`), for the
   * ScenarioRail's per-category drafts: switching a tab stashes the doc,
   * switching back restores it VERBATIM — chips, mentions, paragraphs —
   * because JSON round-trips through the schema and never touches
   * `parseText`'s tokenizer (which would shred namespaced commands, see
   * `fillBody`). `null` when the editor isn't mounted (e.g. dictation).
   */
  snapshotDoc: () => unknown | null
  /**
   * Replace the whole doc with a `snapshotDoc()` result; `null` (no draft
   * stashed for that tab) clears the editor. The change dispatches through
   * the normal transaction path, so `composer.text` writeback — and with
   * it the rail's two-state chip row — follows automatically.
   */
  restoreDoc: (snapshot: unknown | null) => void
}

interface Props {
  placeholder: string
  slashAdapter: SuggestionAdapter
  mentionAdapter: SuggestionAdapter
  /** Submit the current composer (Enter with no open popover). */
  onSubmit: () => void
}

export const ProseMirrorComposerInput = forwardRef<ProseMirrorComposerInputHandle, Props>(
  function ProseMirrorComposerInput(
    { placeholder, slashAdapter, mentionAdapter, onSubmit }: Props,
    forwardedRef
  ): React.JSX.Element {
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

  // --- 文件占位 tag（filePlaceholderPlugin）---------------------------
  // 点「【PPT 文件】」这类占位 → 记下它的 doc 区间 → 打开 hidden
  // file input；选完文件在 onPlaceholderFilePicked 里做原位替换。两个
  // 回调都 deps=[]（读 ref），mount-once 的 plugin 闭包捕获它们是安全的。
  const pendingPlaceholderRef = useRef<{ from: number; to: number } | null>(null)
  const placeholderFileInputRef = useRef<HTMLInputElement | null>(null)
  const onPickPlaceholderFile = useCallback((from: number, to: number, placeholderText: string) => {
    pendingPlaceholderRef.current = { from, to }
    const input = placeholderFileInputRef.current
    if (!input) return
    // 按占位描述过滤可选类型（「PPT 文件」→ .ppt/.pptx）；命不中关键词
    // 就不限制。原生对话框据 accept 置灰不匹配项。
    input.accept = acceptForPlaceholder(placeholderText) ?? ''
    input.click()
  }, [])

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
        createFilePlaceholderPlugin(onPickPlaceholderFile),
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
        // `caret-[hsl(var(--brand))]`：光标用固定品牌绿（不跟用户主题色
        // --accent 走，与 LivePreviewEditor「应用标注」按钮同一份 --brand），
        // 给这个契约输入一个跟其它 chrome 不同、始终认得出的焦点信号。
        class:
          'pm-composer-input min-h-[24px] w-full whitespace-pre-wrap break-words text-foreground caret-[hsl(var(--brand))] focus:outline-none [&_p]:m-0',
        'aria-label': placeholder,
        role: 'textbox',
        'aria-multiline': 'true'
      },
      // Pasted files route through the unified attach pipeline
      // (attachFilesToComposer, 2026-07-16 附件内联化)：有磁盘路径的
      // （Finder 复制的文件）插 `@"path"` mention chip 内联进正文；无
      // 路径的剪贴板截图走 assistant-ui attachments（顶部缩略图行 +
      // base64 vision block），与旧行为一致。Returning `true` consumes
      // the event so ProseMirror doesn't also try to paste the image as
      // text/HTML — that double-handling was what made the screen
      // flicker (PM rebuilt the doc → setText → external sync →
      // rebuild, in a loop).
      handlePaste(_view, event) {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length === 0) return false
        event.preventDefault()
        void attachFilesToComposer(files, runtime)
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

  // 末尾追加一个 atom chip（slash 或 mention）的共享实现。
  // `doc.content.size` is the position right AFTER the last paragraph
  // closes (a doc-level boundary) — inserting inline content there
  // doesn't fit `doc`'s `paragraph+` content expression, so ProseMirror
  // auto-wraps it in a brand-new paragraph to make the doc valid, which
  // is what showed up as "换行" (an unwanted line break) when picking a
  // skill. `- 1` targets the position just *inside* the last paragraph
  // instead, right before its closing token — the same kind of interior
  // position `detectTrigger`/`insertSuggestion` always operate on.
  const appendAtomAtEnd = useCallback((nodeType: 'slash' | 'mention', value: string) => {
    const view = viewRef.current
    if (!view) return
    view.focus()
    const endPos = view.state.doc.content.size - 1
    const $end = view.state.doc.resolve(endPos)
    const lastChar = $end.parent.textContent.slice(-1)
    const needsSpace = lastChar !== '' && lastChar !== ' ' && lastChar !== '\t' && lastChar !== '\n'
    const atom = composerSchema.nodes[nodeType]!.create({ value })
    const space = composerSchema.text(' ')
    const content = needsSpace ? [composerSchema.text(' '), atom, space] : [atom, space]
    const tr = view.state.tr.insert(endPos, content)
    view.dispatch(tr.scrollIntoView())
  }, [])

  // 附件内联化的跨组件入口：ThreadView 整列 dropzone / Composer 的「+」
  // 选择器经 attachFiles → composerBridge 走到这里。挂载即注册、卸载即
  // 注销——同一时刻只有一个编辑器实例（hero XOR dock），单槽正确。
  useEffect(() => {
    registerFileMentionInserter((path) => appendAtomAtEnd('mention', fileMentionValue(path)))
    return () => registerFileMentionInserter(null)
  }, [appendAtomAtEnd])

  // 文件占位 tag 的选择器回调：把选中文件的 mention chip【原位替换】进
  // 占位区间。区间从当前 plugin state 重新求证（选择器打开期间 doc 理论
  // 上不会变，但求证零成本）：pending 区间还压着占位 → 用它；漂移了 →
  // 落到 doc 里第一个占位；占位全没了（被手动删掉）→ 末尾追加兜底。
  const onPlaceholderFilePicked = useCallback(
    (fileList: FileList | null) => {
      const input = placeholderFileInputRef.current
      const file = fileList?.[0]
      if (input) input.value = ''
      const pending = pendingPlaceholderRef.current
      pendingPlaceholderRef.current = null
      if (!file) return
      const path = window.chatApi?.pathForFile(file) ?? ''
      const view = viewRef.current
      if (!path || !view) return
      // 占位一套两条 decoration（replace 区间 + 零宽 widget）——求证目标
      // 区间只认 from<to 的 replace，零宽 widget 不能当替换范围用。
      const decoSet = filePlaceholderKey.getState(view.state)
      const spans = (list: readonly { from: number; to: number }[] | undefined) =>
        (list ?? []).filter((d) => d.from < d.to)
      const target =
        (pending ? spans(decoSet?.find(pending.from, pending.to))[0] : undefined) ??
        spans(decoSet?.find())[0]
      if (!target) {
        appendAtomAtEnd('mention', fileMentionValue(path))
        return
      }
      const atom = composerSchema.nodes.mention!.create({ value: fileMentionValue(path) })
      // chip 前后补空格（相邻字符已是空白则不补）：占位常与中文零空格相邻
      // （「修改【…】：」），序列化出的 `修改@"path"：` 会让下游按边界识别
      // mention 的消费方（气泡渲染、CLI 的 bare 解析）掉坑——空格让文本
      // 自带边界，视觉上 chip 自身 margin 已吞掉这一格，不影响排版观感。
      const $from = view.state.doc.resolve(target.from)
      const before = $from.parent.textBetween(0, $from.parentOffset).slice(-1)
      const afterStart = target.to
      const $to = view.state.doc.resolve(afterStart)
      const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size).slice(0, 1)
      const content = [
        ...(before && !/\s/.test(before) ? [composerSchema.text(' ')] : []),
        atom,
        ...(after && !/\s/.test(after) ? [composerSchema.text(' ')] : [])
      ]
      const tr = view.state.tr.replaceWith(target.from, target.to, content)
      // 光标停在 chip 后，用户接着补下一个【】里的内容。
      tr.setSelection(TextSelection.create(tr.doc, Math.min(target.from + 1, tr.doc.content.size - 1)))
      view.dispatch(tr.scrollIntoView())
      view.focus()
      // 「上传即预览」一致性：拖拽 / 「+」选择器路径（attachFiles）都会
      // 自动开右栏预览，占位 pill 选完文件同样开——三个入口一个行为。
      autoOpenPreviewPanel(file.name, path)
    },
    [appendAtomAtEnd]
  )

  // SkillPickerPopover 的入口：拿到用户选的技能 value 后，在编辑器末尾插入
  // 同一个 slash 原子节点（跟手动打 `/` 挑同一项时 insertSuggestion 产出的
  // 节点一模一样），而不是插入裸文本——这样才会渲染成彩色图标 chip，且
  // serializeDoc 吐回去的还是那串命令原文，下游 matchSlashCommand /
  // fusion-code 无感。
  useImperativeHandle(
    forwardedRef,
    (): ProseMirrorComposerInputHandle => ({
      insertSlashCommand: (value: string) => appendAtomAtEnd('slash', value),
      insertFileMention: (path: string) => appendAtomAtEnd('mention', fileMentionValue(path)),
      resetWithSlashCommand: (value: string) => {
        const view = viewRef.current
        if (!view) return
        // 整 doc 重置为「chip + 空格」：不是前插/换 chip——旧正文一并清掉，
        // 这样点技能永远回到该技能的干净起点（正文空 → rail 显示推荐行）。
        const atom = composerSchema.nodes.slash!.create({ value })
        const para = composerSchema.nodes.paragraph!.create(null, [atom, composerSchema.text(' ')])
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, para)
        tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1))
        view.dispatch(tr.scrollIntoView())
        view.focus()
      },
      fillBody: (text: string) => {
        const view = viewRef.current
        if (!view) return
        const { doc } = view.state
        // Keep a leading slash chip (first inline of the first paragraph)
        // and replace from just after it; otherwise replace the whole doc
        // interior. Positions: 1 = inside the first paragraph, before its
        // first child; an atom chip has nodeSize 1.
        const firstInline = doc.firstChild?.firstChild
        const hasChip = firstInline?.type.name === 'slash'
        const from = hasChip ? 1 + firstInline.nodeSize : 1
        // `content.size - 1` is the interior end of the LAST paragraph.
        // A multi-paragraph body is replaced across block boundaries —
        // ProseMirror's replace fitting collapses it back to one block.
        const to = doc.content.size - 1
        // Prompt templates are single-line by contract (PM text nodes
        // cannot contain `\n`); flatten any stray newlines defensively.
        const body = (hasChip ? ' ' : '') + text.replace(/\n+/g, ' ')
        const tr = view.state.tr.replaceWith(from, Math.max(from, to), composerSchema.text(body))
        tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1))
        view.dispatch(tr.scrollIntoView())
        view.focus()
      },
      snapshotDoc: () => {
        const view = viewRef.current
        return view ? view.state.doc.toJSON() : null
      },
      restoreDoc: (snapshot: unknown | null) => {
        const view = viewRef.current
        if (!view) return
        let doc: PMNode
        if (snapshot == null) {
          doc = parseText('')
        } else {
          try {
            doc = PMNodeCls.fromJSON(composerSchema, snapshot)
          } catch (err) {
            // 陈旧/异构快照（理论上只有 schema 变更会走到）→ 当作无草稿清空。
            console.warn('[ProseMirrorComposerInput] restoreDoc: bad snapshot, clearing', err)
            doc = parseText('')
          }
        }
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)
        tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1))
        view.dispatch(tr.scrollIntoView())
        view.focus()
      }
    }),
    []
  )

  return (
    <div className="relative w-full">
      <div ref={editorHostRef} className="w-full" />
      {/* 文件占位 tag 的选择器（filePlaceholderPlugin）：点占位 → click()
          这个 hidden input → onChange 原位替换成 mention chip。 */}
      <input
        ref={placeholderFileInputRef}
        type="file"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => onPlaceholderFilePicked(e.target.files)}
      />
      {suggestion && items.length > 0 && (
        <SuggestionPopover
          items={items}
          highlighted={highlighted}
          anchorEl={editorHostRef.current}
          onPick={(item) => {
            insertSuggestion(viewRef.current!, suggestion, item)
          }}
          onHover={setHighlighted}
        />
      )}
    </div>
  )
  }
)

function SuggestionPopover({
  items,
  highlighted,
  anchorEl,
  onPick,
  onHover
}: {
  items: SuggestionItem[]
  highlighted: number
  /** The editor host element — the popover left-aligns to it and sits above it. */
  anchorEl: HTMLElement | null
  onPick: (item: SuggestionItem) => void
  onHover: (index: number) => void
}): React.JSX.Element | null {
  // Position relative to the EDITOR box, not the caret: the menu always
  // hugs the input's left edge and sits just above its top, so it doesn't
  // drift right as the user types (the caret-anchored version did, which is
  // why it floated off to the upper-right). Mirrors the file-mention menu.
  const MAX_WIDTH = 640 // px — preferred width when the input is wide enough
  const MIN_WIDTH = 320 // px — readability floor for very narrow inputs
  const GAP = 8 // px between the editor edge and the menu
  const MENU_MAX_H = 320 // px — matches the popover's max height cap
  // The menu flips: it prefers to open ABOVE the input (so the caret/input
  // stays visible while browsing), but on the empty-state hero the input sits
  // low with little room above, so it flips BELOW when the upper gap can't
  // hold it. `placement` picks which edge we pin; `maxH` clamps the body to
  // the space actually available on that side (never overflow the viewport —
  // the old `bottom`-only version spilled off the top of the screen here).
  const [pos, setPos] = useState<
    | {
        placement: 'above' | 'below'
        left: number
        top?: number
        bottom?: number
        width: number
        maxH: number
      }
    | null
  >(null)
  // Hovered row's tooltip: index + the row's viewport rect. The tooltip is
  // `fixed`-positioned off that rect rather than nested in the row, because
  // the popover body is `overflow-y-auto` (clips to its own box) — an
  // `absolute` tooltip spilling out the right edge would be cut off. Only
  // set for rows that actually have a description.
  const [tip, setTip] = useState<{ index: number; left: number; top: number } | null>(
    null
  )

  useLayoutEffect(() => {
    if (!anchorEl) return
    const place = (): void => {
      const r = anchorEl.getBoundingClientRect()
      // Width tracks the input: as wide as 640 when the input allows, but
      // never wider than the input itself (so it doesn't overflow past the
      // composer in the narrow slides-mode column), with a readability floor.
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(r.width)))
      // Clamp left so a narrow window can't push the menu off-screen.
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      // Room above the input's top edge vs. below its bottom edge (minus the
      // gap). Prefer opening above; flip below only when above genuinely can't
      // fit the menu AND below has more room — this keeps the dock composer
      // (lots of room above) opening upward as before, while the empty-state
      // hero (little room above) opens downward instead of spilling off-screen.
      const spaceAbove = r.top - GAP
      const spaceBelow = window.innerHeight - r.bottom - GAP
      const above = spaceAbove >= Math.min(MENU_MAX_H, 160) || spaceAbove >= spaceBelow
      if (above) {
        setPos({
          placement: 'above',
          left,
          bottom: window.innerHeight - r.top + GAP,
          width,
          maxH: Math.min(MENU_MAX_H, Math.max(120, spaceAbove))
        })
      } else {
        setPos({
          placement: 'below',
          left,
          top: r.bottom + GAP,
          width,
          maxH: Math.min(MENU_MAX_H, Math.max(120, spaceBelow))
        })
      }
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorEl, items.length])

  if (!pos) return null

  const tipItem = tip ? items[tip.index] : null

  // Portal'd to <body>: the composer card carries `backdrop-blur` (a
  // backdrop-filter), and per CSS spec a filtered ancestor becomes the
  // containing block for `fixed` descendants — so rendered in-tree, these
  // viewport coords would be re-interpreted relative to the card. That was
  // invisible in the dock layout (card hugs the viewport bottom, offsets ≈ 0)
  // but threw the menu to the top of the screen on the centered empty-state
  // hero. The portal escapes the filtered subtree so `fixed` means viewport
  // again.
  return createPortal(
    <>
    <div
      // 毛玻璃化（2026-07-19，用户点名要求）：原来 bg-popover/95 已经接近
      // 不透明，backdrop-blur-2xl 基本看不出效果——同 dropdown-menu.tsx /
      // context-menu.tsx 那套配方，降到 /55 + backdrop-saturate-150 +
      // backdrop-brightness-125（暗色背景不提亮混合后无「透视感」，同一踩坑
      // 教训见 input.tsx / ScrollToBottomButton 历史注释），ring 换成固定
      // border-white/15 + inset 顶部高光，与其它玻璃 popover 统一视觉语言。
      className="fixed z-30 overflow-y-auto rounded-xl border border-white/15 bg-popover/55 py-1 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-125"
      style={{
        left: pos.left,
        ...(pos.placement === 'above'
          ? { bottom: pos.bottom }
          : { top: pos.top }),
        width: pos.width,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: pos.maxH
      }}
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
              // data-slot 是功能性的，不是装饰：本 popover 通过 createPortal 挂到
              // document.body（见下方 `document.body`），脱离了 .chat-app 豁免子树，
              // 于是 canvas 的裸 button reset（base.css `button:where(:not([data-slot],
              // .chat-app *))`）会把每一行填成描边圆角卡片（亮色下尤其丑）。加 data-slot
              // 逃逸 reset，让行回到纯 hover 高亮的干净外观。同 AssistantMessage /
              // UserMessage / ImagesPanel 里 portal 出去的裸交互元素一致处理。
              data-slot="slash-suggestion-item"
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-[7px] text-left text-[13px] ${
                i === highlighted ? 'bg-accent/[0.12]' : ''
              }`}
              onMouseEnter={(e) => {
                onHover(i)
                if (!item.description) {
                  setTip(null)
                  return
                }
                // Position the tooltip off the row's right edge in viewport
                // coords (fixed), so it isn't clipped by the popover's own
                // overflow. +8 gap; top aligns to the row.
                const r = e.currentTarget.getBoundingClientRect()
                setTip({ index: i, left: r.right + 8, top: r.top })
              }}
              onMouseLeave={() => setTip((cur) => (cur?.index === i ? null : cur))}
              onMouseDown={(e) => {
                // mousedown (not click) so we insert before the editor
                // loses focus / selection.
                e.preventDefault()
                onPick(item)
              }}
            >
              {/* Leading icon. A registered skill shows its coloured chip icon;
                  everything else (plain `/cmd`s, `@` mentions without a chip)
                  gets a neutral command glyph so EVERY row carries a left icon
                  and the names line up — matching the file-mention menu's look. */}
              {skill ? (
                <SkillChipIcon src={skill.image} size={16} />
              ) : (
                <svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground/60"
                >
                  {/* hash glyph — generic "command" mark */}
                  <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
                </svg>
              )}
              {/* Single-row layout: name, then the description trailing inline
                  and truncating, instead of stacking onto a second line. Keeps
                  rows short so the popover fits far more entries on screen.
                  The name is `shrink-0` (it's the primary token — never let a
                  long description squeeze it); the description takes the
                  remaining width and truncates. */}
              <span className="shrink-0 font-medium text-foreground">
                {skill?.label ?? item.label}
              </span>
              {item.description && (
                <span className="ml-1 min-w-0 flex-1 truncate text-muted-foreground/70">
                  {item.description}
                </span>
              )}
            </button>
          </div>
        )
      })}
    </div>
    {/* Full-description tooltip — `fixed` so it isn't clipped by the popover's
        overflow. Positioned off the hovered row's right edge (computed in the
        row's onMouseEnter). Surfaces the complete description (the inline copy
        truncates) plus the raw value, handy for namespaced skills. */}
    {tip && tipItem?.description && (
      <div
        className="pointer-events-none fixed z-40 w-72 rounded-lg bg-neutral-900/95 px-3 py-2 text-[12px] leading-snug text-neutral-100 shadow-xl ring-1 ring-white/10"
        style={{ left: tip.left, top: tip.top }}
      >
        <div>{tipItem.description}</div>
        <div className="mt-1 truncate font-mono text-[11px] text-neutral-400">
          {tipItem.value}
        </div>
      </div>
    )}
    </>,
    document.body
  )
}
