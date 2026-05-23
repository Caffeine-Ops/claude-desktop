import { create } from 'zustand'

/**
 * Todo list store — mirrors free-code's V1 `TodoWrite` data model.
 *
 * Data shape (see free-code/src/utils/todo/types.ts)
 * --------------------------------------------------
 *   TodoItem {
 *     content: string       // imperative form — "Run tests"
 *     activeForm: string    // present continuous — "Running tests"
 *     status: 'pending' | 'in_progress' | 'completed'
 *   }
 *
 * Replacement semantics
 * ---------------------
 * Like V1 TodoWrite, `setTodos` replaces the whole list for a session in
 * one shot rather than diffing individual items. This matches how the
 * LLM emits todos — it hands back the entire updated list each turn.
 * And, mirroring V1's "all completed → clear" behaviour, when every
 * item is marked completed we reset to an empty list on the next write
 * so the panel doesn't become a graveyard of ticked boxes.
 *
 * Per-session isolation
 * ---------------------
 * Todos are keyed by sessionId so switching chat sessions (once the
 * thread-list adapter lands) naturally shows the right list. The
 * current renderer only has a single `'default'` session, but the
 * keying is already in place so we don't need to refactor later.
 *
 * Two write paths
 * ---------------
 *  1. **LLM path** — FusionRuntimeProvider intercepts `tool_use` events
 *     with `toolName === 'TodoWrite'` and calls `setTodos(sessionId,
 *     input.todos)`. This mirrors how free-code's TodoWriteTool updates
 *     appState.todos from inside the tool handler.
 *  2. **User path** — The right-rail panel exposes add/toggle/remove
 *     buttons that call into this store directly, so a user can start
 *     a list even before the model has produced one.
 *
 * Both paths end up in the same list; they don't conflict because the
 * LLM writes the full replacement and the user operations mutate only
 * the items they name.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  activeForm: string
  status: TodoStatus
}

interface TodosState {
  /** sessionId → ordered todo list. Empty/missing entry = no todos. */
  todos: Record<string, TodoItem[]>

  /**
   * Replace the whole list for a session. If every incoming item is
   * already completed, stores `[]` instead — same all-done collapse
   * rule as free-code's TodoWriteTool.call().
   */
  setTodos: (sessionId: string, todos: TodoItem[]) => void

  /** Cycle a single todo's status: pending → in_progress → completed → pending. */
  cycleStatus: (sessionId: string, index: number) => void

  /** Remove a todo by index (user path — tick-off / prune). */
  removeTodo: (sessionId: string, index: number) => void

  /** Drop the entire list for a session (e.g. on reset). */
  clearTodos: (sessionId: string) => void
}

/**
 * Turn an imperative content string into a present-continuous active
 * form, matching free-code's convention ("Run tests" → "Running tests").
 * Used as a fallback inside `extractTodoWriteItems` when the LLM hands
 * us a TodoWrite payload that omits `activeForm` on one of the items.
 */
function deriveActiveForm(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return ''
  // Split the first word off, try to -ing it.
  const space = trimmed.indexOf(' ')
  const verb = space === -1 ? trimmed : trimmed.slice(0, space)
  const rest = space === -1 ? '' : trimmed.slice(space)
  let gerund = verb
  if (/[^aeiou]e$/i.test(verb)) {
    // "make" → "making"
    gerund = verb.slice(0, -1) + 'ing'
  } else if (/[^aeiou][aeiou][^aeiouwxy]$/i.test(verb) && verb.length <= 5) {
    // "run" → "running", "sit" → "sitting" (double final consonant on
    // short CVC verbs). Capped at 5 chars so we don't mangle "listen".
    gerund = verb + verb.slice(-1) + 'ing'
  } else if (!/ing$/i.test(verb)) {
    gerund = verb + 'ing'
  }
  // Capitalize first letter to match the "Running tests" style.
  gerund = gerund.charAt(0).toUpperCase() + gerund.slice(1)
  return gerund + rest
}

const STATUS_CYCLE: Record<TodoStatus, TodoStatus> = {
  pending: 'in_progress',
  in_progress: 'completed',
  completed: 'pending'
}

export const useTodosStore = create<TodosState>((set) => ({
  todos: {},

  setTodos: (sessionId, incoming) =>
    set((s) => {
      const allDone =
        incoming.length > 0 && incoming.every((t) => t.status === 'completed')
      const next = allDone ? [] : incoming
      return { todos: { ...s.todos, [sessionId]: next } }
    }),

  cycleStatus: (sessionId, index) =>
    set((s) => {
      const existing = s.todos[sessionId]
      if (!existing || index < 0 || index >= existing.length) return s
      const next = existing.slice()
      next[index] = {
        ...next[index],
        status: STATUS_CYCLE[next[index].status]
      }
      return { todos: { ...s.todos, [sessionId]: next } }
    }),

  removeTodo: (sessionId, index) =>
    set((s) => {
      const existing = s.todos[sessionId]
      if (!existing || index < 0 || index >= existing.length) return s
      const next = existing.slice()
      next.splice(index, 1)
      return { todos: { ...s.todos, [sessionId]: next } }
    }),

  clearTodos: (sessionId) =>
    set((s) => {
      if (!s.todos[sessionId]) return s
      const next = { ...s.todos }
      delete next[sessionId]
      return { todos: next }
    })
}))

