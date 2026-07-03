import { formatBash } from './bash'
import { formatEdit, formatMultiEdit, formatRead, formatWrite } from './files'
import { formatAskUserQuestion, formatSkill, formatTodoWrite } from './interaction'
import { formatGlob, formatGrep } from './search'
import { formatTaskCreate, formatTaskStop, formatTaskUpdate } from './tasks'
import type { Formatter, FormatterCtx, FriendlyView } from './types'
import { formatToolSearch, formatWebFetch, formatWebSearch } from './web'

export type { FriendlyView, ToolPaneSpec } from './types'

/**
 * Entry point used by ToolCallCard. Swallows formatter errors so a bug
 * in a friendly renderer never crashes the whole card — the caller
 * falls through to the raw JSON view in that case.
 */
export function friendlyToolView(
  toolName: string,
  ctx: FormatterCtx
): FriendlyView | null {
  const fn = FORMATTERS[toolName]
  if (!fn) return null
  try {
    return fn(ctx)
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn(`[ToolFormatters] ${toolName} formatter threw`, err)
    }
    return null
  }
}

const FORMATTERS: Record<string, Formatter> = {
  Bash: formatBash,
  Read: formatRead,
  Write: formatWrite,
  Edit: formatEdit,
  MultiEdit: formatMultiEdit,
  Grep: formatGrep,
  Glob: formatGlob,
  WebFetch: formatWebFetch,
  WebSearch: formatWebSearch,
  ToolSearch: formatToolSearch,
  TodoWrite: formatTodoWrite,
  Skill: formatSkill,
  AskUserQuestion: formatAskUserQuestion,
  TaskCreate: formatTaskCreate,
  TaskUpdate: formatTaskUpdate,
  TaskStop: formatTaskStop
}
