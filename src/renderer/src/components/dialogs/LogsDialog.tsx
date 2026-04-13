import { useEffect, useMemo } from 'react'

import { useDialogStore } from '../../stores/dialogs'
import { useLogsStore, type LogEntry } from '../../stores/logs'

/**
 * LogsDialog
 * ----------
 * A timeline of engine instrumentation breadcrumbs. Opened from the
 * header toolbar button, closed with Esc or click-outside.
 *
 * Each row is one `LogEntry` pushed from the main-process engine over
 * IPC (see `engine.ts:logEvent` and `ipc/register.ts`'s bridge). The
 * user's goal here is one question:
 *
 *     "Where did the ~30s of first-turn latency actually go?"
 *
 * So the dialog's only job is to make inter-event deltas obvious. We
 * render three time columns per row:
 *
 *   1. `Time` — absolute clock time (HH:MM:SS.mmm) so the user can
 *      correlate with anything happening outside the app.
 *   2. `Δ`    — ms since the previous entry. This is the most useful
 *      column — it turns "the list" into "a gantt chart in text".
 *   3. `T`    — ms since the first entry on screen. Lets you read
 *      "at the 15-second mark, the cli finally sent system init".
 *
 * Labels use the same colon/dash convention as the engine emits them
 * (`switchToSession:begin`, `ensureSessionReady:fresh`,
 * `systemInit:received`, `turn:firstChunk`, `turn:end`, …). Details
 * are flattened to a one-line `key=value` summary. No filters, no
 * grouping — pure raw dump. If it turns out we need filtering later,
 * it's a local `useState` away.
 *
 * Empty state: if the user opens the dialog before the engine has
 * emitted anything (fresh launch, no switch yet), we show a short
 * explainer pointing at the "send a message to trigger events".
 */