/**
 * Narrow-type check for a `TodoWrite` tool call payload. Used by the
 * runtime provider to decide whether to fan an incoming `tool_use`
 * into the todo store.
 *
 * The LLM hands us `{ todos: [{ content, activeForm, status }, ...] }`.
 * We validate each field before accepting — silently ignoring a
 * malformed payload is better than blowing up the UI.
 *
 * Partial tolerance
 * -----------------
 * When the `partial` flag is set, items missing one of the required
 * fields are SKIPPED instead of failing the whole payload. This is how
 * the streaming path feeds mid-flight `input_json_delta` fragments
 * into the panel: while the model is still writing an item's content,
 * that item appears with whatever fields it has so far; when the next
 * delta completes it, the lenient parse picks it up on the next tick.
 * Items with an empty `content` (just opened the object) are dropped,
 * not rendered as empty rows.
 */
export function extractTodoWriteItems(
  input: unknown,
  partial = false
): TodoItem[] | null {
  if (!input || typeof input !== 'object') return null
  const maybe = (input as { todos?: unknown }).todos
  if (!Array.isArray(maybe)) return partial ? [] : null
  const out: TodoItem[] = []
  for (const raw of maybe) {
    if (!raw || typeof raw !== 'object') {
      if (partial) continue
      return null
    }
    const r = raw as Record<string, unknown>
    const contentOk = typeof r.content === 'string' && r.content.length > 0
    const statusOk =
      r.status === 'pending' ||
      r.status === 'in_progress' ||
      r.status === 'completed'
    if (!contentOk || !statusOk) {
      if (partial) {
        // Keep the partially-built item visible only if we at least
        // have non-empty content. That way "opening brace, empty
        // string" never flickers as a blank row.
        if (contentOk) {
          out.push({
            content: r.content as string,
            activeForm:
              typeof r.activeForm === 'string' && r.activeForm.length > 0
                ? r.activeForm
                : deriveActiveForm(r.content as string),
            // Status not yet streamed — default to pending so the
            // row renders. Flicker to the real status as soon as
            // the next delta lands.
            status: statusOk ? (r.status as TodoStatus) : 'pending'
          })
        }
        continue
      }
      return null
    }
    const activeForm =
      typeof r.activeForm === 'string' && r.activeForm.length > 0
        ? r.activeForm
        : deriveActiveForm(r.content as string)
    out.push({
      content: r.content as string,
      activeForm,
      status: r.status as TodoStatus
    })
  }
  return out
}

/**
 * Lenient partial-JSON parser tuned for streaming tool args. The LLM
 * streams a tool call's input field by field, so on any given tick we
 * hold a half-open string like:
 *
 *   {"todos":[{"content":"Run tests","status":"in_pro
 *
 * JSON.parse rejects this outright. We close unclosed strings, arrays,
 * and objects greedily, then hand the result to JSON.parse and accept
 * whatever it produces. Failure returns null — callers should fall
 * back to their last known state rather than blanking the UI.
 *
 * The closer tracks:
 *   - whether we're inside a string (and whether the previous char
 *     was a backslash, so `"\""` counts as one escaped quote)
 *   - the stack of opened containers (`[` / `{`)
 *
 * After walking the input once we append the missing closers in
 * reverse order. Trailing commas and dangling `"key":` are handled by
 * trimming them off before closing.
 */
export function parsePartialToolArgs(text: string): unknown {
  if (!text) return null
  const len = text.length
  let inString = false
  let escape = false
  const stack: Array<'{' | '['> = []
  for (let i = 0; i < len; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') stack.push('{')
    else if (ch === '[') stack.push('[')
    else if (ch === '}' || ch === ']') stack.pop()
  }

  let closed = text
  if (inString) closed += '"'
  // Drop trailing whitespace + dangling separators so the resulting
  // JSON is well-formed. Has to run in a loop because stripping `,`
  // can reveal more whitespace or another separator.
  const tailStrip = /[\s,:]+$/
  closed = closed.replace(tailStrip, '')
  // After stripping we might have left something like `"content"` as
  // an object key with no value. Close with `:null` so the parser
  // accepts it.
  if (/"\s*$/.test(closed) && stack[stack.length - 1] === '{') {
    // Detect `"...":` vs bare `"..."` as a value.
    // If the last `"` was preceded by a `:` somewhere since the last
    // container open, it's a value — no fix needed. Otherwise assume
    // it was a key in progress and append `:null`.
    // Coarse heuristic: walk back to the nearest `{` or `,` and see if
    // a `:` appears before that closing `"`.
    let i = closed.length - 2
    let sawColon = false
    while (i >= 0) {
      const c = closed[i]
      if (c === ':') {
        sawColon = true
        break
      }
      if (c === '{' || c === ',') break
      i--
    }
    if (!sawColon) closed += ':null'
  }
  while (stack.length) {
    const top = stack.pop()
    closed += top === '{' ? '}' : ']'
  }
  try {
    return JSON.parse(closed)
  } catch {
    return null
  }
}
