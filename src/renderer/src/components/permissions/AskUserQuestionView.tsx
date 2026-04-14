import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { Kbd } from './PermissionDialog'

/**
 * AskUserQuestionView
 * -------------------
 * Specialized body for the `AskUserQuestion` tool. Mirrors the flow
 * free-code uses in its terminal AskUserQuestionPermissionRequest:
 * the model ships a list of 1-4 questions, each with 2-4 options, and
 * the user has to pick one answer per question before proceeding.
 *
 * Data shape (from free-code/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx)
 * ----------
 *   input: {
 *     questions: [
 *       {
 *         question: string,      // full prompt, ends with "?"
 *         header: string,        // short chip label (≤ chip width)
 *         options: [
 *           { label: string, description: string, preview?: string },
 *           …
 *         ],
 *         multiSelect?: boolean  // we render as single-select only
 *       },
 *       …
 *     ],
 *     answers?: Record<string, string>,
 *     annotations?: Record<string, { preview?: string; notes?: string }>
 *   }
 *
 * "Other" auto-option
 * -------------------
 * free-code's `QuestionView` (see QuestionView.tsx:204-222) appends a
 * special option to every question:
 *
 *   { type: "input", value: "__other__", label: "Other" }
 *
 * When selected it collapses into a free-text input — whatever the
 * user types becomes the actual answer string. We mirror that here
 * so the model's 2-4 options never feel like a dead-end: the user
 * can always escape hatch with their own wording. Our OTHER_VALUE
 * constant is the same `__other__` sentinel free-code uses; it never
 * leaves this component (the final answer is the raw typed text).
 *
 * Simplifications vs. free-code
 * -----------------------------
 * free-code supports `multiSelect`, preview panes, inline notes,
 * planning-mode affordances, and image attachments. This renderer
 * does single-select only — enough to unblock the common case where
 * the model asks one-off clarifying questions. multiSelect input is
 * still accepted gracefully (the first pick wins) so a model can
 * ship a multiSelect question without crashing the dialog.
 *
 * Submission
 * ----------
 * On submit we build `answers: Record<questionText, selectedLabel>`
 * and call the `onSubmit` prop with `{ answers }`. PermissionDialog
 * wraps that in `respond('allow-once', updatedInput)`, which flows
 * through the broker → engine → SDK and lands in the tool's `call()`
 * method where it becomes the tool_result the assistant reads.
 *
 * Keyboard
 * --------
 *   1-4         → select the Nth option (auto-advance on last question
 *                 if all previous answers are set; otherwise just picks)
 *   ↑ / ↓       → move highlight within the current question
 *   Enter       → confirm current question → next (or submit if last)
 *   Backspace   → previous question (only if there is one)
 *   Esc         → cancel (sends 'deny' through the broker)
 */

type Option = {
  label: string
  description?: string
}

type Question = {
  question: string
  header?: string
  options: Option[]
}

type Props = {
  input: unknown
  onSubmit: (updatedInput: { answers: Record<string, string> }) => void
  onCancel: () => void
}

/**
 * Sentinel used to mark the "Other" row inside the highlight state —
 * any highlight index equal to `options.length` means Other is the
 * current focus. We don't use a string literal in state because the
 * index-based model keeps ArrowUp/Down arithmetic trivial.
 */
const OTHER_PLACEHOLDER = 'Type your own answer…'

