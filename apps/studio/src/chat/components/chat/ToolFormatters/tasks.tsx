import { extractText, getStringArg } from '../toolHelpers'
import { isObj, pick, unescapeJsonString } from './helpers'
import type { FormatterCtx, FriendlyView } from './types'

/* ───────────── workflow-task tools (TaskCreate / TaskUpdate / …) ─────────────
 *
 * fusion-code tracks long jobs (ppt-master especially) through these
 * tools, so a slides run shows a steady stream of them. Their raw JSON
 * args are pure plumbing to a regular user — `subject` IS the human
 * line, `activeForm` / IDs / "Task #2 created successfully" boilerplate
 * are noise. Promote the subject, render the description as plain
 * wrapped prose (not a JSON pane), and only fall back to the raw
 * output pane when the result does NOT look like the usual success
 * boilerplate (that's the error case, which must stay visible).
 */

/** Pull the task id out of args regardless of key spelling — the SDK
 *  uses `taskId`, older shapes used `task_id` / `id`. */
export function taskIdArg(args: unknown): string | undefined {
  if (!isObj(args)) return undefined
  const v = args.taskId ?? args.task_id ?? args.id
  return typeof v === 'string' || typeof v === 'number'
    ? String(v)
    : undefined
}

export function formatTaskCreate({
  args,
  argsText,
  result,
  running,
  lang
}: FormatterCtx): FriendlyView | null {
  // While the call streams, `args` is still an unparsed text blob —
  // regex the subject out of `argsText` so the card shows the human
  // line immediately instead of flashing raw green JSON.
  let subject = getStringArg(args, 'subject')
  let description = getStringArg(args, 'description')
  if (!subject && typeof argsText === 'string') {
    const m = /"subject"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(argsText)
    if (m) subject = unescapeJsonString(m[1]!)
    const d = /"description"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(argsText)
    if (d) description = unescapeJsonString(d[1]!)
  }
  if (!subject) return null

  const resText = extractText(result).trim()
  const num = /task\s+#?(\d+)\s+created/i.exec(resText)?.[1]
  const resultIsBoilerplate =
    running || resText.length === 0 || /created successfully/i.test(resText)

  return {
    headline: (
      <span>
        {pick(lang, '新任务', 'New task')}{' '}
        <span className="font-medium text-foreground/90">{subject}</span>
        {num && (
          <span className="ml-1.5 text-[11px] text-muted-foreground/60">
            #{num}
          </span>
        )}
      </span>
    ),
    input: description
      ? {
          label: pick(lang, '任务说明', 'Details'),
          content: (
            <p className="max-w-full whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/80">
              {description}
            </p>
          ),
          copyText: description
        }
      : null,
    // Success boilerplate is already conveyed by the green check +
    // "#N" in the headline; anything else (error text) falls through
    // to the default output pane so failures stay visible.
    output: resultIsBoilerplate ? null : undefined
  }
}

export function formatTaskUpdate({
  args,
  result,
  running,
  lang
}: FormatterCtx): FriendlyView | null {
  const id = taskIdArg(args)
  if (!id) return null
  const status = getStringArg(args, 'status')
  const subject = getStringArg(args, 'subject')
  const description = getStringArg(args, 'description')

  const taskRef = pick(lang, `任务 #${id}`, `task #${id}`)
  let phrase: string
  switch (status) {
    case 'completed':
      phrase = pick(lang, `${taskRef} 已完成`, `Completed ${taskRef}`)
      break
    case 'in_progress':
      phrase = pick(lang, `开始执行${taskRef}`, `Started ${taskRef}`)
      break
    case 'pending':
      phrase = pick(lang, `${taskRef} 移回待办`, `Moved ${taskRef} back to pending`)
      break
    case 'cancelled':
    case 'canceled':
    case 'deleted':
      phrase = pick(lang, `${taskRef} 已取消`, `Cancelled ${taskRef}`)
      break
    default:
      phrase = pick(lang, `更新${taskRef}`, `Updated ${taskRef}`)
  }

  const resText = extractText(result).trim()
  const resultIsBoilerplate =
    running || resText.length === 0 || /updated successfully|^success/i.test(resText)

  return {
    headline: (
      <span>
        {phrase}
        {subject && (
          <span className="ml-1 text-muted-foreground/70">· {subject}</span>
        )}
      </span>
    ),
    input: description
      ? {
          label: pick(lang, '任务说明', 'Details'),
          content: (
            <p className="max-w-full whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/80">
              {description}
            </p>
          ),
          copyText: description
        }
      : null,
    output: resultIsBoilerplate ? null : undefined
  }
}

/* ───────────── TaskOutput (background shell / agent / remote-session poll) ─────────────
 *
 * Unlike TaskCreate/Update/Stop above (the todo-list task system), this
 * tool polls the OUTPUT of a background job — `{task_id, block, timeout}`
 * is pure plumbing to a regular user (an opaque id + a wait budget in
 * ms). The actual payload worth showing is the task's own output, which
 * lands in `result` and already renders through the default Output pane
 * — only the Input JSON needs replacing.
 */
export function formatTaskOutput({
  args,
  running,
  lang
}: FormatterCtx): FriendlyView | null {
  const id = taskIdArg(args)
  if (!id) return null
  const block = isObj(args) ? args.block !== false : true
  const taskRef = pick(lang, `任务 #${id}`, `task #${id}`)

  return {
    headline: (
      <span>
        {pick(lang, `查看${taskRef}的输出`, `Output of ${taskRef}`)}
        {running && block && (
          <span className="ml-1.5 text-[11px] text-muted-foreground/60">
            {pick(lang, '等待完成中…', 'waiting to finish…')}
          </span>
        )}
      </span>
    ),
    input: null,
    // Leave the default Output pane alone — it's the task's real
    // stdout/report, not noise.
    output: undefined
  }
}

export function formatTaskStop({
  args,
  result,
  running,
  lang
}: FormatterCtx): FriendlyView | null {
  const id = taskIdArg(args)
  if (!id) return null
  const resText = extractText(result).trim()
  const resultIsBoilerplate =
    running || resText.length === 0 || /stopped|cancelled|success/i.test(resText)
  return {
    headline: (
      <span>{pick(lang, `停止任务 #${id}`, `Stop task #${id}`)}</span>
    ),
    input: null,
    output: resultIsBoilerplate ? null : undefined
  }
}
