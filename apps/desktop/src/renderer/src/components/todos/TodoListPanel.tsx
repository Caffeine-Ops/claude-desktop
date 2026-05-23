import { useT, useTFormat } from '../../i18n'
import { useChatStore } from '../../stores/chat'
import { useTodosStore, type TodoItem, type TodoStatus } from '../../stores/todos'

/**
 * TodoListPanel
 * -------------
 * Top half of the right rail. The outer `aside` (border, background,
 * fixed 288px width) lives in App.tsx so TodoListPanel and
 * WorkspaceTreePanel can share a single rail container without each
 * duplicating the chrome. This component contributes only its own
 * section (header + scroll list), sized to `flex-1` so it splits
 * vertical space evenly with the workspace tree below.
 *
 * Reads from `useTodosStore` keyed by the current session id and
 * renders it read-only — the LLM owns the list, users can only tick
 * rows off or clear the whole list.
 *
 * Shape taken from free-code
 * --------------------------
 * - Three statuses (pending / in_progress / completed), matching
 *   `free-code/src/utils/todo/types.ts` exactly.
 * - Icon vocabulary lifted from `TaskListV2.tsx:220-241`:
 *     pending     → ◻   (figures.squareSmall, muted)
 *     in_progress → ◼   (figures.squareSmallFilled, Claude orange, bold)
 *     completed   → ✔   (figures.tick, green, strikethrough + dim)
 * - "All done → wipe list" is handled in the store (setTodos), mirroring
 *   `TodoWriteTool.call()` in free-code, so this component never needs
 *   to render an empty "everything's completed" graveyard.
 *
 * Write path
 * ----------
 * The LLM writes the whole list in one go via `setTodos`, wired in
 * FusionRuntimeProvider by intercepting `TodoWrite` tool calls. The
 * panel is strictly read-only on the user side — there's no "add
 * todo" composer and the row icons are not clickable. The agent is
 * the single source of truth for the task list, so surfacing a click
 * affordance would just let users drift the UI out of sync with what
 * the model believes it's tracking.
 */
