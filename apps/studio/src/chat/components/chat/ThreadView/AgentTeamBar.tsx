import { useMemo, useState } from 'react'
import { Bot, ChevronDown, Loader2 } from 'lucide-react'

import { useT } from '../../../i18n'
import { useTeamMemberTasks } from '../../../stores/chat'
import { useAgentTeamStore } from '../../../stores/agentTeam'
import { resolveAgentPersona, type AgentPersona } from '../../../lib/agentPersona'
import { cn } from '@/src/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { buildWfRows, type WfRow } from './WorkflowTaskTree'

/**
 * The composer-dock "digital team" pill row (docs/ui-prototype reference:
 * 交付总监/工程师 chips + a mascot badge). Sits ABOVE the composer card,
 * mounted unconditionally in both Composer variants (`hero` and dock) —
 * it self-hides once `useTeamMemberTasks()` has nothing to show, so
 * there's no variant branch to keep in sync.
 *
 * Data source (2026-07-19 rework): ANY Task/Agent/Workflow tool call that
 * has spawned a subtask, not just `Workflow` calls — see
 * `useTeamMemberTasks`'s doc comment for why (upstream's real multi-process
 * "Agent Teams" backend isn't reachable in this build; this bar visualizes
 * the SAME plain-subagent/workflow machinery the app already had, just
 * without the old `toolName === 'Workflow'` blinder). Clicking a pill hands
 * off to `AgentTeamDetail` (the takeover view) via the `agentTeam` store;
 * this component owns no detail-rendering logic itself.
 *
 * Label text (2026-07-19, third pass): each pill shows the member's REAL
 * `row.label` (the model's own description, e.g. "查询黄金价格") — an
 * earlier version showed a fabricated persona name instead ("沈听澜" etc,
 * hashed client-side). The user rejected that outright ("这些智能体名称都
 * 有问题不要虚构"), and a live test had already shown why it doesn't work:
 * the model itself doesn't recognize a name it never assigned. Only the
 * avatar hue/icon stay hash-derived — that's non-textual decoration, not a
 * claim about identity.
 */
const MAX_VISIBLE_MEMBERS = 4

