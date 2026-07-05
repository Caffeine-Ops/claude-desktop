import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'

import type { WorkflowTask } from '@desktop-shared/types'
import { useI18n, useT, useToolLabel } from '../../../i18n'
import {
  useChatStore,
  useToolCallTasks,
  useToolCallTiming
} from '../../../stores/chat'
import { useComposerModeStore } from '../../../stores/composerMode'
import { usePermissionForToolUseId } from '../../../stores/permissions'
import { extractText, safeStringify } from '../toolHelpers'
import { friendlyToolView } from '../ToolFormatters'
import { InlinePermissionPrompt } from '../../permissions/InlinePermissionPrompt'
import { escapeHtml, languageFromPath } from './codeViewUtils'

/* ───────────────────── Tool-call card ──────────────────────── */

/**
 * Inline tool-call row in free-code's gutter style. Layout:
 *
 *     ⎿  Read  done
 *        │ Input
 *        │   { file_path: "..." }
 *        │ Output
 *        │   ...
 *
 * The leading `⎿` glyph is the gutter character (matches fusion-code
 * terminal's box-drawings light up-and-left for tool blocks). Color
 * is amber while the tool is running, dim when done. The whole block
 * is an inline `<details>` that expands during running and collapses
 * once the result lands, so finished tool calls don't visually crowd
 * the assistant text around them. The Input / Output sub-blocks are
 * indented under a thin left rule (`border-l`) to echo the gutter.
 *
 * Prop shape follows assistant-ui's `tools.Fallback` contract.
 */
type ToolFallbackProps = {
  toolName: string
  toolCallId: string
  args: unknown
  argsText?: string
  result?: unknown
  status?: {
    type: 'running' | 'requires-action' | 'complete' | 'incomplete'
    reason?: string
  }
}

/**
 * Heuristic error sniff on a settled tool result: the SDK surfaces tool
 * failures as text beginning with "Error" ("Error calling tool …",
 * "Error: ENOENT …"). Purely VISUAL — it flips the status badge / tool
 * name / output pane into the red error tone and never affects behavior,
 * so a false negative just means the old neutral rendering.
 */
function resultLooksError(result: unknown): boolean {
  if (result === undefined) return false
  const text = typeof result === 'string' ? result : extractText(result)
  return /^\s*Error(\b|:)/.test(text)
}

