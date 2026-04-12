import { useEffect, useState } from 'react'

import type { McpServerInfo, SessionMeta } from '../../../../shared/types'
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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  const servers = meta?.mcpServers ?? []
  const isEmpty = !loading && servers.length === 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="MCP servers"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="flex h-[60vh] max-h-[560px] w-[560px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#0e0e11] shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div>
            <div className="text-[14px] font-semibold text-zinc-100">
              MCP Servers
            </div>
            <div className="text-[11px] text-zinc-500">
              {loading
                ? 'Loading…'
                : isEmpty
                  ? 'No servers loaded yet'
                  : `${servers.length} server${servers.length === 1 ? '' : 's'}`}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-800/80 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && (
            <div className="px-3 py-4 text-[12.5px] text-zinc-500">
              Loading servers…
            </div>
          )}

          {isEmpty && (
            <div className="px-5 py-8 text-center text-[12.5px] text-zinc-500">
              <div className="mb-2 font-medium text-zinc-400">
                No MCP servers loaded yet
              </div>
              <div className="text-[11.5px] text-zinc-600">
                Send any message first to start fusion-code, then re-open
                <br />
                this dialog. Servers will populate from the session's first
                <br />
                <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[10.5px]">
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
                  <div className="flex items-center gap-3 rounded-md px-3 py-2 text-[13px] hover:bg-zinc-800/60">
                    <ServerStatusBadge status={server.status} />
                    <span className="truncate font-mono text-zinc-200">
                      {server.name}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950/60 px-5 py-2 text-[11px] text-zinc-500">
          <span>
            <Kbd>Esc</Kbd> close
          </span>
          {meta?.model && (
            <span className="truncate font-mono text-zinc-600">{meta.model}</span>
          )}
        </div>
      </div>
    </div>
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
      dot: 'bg-zinc-600',
      label: 'disconnected',
      text: 'text-zinc-500'
    },
    unknown: {
      dot: 'bg-zinc-600',
      label: 'unknown',
      text: 'text-zinc-500'
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

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
      {children}
    </kbd>
  )
}
