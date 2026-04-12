import type {
  Unstable_DirectiveFormatter,
  Unstable_TriggerAdapter,
  Unstable_TriggerItem
} from '@assistant-ui/core'

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
 * Selection behavior is "insert directive": picking an item replaces
 * the `/<query>` token in the input with the command's label and
 * appends a trailing space, so the user can continue typing arguments.
 * This matches fusion-code's terminal `/` UX — picking a command does
 * NOT auto-submit; the user still has to press Enter to send.
 *
 * The actual submit/dispatch logic lives upstream:
 *   - Client commands → `FusionRuntimeProvider.matchSlashCommand` →
 *     opens a dialog
 *   - CLI commands    → fall through to `chatApi.send`, which routes
 *     the raw `/cmd` to fusion-code as a normal user prompt
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

export function buildSlashAdapter(
  sessionMeta: SessionMeta | null
): Unstable_TriggerAdapter {
  const items: Unstable_TriggerItem[] = []
  const seen = new Set<string>()

  // 1) Client commands — top of list, with custom descriptions.
  for (const cmd of CLIENT_COMMANDS) {
    items.push({
      id: `client-${cmd.name}`,
      type: 'slash',
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
      type: 'slash',
      label: `/${name}`,
      description: 'Built-in command'
    })
  }

  // IMPORTANT: empty `categories` forces the popover into search
  // mode immediately on `/`. With a non-empty array the primitive
  // would render a category picker first and the items render-prop
  // would never fire (`TriggerPopoverItems.js:13`).
  return {
    categories: () => [],
    categoryItems: () => items,
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

/**
 * Directive formatter for slash command insertion.
 *
 * `unstable_defaultDirectiveFormatter` from @assistant-ui/core
 * serializes items as `:type[label]{name=id}` — that's the mention
 * chip format used by `@`-mentions, not what we want for slash
 * commands. We want the literal command name (`/skill`) inserted
 * verbatim so the existing `matchSlashCommand` dispatch in
 * FusionRuntimeProvider keeps working.
 *
 * `parse` returns the entire string as a single text segment because
 * we never want any portion of the composer text to be re-rendered as
 * a "mention chip" — slash commands are plain text, full stop.
 */
export const slashFormatter: Unstable_DirectiveFormatter = {
  serialize: (item) => item.label,
  parse: (text) => (text ? [{ kind: 'text', text }] : [])
}
