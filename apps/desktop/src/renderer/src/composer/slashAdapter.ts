import type { SuggestionItem } from './suggestionPlugin'
import type { SuggestionAdapter } from './ProseMirrorComposerInput'
import { findSkillChipSpec } from './skillChipRegistry'

import type { SessionMeta } from '../../../shared/types'

const GROUP_SKILL = '技能'
const GROUP_COMMAND = '命令'

/**
 * Slash command adapter for the composer's `/` autocomplete popover.
 *
 * Two sources, in priority order:
 *
 *   1. **Client commands** — hardcoded below. Handled inside the
 *      renderer once the user submits the inserted `/cmd` text:
 *      `FusionRuntimeProvider.onNew` matches them and opens the
 *      corresponding dialog (see `matchSlashCommand`).
 *
 *   2. **CLI commands** — pulled from cached `SessionMeta.slashCommands`
 *      (populated by fusion-code's `system init` SDK message). The SDK
 *      only gives us names, so we render a generic "Built-in command"
 *      description.
 *
 * Picking an item inserts a `slash` atom node carrying the literal
 * `/cmd` value, plus a trailing space (see `insertSuggestion`). The
 * doc serializes that node back to the verbatim `/cmd` string, so
 * `matchSlashCommand` downstream keeps working. Picking does NOT
 * auto-submit; the user still presses Enter to send.
 */

interface ClientCommand {
  name: string
  aliases?: readonly string[]
  description: string
}

const CLIENT_COMMANDS: readonly ClientCommand[] = [
  {
    name: 'skill',
    aliases: ['skills'],
    description: 'Show installed skills'
  },
  {
    name: 'mcp',
    description: 'Show MCP server status'
  }
]

export function buildSlashAdapter(sessionMeta: SessionMeta | null): SuggestionAdapter {
  // Collect into two buckets so the 「技能」 group (commands with a bespoke chip
  // icon — gpt-image-2 / ppt-master) floats to the top, and everything else
  // falls under 「命令」. The popover draws a heading whenever `group` changes
  // between consecutive items, so same-group entries MUST stay contiguous —
  // hence concatenating skills first, commands second.
  const skills: SuggestionItem[] = []
  const commands: SuggestionItem[] = []
  const seen = new Set<string>()

  const push = (item: Omit<SuggestionItem, 'group'>): void => {
    // A command with a registered chip spec is a "skill" surface; otherwise a
    // plain command. Lookup is by the literal value, same key the chip uses.
    if (findSkillChipSpec(item.value)) {
      skills.push({ ...item, group: GROUP_SKILL })
    } else {
      commands.push({ ...item, group: GROUP_COMMAND })
    }
  }

  // 1) Client commands — custom descriptions.
  for (const cmd of CLIENT_COMMANDS) {
    push({
      id: `client-${cmd.name}`,
      value: `/${cmd.name}`,
      label: `/${cmd.name}`,
      description: cmd.description
    })
    seen.add(cmd.name)
    cmd.aliases?.forEach((a) => seen.add(a))
  }

  // 2) CLI commands from session meta. The SDK's `system init` only gives
  // us names (no per-command help text), so we DON'T synthesize a filler
  // "Built-in command" line — an identical, meaningless subtitle on every
  // row just adds visual noise and doubles row height. We leave description
  // empty; the popover renders these as a single tidy name-only row.
  const fusionCmds = sessionMeta?.slashCommands ?? []
  for (const name of fusionCmds) {
    if (seen.has(name)) continue
    push({
      id: `fc-${name}`,
      value: `/${name}`,
      label: `/${name}`
    })
  }

  const items = [...skills, ...commands]

  return {
    search: (query) => {
      if (!query) return items
      const q = query.toLowerCase()
      return items.filter(
        (it) =>
          it.label.toLowerCase().includes(q) ||
          (it.description?.toLowerCase().includes(q) ?? false)
      )
    }
  }
}
