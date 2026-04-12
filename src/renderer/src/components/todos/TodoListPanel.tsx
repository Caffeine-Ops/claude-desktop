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
 *     pending     → ○   (hollow circle, muted)
 *     in_progress → ●   (filled circle, accent — Claude orange-ish)
 *     completed   → ✓   (tick, green, strikethrough)
 * - "All done → wipe list" is handled in the store (setTodos), mirroring
 *   `TodoWriteTool.call()` in free-code, so this component never needs
 *   to render an empty "everything's completed" graveyard.
 *
 * Write path
 * ----------
 * The LLM writes the whole list in one go via `setTodos`, wired in
 * FusionRuntimeProvider by intercepting `TodoWrite` tool calls. Users
 * can click a row's icon to cycle pending → in_progress → completed →
 * pending and delete rows, but there's no "add todo" composer — that
 * path was removed intentionally so the panel always reflects what the
 * model is actually tracking, not a hand-maintained parallel list.
 */
export function TodoListPanel(): React.JSX.Element {
  const sessionId = useChatStore((s) => s.sessionId)
  const todos = useTodosStore((s) => s.todos[sessionId] ?? EMPTY)
  const cycleStatus = useTodosStore((s) => s.cycleStatus)
  const removeTodo = useTodosStore((s) => s.removeTodo)
  const clearTodos = useTodosStore((s) => s.clearTodos)

  // Counts drive the small "3 / 5" summary next to the header. Kept
  // inline instead of memoized — the list is bounded and re-renders
  // only on explicit mutations, so the arithmetic is negligible.
  const completed = todos.filter((t) => t.status === 'completed').length
  const total = todos.length

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* Header row — section label, count, clear button. Mirrors the
          Chats header on the left rail for visual symmetry. */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
          Todos
        </span>
        {total > 0 && (
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <span className="tabular-nums">
              <span className="text-zinc-300">{completed}</span>
              <span className="text-zinc-600">{' / '}</span>
              <span>{total}</span>
            </span>
            <button
              type="button"
              onClick={() => clearTodos(sessionId)}
              className="rounded px-1.5 py-0.5 text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-300"
              aria-label="Clear all todos"
              title="Clear all"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* Scroll region. min-h-0 + flex-1 so the list body can shrink
          inside the flex-col section without pushing the header off.
          Extra top padding fills the space where the composer used
          to sit so the header doesn't hug the first row. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
        {todos.length === 0 ? (
          <EmptyHint />
        ) : (
          <ul className="space-y-0.5">
            {todos.map((todo, i) => (
              <TodoRow
                key={`${i}-${todo.content}`}
                todo={todo}
                onCycle={() => cycleStatus(sessionId, i)}
                onRemove={() => removeTodo(sessionId, i)}
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
  return (
    <div className="mt-4 rounded-md border border-dashed border-zinc-800/80 px-3 py-4 text-center text-[11px] leading-relaxed text-zinc-600">
      <div className="mb-1 font-medium text-zinc-500">No todos yet</div>
      <div>
        Ask Claude to use
        <br />
        <code className="rounded bg-zinc-900 px-1 py-0.5 text-[10.5px] font-mono text-zinc-400">
          TodoWrite
        </code>
      </div>
    </div>
  )
}

/* ─────────────────── Single row ─────────────────── */

type RowProps = {
  todo: TodoItem
  onCycle: () => void
  onRemove: () => void
}

function TodoRow({ todo, onCycle, onRemove }: RowProps): React.JSX.Element {
  const { icon, iconClass } = getStatusIcon(todo.status)
  const isCompleted = todo.status === 'completed'
  const isInProgress = todo.status === 'in_progress'

  // While in_progress, surface the activeForm ("Running tests") instead
  // of the imperative content ("Run tests") — matches how free-code's
  // TaskListV2 uses activeForm as the spinner label for the running row.
  const label = isInProgress ? todo.activeForm || todo.content : todo.content

  return (
    <li className="group/todo relative">
      <div className="flex items-start gap-2 rounded-md px-2 py-1.5 text-[13px] transition hover:bg-zinc-800/40">
        <button
          type="button"
          onClick={onCycle}
          className={
            'mt-[1px] flex size-4 shrink-0 items-center justify-center rounded-sm font-mono text-[13px] leading-none transition ' +
            iconClass
          }
          aria-label={`Toggle status (currently ${todo.status})`}
          title={`Status: ${todo.status.replace('_', ' ')}`}
        >
          {icon}
        </button>
        <span
          className={
            'min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed ' +
            (isCompleted
              ? 'text-zinc-600 line-through'
              : isInProgress
                ? 'font-medium text-zinc-100'
                : 'text-zinc-300')
          }
        >
          {label}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="mt-[1px] flex size-4 shrink-0 items-center justify-center rounded text-[12px] leading-none text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-300 group-hover/todo:opacity-100"
          aria-label="Remove todo"
          title="Remove"
        >
          ×
        </button>
      </div>
    </li>
  )
}

/**
 * Map a TodoStatus to an icon glyph + Tailwind class pair.
 *
 * Icons match the free-code CLI vocabulary (see TaskListV2.tsx:220-241,
 * which uses the `figures` package: `figures.tick`, `squareSmallFilled`,
 * `squareSmall`). We use Unicode equivalents that render cleanly in the
 * browser without pulling in the whole `figures` package:
 *
 *   pending     → ○    (empty)
 *   in_progress → ●    (filled, accent color)
 *   completed   → ✓    (tick, success color)
 */
function getStatusIcon(status: TodoStatus): {
  icon: string
  iconClass: string
} {
  switch (status) {
    case 'completed':
      return { icon: '✓', iconClass: 'text-emerald-500' }
    case 'in_progress':
      return { icon: '●', iconClass: 'text-amber-400' }
    case 'pending':
      return { icon: '○', iconClass: 'text-zinc-600 hover:text-zinc-400' }
  }
}

// Stable empty array reference so the zustand selector doesn't treat
// an absent session as a fresh value on every render (which would
// thrash React's re-render detection).
const EMPTY: readonly TodoItem[] = Object.freeze([])