export function ToolCallCard(props: ToolFallbackProps): React.JSX.Element {
  const { toolName, toolCallId, args, argsText, result, status } = props
  const toolLabel = useToolLabel()
  const t = useT()
  const lang = useI18n((s) => s.lang)
  const running = status?.type === 'running' || status?.type === 'requires-action'
  // 入场动画只给「实时落进流」的卡：挂载瞬间还在 running = 流式新卡；挂载
  // 即已 settled = 历史恢复/切会话重挂载——那批卡齐播 0.38s 上浮，切换读
  // 起来就是整屏抖一下（2026-07-04 用户反馈，会话切换零动画方针）。
  // useRef 捕获首渲染值：卡片后续从 running 转 settled 不改变这个判定。
  const enteredLive = useRef(running).current
  // Look up any pending tool-permission request whose `toolUseId` matches
  // this card. When present we render an inline `InlinePermissionPrompt`
  // below the Input pane instead of the old fullscreen modal — one
  // prompt per tool call means parallel tool_use blocks all get their
  // own decision UI and the assistant never stalls waiting on a lost
  // sibling request. See stores/permissions.ts for the store shape.
  const pendingPermission = usePermissionForToolUseId(toolCallId)
  // Workflow/Task subagents spawned by THIS tool call (Task / Workflow
  // tools). Looked up by id from the chat store — same indirection as
  // the permission prompt above, since assistant-ui's Fallback props
  // don't carry the part's `tasks` field. Empty for ordinary tools.
  const subtasks = useToolCallTasks(toolCallId)
  // Per-tool elapsed timer (header, right-aligned). startedAt is stamped when
  // the tool call begins; endedAt when its result lands. ToolElapsed ticks live
  // while running and freezes on the final duration once endedAt exists.
  const { startedAt: toolStartedAt, endedAt: toolEndedAt } = useToolCallTiming(toolCallId)
  // AskUserQuestion is a special beast — its "args" are the questions
  // themselves and the InlinePermissionPrompt renders the dedicated
  // interactive view that lets the user pick answers. While that prompt
  // is pending, ANY static preview of the same questions above it is
  // pure duplication (the user sees the question list twice — once as a
  // read-only card, once as the live picker). So when AskUserQuestion is
  // pending we suppress not just the raw JSON Input pane but ALSO the
  // friendly headline + friendly input pane (the AskUserQuestion
  // formatter's question preview). After the user answers,
  // pendingPermission clears and the friendly summary comes back so the
  // resolved turn still shows what was asked.
  const askPending =
    pendingPermission !== null && toolName === 'AskUserQuestion'
  // In slides sessions the canvas's 问题 tab hosts the WHOLE AskUserQuestion
  // lifecycle — the streaming input preview AND the answerable form. So for
  // any AskUserQuestion call in a slides session, suppress this card's inline
  // surfaces entirely (input pane, friendly headline, inline prompt): the
  // canvas owns it. This covers the streaming phase too (pendingPermission is
  // still null then), which is why it keys off toolName, not askPending.
  // Outside slides sessions (no canvas) the inline prompt stays the only place
  // to answer. Subscribed (not getState) so flipping into slides mode re-renders.
  const cardSessionId = useChatStore((s) => s.sessionId)
  const cardIsSlides = useComposerModeStore((s) =>
    cardSessionId ? s.slidesSessions[cardSessionId] === true : false
  )
  const askHandledByCanvas =
    toolName === 'AskUserQuestion' && cardIsSlides
  // In slides sessions the canvas's 文件 tab shows the FULL written-file
  // content (and auto-focuses on each write), so the inline card's content
  // preview would just duplicate it. Suppress the friendly Content pane for
  // Write calls here — but keep the headline ("写入文件 total.md · 82 行"),
  // which is a useful one-line marker, not a duplicate of the canvas.
  // Outside slides sessions (no canvas) the inline preview stays the only
  // place to see what was written, so it's untouched.
  const writeHandledByCanvas = toolName === 'Write' && cardIsSlides
  const hideInputPane = askPending || askHandledByCanvas

  // Input-pane display logic — see the original prop-shape comment.
  const hasArgsText = typeof argsText === 'string' && argsText.length > 0
  const inputBody = running
    ? hasArgsText
      ? argsText!
      : '…'
    : safeStringify(args !== undefined ? args : argsText)

  // One-line preview shown next to the tool name while collapsed —
  // lets the user eyeball the call without expanding. `summarizeArgs`
  // picks the most informative scalar field (file_path / query /
  // command / pattern / url …) and falls back to "…" otherwise.
  const summary = summarizeArgs(args)

  // If this is a file-oriented tool (Read / Write / Edit / MultiEdit)
  // we know the result is source code and which language to highlight
  // it as from the `file_path` arg. For everything else (Bash, Grep,
  // Glob, WebFetch, …) we fall back to the original JsonView.
  const filePath = pickFilePath(args)
  const codeLanguage = filePath ? languageFromPath(filePath) : undefined
  const isCodeResult =
    filePath !== undefined &&
    (toolName === 'Read' ||
      toolName === 'Write' ||
      toolName === 'Edit' ||
      toolName === 'MultiEdit')

  // Friendly (human-readable) view, if the tool has a formatter. See
  // ToolFormatters.tsx for the per-tool rules. The formatter owns the
  // panes it sets; anything it leaves `undefined` falls through to the
  // raw JSON / CodeFileView default below, and explicit `null` hides
  // the pane entirely. Formatters gracefully return null when `args`
  // is still a streaming text blob (we don't memoize for the same
  // reason — args can mutate mid-stream).
  const friendly = friendlyToolView(toolName, {
    args,
    argsText,
    result,
    running,
    lang
  })

  // Decide what goes into the input slot.
  //   - friendly.input === undefined ⇒ default JSON pane (honouring
  //     hideInputPane from the AskUserQuestion special-case)
  //   - friendly.input === null      ⇒ no input pane at all
  //   - friendly.input === object    ⇒ friendly replacement
  // `writeHandledByCanvas` drops the friendly Content pane (the canvas 文件 tab
  // owns it); the headline above still renders.
  const useFriendlyInput = Boolean(friendly?.input) && !writeHandledByCanvas
  const hideDefaultInput =
    hideInputPane ||
    writeHandledByCanvas ||
    friendly?.input === null ||
    useFriendlyInput

  // Same semantics for the output slot, with the extra wrinkle that
  // the default output splits into CodeFileView vs JsonView based on
  // `isCodeResult`. Friendly formatters for Read leave `output`
  // undefined so Read's CodeFileView continues to render.
  const useFriendlyOutput = Boolean(friendly?.output)
  const hideDefaultOutput =
    friendly?.output === null || useFriendlyOutput || result === undefined

  // Slides-session AskUserQuestion is rendered entirely in the canvas's 问题
  // tab (streaming preview + answerable form), so this inline card — headline,
  // streaming JSON, prompt and all — would be a duplicate. Render nothing.
  // All hooks above have already run, so this early return is hook-safe.
  if (askHandledByCanvas) return <></>

  // Visual error tone (red badge / name / output pane). Heuristic on the
  // settled result text — see resultLooksError above.
  const failed = !running && resultLooksError(result)

  return (
    // tc-row-in 只在实时落卡时挂（enteredLive）：历史恢复/切会话的卡即时
    // 呈现，不重播入场（原先无条件挂类，切会话整屏卡片齐刷刷上浮）。
    <div className={(enteredLive ? 'tc-row-in ' : '') + 'w-full min-w-0'}>
      {/* tc-details animates expand/collapse height via ::details-content
          (see main.css) — the native <details> stays, no controlled state. */}
      {/* data-selectable：放开工具卡输出（命令输出 / diff 内容 / JSON / 搜索
          结果…）可复制。.chat-app 全局禁选之上，后代继承（见 main.css）；
          已标 select-none 的 diff 行号列 / ± 前缀符仍不进剪贴板（CSS 规则
          用 :not(.select-none) 排除）。头部短标签一并可选，无碍功能。 */}
      <details open={running} data-selectable="true" className="group/tool tc-details">
          {/* Compact tool header (DESIGN.md §4): a status badge, the tool
              label, and the most-informative arg (command / file / query)
              inline on the same row — no DONE pill, no gutter glyph.
              Mirrors the lightweight "已执行命令 ls -la" row in the
              reference design. The summary stays visible when expanded
              (it IS the headline), so we drop the old group-open hide. */}
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
            <StatusCheck running={running} error={failed} />
            <span
              className={
                'shrink-0 font-medium ' + (failed ? 'text-red-500' : 'text-foreground')
              }
            >
              {toolLabel(toolName)}
            </span>
            {summary && (
              <span
                className={
                  'min-w-0 truncate font-mono text-[12px] ' +
                  // Sweep-of-light on the args while the tool runs (same
                  // .shimmer-text the streaming verbs use) — settles back to
                  // plain muted text the moment the result lands.
                  (running ? 'shimmer-text' : 'text-muted-foreground')
                }
              >
                {summary}
              </span>
            )}
            <ToolElapsed
              startedAt={toolStartedAt}
              endedAt={toolEndedAt}
              running={running}
              className="ml-auto"
            />
            <span
              aria-hidden
              className="shrink-0 font-mono text-[10.5px] text-muted-foreground/50 transition-transform duration-200 group-open/tool:rotate-90"
            >
              ▾
            </span>
          </summary>

          <div className="mt-2 space-y-2 pl-[22px] text-[12px]">
            {/* While AskUserQuestion is pending, hide the static question
                preview (headline + friendly input) — the interactive
                InlinePermissionPrompt below already shows the questions,
                so rendering both duplicates the whole list. */}
            {!askPending && friendly?.headline && (
              <div className="text-[12.5px] leading-relaxed text-foreground/85">
                {friendly.headline}
              </div>
            )}

            {!askPending && useFriendlyInput && friendly?.input && (
              <ToolPane
                label={friendly.input.label}
                copyText={friendly.input.copyText}
              >
                {friendly.input.content}
              </ToolPane>
            )}

            {!hideDefaultInput && (
              <ToolPane label={t('toolPaneInputLabel')} copyText={inputBody}>
                <JsonView text={inputBody} maxHeight />
              </ToolPane>
            )}

            {pendingPermission && !askHandledByCanvas && (
              <InlinePermissionPrompt request={pendingPermission} />
            )}

            {subtasks.length > 0 && <WorkflowTaskList tasks={subtasks} />}

            {useFriendlyOutput && friendly?.output && (
              <ToolPane
                label={friendly.output.label}
                copyText={friendly.output.copyText}
                tone={failed ? 'error' : undefined}
              >
                {friendly.output.content}
              </ToolPane>
            )}

            {!hideDefaultOutput &&
              (isCodeResult ? (
                <ToolPane
                  label={t('toolPaneOutputLabel')}
                  copyText={extractText(result)}
                  tone={failed ? 'error' : undefined}
                >
                  <CodeFileView
                    text={extractText(result)}
                    language={codeLanguage}
                  />
                </ToolPane>
              ) : (
                <ToolPane
                  label={t('toolPaneOutputLabel')}
                  copyText={safeStringify(result)}
                  tone={failed ? 'error' : undefined}
                >
                  <JsonView text={safeStringify(result)} maxHeight />
                </ToolPane>
              ))}

            {/* Running placeholder — fills the otherwise-empty gap under a
                tool card while it executes and no output has streamed back
                yet. A pulsing accent dot + "正在执行…" with an animated
                ellipsis (pure-CSS .tool-loading-dots). Suppressed once any
                output lands (useFriendlyOutput / result), while a permission
                prompt is showing (the prompt IS the active surface), and
                for Task/Workflow cards that already render a live subtask
                list. */}
            {running &&
              result === undefined &&
              !useFriendlyOutput &&
              !pendingPermission &&
              subtasks.length === 0 && <ToolRunningHint />}
          </div>
      </details>
    </div>
  )
}