export function TodoListPanel(): React.JSX.Element {
  const t = useT()
  const sessionId = useChatStore((s) => s.sessionId)
  const todos = useTodosStore((s) =>
    sessionId === null ? EMPTY : (s.todos[sessionId] ?? EMPTY)
  )
  // Counts drive the small "3 / 5" summary next to the header. Kept
  // inline instead of memoized — the list is bounded and re-renders
  // only on explicit mutations, so the arithmetic is negligible.
  const completed = todos.filter((t) => t.status === 'completed').length
  const total = todos.length

  const progress = total === 0 ? 0 : Math.round((completed / total) * 100)

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-foreground/[0.03] dark:bg-white/[0.04]"
      style={{ letterSpacing: '-0.01em' }}
    >
      {/* Header row — small section glyph + label on the left, count
          pill on the right. The pill renders only when there's a list
          to count, so the empty state stays uncluttered. */}
      <div className="flex items-center justify-between gap-2 px-3.5 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-[18px] shrink-0 items-center justify-center text-muted-foreground">
            <ListIcon />
          </span>
          <span
            className="font-semibold text-foreground"
            style={{ fontSize: '13px', letterSpacing: '-0.012em' }}
          >
            {t('todosTitle')}
          </span>
        </div>
        {total > 0 && (
          <span
            className="rounded-full bg-foreground/[0.08] px-2 py-[2px] text-[10.5px] font-medium tabular-nums text-muted-foreground dark:bg-white/[0.1]"
            style={{ letterSpacing: '-0.01em' }}
          >
            <span className="text-foreground">{completed}</span>
            <span className="px-0.5 text-muted-foreground/50">/</span>
            <span>{total}</span>
          </span>
        )}
      </div>

      {/* Progress bar — thin track that fills with accent. Only shown
          when there's an actual list, otherwise the empty-state hint
          gets the vertical room to itself. */}
      {total > 0 && (
        <div className="mx-3.5 mb-2 h-[3px] overflow-hidden rounded-full bg-foreground/[0.08] dark:bg-white/[0.1]">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
            aria-hidden
          />
        </div>
      )}

      {/* Scroll region. min-h-0 + flex-1 so the list body can shrink
          inside the flex-col section without pushing the header off. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-0.5">
        {todos.length === 0 ? (
          <EmptyHint />
        ) : (
          <ul className="space-y-0.5">
            {todos.map((todo, i) => (
              <TodoRow
                key={`${i}-${todo.content}`}
                todo={todo}
                t={t}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/* ─────────────────── Empty-state hint ─────────────────── */

function EmptyHint(): React.JSX.Element {
  const t = useT()
  return (
    <div
      className="mx-2 mt-1 flex flex-col items-center gap-2.5 rounded-xl px-3 py-6 text-center text-muted-foreground"
      style={{ fontSize: '11.5px', lineHeight: 1.47, letterSpacing: '-0.01em' }}
    >
      <span className="flex size-8 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground/80 dark:bg-white/[0.08]">
        <ListIcon />
      </span>
      <div className="font-medium text-foreground/75">{t('todosEmpty')}</div>
      <div className="text-muted-foreground/70">
        {t('todosEmptyHintBefore')}
        <code
          className="rounded-[5px] bg-foreground/[0.08] px-1 py-0.5 font-mono text-foreground/80 dark:bg-white/[0.1]"
          style={{ fontSize: '10.5px' }}
        >
          TodoWrite
        </code>
        {t('todosEmptyHintAfter')}
      </div>
    </div>
  )
}

/* ─────────────────── Single row ─────────────────── */

type RowProps = {
  todo: TodoItem
  t: (key: import('../../i18n').StringKey) => string
}

function TodoRow({ todo, t }: RowProps): React.JSX.Element {
  const tf = useTFormat()
  const isCompleted = todo.status === 'completed'
  const isInProgress = todo.status === 'in_progress'

  // While in_progress, surface the activeForm ("Running tests") instead
  // of the imperative content ("Run tests") — matches how free-code's
  // TaskListV2 uses activeForm as the spinner label for the running row.
  const label = isInProgress ? todo.activeForm || todo.content : todo.content
  const statusLabel =
    todo.status === 'pending'
      ? t('todoStatusPending')
      : todo.status === 'in_progress'
        ? t('todoStatusInProgress')
        : t('todoStatusCompleted')

  return (
    <li className="relative">
      <div
        className={
          'group/todo relative flex items-start gap-2.5 rounded-lg py-1.5 pl-2.5 pr-2 transition-colors ' +
          (isInProgress ? 'bg-accent/[0.1] dark:bg-accent/[0.15]' : '')
        }
        style={{ fontSize: '12.5px', letterSpacing: '-0.012em' }}
      >
        {/* Active-row accent strip — only shown for in_progress so the
            currently-running task is impossible to miss in a long list. */}
        {isInProgress && (
          <span
            aria-hidden
            className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent"
          />
        )}

        {/* Status icon is presentational only — the todo list is
            owned by the agent via TodoWrite tool calls, so the user
            cannot cycle or edit individual rows. `title` still gives
            the screen-reader / hover-tooltip label. */}
        <span
          aria-label={tf('todosStatusTitle', { status: statusLabel })}
          title={tf('todosStatusTitle', { status: statusLabel })}
          className="mt-[1px] flex size-[14px] shrink-0 items-center justify-center"
        >
          <StatusIcon status={todo.status} />
        </span>
        <span
          className={
            'min-w-0 flex-1 whitespace-pre-wrap break-words leading-snug ' +
            (isCompleted
              ? 'text-muted-foreground/50 line-through decoration-muted-foreground/40'
              : isInProgress
                ? 'font-medium text-foreground'
                : 'text-foreground/90')
          }
        >
          {label}
        </span>
      </div>
    </li>
  )
}

function StatusIcon({ status }: { status: TodoStatus }): React.JSX.Element {
  if (status === 'completed') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-full text-emerald-500"
        aria-hidden
      >
        <circle cx="8" cy="8" r="6" fill="rgb(16 185 129 / 0.18)" stroke="none" />
        <path d="m5.2 8.2 2 2 3.8-4.2" />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <span className="relative flex size-full items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/40" />
        <span className="relative inline-flex size-[8px] rounded-full bg-accent" />
      </span>
    )
  }
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-full text-muted-foreground/60 transition group-hover/todo:text-muted-foreground"
      aria-hidden
    >
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  )
}

function ListIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[13px]"
      aria-hidden
    >
      <line x1="6" y1="4" x2="13" y2="4" />
      <line x1="6" y1="8" x2="13" y2="8" />
      <line x1="6" y1="12" x2="13" y2="12" />
      <circle cx="3.5" cy="4" r="0.8" fill="currentColor" />
      <circle cx="3.5" cy="8" r="0.8" fill="currentColor" />
      <circle cx="3.5" cy="12" r="0.8" fill="currentColor" />
    </svg>
  )
}

// Stable empty array reference so the zustand selector doesn't treat
// an absent session as a fresh value on every render (which would
// thrash React's re-render detection).
const EMPTY: readonly TodoItem[] = Object.freeze([])
