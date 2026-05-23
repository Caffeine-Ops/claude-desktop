import type { SuggestionItem } from './suggestionPlugin'
import type { SuggestionAdapter } from './ProseMirrorComposerInput'

import type { SessionMeta } from '../../../shared/types'

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
  const items: SuggestionItem[] = []
  const seen = new Set<string>()

  // 1) Client commands — top of list, with custom descriptions.
  for (const cmd of CLIENT_COMMANDS) {
    items.push({
      id: `client-${cmd.name}`,
      value: `/${cmd.name}`,
      label: `/${cmd.name}`,
      description: cmd.description
    })
    seen.add(cmd.name)
    cmd.aliases?.forEach((a) => seen.add(a))
  }

  // 2) CLI commands from session meta.
  const fusionCmds = sessionMeta?.slashCommands ?? []
  for (const name of fusionCmds) {
    if (seen.has(name)) continue
    items.push({
      id: `fc-${name}`,
      value: `/${name}`,
      label: `/${name}`,
      description: 'Built-in command'
    })
  }

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
