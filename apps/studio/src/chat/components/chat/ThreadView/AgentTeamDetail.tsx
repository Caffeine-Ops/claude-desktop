import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react'

import { useT } from '../../../i18n'
import { useChatStore, useTeamMemberTasks } from '../../../stores/chat'
import { useAgentTeamStore } from '../../../stores/agentTeam'
import { resolveAgentPersona } from '../../../lib/agentPersona'
import { Button } from '@/src/components/ui/button'
import { AssistantMarkdown } from '../AssistantMarkdown'
import { AgentAvatar } from './AgentTeamBar'
import {
  buildWfRows,
  formatWfDuration,
  formatWfTokens,
  WorkflowTaskGlyph
} from './WorkflowTaskTree'
import { WfDetail } from './WorkflowAgentsView'

/** Loose content-part bag — same convention as stores/chat.ts's own
 * `ContentPart` (a discriminated union that's finicky to model exactly
 * against assistant-ui's types, so the whole codebase treats it as a
 * `{type, ...}` bag validated at read time instead). This is DATA off an
 * IPC round-trip, not a live assistant-ui message — there is no runtime
 * validator downstream to lean on, so every field access here goes
 * through an explicit `typeof` check. */
type LooseContentPart = { type: string; [key: string]: unknown }
type LooseMessage = { id?: string; role?: string; content?: unknown }

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready'
      messages: LooseMessage[]
      updatedAt?: number
      usage?: { inputTokens: number; outputTokens: number }
    }

/**
 * Full-takeover detail view for one team member — replaces the message
 * viewport (ThreadView keeps the agent-team bar and composer mounted
 * around it) while `useAgentTeamStore`'s selection is non-null. Fetches
 * the agent's REAL on-disk transcript via SUBAGENT_TRANSCRIPT_LOAD
 * (agentId + the foreground sessionId) rather than the `workflow_progress`
 * latest-only snapshot the bar/WorkflowAgentsView show — see
 * SubagentTranscript's header comment in sessionStore.ts for why that
 * snapshot alone can't carry a full history.
 *
 * Falls back to the snapshot-based `WfDetail` (borrowed from
 * WorkflowAgentsView) in two cases that have no transcript to fetch:
 * a row with no `agentId` yet (early snapshot, or a plain Task-tool row —
 * see WfRow's `agentId` comment), or a transcript fetch that failed.
 */
