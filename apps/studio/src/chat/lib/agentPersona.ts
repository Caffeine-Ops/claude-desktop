import {
  BookOpen,
  Cloud,
  Compass,
  Cpu,
  Layers,
  Palette,
  ShieldCheck,
  Wrench,
  type LucideIcon
} from 'lucide-react'

/**
 * Front-end-only avatar visuals for a workflow/team member — the wire
 * protocol (`WorkflowAgent`/`WorkflowTask`) has no persona field, only
 * `subagentType`/`label`/`model`. Deliberately covers ONLY non-textual,
 * purely decorative pixels (an avatar hue + icon): a made-up display
 * NAME was tried here first (2026-07-19) and reverted the same day — the
 * user rejected it outright ("这些智能体名称都有问题不要虚构"), and a live
 * test had already shown WHY it's a bad idea: the model itself doesn't
 * know the fabricated name and says so ("没找到叫清拓野的agent"). Every
 * caller must show the member's REAL `label`/description (from
 * `WfRow.label` — the model's own text, e.g. "查询黄金价格") as the
 * visible identifier, never anything generated here.
 *
 * Same identity → same avatar across every re-render/snapshot within a
 * run. Keyed off a stable `identity` string (callers pass `WfRow.id` —
 * unique for both nested `local_workflow` agents and plain Task/Agent
 * rows, see WorkflowTaskTree.tsx), NOT off mutable fields like `status`
 * or `lastToolName`.
 */

export interface AgentPersona {
  /** 0–359 hue for the avatar's background — deterministic, not user data. */
  avatarHue: number
  /** Deterministic pick from a pre-generated headshot pool (12 slots),
   * `/team-avatars/avatar-01.png` … `avatar-12.png`. The pool is empty by
   * default (no image assets shipped yet) — callers must render with an
   * `onError` fallback to the hue+Icon circle below; this field just
   * reserves a stable slot per identity so images can be dropped in
   * later with zero code changes. */
  avatarSrc: string
  /** Purely decorative pictogram — a coarse "what kind of task" hint
   * picked from `subagentType`/keyword sniffing, NOT a claimed job title.
   * Never render it next to text implying it's an authoritative role. */
  Icon: LucideIcon
}

/** Exact `subagentType` matches for the agent types this app actually
 * spawns (see the Agent tool's registry) — everything else falls
 * through to the namespace check below, then the generic default. */
const EXACT_ICONS: Record<string, LucideIcon> = {
  Explore: Compass,
  Plan: Layers,
  'general-purpose': Wrench,
  claude: Wrench,
  'code-reviewer': ShieldCheck,
  'claude-code-guide': BookOpen
}

/** Plugin agents are namespaced `plugin:name` (e.g. `codex:codex-rescue`,
 * `vercel:ai-architect`) — match on the prefix so new agents added to a
 * known plugin don't need a new entry here. */
const NAMESPACE_ICONS: Record<string, LucideIcon> = {
  codex: Cpu,
  vercel: Cloud,
  cloudflare: Cloud,
  impeccable: Palette
}

/** Cycled by a stable hash when nothing else identifies a shape — the
 * common case, since `local_workflow` agents (`agent()` calls inside a
 * Workflow script) carry only `label`/`model`, never `subagentType` (that
 * field belongs to the OTHER wire shape, a plain Task-tool subtask).
 * Deterministic, not meaningful in itself — purely visual variety. */
const ICON_CYCLE: LucideIcon[] = [Wrench, Compass, Layers, ShieldCheck]

/** Keyword hints scanned over `label`/`phaseTitle` for `local_workflow`
 * agents — best-effort, bilingual, case-insensitive. First match wins. */
const LABEL_KEYWORD_ICONS: [RegExp, LucideIcon][] = [
  [/调研|研究|探索|search|research|explore/i, Compass],
  [/架构|设计方案|规划|plan|architect|design/i, Layers],
  [/审核|评审|质检|校验|review|qa|verify/i, ShieldCheck],
  [/视觉|设计|design|ui|ux/i, Palette]
]

function resolveIcon(params: {
  subagentType?: string
  label?: string
  phaseTitle?: string
  cycleHash: number
}): LucideIcon {
  const { subagentType, label, phaseTitle, cycleHash } = params
  if (subagentType) {
    const exact = EXACT_ICONS[subagentType]
    if (exact) return exact
    const ns = subagentType.split(':')[0]
    const nsMatch = NAMESPACE_ICONS[ns]
    if (nsMatch) return nsMatch
  }
  const haystack = `${label ?? ''} ${phaseTitle ?? ''}`
  for (const [pattern, icon] of LABEL_KEYWORD_ICONS) {
    if (pattern.test(haystack)) return icon
  }
  return ICON_CYCLE[cycleHash % ICON_CYCLE.length]
}

/** djb2 — a tiny deterministic string hash, not a crypto primitive. Only
 * property that matters: same input always yields the same output. */
function hashString(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  return hash >>> 0
}

export function resolveAgentPersona(params: {
  subagentType?: string
  label?: string
  phaseTitle?: string
  /** Stable identity to hash the avatar off — pass `WfRow.id` (already
   * unique and stable across snapshots for both `local_workflow` nested
   * agents (`${taskId}:${agentIndex}`) and plain Task/Agent rows
   * (`taskId`), unlike a bare numeric index which only `local_workflow`
   * agents get a documented-stable one for). A raw number is still
   * accepted for legacy callers that only have an index. */
  identity: string | number
}): AgentPersona {
  const { subagentType, label, phaseTitle, identity } = params
  const identityStr = String(identity)

  // Two independent hashes so hue and icon-cycle position don't track
  // each other 1:1.
  const h1 = hashString(`persona-a-${identityStr}`)
  const h3 = hashString(`persona-c-${identityStr}`)

  const Icon = resolveIcon({ subagentType, label, phaseTitle, cycleHash: h3 })
  const avatarSlot = String((h1 % 12) + 1).padStart(2, '0')

  return {
    avatarHue: h1 % 360,
    avatarSrc: `/team-avatars/avatar-${avatarSlot}.png`,
    Icon
  }
}