/**
 * Live sub-agent list rendered inside a Task/Workflow tool card, styled
 * after Claude Code's terminal output: a `⎿` gutter, one row per spawned
 * agent (status glyph + name + right-aligned `tok · tool · elapsed`
 * metadata), with a header line summarising `done/total agents · total
 * elapsed`. Fed by the `task_update` event stream (see stores/chat.ts
 * `updateToolCallTasks`). Deliberately flat — an at-a-glance strip, not
 * a nested transcript.
 */
function WorkflowTaskList({
  tasks
}: {
  tasks: WorkflowTask[]
}): React.JSX.Element {
  const t = useT()
  const done = tasks.filter(
    (task) =>
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'stopped'
  ).length
  // Header elapsed = the longest single agent's elapsed (they run
  // concurrently, so summing would overstate wall-clock).
  const elapsedMs = tasks.reduce(
    (max, task) => Math.max(max, task.durationMs ?? 0),
    0
  )
  return (
    <div className="mt-1 border-l border-border/50 pl-3">
      <div className="flex items-center gap-2 pb-1.5 font-mono text-[11px] text-muted-foreground/70">
        <span className="tabular-nums">
          {done}/{tasks.length} {t('toolWorkflowAgentsLabel')}
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

/** Right-aligned `27.2k tok · 1 tool · 16s` metadata for an agent row. */
function formatWfMeta(task: WorkflowTask): string {
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
function formatWfTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/** 16000 → "16s", 95000 → "1m35s". */
function formatWfDuration(ms: number): string {
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
function WorkflowTaskGlyph({
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
 * Ringed status check for the tool header — replaces the old
 * StatusDot + DONE-pill pair. Mirrors the reference design's leading
 * glyph: a hairline-ringed circle holding a ✓ when complete (emerald,
 * the macOS success green — DESIGN.md reserves blue for interactive
 * elements), and a pulsing accent-blue ring while the call runs. No
 * text pill: completion is now carried by the glyph alone, keeping the
 * header to a single quiet row.
 */
/**
 * ToolElapsed
 * -----------
 * Per-tool elapsed-time readout in the ToolCallCard header (the `166.5s`
 * the user asked for). Two phases:
 *
 *   - running  → a 100ms ticker re-renders the row so the readout climbs in
 *                tenths of a second; elapsed = now − startedAt.
 *   - finished → the interval is torn down and the readout freezes on
 *                endedAt − startedAt (the real duration), staying visible
 *                forever as a "this step took N seconds" trace.
 *
 * Renders nothing when `startedAt` is missing — old messages / replayed
 * history have no timestamp, and we don't want a bogus 0.0s on them.
 *
 * The ticker only runs while `running` (and only after mount), so finished
 * cards — which can be numerous in a long thread — carry zero timers.
 */
export function ToolElapsed({
  startedAt,
  endedAt,
  running,
  className
}: {
  startedAt: number | undefined
  endedAt: number | undefined
  running: boolean
  className?: string
}): React.JSX.Element | null {
  // Live ticker: only armed while the tool is running AND we know when it
  // started. Finished tools (endedAt present) never schedule an interval.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running || startedAt === undefined || endedAt !== undefined) return
    const id = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(id)
  }, [running, startedAt, endedAt])

  if (startedAt === undefined) return null

  // Frozen duration once ended; otherwise live since start. Clamp at 0 so a
  // tiny clock skew can't render a negative.
  const elapsedMs = Math.max(0, (endedAt ?? Date.now()) - startedAt)
  const label = `${(elapsedMs / 1000).toFixed(1)}s`
  const done = endedAt !== undefined

  return (
    <span
      className={
        'shrink-0 font-mono text-[11.5px] tabular-nums ' +
        (done ? 'text-muted-foreground/70' : 'text-accent') +
        (className ? ' ' + className : '')
      }
      aria-label={`耗时 ${label}`}
    >
      {label}
    </span>
  )
}

/**
 * Tool status badge, with the motion language landed from the prototype
 * (docs/tool-call-cards.html):
 *   - running → an accent ARC spinner (the old pulsing ring read as
 *     "stalled"; a moving arc reads as "in flight").
 *   - done    → emerald disc pops in, the check draws itself
 *     (stroke-dashoffset), a two-beat "landed" moment.
 *   - error   → red disc + drawn ✗ (see resultLooksError in ToolCallCard).
 * The pop/draw plays ONLY on a live running→settled transition, gated by
 * `sawRunning`: cards mounted already-settled (history restore paints
 * dozens at once) render the static final glyph — a synchronized mass pop
 * reads as a glitch, not delight.
 */
function StatusCheck({
  running,
  error
}: {
  running: boolean
  error?: boolean
}): React.JSX.Element {
  const sawRunning = useRef(running)
  if (running) sawRunning.current = true
  const animate = sawRunning.current && !running
  if (running) {
    return (
      <span aria-hidden className="relative size-[15px] shrink-0">
        <svg viewBox="0 0 15 15" className="absolute inset-0 size-full">
          <circle className="tc-spin" cx="7.5" cy="7.5" r="6" />
        </svg>
      </span>
    )
  }
  return (
    <span aria-hidden className="relative size-[15px] shrink-0">
      <svg viewBox="0 0 15 15" className="absolute inset-0 size-full">
        <circle
          className={(animate ? 'tc-pop ' : '') + (error ? 'fill-red-500' : 'fill-brand')}
          cx="7.5"
          cy="7.5"
          r="7.5"
        />
        {error ? (
          <path
            className={'tc-x' + (animate ? ' tc-draw' : '')}
            d="M5.2 5.2l4.6 4.6M9.8 5.2l-4.6 4.6"
          />
        ) : (
          <path
            className={'tc-k' + (animate ? ' tc-draw' : '')}
            d="M4.4 7.8l2.1 2.1 4.1-4.4"
          />
        )}
      </svg>
    </span>
  )
}

/**
 * Running placeholder for a tool card whose output hasn't streamed back
 * yet. A breathing accent dot + the localized "正在执行" verb + a
 * pure-CSS animated ellipsis (`.tool-loading-dots`). Mirrors the
 * waiting-state vocabulary of ThinkingSpinner / the AskUserQuestion
 * streaming hint, so a card in flight never reads as a blank gap. No
 * timer/state — the dot uses Tailwind's `animate-pulse` and the dots
 * run off a CSS keyframe, so this costs nothing on the main thread.
 */
function ToolRunningHint(): React.JSX.Element {
  const t = useT()
  return (
    <div
      className="flex items-center gap-2 py-0.5 text-[12px] text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden
        className="tc-breathe inline-block size-1.5 shrink-0 rounded-full bg-brand"
      />
      <span className="tool-loading-dots">{t('toolRunningHint')}</span>
    </div>
  )
}

function ToolPane({
  label,
  tone,
  children
}: {
  label: string
  /** Kept in the prop list for call-site compatibility but no longer
   *  rendered — the simplified pane dropped its per-box COPY button
   *  (see the reference design: a single bordered output frame with
   *  just a corner label, no copy affordance). */
  copyText?: string
  /** 'error' tints the frame red (failed tool's output pane) — border,
   *  wash and corner label all shift so the failure reads at a glance
   *  without opening the pane's content. */
  tone?: 'error'
  children: React.ReactNode
}): React.JSX.Element {
  // `min-w-0` on both the outer frame and the body wrapper lets the
  // pane shrink below its child <pre>'s intrinsic width — without it,
  // a single long unwrappable line would push the chat column wider
  // than its flex slot and steal pixels from the right rail on narrow
  // windows. The pre inside JsonView then owns the horizontal scroll.
  //
  // Simplified output frame (matches the reference design): a single
  // hairline-bordered card on the canvas — NOT the old two-tone
  // bg-muted/bg-card stack with a COPY button. The label floats in the
  // top-left as quiet mono micro-copy ("Response" / "输出"), the body
  // holds the raw content. No header strip, no copy button.
  return (
    <div
      className={
        'min-w-0 overflow-hidden rounded-apple-md border ' +
        (tone === 'error'
          ? 'border-red-500/30 bg-red-500/[0.05]'
          : 'border-border/60 bg-card/40')
      }
    >
      <div className="px-3 pt-2">
        <span
          className={
            'font-mono text-[10px] uppercase tracking-[0.08em] ' +
            (tone === 'error' ? 'text-red-500/80' : 'text-muted-foreground/70')
          }
        >
          {label}
        </span>
      </div>
      <div className="min-w-0 px-3 pb-2 pt-1">{children}</div>
    </div>
  )
}

/**
 * Lightweight JSON syntax highlighter. Walks a pretty-printed JSON
 * string with a single regex and wraps each token in a colored span.
 * No dependency on a prism / shiki bundle — the tool-call card
 * renders inline in every assistant message, so cheap & dependency-
 * free wins over the perfect highlight.
 *
 * Falls back to plain text if the input is empty or doesn't contain
 * obvious JSON markers (e.g. raw command output strings from Bash).
 */
function JsonView({
  text,
  maxHeight
}: {
  text: string
  maxHeight?: boolean
}): React.JSX.Element {
  if (!text) {
    return (
      <pre className="font-mono text-[11.5px] text-muted-foreground/60">
        (empty)
      </pre>
    )
  }
  const looksJson = /^[\s]*[\{\[]/.test(text)
  return (
    // `whitespace-pre` (no wrap) + `overflow-x-auto` so long lines
    // scroll horizontally inside the pane instead of forcing the
    // column wider. `max-w-full` + parent `min-w-0` (set on ToolPane)
    // is what keeps the chat column from bursting and stealing
    // pixels from the right rail on narrow windows. Vertical
    // scrolling is opt-in via `maxHeight` for paths where we want
    // to cap a giant tool result.
    <pre
      className={
        'max-w-full overflow-x-auto whitespace-pre font-mono text-[11.5px] leading-snug text-foreground/85 ' +
        (maxHeight
          ? 'max-h-80 overflow-y-auto pb-5 [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-28px),transparent_100%)]'
          : '')
      }
    >
      {looksJson ? highlightJson(text) : text}
    </pre>
  )
}

function highlightJson(src: string): React.ReactNode[] {
  // Single regex pulls out the four JSON token kinds plus runs of
  // structural / whitespace text in between. Order matters: strings
  // first so embedded `:`/`,` inside a string don't get mistaken for
  // structural tokens.
  const tokenRe =
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g
  const out: React.ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(src)) !== null) {
    if (m.index > last) {
      out.push(<span key={key++}>{src.slice(last, m.index)}</span>)
    }
    if (m[1] !== undefined) {
      // Quoted string. If immediately followed by `:`, it's a key.
      const isKey = m[2] !== undefined
      out.push(
        <span
          key={key++}
          className={isKey ? 'text-accent' : 'text-emerald-500'}
        >
          {m[1]}
        </span>
      )
      if (isKey) out.push(<span key={key++}>{m[2]}</span>)
    } else if (m[3] !== undefined) {
      out.push(
        <span key={key++} className="text-amber-400">
          {m[3]}
        </span>
      )
    } else if (m[4] !== undefined) {
      out.push(
        <span key={key++} className="text-sky-400">
          {m[4]}
        </span>
      )
    }
    last = tokenRe.lastIndex
  }
  if (last < src.length) {
    out.push(<span key={key++}>{src.slice(last)}</span>)
  }
  return out
}

/**
 * Pull a single representative scalar out of a tool-call args object
 * for the collapsed summary. Picks the first matching field from a
 * priority list, truncates to ~60 chars, and returns null if no
 * scalar is found (the summary is then omitted).
 */
function summarizeArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  // `subject` outranks `description` for the workflow-task tools
  // (TaskCreate / TaskUpdate): subject is the human one-liner ("生成两
  // 张新水墨图") while description is the technical how-to — showing
  // the latter in the header is exactly the noise a regular user
  // can't read.
  const keys = [
    'file_path',
    'path',
    'pattern',
    'query',
    'command',
    'cmd',
    'url',
    'name',
    'subject',
    'description'
  ]
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) {
      // Shell commands often open with setup links (`export VAR=… &&`,
      // `cd … &&`, bare env assignments) that eat the whole 60-char
      // budget before the substantive command appears. Peel them off —
      // this is display-only; the full command stays in copy/raw.
      const s =
        k === 'command' || k === 'cmd' ? stripCommandPrefixes(v) : v
      // File paths truncate from the LEFT: a deep absolute path cut at
      // 60 chars from the right shows only the useless machine prefix
      // ("/Users/…/Library/Mobile Documents/iCloud~md~ob…") — the
      // basename is the part a person actually recognizes.
      if (k === 'file_path' || k === 'path') return shortenPathTail(s)
      return s.length > 60 ? `${s.slice(0, 57)}…` : s
    }
    if (typeof v === 'number') return String(v)
  }
  return null
}

/** Shorten a filesystem path keeping its TAIL: basename plus as many
 *  parent segments as fit the ~60-char header budget, prefixed with
 *  "…/" when anything was dropped. */
function shortenPathTail(p: string): string {
  if (p.length <= 60) return p
  const segs = p.split('/').filter((s) => s.length > 0)
  let out = segs[segs.length - 1] ?? p
  for (let i = segs.length - 2; i >= 0; i--) {
    const cand = `${segs[i]}/${out}`
    if (cand.length > 56) break
    out = cand
  }
  // Whole path fit after all (only separators were dropped) — keep it.
  return out.length >= p.length - 2 ? p : `…/${out}`
}

/** Peel `export VAR=…`, bare `VAR=…` and `cd …` links off the front of
 *  a `&&` / `;` chain until a substantive command surfaces. Falls back
 *  to the original string if peeling would leave nothing. */
function stripCommandPrefixes(cmd: string): string {
  let body = cmd.trim()
  for (;;) {
    // Separator between links: `&&`, `;` — or a bare newline, which
    // multi-line heredoc-style commands use instead (`cd "…"\npython …`).
    const next = body
      .replace(
        /^export\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:&&|;|\n)\s*/,
        ''
      )
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '')
      .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\n)\s*/, '')
    if (next === body) break
    body = next
  }
  return body.length > 0 ? body : cmd.trim()
}

