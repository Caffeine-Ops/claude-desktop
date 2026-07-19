import { useEffect, useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { AnimatePresence, motion } from 'motion/react'
import type { WorkflowTask, WorkflowTaskStatus } from '@desktop-shared/types'

import { useT } from '../../../i18n'
import { railGliderSpring } from '../../../shell/railMotion'
import { cn } from '@/src/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/src/components/ui/tooltip'
import { escapeHtml } from './codeViewUtils'
import {
  buildWfRows,
  formatWfDuration,
  formatWfMeta,
  formatWfTokens,
  groupWfRowsByPhase,
  WorkflowTaskGlyph,
  type WfRow
} from './WorkflowTaskTree'

/* ──────────────── Workflow multi-agent detail view (right tab) ──────────────── */

/**
 * The "多智能体视图" tab of WorkflowScriptPanel: a master/detail view over
 * the SAME `task_update` stream WorkflowTaskList renders as a compact
 * terminal strip (see that file's header comment on the shared data
 * source). Where the compact tree is an at-a-glance strip meant to sit
 * inside a tool card, this is the dedicated "watch every agent run" view
 * the tab exists for — an overview bar, a phase-grouped selectable list,
 * and a detail pane with the selected agent's prompt/metrics/activity/
 * result.
 *
 * `workflow_progress` is a LATEST-ONLY snapshot per agent (see engine.ts's
 * `parseWorkflowProgress` comment) — there is no wire history of every
 * tool call, only "the most recent one". The activity log below is
 * therefore reconstructed client-side by diffing successive snapshots: a
 * real, observed transition each time `lastToolName`/`lastToolSummary`
 * changes, NOT a fabricated complete timeline — two tool calls that both
 * land between two snapshots would only show the later one. That's an
 * honest sampling gap, not a bug to paper over with invented per-call
 * timestamps.
 */

interface ToolEvent {
  tool: string
  summary?: string
}

export function WorkflowAgentsView({
  tasks
}: {
  tasks: WorkflowTask[]
}): React.JSX.Element {
  const t = useT()
  const rows = useMemo(() => buildWfRows(tasks), [tasks])
  const phases = useMemo(
    () => tasks.find((tk) => tk.phases && tk.phases.length > 0)?.phases,
    [tasks]
  )
  const groups = useMemo(() => groupWfRowsByPhase(phases, rows), [phases, rows])
  const showPhaseTitles = groups.length > 1 || Boolean(groups[0]?.title)

  // 选中态：优先落在正在跑的那个 agent 上（"现在发生了什么"是这个视图存
  // 在的理由）；没有运行中的（全部落定/尚未开始）落第一个。选中目标若从
  // rows 里消失（防御性——正常不会发生）回落第一个。
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    setSelectedId((prev) => {
      if (prev && rows.some((r) => r.id === prev)) return prev
      return rows.find((r) => r.status === 'running')?.id ?? rows[0]?.id ?? null
    })
  }, [rows])

  // 活动记录累积：每次快照只报"最新一次工具调用"，这里把连续快照间
  // lastTool 真正变化的时刻串成一条记录。必须在 effect 里做（不能在渲染期
  // 塞副作用），且用 state 而非 ref——要让新条目触发重渲染。
  const [history, setHistory] = useState<Map<string, ToolEvent[]>>(new Map())
  useEffect(() => {
    setHistory((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const row of rows) {
        if (!row.lastToolName) continue
        const list = next.get(row.id) ?? []
        const last = list[list.length - 1]
        if (last && last.tool === row.lastToolName && last.summary === row.lastToolSummary) {
          continue
        }
        changed = true
        next.set(row.id, [...list, { tool: row.lastToolName, summary: row.lastToolSummary }])
      }
      return changed ? next : prev
    })
  }, [rows])

  const selected = rows.find((r) => r.id === selectedId) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WfOverview rows={rows} />
      <div className="flex min-h-0 flex-1">
        <div
          data-selectable="true"
          className="w-[228px] shrink-0 overflow-y-auto border-r border-border/55 px-2 py-2"
        >
          {groups.map((group, gi) => (
            <div key={group.key} className={gi > 0 ? 'mt-3' : undefined}>
              {showPhaseTitles && group.title && (
                <div className="flex items-center gap-1.5 px-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55">
                  <span className="truncate">{group.title}</span>
                  <span className="ml-auto shrink-0 tabular-nums normal-case tracking-normal">
                    {
                      group.rows.filter(
                        (r) =>
                          r.status === 'completed' ||
                          r.status === 'failed' ||
                          r.status === 'stopped'
                      ).length
                    }
                    /{group.rows.length}
                  </span>
                </div>
              )}
              <div className="space-y-0.5">
                {group.rows.map((row) => (
                  <WfRowButton
                    key={row.id}
                    row={row}
                    selected={row.id === selectedId}
                    onSelect={() => setSelectedId(row.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div data-selectable="true" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {selected ? (
              <motion.div
                key={selected.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ type: 'spring', bounce: 0, visualDuration: 0.2 }}
                className="px-5 py-4"
              >
                <WfDetail row={selected} history={history.get(selected.id) ?? []} />
              </motion.div>
            ) : (
              <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">
                {t('workflowAgentEmptyDetail')}
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

/** Overview strip: one progress segment per unit + aggregate metrics
 * (elapsed = longest single unit, since units run concurrently — summing
 * would overstate wall-clock, same convention as WorkflowTaskList's
 * header). */
function WfOverview({ rows }: { rows: WfRow[] }): React.JSX.Element {
  const t = useT()
  const done = rows.filter(
    (r) => r.status === 'completed' || r.status === 'failed' || r.status === 'stopped'
  ).length
  const elapsedMs = rows.reduce((max, r) => Math.max(max, r.durationMs ?? 0), 0)
  const tokens = rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
  const toolCalls = rows.reduce((sum, r) => sum + (r.toolCalls ?? 0), 0)

  return (
    <div className="flex shrink-0 items-center gap-6 border-b border-border/55 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-[11.5px] text-muted-foreground">
          <span className="tabular-nums">
            {done}/{rows.length} {t('toolWorkflowAgentsLabel')}
          </span>
        </div>
        <div className="flex gap-1">
          {rows.map((r) => (
            <span
              key={r.id}
              aria-hidden
              className={cn(
                'h-[5px] flex-1 rounded-full transition-colors duration-300',
                r.status === 'completed' && 'bg-emerald-500',
                r.status === 'failed' && 'bg-red-500',
                r.status === 'running' && 'bg-brand/70',
                r.status === 'pending' && 'bg-muted',
                r.status === 'stopped' && 'bg-muted-foreground/40'
              )}
            />
          ))}
        </div>
      </div>
      <div className="flex shrink-0 gap-5">
        {elapsedMs > 0 && (
          <WfOverviewMetric
            value={formatWfDuration(elapsedMs)}
            label={t('workflowAgentDurationLabel')}
          />
        )}
        {tokens > 0 && (
          <WfOverviewMetric value={formatWfTokens(tokens)} label={t('workflowAgentTokensLabel')} />
        )}
        {toolCalls > 0 && (
          <WfOverviewMetric value={String(toolCalls)} label={t('workflowAgentToolsLabel')} />
        )}
      </div>
    </div>
  )
}

function WfOverviewMetric({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div>
      <div className="font-mono text-[16px] font-semibold leading-none tabular-nums">{value}</div>
      <div className="mt-1 text-[10.5px] text-muted-foreground">{label}</div>
    </div>
  )
}

/** One selectable row in the left list. The selected state's fill is a
 * shared-layout `motion.span` (`layoutId`) — switching the selection
 * SLIDES the highlight from the old row to the new one instead of two
 * backgrounds blinking on/off, the same glider idiom as the app's rail
 * nav (see railMotion.ts). Safe to reuse one global layoutId here: only
 * one WorkflowAgentsView is ever mounted at a time (the panel is a
 * singleton), and the parent remounts this component (`key={shownId}`)
 * whenever the viewed call changes, so there's never a cross-call
 * collision to worry about. */
function WfRowButton({
  row,
  selected,
  onSelect
}: {
  row: WfRow
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  // WfRow 用 `toolCalls` 命名（对齐 WorkflowAgent），formatWfMeta 的参数
  // 形状用的是 `toolUses`（对齐 WorkflowTask）——两个上游类型这个字段名不
  // 一样，这里必须显式改名，直接传 row 会静默丢工具调用数（字段对不上，
  // 结构类型检查不报错，值却读不到）。
  const meta = formatWfMeta({
    tokens: row.tokens,
    toolUses: row.toolCalls,
    durationMs: row.durationMs
  })
  // 列表窄（228px），中文 agent 名很容易被截断到只剩一两个字——hover
  // tooltip 兜底显示全名。触发区是整行（trigger 包住整个 button），不是
  // 只有那截断的文字本身——否则用户得把鼠标精确停在那一两个字上才触发，
  // 体验上等于没有。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            'group relative isolate flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
            selected ? 'text-foreground' : 'text-foreground/75 hover:bg-secondary/60'
          )}
        >
          {selected && (
            <motion.span
              aria-hidden
              layoutId="workflow-agent-row-glider"
              transition={railGliderSpring}
              className="absolute inset-0 -z-[1] rounded-md bg-secondary"
            />
          )}
          <WorkflowTaskGlyph status={row.status} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{row.label}</span>
          {meta && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
              {meta}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{row.label}</TooltipContent>
    </Tooltip>
  )
}

/** Exported so `AgentTeamDetail` can reuse it as a snapshot-based fallback
 * when a row has no `agentId` (no transcript to fetch) or the transcript
 * fetch fails — same latest-only data this view has always shown, just
 * borrowed by the other surface instead of duplicated. */
export function WfDetail({ row, history }: { row: WfRow; history: ToolEvent[] }): React.JSX.Element {
  const t = useT()
  const metrics: { value: string; label: string }[] = []
  if (typeof row.tokens === 'number' && row.tokens > 0) {
    metrics.push({ value: formatWfTokens(row.tokens), label: t('workflowAgentTokensLabel') })
  }
  if (typeof row.toolCalls === 'number' && row.toolCalls > 0) {
    metrics.push({ value: String(row.toolCalls), label: t('workflowAgentToolsLabel') })
  }
  if (typeof row.durationMs === 'number' && row.durationMs > 0) {
    metrics.push({ value: formatWfDuration(row.durationMs), label: t('workflowAgentDurationLabel') })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          <WorkflowTaskGlyph status={row.status} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-snug text-foreground">{row.label}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <WfStatusBadge status={row.status} />
            {row.phaseTitle && <WfPlainBadge>{row.phaseTitle}</WfPlainBadge>}
            {row.subagentType && row.subagentType !== row.label && (
              <WfPlainBadge>{row.subagentType}</WfPlainBadge>
            )}
            {row.model && <WfPlainBadge>{row.model}</WfPlainBadge>}
          </div>
        </div>
      </div>

      {row.promptPreview && (
        <div className="rounded-md border border-border/55 bg-muted/25 px-3 py-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {t('workflowAgentPromptLabel')}
          </div>
          <div className="text-[12px] leading-relaxed text-muted-foreground">
            {row.promptPreview}
          </div>
        </div>
      )}

      {metrics.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {metrics.map((m) => (
            <div
              key={m.label}
              className="rounded-md border border-border/55 bg-muted/20 px-2.5 py-2"
            >
              <div className="font-mono text-[15px] font-semibold leading-none tabular-nums">
                {m.value}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">{m.label}</div>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
          {t('workflowAgentActivityLabel')}
        </div>
        {history.length > 0 ? (
          <WfActivityTimeline history={history} running={row.status === 'running'} />
        ) : (
          <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-[11.5px] text-muted-foreground">
            {t('workflowAgentNoActivityYet')}
          </div>
        )}
      </div>

      {(row.resultText || row.error) && (
        <div>
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {t('toolWorkflowResultLabel')}
          </div>
          <WfResultBlock
            text={row.error ? [row.error, row.resultText].filter(Boolean).join('\n\n') : row.resultText ?? ''}
            isError={Boolean(row.error)}
          />
        </div>
      )}
    </div>
  )
}

function WfStatusBadge({ status }: { status: WorkflowTaskStatus }): React.JSX.Element {
  const t = useT()
  const map: Record<WorkflowTaskStatus, { text: string; cls: string }> = {
    completed: {
      text: t('toolStatusDone'),
      cls: 'text-emerald-600 bg-emerald-500/12 dark:text-emerald-400'
    },
    failed: { text: t('toolStatusFailed'), cls: 'text-red-600 bg-red-500/12 dark:text-red-400' },
    stopped: { text: t('toolStatusStopped'), cls: 'text-muted-foreground bg-muted' },
    pending: { text: t('toolStatusPending'), cls: 'text-muted-foreground bg-muted' },
    running: { text: t('toolStatusRunning'), cls: 'text-brand bg-brand/12' }
  }
  const { text, cls } = map[status]
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium', cls)}>{text}</span>
  )
}

function WfPlainBadge({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
      {children}
    </span>
  )
}

/** Ordered log of observed tool-call transitions (see the file header
 * comment on why this isn't a complete backend timeline). The dot+rail
 * connector is plain flex layout (not absolutely-positioned dots on a
 * border line) so it holds up regardless of how many lines a summary
 * wraps to. */
function WfActivityTimeline({
  history,
  running
}: {
  history: ToolEvent[]
  running: boolean
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="space-y-0">
      {history.map((ev, i) => {
        const isLive = i === history.length - 1 && running
        return (
          <div key={i} className="flex gap-2">
            <div className="flex w-3 shrink-0 flex-col items-center pt-1.5">
              <span
                aria-hidden
                className={cn(
                  'size-[6px] shrink-0 rounded-full',
                  isLive ? 'bg-brand animate-pulse' : 'bg-muted-foreground/50'
                )}
              />
              {i < history.length - 1 && (
                <span aria-hidden className="mt-1 w-px flex-1 bg-border/60" />
              )}
            </div>
            <div className="min-w-0 flex-1 pb-2.5">
              <div className="flex items-baseline gap-2 font-mono text-[11.5px]">
                <span className="font-semibold text-foreground/85">{ev.tool}</span>
                {isLive && <span className="text-[10px] text-brand">{t('toolRunningHint')}</span>}
              </div>
              {ev.summary && (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/75">
                  {ev.summary}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Result / error block. `resultPreview`/`result` are free text, not
 * guaranteed JSON — best-effort JSON.parse + pretty-print + hljs
 * highlight when it round-trips, plain escaped text otherwise. Never
 * fabricates structure the payload doesn't have. */
function WfResultBlock({ text, isError }: { text: string; isError: boolean }): React.JSX.Element {
  const html = useMemo(() => {
    const trimmed = text.trim()
    if (!trimmed) return ''
    try {
      const pretty = JSON.stringify(JSON.parse(trimmed), null, 2)
      return hljs.highlight(pretty, { language: 'json', ignoreIllegals: true }).value
    } catch {
      return escapeHtml(text)
    }
  }, [text])
  return (
    <pre
      className={cn(
        'overflow-x-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2 font-mono text-[11.5px] leading-relaxed',
        isError
          ? 'border-red-500/25 bg-red-500/[0.06] text-red-600 dark:text-red-400'
          : 'border-border/55 bg-muted/20 text-foreground/85'
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