export function AgentTeamBar(): React.JSX.Element | null {
  const t = useT()
  const tasks = useTeamMemberTasks()
  const select = useAgentTeamStore((s) => s.select)
  const collapsed = useAgentTeamStore((s) => s.collapsed)
  const toggleCollapsed = useAgentTeamStore((s) => s.toggleCollapsed)

  const rows = useMemo(() => buildWfRows(tasks), [tasks])

  if (rows.length === 0) return null

  if (collapsed) {
    return (
      <div className="mb-2 flex items-center">
        <CollapsedBadge rows={rows} onExpand={toggleCollapsed} />
      </div>
    )
  }

  const visible = rows.slice(0, MAX_VISIBLE_MEMBERS)
  const overflow = rows.slice(MAX_VISIBLE_MEMBERS)

  return (
    <div className="mb-2 flex items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {visible.map((row) => (
          <AgentTeamPill key={row.id} row={row} onSelect={() => select(row.id)} />
        ))}
        {overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('agentTeamBarMore')}
                className="flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-border/55 bg-card/70 px-2.5 text-[11.5px] font-medium text-muted-foreground backdrop-blur-xl backdrop-saturate-150 transition-colors hover:bg-secondary/60"
              >
                +{overflow.length}
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {overflow.map((row) => {
                const persona = resolveAgentPersona({
                  subagentType: row.subagentType,
                  label: row.label,
                  phaseTitle: row.phaseTitle,
                  identity: row.id
                })
                return (
                  <DropdownMenuItem key={row.id} onSelect={() => select(row.id)}>
                    <persona.Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{row.label}</span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <button
          type="button"
          aria-label={t('agentTeamBarCollapse')}
          onClick={toggleCollapsed}
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/55 bg-card/70 text-muted-foreground backdrop-blur-xl backdrop-saturate-150 transition-colors hover:bg-secondary/60"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>
      {/* 纯装饰性吉祥物徽标——参考设计截图右下角的机器人小图标，不承载
          任何交互（点击面积特意不做，避免用户误以为它是个功能入口）。 */}
      <div
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/55 bg-card/70 text-muted-foreground backdrop-blur-xl backdrop-saturate-150"
      >
        <Bot className="size-4" />
      </div>
    </div>
  )
}

/** Collapsed state: overlapping avatar stack (first 3 members) + a total
 * count, all one click target that re-expands the bar. */
function CollapsedBadge({
  rows,
  onExpand
}: {
  rows: WfRow[]
  onExpand: () => void
}): React.JSX.Element {
  const t = useT()
  const stacked = rows.slice(0, 3)
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={t('agentTeamBarExpand')}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/55 bg-card/70 py-1 pl-1 pr-2.5 backdrop-blur-xl backdrop-saturate-150 transition-colors hover:bg-secondary/60"
    >
      <span className="flex shrink-0 items-center">
        {stacked.map((row, i) => {
          const persona = resolveAgentPersona({
            subagentType: row.subagentType,
            label: row.label,
            phaseTitle: row.phaseTitle,
            identity: row.id
          })
          return (
            <span key={row.id} className={i > 0 ? '-ml-2' : ''} style={{ zIndex: stacked.length - i }}>
              <AgentAvatar persona={persona} sizeClassName="size-6" ringClassName="ring-2 ring-card" />
            </span>
          )
        })}
      </span>
      <span className="text-[11.5px] font-medium text-foreground">{rows.length}</span>
      <ChevronDown className="size-3 shrink-0 -rotate-90 text-muted-foreground" />
    </button>
  )
}

/** Avatar circle: pre-generated headshot image when available, falling
 * back to the deterministic hue+Icon circle the moment the image 404s
 * (the `/team-avatars/` pool ships empty — see AgentPersona.avatarSrc's
 * doc comment). `useState` here, not a ref, so the fallback actually
 * re-renders the swapped content. */
export function AgentAvatar({
  persona,
  sizeClassName,
  ringClassName
}: {
  persona: AgentPersona
  sizeClassName: string
  ringClassName?: string
}): React.JSX.Element {
  const [imgFailed, setImgFailed] = useState(false)
  const Icon = persona.Icon
  if (imgFailed) {
    return (
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full text-white',
          sizeClassName,
          ringClassName
        )}
        style={{ backgroundColor: `hsl(${persona.avatarHue} 55% 45%)` }}
      >
        <Icon className="size-3.5" />
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={persona.avatarSrc}
      alt=""
      aria-hidden
      onError={() => setImgFailed(true)}
      className={cn('shrink-0 rounded-full object-cover', sizeClassName, ringClassName)}
    />
  )
}

function AgentTeamPill({
  row,
  onSelect
}: {
  row: WfRow
  onSelect: () => void
}): React.JSX.Element {
  const persona = resolveAgentPersona({
    subagentType: row.subagentType,
    label: row.label,
    phaseTitle: row.phaseTitle,
    identity: row.id
  })

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border/55 bg-card/70 py-1 pl-2 pr-2.5 backdrop-blur-xl backdrop-saturate-150 transition-colors hover:bg-secondary/60"
    >
      <AgentAvatar persona={persona} sizeClassName="size-7" />
      <span className="max-w-[10rem] truncate text-[12px] font-medium text-foreground">
        {row.label}
      </span>
      <StatusDot status={row.status} />
    </button>
  )
}

function StatusDot({ status }: { status: WfRow['status'] }): React.JSX.Element {
  if (status === 'running') {
    return <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-brand" />
  }
  const cls =
    status === 'completed'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-red-500'
        : 'bg-muted-foreground/40'
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', cls)} />
}