/* ───────────── Code-file output highlighting ────────────── */

/**
 * Pull `file_path` out of an arbitrary tool-args blob. Tools are
 * free-form JSON so we just poke at the conventional keys the
 * file-oriented tools use.
 */
function pickFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const obj = args as Record<string, unknown>
  const v = obj.file_path ?? obj.filePath ?? obj.path
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Parse Claude Code's `Read` output which is `cat -n` style:
 *     `     1\timport foo from 'bar'`
 *
 * Returns a `{ gutter, code }` pair with matching line counts so the
 * renderer can show them side-by-side. If the input doesn't match the
 * numbered format (Write/Edit output, raw files from other tools) we
 * generate sequential line numbers so every view looks consistent.
 */
function splitNumberedLines(text: string): {
  gutter: number[]
  code: string
} {
  const lines = text.split('\n')
  const gutter: number[] = []
  const codeLines: string[] = []
  let allNumbered = lines.length > 0
  for (const line of lines) {
    const m = /^\s*(\d+)\t(.*)$/.exec(line)
    if (!m) {
      allNumbered = false
      break
    }
    gutter.push(parseInt(m[1]!, 10))
    codeLines.push(m[2]!)
  }
  if (!allNumbered) {
    return {
      gutter: lines.map((_, i) => i + 1),
      code: text
    }
  }
  return { gutter, code: codeLines.join('\n') }
}

