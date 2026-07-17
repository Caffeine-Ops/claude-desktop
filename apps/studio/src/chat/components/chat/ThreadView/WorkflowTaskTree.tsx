import type {
  WorkflowAgent,
  WorkflowPhaseInfo,
  WorkflowTask,
  WorkflowTaskStatus
} from '@desktop-shared/types'
import { useT } from '../../../i18n'

/* ──────────────── Workflow / Task live sub-agent tree ──────────────── */

/*
 * 从 ToolCallCard.tsx 抽出的独立文件（2026-07-07）：Workflow 脚本面板
 * （WorkflowScriptPanel）也要渲染同一棵实时任务树——工具卡片里是收纳
 * 视图，面板里是铺开视图，两处必须一个像素不差地同源。除搬家外零改动。
 */

/**
 * Live sub-agent list rendered inside a Task/Workflow tool card, styled
 * after Claude Code's terminal output: a `⎿` gutter, one row per spawned
 * agent (status glyph + name + right-aligned `tok · tool · elapsed`
 * metadata), with a header line summarising `done/total agents · total
 * elapsed`. Fed by the `task_update` event stream (see stores/chat.ts
 * `updateToolCallTasks`). Deliberately flat — an at-a-glance strip, not
 * a nested transcript.
 */
export function WorkflowTaskList({
  tasks
}: {
  tasks: WorkflowTask[]
}): React.JSX.Element {
  const t = useT()
  // Counting unit: a workflow task that carries a `workflow_progress`
  // snapshot counts its AGENTS (the "1/1 agents" it would otherwise show
  // is technically true but useless — the run may hold 8 of them); a
  // plain Task-tool subtask counts as itself. Both shapes share
  // status/durationMs, so one reduce covers the mix.
  const units = tasks.flatMap(
    (task): { status: WorkflowTask['status']; durationMs?: number }[] =>
      task.agents && task.agents.length > 0 ? task.agents : [task]
  )
  const done = units.filter(
    (u) =>
      u.status === 'completed' ||
      u.status === 'failed' ||
      u.status === 'stopped'
  ).length
  // Header elapsed = the longest single agent's elapsed (they run
  // concurrently, so summing would overstate wall-clock).
  const elapsedMs = units.reduce(
    (max, u) => Math.max(max, u.durationMs ?? 0),
    0
  )
  return (
    <div className="mt-1 border-l border-border/50 pl-3">
      <div className="flex items-center gap-2 pb-1.5 font-mono text-[11px] text-muted-foreground/70">
        <span className="tabular-nums">
          {done}/{units.length} {t('toolWorkflowAgentsLabel')}
        </span>
        {elapsedMs > 0 && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span className="tabular-nums">{formatWfDuration(elapsedMs)}</span>
          </>
        )}
      </div>
      <div className="space-y-1.5">
        {tasks.map((task) => (
          <WorkflowTaskRow key={task.taskId} task={task} />
        ))}
      </div>
    </div>
  )
}

/** One agent row: status glyph + name + right-aligned token/tool/elapsed
 * metadata, with an optional second line (progress summary / error) and
 * an expandable result block when the agent has completed. */