export function LogsDialog(): React.JSX.Element | null {
  const open = useDialogStore((s) => s.open === 'logs')
  const close = useDialogStore((s) => s.closeDialog)
  const entries = useLogsStore((s) => s.entries)
  const clear = useLogsStore((s) => s.clear)

  // Esc closes.
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

  // Precompute deltas + absolute-from-first offsets once per open. We
  // project into a view model so the render pass doesn't need to reach
  // back into the store for each row.
  const rows = useMemo<TimelineRow[]>(() => {
    if (entries.length === 0) return []
    const first = entries[0]!.ts
    const out: TimelineRow[] = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const prev = i === 0 ? e : entries[i - 1]!
      out.push({
        id: e.id,
        ts: e.ts,
        fromStart: e.ts - first,
        deltaPrev: e.ts - prev.ts,
        label: e.label,
        sessionId: e.sessionId,
        details: formatDetails(e.details)
      })
    }
    return out
  }, [entries])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Engine log timeline"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="flex h-[80vh] max-h-[900px] w-[900px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#0e0e11] shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div>
            <div className="text-[14px] font-semibold text-zinc-100">
              Engine timeline
            </div>
            <div className="text-[11px] text-zinc-500">
              {entries.length === 0
                ? 'No events yet — start a chat to record cli lifecycle'
                : `${entries.length} event${entries.length === 1 ? '' : 's'}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clear}
              disabled={entries.length === 0}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="flex size-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-800/80 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body — scrolling timeline. Column layout is a grid so
            timestamps don't drift out of alignment when labels have
            different widths. */}
        <div className="flex-1 overflow-y-auto font-mono text-[11.5px]">
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[12px] text-zinc-500">
              <div className="font-medium text-zinc-400">
                Timeline is empty
              </div>
              <div className="text-[11px] leading-relaxed text-zinc-600">
                Events arrive as the engine switches sessions and spawns the
                cli.
                <br />
                Pick a chat or send a message to start recording.
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[auto_auto_auto_1fr] gap-x-3 px-4 py-2">
              <HeaderRow />
              {rows.map((r) => (
                <Row key={r.id} row={r} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950/60 px-5 py-2 text-[11px] text-zinc-500">
          <span>
            <Kbd>Esc</Kbd> close · newest event at bottom · Δ = gap from
            previous event · T = offset from first event
          </span>
          <span className="font-mono text-zinc-600">
            {rows.length > 0
              ? `span ${formatMs(rows[rows.length - 1]!.fromStart)}`
              : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

interface TimelineRow {
  id: string
  ts: number
  fromStart: number
  deltaPrev: number
  label: string
  sessionId?: string
  details: string
}

function HeaderRow(): React.JSX.Element {
  return (
    <>
      <div className="border-b border-zinc-800 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
        Time
      </div>
      <div className="border-b border-zinc-800 pb-1 text-right text-[10px] uppercase tracking-wider text-zinc-600">
        Δ
      </div>
      <div className="border-b border-zinc-800 pb-1 text-right text-[10px] uppercase tracking-wider text-zinc-600">
        T
      </div>
      <div className="border-b border-zinc-800 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
        Event
      </div>
    </>
  )
}

function Row({ row }: { row: TimelineRow }): React.JSX.Element {
  // Highlight rows whose Δ is meaningful (>100ms) so the eye finds
  // the cold-start gaps immediately. Sub-100ms events are usually
  // synchronous glue and don't need emphasis.
  const slow = row.deltaPrev >= 100
  return (
    <>
      <div className="py-0.5 text-zinc-500">{formatClock(row.ts)}</div>
      <div
        className={
          'py-0.5 text-right tabular-nums ' +
          (slow ? 'font-semibold text-amber-300' : 'text-zinc-600')
        }
      >
        {formatMs(row.deltaPrev)}
      </div>
      <div className="py-0.5 text-right tabular-nums text-zinc-500">
        {formatMs(row.fromStart)}
      </div>
      <div className="py-0.5 text-zinc-200">
        <span className={labelColorClass(row.label)}>{row.label}</span>
        {row.details ? (
          <span className="ml-2 text-zinc-500">{row.details}</span>
        ) : null}
        {row.sessionId ? (
          <span className="ml-2 text-zinc-700">
            [{row.sessionId.slice(0, 8)}]
          </span>
        ) : null}
      </div>
    </>
  )
}

/**
 * Map event-label prefixes to a tint so the eye can scan categories.
 * Kept tiny — just enough contrast that "cli spawn" groups visually
 * separate from "turn run" and everything else stays neutral.
 */
function labelColorClass(label: string): string {
  if (label.startsWith('switchToSession')) return 'text-sky-300'
  if (label.startsWith('ensureSessionReady')) return 'text-violet-300'
  if (label.startsWith('openSession')) return 'text-violet-300'
  if (label.startsWith('systemInit')) return 'text-emerald-300'
  if (label.startsWith('teardown')) return 'text-rose-300'
  if (label.startsWith('send')) return 'text-amber-200'
  if (label.startsWith('turn')) return 'text-amber-200'
  return 'text-zinc-200'
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

/**
 * Compact millisecond formatter. <1s shows `NNNms`, 1-99s shows
 * `NN.Ns`, ≥100s shows `NNNs`. Keeps column width stable enough for
 * tabular-nums to align cleanly.
 */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 100) return `${s.toFixed(1)}s`
  return `${Math.round(s)}s`
}

/**
 * Flatten the free-form details bag to `k=v k=v` for inline display.
 * Keeps it readable in the single-line row — nested objects are
 * JSON-stringified, arrays are comma-joined.
 */
function formatDetails(details?: LogEntry['details']): string {
  if (!details) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined || v === null) continue
    let str: string
    if (typeof v === 'string') str = v
    else if (typeof v === 'number' || typeof v === 'boolean') str = String(v)
    else if (Array.isArray(v)) str = v.map((x) => String(x)).join(',')
    else str = JSON.stringify(v)
    // Trim long values so one runaway detail can't wreck row alignment.
    if (str.length > 60) str = str.slice(0, 57) + '…'
    parts.push(`${k}=${str}`)
  }
  return parts.join(' ')
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
      {children}
    </kbd>
  )
}