function CodeFileView({
  text,
  language
}: {
  text: string
  language: string | undefined
}): React.JSX.Element {
  const { gutter, code, html } = useMemo(() => {
    const { gutter: g, code: c } = splitNumberedLines(text)
    // highlight.js throws if you hand it an unregistered language, so
    // we check `getLanguage` first and otherwise fall back to
    // `highlightAuto` which scans for the best match across the
    // bundled set. `ignoreIllegals: true` keeps partial / mid-stream
    // snippets from tripping the highlighter.
    let rendered: string
    try {
      if (language && hljs.getLanguage(language)) {
        rendered = hljs.highlight(c, { language, ignoreIllegals: true }).value
      } else {
        rendered = hljs.highlightAuto(c).value
      }
    } catch {
      rendered = escapeHtml(c)
    }
    return { gutter: g, code: c, html: rendered }
  }, [text, language])

  if (!text) {
    return (
      <pre className="font-mono text-[11.5px] text-muted-foreground/60">
        (empty)
      </pre>
    )
  }

  return (
    // Vertical scroll + fade-out mask lives on the outer div so both
    // the line-number gutter and the code column share the exact same
    // viewport. `pb-6` leaves enough breathing room that the last line
    // of code stays fully legible once the user scrolls to the bottom —
    // only the trailing padding gets eaten by the mask.
    <div className="max-h-80 overflow-auto rounded-sm bg-card/20 pb-6 [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-32px),transparent_100%)]">
      <div className="flex font-mono text-[11.5px] leading-[1.55]">
        <pre
          aria-hidden
          className="select-none whitespace-pre py-1 pl-2 pr-3 text-right tabular-nums text-muted-foreground/50"
        >
          {gutter.join('\n')}
        </pre>
        <pre
          className="flex-1 overflow-x-auto whitespace-pre py-1 pr-3 text-foreground/90 [font-feature-settings:'calt','tnum'] [hyphens:none]"
          // hljs returns already-escaped HTML with <span class="hljs-*">
          // wrappers. These are the same class names our highlight.css
          // palette targets, so no extra theming needed here.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
  // `code` is only used for clipboard parity; suppressed here since
  // ToolPane's CopyButton uses the outer extractText() value.
  void code
}