function WorkflowTaskRow({ task }: { task: WorkflowTask }): React.JSX.Element {
  const t = useT()
  const label =
    task.workflowName || task.description || task.subagentType || task.taskId
  const secondary = task.error || task.summary
  const meta = formatWfMeta(task)
  // Only completed tasks carry a meaningful deliverable to expand; while
  // running, `summary` (the live progress line) already shows above.
  const hasResult =
    task.status === 'completed' &&
    Boolean(task.result) &&
    task.result !== task.summary
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 font-mono text-[12px]">
        <WorkflowTaskGlyph status={task.status} />
        <span className="min-w-0 truncate font-medium text-foreground/90">
          {label}
        </span>
        {task.subagentType && task.subagentType !== label && (
          <span className="shrink-0 text-[10.5px] text-muted-foreground/40">
            {task.subagentType}
          </span>
        )}
        {meta && (
          <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-foreground/50">
            {meta}
          </span>
        )}
      </div>
      {secondary && (
        <div
          className={
            'pl-5 text-[11px] leading-snug ' +
            (task.error
              ? 'text-red-500/85'
              : 'line-clamp-2 text-muted-foreground/65')
          }
        >
          {secondary}
        </div>
      )}
      {task.agents && task.agents.length > 0 && (
        <WorkflowAgentTree phases={task.phases} agents={task.agents} />
      )}
      {hasResult && (
        <details className="group/wfres pl-5">
          <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 transition hover:text-muted-foreground">
            <span
              aria-hidden
              className="inline-block transition group-open/wfres:rotate-90"
            >
              ▸
            </span>
            {t('toolWorkflowResultLabel')}
          </summary>
          <div className="mt-1 whitespace-pre-wrap rounded-md bg-muted/30 p-2 text-[11.5px] leading-relaxed text-foreground/80">
            {task.result}
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * The phase → agent tree for a `local_workflow` run, fed by the
 * `workflow_progress` snapshots piggybacked on task_progress events.
 * Skeleton comes from the script's phase list, so phases the run hasn't
 * reached yet still show (as a bare title) — the user sees "4 stages,
 * we're in stage 2" at a glance. Agents attach to their phase by
 * `phaseIndex`; ones with an index no phase claims (defensive: the
 * snapshot is an internal CLI structure) collect in a trailing group.
 */
/**
 * Phase 分组算法，`WorkflowAgentTree`（本文件）与 `WorkflowAgentsView`
 * （多智能体详情面板）共用——两处对同一份 `workflow_progress` 快照分别做
 * 「收纳视图」与「铺开视图」，分组规则必须一个像素不差地同源（同
 * WorkflowTaskList 头部注释的同源纪律）。骨架来自脚本的 phase 列表，
 * 所以运行还没到达的 phase 仍会出现（只是 rows 为空）；agent 按
 * `phaseIndex` 认领，没有对应 phase 的（防御性：快照是内部 CLI 结构）
 * 落进按 index 排序的尾部分组。组内固定按 `.index`（spawn 顺序）排序。
 */
export function groupWfRowsByPhase<
  T extends { phaseIndex?: number; phaseTitle?: string; index: number }
>(
  phases: WorkflowPhaseInfo[] | undefined,
  items: T[]
): { key: number; title?: string; rows: T[] }[] {
  const byPhase = new Map<number, T[]>()
  for (const item of items) {
    const key = item.phaseIndex ?? 0
    const list = byPhase.get(key)
    if (list) list.push(item)
    else byPhase.set(key, [item])
  }
  const groups: { key: number; title?: string; rows: T[] }[] = []
  for (const phase of phases ?? []) {
    groups.push({
      key: phase.index,
      title: phase.title,
      rows: (byPhase.get(phase.index) ?? []).slice().sort((a, b) => a.index - b.index)
    })
    byPhase.delete(phase.index)
  }
  for (const [key, rest] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
    groups.push({
      key,
      title: rest[0]?.phaseTitle,
      rows: rest.slice().sort((a, b) => a.index - b.index)
    })
  }
  return groups
}

function WorkflowAgentTree({
  phases,
  agents
}: {
  phases?: WorkflowPhaseInfo[]
  agents: WorkflowAgent[]
}): React.JSX.Element {
  const groups = groupWfRowsByPhase(phases, agents)
  const showTitles = groups.length > 1 || Boolean(groups[0]?.title)
  return (
    <div className="space-y-1 pl-5 pt-0.5">
      {groups.map((group) => (
        <div key={group.key} className="space-y-0.5">
          {showTitles && group.title && (
            <div className="pt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/45">
              {group.title}
            </div>
          )}
          {group.rows.map((agent) => (
            <WorkflowAgentRow key={agent.index} agent={agent} />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * One agent() row: status glyph + label + right-aligned tok/tools/elapsed,
 * with a live second line — while running, the agent's most recent REAL
 * tool call ("WebSearch — GPT-5.6 release announcement"); before its
 * first tool call, the prompt preview; once done, the result preview.
 * This second line is the actual "what is this sub-agent doing right
 * now" the whole feature exists for.
 */
/** One agent()'s current one-line "what's happening" text: while running,
 * its most recent real tool call; before that, the prompt preview; once
 * settled, the result (or, if it failed with no result, the last tool's
 * summary). Shared by the compact row below and `WorkflowAgentsView`'s
 * detail panel so the two never disagree about "what is this doing". */
export function computeWfAgentActivity(agent: WorkflowAgent): string | undefined {
  if (agent.status === 'completed' || agent.status === 'stopped') {
    return agent.resultPreview
  }
  if (agent.status === 'failed') {
    return agent.resultPreview || agent.lastToolSummary
  }
  return (
    [agent.lastToolName, agent.lastToolSummary].filter(Boolean).join(' — ') ||
    agent.promptPreview
  )
}

function WorkflowAgentRow({
  agent
}: {
  agent: WorkflowAgent
}): React.JSX.Element {
  const activity = computeWfAgentActivity(agent)
  const meta = formatWfMeta({
    tokens: agent.tokens,
    toolUses: agent.toolCalls,
    durationMs: agent.durationMs
  })
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 font-mono text-[11.5px]">
        <WorkflowTaskGlyph status={agent.status} />
        <span className="min-w-0 truncate text-foreground/80">
          {agent.label}
        </span>
        {meta && (
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
            {meta}
          </span>
        )}
      </div>
      {activity && (
        <div
          className={
            'line-clamp-2 pl-5 text-[10.5px] leading-snug ' +
            (agent.status === 'failed'
              ? 'text-red-500/85'
              : 'text-muted-foreground/60')
          }
        >
          {activity}
        </div>
      )}
    </div>
  )
}

/** Right-aligned `27.2k tok · 1 tool · 16s` metadata for a task or
 * agent row (WorkflowAgent callers map their `toolCalls` onto
 * `toolUses`). Exported — `WorkflowAgentsView` reuses it verbatim so the
 * detail panel's metadata reads identically to the compact tree's. */
export function formatWfMeta(task: {
  tokens?: number
  toolUses?: number
  durationMs?: number
}): string {
  const bits: string[] = []
  if (typeof task.tokens === 'number' && task.tokens > 0) {
    bits.push(`${formatWfTokens(task.tokens)} tok`)
  }
  if (typeof task.toolUses === 'number' && task.toolUses > 0) {
    bits.push(`${task.toolUses} tool${task.toolUses === 1 ? '' : 's'}`)
  }
  if (typeof task.durationMs === 'number' && task.durationMs > 0) {
    bits.push(formatWfDuration(task.durationMs))
  }
  return bits.join(' · ')
}

/** 27200 → "27.2k", 950 → "950". */
export function formatWfTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/** 16000 → "16s", 95000 → "1m35s". */
export function formatWfDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}m` : `${m}m${rem}s`
}

/**
 * Monospace status glyph echoing Claude Code's terminal vocabulary:
 * `✔` done · `✗` failed · `⊘` stopped · `◐` (pulsing) running ·
 * `○` pending. Coloured per state; only the running glyph animates.
 */
export function WorkflowTaskGlyph({
  status
}: {
  status: WorkflowTask['status']
}): React.JSX.Element {
  const map = {
    completed: { glyph: '✔', cls: 'text-emerald-500' },
    failed: { glyph: '✗', cls: 'text-red-500' },
    stopped: { glyph: '⊘', cls: 'text-muted-foreground/60' },
    pending: { glyph: '○', cls: 'text-muted-foreground/40' },
    running: { glyph: '◐', cls: 'text-accent animate-pulse' }
  } as const
  const { glyph, cls } = map[status]
  return (
    <span aria-hidden className={'w-3 shrink-0 text-center ' + cls}>
      {glyph}
    </span>
  )
}

/**
 * One row in the flattened, UI-facing view of a workflow's units — the
 * shared shape `WorkflowAgentsView` (multi-agent detail panel) selects
 * and displays. Unifies the two shapes `task_update` can carry: a
 * `local_workflow` task's nested `WorkflowAgent[]` (the common case, rich
 * per-agent fields) and a plain Task-tool subtask with no nested agents
 * (itself the unit — `subagentType` stands in for `label`/model niceties
 * the wire protocol doesn't give plain subtasks).
 */
export interface WfRow {
  id: string
  index: number
  label: string
  status: WorkflowTaskStatus
  phaseIndex?: number
  phaseTitle?: string
  model?: string
  subagentType?: string
  promptPreview?: string
  resultText?: string
  error?: string
  /** Current one-line "what's happening" text — see computeWfAgentActivity. */
  activity?: string
  lastToolName?: string
  lastToolSummary?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
}

/** Flatten a tool call's `WorkflowTask[]` into `WfRow[]`. A task carrying
 * `agents` (local_workflow) expands into one row per agent; a plain task
 * (Task tool, no nested agents) becomes one row itself. Mixing both
 * shapes in the same call is not a real scenario today, but handling it
 * defensively costs nothing — the array traversal already covers it. */
export function buildWfRows(tasks: WorkflowTask[]): WfRow[] {
  const rows: WfRow[] = []
  tasks.forEach((task, taskIdx) => {
    if (task.agents && task.agents.length > 0) {
      for (const agent of task.agents) {
        rows.push({
          id: `${task.taskId}:${agent.index}`,
          index: agent.index,
          label: agent.label,
          status: agent.status,
          phaseIndex: agent.phaseIndex,
          phaseTitle: agent.phaseTitle,
          model: agent.model,
          promptPreview: agent.promptPreview,
          resultText: agent.resultPreview,
          activity: computeWfAgentActivity(agent),
          lastToolName: agent.lastToolName,
          lastToolSummary: agent.lastToolSummary,
          tokens: agent.tokens,
          toolCalls: agent.toolCalls,
          durationMs: agent.durationMs
        })
      }
    } else {
      rows.push({
        id: task.taskId,
        index: taskIdx,
        label: task.workflowName || task.description || task.subagentType || task.taskId,
        status: task.status,
        subagentType: task.subagentType,
        promptPreview: task.description,
        resultText: task.result,
        error: task.error,
        activity: task.error || task.summary,
        lastToolName: task.lastToolName,
        tokens: task.tokens,
        toolCalls: task.toolUses,
        durationMs: task.durationMs
      })
    }
  })
  return rows
}
