import { extractText, getStringArg } from '../toolHelpers'
import { isObj, pick } from './helpers'
import { TodoStatusMark } from './sharedComponents'
import type { FormatterCtx, FriendlyView } from './types'

type TodoItem = {
  content: string
  status: string
  activeForm?: string
}

export function formatTodoWrite({
  args,
  lang
}: FormatterCtx): FriendlyView | null {
  if (!isObj(args) || !Array.isArray(args.todos)) return null
  const todos: TodoItem[] = args.todos
    .filter((t): t is Record<string, unknown> => isObj(t))
    .map((t) => ({
      content: typeof t.content === 'string' ? t.content : '',
      status: typeof t.status === 'string' ? t.status : 'pending',
      activeForm:
        typeof t.activeForm === 'string' ? t.activeForm : undefined
    }))

  const completed = todos.filter((t) => t.status === 'completed').length

  return {
    headline: (
      <span>
        {pick(lang, '更新任务清单', 'Update todos')}
        <span className="ml-1 text-muted-foreground/60">
          · {pick(lang, `${todos.length} 项`, `${todos.length} items`)}
          {completed > 0 &&
            ` · ${pick(lang, `已完成 ${completed}`, `${completed} done`)}`}
        </span>
      </span>
    ),
    input: {
      label: pick(lang, '任务', 'Todos'),
      content: (
        <ul className="space-y-1 text-[12px]">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-[3px] flex size-[12px] shrink-0 items-center justify-center">
                <TodoStatusMark status={t.status} />
              </span>
              <span
                className={
                  t.status === 'completed'
                    ? 'text-muted-foreground/60 line-through'
                    : t.status === 'in_progress'
                      ? 'text-accent'
                      : 'text-foreground/85'
                }
              >
                {t.status === 'in_progress' && t.activeForm
                  ? t.activeForm
                  : t.content}
              </span>
            </li>
          ))}
        </ul>
      ),
      copyText: todos
        .map(
          (t) =>
            `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`
        )
        .join('\n')
    },
    output: null
  }
}

type AskQuestion = {
  question: string
  header?: string
  options: { label: string; description?: string }[]
}

function parseAskUserQuestions(args: unknown): AskQuestion[] {
  if (!isObj(args) || !Array.isArray(args.questions)) return []
  const out: AskQuestion[] = []
  for (const q of args.questions) {
    if (!isObj(q) || typeof q.question !== 'string') continue
    if (!Array.isArray(q.options)) continue
    const options: AskQuestion['options'] = []
    for (const opt of q.options) {
      if (!isObj(opt) || typeof opt.label !== 'string') continue
      options.push({
        label: opt.label,
        description:
          typeof opt.description === 'string' && opt.description.length > 0
            ? opt.description
            : undefined
      })
    }
    if (options.length === 0) continue
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : undefined,
      options
    })
  }
  return out
}