export function AgentTeamDetail(): React.JSX.Element | null {
  const t = useT()
  const selectedRowId = useAgentTeamStore((s) => s.selectedRowId)
  const clear = useAgentTeamStore((s) => s.clear)
  const sessionId = useChatStore((s) => s.sessionId)
  const tasks = useTeamMemberTasks()

  const rows = useMemo(() => buildWfRows(tasks), [tasks])
  const row = rows.find((r) => r.id === selectedRowId) ?? null

  // 防御性：选中的成员从 rows 里消失（正常不会发生——workflow 完成后
  // agents 快照只会累加不会缩短）就自动退出接管，回到主会话，而不是
  // 卡在一个渲染不出内容的空壳接管态。
  useEffect(() => {
    if (selectedRowId && !row) clear()
  }, [selectedRowId, row, clear])

  const [load, setLoad] = useState<LoadState>({ status: 'idle' })

  useEffect(() => {
    if (!row?.agentId || !sessionId) {
      setLoad({ status: 'idle' })
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    window.chatApi
      .loadSubagentTranscript({ sessionId, agentId: row.agentId })
      .then((res) => {
        if (cancelled) return
        setLoad({
          status: 'ready',
          messages: res.messages as unknown as LooseMessage[],
          updatedAt: res.updatedAt,
          usage: res.usage
        })
      })
      .catch((err) => {
        console.error('[AgentTeamDetail] loadSubagentTranscript failed:', err)
        if (!cancelled) setLoad({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [row?.agentId, sessionId])

  if (!row) return null

  const persona = resolveAgentPersona({
    subagentType: row.subagentType,
    label: row.label,
    phaseTitle: row.phaseTitle,
    identity: row.id
  })
  const useFallback = !row.agentId || load.status === 'error'
  const usage = load.status === 'ready' ? load.usage : undefined
  const updatedAt = load.status === 'ready' ? load.updatedAt : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border/55 bg-card/70 px-4 py-3 backdrop-blur-xl backdrop-saturate-150">
        <div className="flex min-w-0 items-center gap-2">
          <AgentAvatar persona={persona} sizeClassName="size-7" />
          <div className="min-w-0 truncate text-[14px] font-semibold text-foreground">
            {row.label}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10.5px] text-muted-foreground">
          {typeof updatedAt === 'number' && (
            <span>
              {t('agentTeamDetailUpdatedAt')} {new Date(updatedAt).toLocaleTimeString()}
            </span>
          )}
          {typeof row.toolCalls === 'number' && row.toolCalls > 0 && (
            <span>
              {t('agentTeamDetailToolCalls')} {row.toolCalls}
            </span>
          )}
          {usage && (
            <span>
              {t('agentTeamDetailTokensIO')} {formatWfTokens(usage.inputTokens)}/
              {formatWfTokens(usage.outputTokens)}
            </span>
          )}
          {typeof row.durationMs === 'number' && row.durationMs > 0 && (
            <span>{formatWfDuration(row.durationMs)}</span>
          )}
          <WorkflowTaskGlyph status={row.status} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {load.status === 'loading' && (
          <div className="flex items-center gap-2 py-8 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t('agentTeamDetailLoading')}
          </div>
        )}

        {useFallback && load.status !== 'loading' && (
          <>
            {load.status === 'error' && (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-600 dark:text-red-400">
                <AlertCircle className="size-3.5 shrink-0" />
                {t('agentTeamDetailLoadError')}
              </div>
            )}
            <WfDetail row={row} history={[]} />
          </>
        )}

        {load.status === 'ready' &&
          load.messages.map((msg, i) => (
            <TranscriptMessage key={msg.id ?? i} message={msg} />
          ))}
      </div>

      {/* 没有真实的 per-member mailbox（上游 teammate 后端在当前环境不可达
          ——见 2026-07-19 plan）：想跟某个成员说什么，直接用下方常驻的主
          composer 发（Composer + AgentTeamBar 在接管态下依旧挂载，见本文件
          头注释）——不另起一条输入行，避免用户误以为这是能单独私聊某个
          成员的独立信道。 */}
      <div className="shrink-0 border-t border-border/55 px-4 py-3">
        <Button variant="outline" className="w-full gap-2" onClick={clear}>
          <ArrowLeft className="size-3.5" />
          {t('agentTeamDetailBackToMain')}
        </Button>
      </div>
    </div>
  )
}

function TranscriptMessage({ message }: { message: LooseMessage }): React.JSX.Element | null {
  const parts = Array.isArray(message.content)
    ? (message.content as unknown[]).filter(
        (p): p is LooseContentPart => typeof p === 'object' && p !== null && 'type' in p
      )
    : []
  if (parts.length === 0) return null

  return (
    <div className="mb-4">
      {parts.map((part, i) => (
        <TranscriptPart key={i} part={part} />
      ))}
    </div>
  )
}

function TranscriptPart({ part }: { part: LooseContentPart }): React.JSX.Element | null {
  if (part.type === 'text' && typeof part.text === 'string') {
    return <AssistantMarkdown text={part.text} />
  }
  if (part.type === 'reasoning' && typeof part.text === 'string') {
    return (
      <div className="my-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-[12px] italic leading-relaxed text-muted-foreground">
        {part.text}
      </div>
    )
  }
  if (part.type === 'tool-call') {
    return <TranscriptToolCall part={part} />
  }
  if (part.type === 'image' && typeof part.image === 'string') {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={part.image}
          alt=""
          className="my-2 max-w-full rounded-md border border-border/50"
        />
      </>
    )
  }
  return null
}

/** Deliberately NOT the full ToolCallCard — that component is wired
 * through assistant-ui's Fallback props and a live tool-call store
 * lookup (useToolCallTasks/useToolCallTiming by toolUseId), neither of
 * which apply to a read-only array of past messages. A compact one-line
 * summary (tool name + a short args/result peek) covers what a transcript
 * reader actually needs here. */
function TranscriptToolCall({ part }: { part: LooseContentPart }): React.JSX.Element {
  const toolName = typeof part.toolName === 'string' ? part.toolName : 'tool'
  const argsText = safePreview(part.args)
  const resultText = safePreview(part.result)
  return (
    <div className="my-2 rounded-md border border-border/50 bg-muted/15 px-3 py-2">
      <div className="font-mono text-[11px] font-semibold text-foreground/80">{toolName}</div>
      {argsText && (
        <div className="mt-1 line-clamp-3 font-mono text-[10.5px] text-muted-foreground/80">
          {argsText}
        </div>
      )}
      {resultText && (
        <div className="mt-1 line-clamp-3 font-mono text-[10.5px] text-muted-foreground/60">
          → {resultText}
        </div>
      )}
    </div>
  )
}

function safePreview(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.slice(0, 300)
  try {
    return JSON.stringify(value).slice(0, 300)
  } catch {
    return null
  }
}