export function AskUserQuestionView({
  input,
  onSubmit,
  onCancel
}: Props): React.JSX.Element {
  // Parse once per mount. The permission request payload is stable
  // for a single dialog lifetime, so memoizing on `input` is both
  // correct and cheap.
  const questions = useMemo(() => parseQuestions(input), [input])

  // Per-question selection state. Key is the question text (same key
  // we'll use when building the answers Record on submit) because the
  // questions schema guarantees unique question strings. Missing keys
  // mean "not yet answered". We seed from any pre-existing `answers`
  // field on the input so resuming a session mid-question doesn't
  // lose previous picks.
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    seedAnswers(input)
  )
  const [qIndex, setQIndex] = useState(0)
  // Highlighted row index *within the current question*. Range is
  // `[0, options.length]` — the extra slot at the end is the "Other"
  // row, which renders differently from a normal option but
  // participates in the same up/down/enter cursor.
  const [highlight, setHighlight] = useState(0)
  // True when the Other row is currently editing (text input has
  // focus). The global key handler mostly no-ops while this is true so
  // the input can consume its own keystrokes — the only global key we
  // keep is Escape, which exits edit mode rather than cancelling the
  // whole dialog (less surprising than nuking the user's draft).
  const [otherEditing, setOtherEditing] = useState(false)
  // Per-question draft text for the Other row. Persisted across
  // question navigation so "Back → forward" doesn't lose what the
  // user typed. Keyed by question text like `answers`.
  const [otherDraftByQuestion, setOtherDraftByQuestion] = useState<
    Record<string, string>
  >({})
  // Ref to the Other <input> so we can imperatively focus it when the
  // user enters edit mode via keyboard (mouse click sets focus via
  // the browser's built-in behavior).
  const otherInputRef = useRef<HTMLInputElement | null>(null)

  const current = questions[qIndex] ?? null
  // Row count includes the Other sentinel, so keyboard nav can reach
  // the bottom. Options contribute their own length; Other is +1.
  const rowCount = current ? current.options.length + 1 : 0
  const otherIndex = current ? current.options.length : -1
  const onOtherRow = current !== null && highlight === otherIndex

  // Snap highlight to a pre-existing answer whenever we land on a
  // question that has one. Also reset to 0 when switching into a
  // fresh (unanswered) question so the top option is always the
  // default pick.
  useEffect(() => {
    if (!current) return
    const existing = answers[current.question]
    if (existing) {
      const idx = current.options.findIndex((o) => o.label === existing)
      if (idx >= 0) {
        setHighlight(idx)
      } else if (existing === otherDraftByQuestion[current.question]) {
        // Previous answer came from the Other row — restore focus to
        // it so the user can tweak without going back through Tab.
        setHighlight(current.options.length)
      } else {
        setHighlight(0)
      }
    } else {
      setHighlight(0)
    }
    // Clear editing state on every question change so arrow keys
    // don't leak into a previous question's input.
    setOtherEditing(false)
    // We intentionally only depend on the question index — the
    // effect is about "arrived at a new question", not "answers
    // changed". Resetting on every answer write would snap the
    // highlight back to 0 after every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qIndex])

  const isLastQuestion = qIndex === questions.length - 1
  const totalQuestions = questions.length

  /**
   * Commit `label` as the answer for the current question. Advances to
   * the next question; if this was the last one, builds the answers
   * map and calls `onSubmit`. Not all selections auto-advance — the
   * caller decides whether to skip ahead so keyboard and mouse can
   * share the commit path.
   */
  const commitAnswer = useCallback(
    (label: string, advance: boolean): void => {
      if (!current) return
      const nextAnswers = { ...answers, [current.question]: label }
      setAnswers(nextAnswers)
      if (!advance) return
      if (isLastQuestion) {
        // Build the final Record in insertion order of the questions
        // array so the assistant sees answers in a stable order when
        // it reads the tool_result.
        const out: Record<string, string> = {}
        for (const q of questions) {
          const a = nextAnswers[q.question]
          if (a) out[q.question] = a
        }
        onSubmit({ answers: out })
      } else {
        setQIndex((i) => Math.min(i + 1, questions.length - 1))
      }
    },
    [answers, current, isLastQuestion, questions, onSubmit]
  )

  // ── Keyboard handler ──────────────────────────────────────────────
  useEffect(() => {
    if (!current) return
    const handler = (e: KeyboardEvent): void => {
      // When editing the Other input, let the input handle almost
      // everything itself. We only intercept Escape here to exit
      // edit mode without losing the whole dialog — and we skip
      // preventDefault on the input's own keys so the textbox stays
      // responsive. The input's own onKeyDown handles Enter/commit.
      if (otherEditing) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setOtherEditing(false)
          otherInputRef.current?.blur()
        }
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      // Numeric direct-select (1..N). Commits AND advances — matches
      // free-code's behavior where "2" means "pick option 2 and move
      // on", not just "highlight". Number keys never target the
      // Other row; the user has to navigate there explicitly.
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1
        if (n >= 0 && n < current.options.length) {
          e.preventDefault()
          commitAnswer(current.options[n].label, true)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => Math.min(h + 1, rowCount - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (highlight === otherIndex) {
          // Enter on the Other row opens edit mode and focuses the
          // input. The next Enter (inside the input's own handler)
          // will submit the typed text.
          setOtherEditing(true)
          // Defer focus one tick so React has rendered the row in
          // edit mode. setTimeout(0) is fine — the input is always
          // mounted, we're just switching its interactive state.
          setTimeout(() => otherInputRef.current?.focus(), 0)
          return
        }
        const label = current.options[highlight]?.label
        if (label) commitAnswer(label, true)
        return
      }
      if (e.key === 'Backspace' && qIndex > 0) {
        e.preventDefault()
        setQIndex((i) => Math.max(i - 1, 0))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    current,
    highlight,
    qIndex,
    rowCount,
    otherIndex,
    otherEditing,
    commitAnswer,
    onCancel
  ])

  /**
   * Keydown handler attached to the Other row's <input> itself.
   * Handles Enter (submit typed text as answer) and Escape (exit
   * edit mode). All other keys are left untouched so normal text
   * editing (arrows inside the field, backspace, etc.) works as
   * expected without fighting the global handler.
   */
  const handleOtherInputKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (!current) return
      if (e.key === 'Enter') {
        e.preventDefault()
        const draft = otherDraftByQuestion[current.question] ?? ''
        const trimmed = draft.trim()
        if (trimmed.length === 0) return
        setOtherEditing(false)
        otherInputRef.current?.blur()
        commitAnswer(trimmed, true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setOtherEditing(false)
        otherInputRef.current?.blur()
      }
      // Stop propagation so the global handler above doesn't ALSO
      // see the key and try to re-interpret it (otherwise numeric
      // keys typed in the input would trigger option selection).
      e.stopPropagation()
    },
    [current, otherDraftByQuestion, commitAnswer]
  )

  // ── Degraded / malformed input fallback ───────────────────────────
  // If we couldn't parse anything usable out of the input, fall back
  // to a minimal "dump + Yes/No" view so the user isn't stuck. This
  // matches the old PermissionDialog visual — safer than crashing.
  if (questions.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-4 pt-4">
        <div className="mb-2 text-[14px] font-semibold text-foreground">
          Claude has a question
        </div>
        <div className="mb-4 max-h-48 overflow-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/80">
          <pre className="whitespace-pre-wrap break-words">
            {safeStringify(input)}
          </pre>
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => onSubmit({ answers: {} })}
            className="flex w-full items-center gap-3 rounded-md border border-accent/40 bg-accent/15 px-3 py-2 text-left text-[13px] font-medium text-accent transition hover:border-accent hover:bg-accent/25"
          >
            Continue
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex w-full items-center gap-3 rounded-md border border-border bg-card/60 px-3 py-2 text-left text-[13px] text-foreground transition hover:border-input hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (!current) return <div />

  return (
    // Outer shell is `flex-1 min-h-0` so it fills the DialogShell's
    // max-height budget and lets the inner scroll region actually
    // shrink. Without `min-h-0`, flex children refuse to shrink below
    // their content and the overflow gets clipped at the card edge
    // on short windows.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Scrollable body: question prompt + all options. `min-h-0`
          + `overflow-y-auto` lets this region scroll when the
          combined height of question text and options exceeds the
          viewport's remaining budget. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-4">
        {/* Header: question counter + optional chip header */}
        <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground/80">
          {totalQuestions > 1 && (
            <span className="font-mono tabular-nums">
              Question {qIndex + 1} / {totalQuestions}
            </span>
          )}
          {current.header && (
            <span className="rounded border border-border bg-card/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {current.header}
            </span>
          )}
        </div>

        {/* The question itself. whitespace-pre-wrap because models
            sometimes drop in \n to group related context. */}
        <div className="mb-4 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground">
          {current.question}
        </div>

        <div className="flex flex-col gap-1">
          {current.options.map((opt, i) => (
            <OptionRow
              key={`${qIndex}-${i}-${opt.label}`}
              index={i + 1}
              label={opt.label}
              description={opt.description}
              highlighted={i === highlight && !onOtherRow}
              onHover={() => setHighlight(i)}
              onClick={() => commitAnswer(opt.label, true)}
            />
          ))}
          <OtherRow
            highlighted={onOtherRow}
            editing={otherEditing}
            draft={otherDraftByQuestion[current.question] ?? ''}
            inputRef={otherInputRef}
            onHover={() => setHighlight(otherIndex)}
            onClickRow={() => {
              // Clicking the row: move highlight here and enter edit
              // mode in one gesture. Focus lands on the input via
              // the next render; the global handler ignores the
              // click so we don't accidentally commit anything.
              setHighlight(otherIndex)
              setOtherEditing(true)
              setTimeout(() => otherInputRef.current?.focus(), 0)
            }}
            onChange={(next) =>
              setOtherDraftByQuestion((prev) => ({
                ...prev,
                [current.question]: next
              }))
            }
            onKeyDown={handleOtherInputKey}
            onBlur={() => setOtherEditing(false)}
          />
        </div>
      </div>

      {/* Footer — pinned to the bottom via `shrink-0` so the scrollable
          body above never overlaps the keyboard hint row, no matter
          how tall the question / option list gets. */}
      <div className="flex shrink-0 items-center justify-between border-t border-border bg-background/60 px-5 py-2 text-[11px] text-muted-foreground/80">
        <span className="flex items-center gap-2">
          {otherEditing ? (
            <>
              <Kbd>↵</Kbd> submit · <Kbd>Esc</Kbd> back to list
            </>
          ) : (
            <>
              <Kbd>Esc</Kbd> cancel · <Kbd>↵</Kbd> select · <Kbd>1-{current.options.length}</Kbd> pick
              {qIndex > 0 && (
                <>
                  {' · '}
                  <Kbd>⌫</Kbd> back
                </>
              )}
            </>
          )}
        </span>
        <span className="truncate font-mono text-muted-foreground/60">AskUserQuestion</span>
      </div>
    </div>
  )
}

/* ─────────────────── Option row ─────────────────── */

function OptionRow({
  index,
  label,
  description,
  highlighted,
  onHover,
  onClick
}: {
  index: number
  label: string
  description?: string
  highlighted: boolean
  onHover: () => void
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      className={
        'flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-[13px] transition focus:outline-none ' +
        (highlighted
          ? 'border-accent/50 bg-accent/15 text-accent'
          : 'border-border bg-card/60 text-foreground hover:border-input hover:bg-muted')
      }
    >
      <span
        className={
          'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold ' +
          (highlighted ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground')
        }
      >
        {index}
      </span>
      <span className="min-w-0 flex-1">
        <div className={'truncate font-medium ' + (highlighted ? 'text-accent' : 'text-foreground')}>{label}</div>
        {description && (
          <div className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-muted-foreground/80">
            {description}
          </div>
        )}
      </span>
    </button>
  )
}

/* ─────────────────── Other (free-text) row ─────────────────── */

/**
 * The auto-appended "Other" row. Two visual modes:
 *
 *   - **Idle** (not highlighted, not editing): looks like a dimmed
 *     OptionRow with a tag icon instead of a number, to make it clear
 *     this is a different kind of row.
 *   - **Highlighted, not editing**: same visual treatment as a
 *     highlighted OptionRow — tells the user "Enter will activate
 *     this, but it's a text field, not a single click".
 *   - **Editing**: card switches to a focused state with an inline
 *     <input> taking up the label area. Typing goes into `draft`
 *     (lifted to the parent so navigation across questions
 *     preserves it). Enter inside the input commits via onKeyDown,
 *     Escape bails, blur exits edit mode.
 *
 * Mirrors free-code's `{ type: "input", value: "__other__", label:
 * "Other", placeholder, initialValue, onChange }` contract.
 */
function OtherRow({
  highlighted,
  editing,
  draft,
  inputRef,
  onHover,
  onClickRow,
  onChange,
  onKeyDown,
  onBlur
}: {
  highlighted: boolean
  editing: boolean
  draft: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onHover: () => void
  onClickRow: () => void
  onChange: (next: string) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void
  onBlur: () => void
}): React.JSX.Element {
  const active = highlighted || editing
  return (
    <div
      onMouseEnter={onHover}
      onClick={() => {
        // Clicks anywhere on the row — except the input itself —
        // transition into edit mode. The input's own onClick
        // stopPropagation prevents this firing twice.
        if (!editing) onClickRow()
      }}
      className={
        'flex w-full cursor-text items-start gap-3 rounded-md border px-3 py-2 text-left text-[13px] transition focus-within:border-accent/50 focus-within:bg-accent/15 ' +
        (active
          ? 'border-accent/50 bg-accent/15 text-accent'
          : 'border-border bg-card/60 text-foreground hover:border-input hover:bg-muted')
      }
    >
      <span
        aria-hidden
        className={
          'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold ' +
          (active ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground')
        }
      >
        {/* Plus glyph so the Other row reads "add your own answer"
            even without the sidebar hint — distinct from numbered
            option rows above. */}
        +
      </span>
      <span className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onClick={(e) => e.stopPropagation()}
            placeholder={OTHER_PLACEHOLDER}
            className="w-full bg-transparent font-medium text-foreground caret-accent placeholder:text-muted-foreground/80 focus:outline-none"
          />
        ) : (
          <div
            className={
              'truncate font-medium ' +
              (active ? 'text-accent' : 'text-foreground/80')
            }
          >
            {draft.length > 0 ? draft : 'Other'}
          </div>
        )}
        {!editing && (
          <div className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-muted-foreground/80">
            Type your own answer in your own words.
          </div>
        )}
      </span>
    </div>
  )
}

/* ─────────────────── Parsers ─────────────────── */

/**
 * Shape-check and extract the questions array from a raw tool input.
 * Returns an empty array on any shape mismatch — callers render a
 * fallback view in that case rather than crashing. Strict enough to
 * drop garbage, lenient enough to survive trivial variations (missing
 * `header`, missing `description`, etc.).
 */
function parseQuestions(input: unknown): Question[] {
  if (!input || typeof input !== 'object') return []
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const rq = q as Record<string, unknown>
    const question = typeof rq.question === 'string' ? rq.question : null
    if (!question) continue
    const optsRaw = rq.options
    if (!Array.isArray(optsRaw)) continue
    const options: Option[] = []
    for (const opt of optsRaw) {
      if (!opt || typeof opt !== 'object') continue
      const ro = opt as Record<string, unknown>
      const label = typeof ro.label === 'string' ? ro.label : null
      if (!label) continue
      options.push({
        label,
        description:
          typeof ro.description === 'string' && ro.description.length > 0
            ? ro.description
            : undefined
      })
    }
    if (options.length === 0) continue
    out.push({
      question,
      header: typeof rq.header === 'string' ? rq.header : undefined,
      options
    })
  }
  return out
}

function seedAnswers(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {}
  const maybe = (input as { answers?: unknown }).answers
  if (!maybe || typeof maybe !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(maybe as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function safeStringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