function parseAskUserAnswers(args: unknown): Record<string, string> {
  if (!isObj(args) || !isObj(args.answers)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(args.answers)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Fallback: extract the answers from the tool result string. The tool's
 * `mapToolResultToToolResultBlockParam` formats the payload as
 *   `User has answered your questions: "Q1"="A1", "Q2"="A2". ...`
 * When the assistant-ui state doesn't echo the updated `answers` back
 * into `args`, this regex is our only source of truth for which option
 * the user actually picked.
 */
function parseAnswersFromResult(result: unknown): Record<string, string> {
  const text = extractText(result)
  if (!text) return {}
  const out: Record<string, string> = {}
  const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const q = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const a = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    out[q] = a
  }
  return out
}

export function formatAskUserQuestion({
  args,
  result,
  running,
  lang
}: FormatterCtx): FriendlyView | null {
  const questions = parseAskUserQuestions(args)
  if (questions.length === 0) return null
  // Prefer answers from `args` when the broker echoed them back; fall
  // back to scraping the tool result string (that's where AskUserQuestion
  // actually reports the picks in our current wiring).
  const answersFromArgs = parseAskUserAnswers(args)
  const answersFromResult = parseAnswersFromResult(result)
  const answers: Record<string, string> = { ...answersFromResult, ...answersFromArgs }
  const answered = Object.keys(answers).length
  const total = questions.length
  const allAnswered = answered === total && total > 0

  // Split a possibly-comma-separated answer (multiSelect) into the
  // individual picked labels so we can highlight every matching row.
  const pickedLabels = (questionText: string): Set<string> => {
    const raw = answers[questionText]
    if (!raw) return new Set()
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  }

  const headline = (
    <span className="text-foreground/85">
      {running && !allAnswered
        ? pick(lang, '等待你的回答', 'Waiting for your answer')
        : allAnswered
          ? pick(
              lang,
              total === 1 ? '已回答 1 个问题' : `已回答 ${total} 个问题`,
              total === 1 ? 'Answered 1 question' : `Answered ${total} questions`
            )
          : pick(
              lang,
              `${answered}/${total} 个问题已回答`,
              `${answered}/${total} questions answered`
            )}
    </span>
  )

  const content = (
    <div className="space-y-3">
      {questions.map((q, qi) => {
        const picks = pickedLabels(q.question)
        // 「其他」自由输入的答案不等于任何预设选项的 label——如果
        // 只按 label 匹配高亮，用户自己打的字会整个消失（四个选项
        // 全空心、又没有"未作答"兜底，历史事故）。这里把匹配不到
        // 选项的部分单独收出来，在选项列表末尾补一行回显。
        const labelSet = new Set(q.options.map((o) => o.label))
        const customPicks = [...picks].filter((p) => !labelSet.has(p))
        // multiSelect 的逗号拆分会把含逗号的自由文本拆碎；当整条
        // 回答都匹配不到选项时（纯自定义回答），直接展示原始字符
        // 串，保住用户输入里的逗号。
        const customText =
          customPicks.length === 0
            ? null
            : customPicks.length === picks.size
              ? (answers[q.question] ?? customPicks.join(', '))
              : customPicks.join(', ')
        return (
          <div
            key={qi}
            className="space-y-1.5 rounded-md border border-border/60 bg-card/60 p-2.5"
          >
            <div className="flex items-baseline gap-2">
              {q.header && (
                <span className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-[1px] text-[10px] font-medium text-muted-foreground">
                  {q.header}
                </span>
              )}
              <span className="text-[12.5px] leading-snug text-foreground/90">
                {q.question}
              </span>
            </div>
            <ul className="space-y-1 pl-0.5">
              {q.options.map((opt, oi) => {
                const selected = picks.has(opt.label)
                return (
                  <li
                    key={oi}
                    className={
                      'flex items-start gap-2 rounded-sm px-1.5 py-1 text-[12px] ' +
                      (selected
                        ? 'bg-emerald-500/10 text-foreground'
                        : 'text-foreground/70')
                    }
                  >
                    <span
                      aria-hidden
                      className={
                        'mt-[3px] flex size-[12px] shrink-0 items-center justify-center rounded-full border ' +
                        (selected
                          ? 'border-emerald-500 bg-emerald-500 text-white'
                          : 'border-muted-foreground/40')
                      }
                    >
                      {selected && (
                        <svg
                          width="8"
                          height="8"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={
                          selected
                            ? 'font-medium text-foreground'
                            : 'text-foreground/80'
                        }
                      >
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="ml-1.5 text-muted-foreground/75">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </li>
                )
              })}
              {customText !== null && (
                <li className="flex items-start gap-2 rounded-sm bg-emerald-500/10 px-1.5 py-1 text-[12px] text-foreground">
                  <span
                    aria-hidden
                    className="mt-[3px] flex size-[12px] shrink-0 items-center justify-center rounded-full border border-emerald-500 bg-emerald-500 text-white"
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="break-words font-medium text-foreground">
                      {customText}
                    </span>
                    <span className="ml-1.5 text-muted-foreground/75">
                      {pick(lang, '自定义回答', 'Custom answer')}
                    </span>
                  </span>
                </li>
              )}
              {picks.size === 0 && !running && (
                <li className="pl-5 text-[11px] italic text-muted-foreground/60">
                  {pick(lang, '未作答', 'No answer')}
                </li>
              )}
            </ul>
          </div>
        )
      })}
    </div>
  )

  const copyText = questions
    .map((q) => {
      const picked = answers[q.question]
      const head = q.header ? `[${q.header}] ` : ''
      const optsText = q.options
        .map((o) => `  - ${o.label}${o.description ? `: ${o.description}` : ''}`)
        .join('\n')
      return `${head}${q.question}\n${optsText}${picked ? `\n→ ${picked}` : ''}`
    })
    .join('\n\n')

  return {
    headline,
    input: {
      label: pick(lang, '询问', 'Questions'),
      content,
      copyText
    },
    // Tool result is just a "User has answered..." confirmation string —
    // the highlighted selections above already convey it.
    output: extractText(result).length > 0 ? null : undefined
  }
}

export function formatSkill({ args, lang }: FormatterCtx): FriendlyView | null {
  const skill = getStringArg(args, 'skill')
  if (!skill) return null
  const skillArgs = getStringArg(args, 'args')
  return {
    headline: (
      <span>
        {pick(lang, '调用技能', 'Launch skill')}{' '}
        <code className="font-mono text-[11.5px] text-accent">{skill}</code>
        {skillArgs && (
          <span className="ml-1 text-muted-foreground/60">
            · {pick(lang, '参数', 'args')}{' '}
            <code className="font-mono text-[11px]">{skillArgs}</code>
          </span>
        )}
      </span>
    ),
    input: null,
    // Skill's stdout is just a "Launching skill: X" confirmation line —
    // the headline already says that, so suppress it.
    output: null
  }
}
