import { useEffect, useState } from 'react'
import { DialogShell } from '@/src/components/ui/dialog-shell'

import type { McpServerInfo, SessionMeta } from '@desktop-shared/types'
import { useDialogStore } from '../../stores/dialogs'

/**
 * McpDialog
 * ---------
 * Triggered by typing `/mcp` in the composer. Mirrors fusion-code's
 * terminal `/mcp` settings panel: a list of attached MCP servers with
 * their connection state.
 *
 * Data source is `SessionMeta.mcpServers`, populated lazily from the
 * `system init` SDK message on the first turn. Empty until then —
 * we show a "send a message first" placeholder in that case.
 *
 * Out of scope (intentionally) for the first cut:
 *   - Reconnect / enable / disable buttons (CLI subcommand `/mcp reconnect`)
 *   - Per-server tools list (CLI Enter-to-expand)
 *   - Scope grouping (project / user / local / enterprise)
 *
 * Those can be layered on without changing how the dialog opens.
 */
export function McpDialog(): React.JSX.Element | null {
  const open = useDialogStore((s) => s.open === 'mcp')
  const close = useDialogStore((s) => s.closeDialog)

  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.chatApi
      .getSessionMeta()
      .then(setMeta)
      .catch((err) => {
        console.error('[McpDialog] getSessionMeta failed', err)
      })
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const servers = meta?.mcpServers ?? []
  const isEmpty = !loading && servers.length === 0

  return (
    <DialogShell label="MCP servers" onClose={close}>
      <DialogShell.Header
        title="MCP Servers"
        subtitle={
          loading
            ? 'Loading…'
            : isEmpty
              ? 'No servers loaded yet'
              : `${servers.length} server${servers.length === 1 ? '' : 's'}`
        }
        onClose={close}
      />

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && (
          <div className="px-3 py-4 text-[12.5px] text-muted-foreground/80">
            Loading servers…
          </div>
        )}

        {isEmpty && (
          <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground/80">
            <div className="mb-2 font-medium text-muted-foreground">
              No MCP servers loaded yet
            </div>
            <div className="text-[11.5px] text-muted-foreground/60">
              Send any message first to start fusion-code, then re-open
              <br />
              this dialog. Servers will populate from the session's first
              <br />
              <code className="rounded bg-card px-1 py-0.5 font-mono text-[10.5px]">
                system init
              </code>{' '}
              message.
            </div>
          </div>
        )}

        {!loading && !isEmpty && (
          <ul className="space-y-0.5">
            {servers.map((server) => (
              <li key={server.name}>
                <div className="flex items-center gap-3 rounded-md px-3 py-2 text-[13px] hover:bg-hover/60">
                  <ServerStatusBadge status={server.status} />
                  <span className="truncate font-mono text-foreground">
                    {server.name}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DialogShell.Footer hint="close" trailing={meta?.model} />
    </DialogShell>
  )
}

/**
 * Color-coded dot + label for one MCP server's connection state.
 * Matches the fusion-code CLI's status icon vocabulary:
 *   connected   → emerald solid dot
 *   pending     → amber pulsing dot (still connecting)
 *   error       → red solid dot
 *   disconnected → grey solid dot
 *   unknown     → grey solid dot (status string didn't parse)
 */
function ServerStatusBadge({
  status
}: {
  status: McpServerInfo['status']
}): React.JSX.Element {
  const variants: Record<
    McpServerInfo['status'],
    { dot: string; label: string; text: string }
  > = {
    connected: {
      dot: 'bg-emerald-500',
      label: 'connected',
      text: 'text-emerald-400'
    },
    pending: {
      dot: 'bg-amber-400 animate-pulse',
      label: 'pending',
      text: 'text-amber-400'
    },
    error: {
      dot: 'bg-red-500',
      label: 'error',
      text: 'text-red-400'
    },
    disconnected: {
      dot: 'bg-muted-foreground/80',
      label: 'disconnected',
      text: 'text-muted-foreground/80'
    },
    unknown: {
      dot: 'bg-muted-foreground/80',
      label: 'unknown',
      text: 'text-muted-foreground/80'
    }
  }
  const v = variants[status]
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px]">
      <span className={`size-1.5 rounded-full ${v.dot}`} />
      <span className={`w-[78px] font-mono ${v.text}`}>{v.label}</span>
    </span>
  )
}
