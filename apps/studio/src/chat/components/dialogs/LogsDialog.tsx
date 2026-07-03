import { useMemo, useState } from 'react'
import { DialogShell } from '@open-design/ui'

import { useT, useTFormat } from '../../i18n'
import { useDialogStore } from '../../stores/dialogs'
import { useLogsStore, type LogEntry } from '../../stores/logs'
import { useUiLogsStore, type UiLogEntry } from '../../stores/uiLogs'

/**
 * Which log channel the dialog is currently viewing. `engine` reads the
 * IPC-fed engine timeline; `ui` reads the renderer-side breadcrumb
 * trail (rename clicks, dialog opens, etc). The two stores stay
 * separate so neither side's "Clear" affects the other and the IPC
 * inflow path doesn't have to know about UI tagging.
 */
type LogChannel = 'engine' | 'ui'

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
  const t = useT()
  const tf = useTFormat()
  const open = useDialogStore((s) => s.open === 'logs')
  const close = useDialogStore((s) => s.closeDialog)
  const engineEntries = useLogsStore((s) => s.entries)
  const clearEngine = useLogsStore((s) => s.clear)
  const uiEntries = useUiLogsStore((s) => s.entries)
  const clearUi = useUiLogsStore((s) => s.clear)

  // Active tab. Default to engine because that's the existing behavior
  // and it's the one with cold-start latency answers.
  const [channel, setChannel] = useState<LogChannel>('engine')

  // Engine entries arrive shape-compatible already; UI entries lack the
  // optional `sessionId` field. Project both into a single TimelineRow
  // shape so the rendering grid stays one code path.
  const sourceEntries: ReadonlyArray<LogEntry | UiLogEntry> =
    channel === 'engine' ? engineEntries : uiEntries

  const rows = useMemo<TimelineRow[]>(() => {
    if (sourceEntries.length === 0) return []
    const first = sourceEntries[0]!.ts
    const out: TimelineRow[] = []
    for (let i = 0; i < sourceEntries.length; i++) {
      const e = sourceEntries[i]!
      const prev = i === 0 ? e : sourceEntries[i - 1]!
      out.push({
        id: e.id,
        ts: e.ts,
        fromStart: e.ts - first,
        deltaPrev: e.ts - prev.ts,
        label: e.label,
        sessionId:
          'sessionId' in e ? (e as LogEntry).sessionId : undefined,
        details: formatDetails(e.details)
      })
    }
    return out
  }, [sourceEntries])

  const activeCount = rows.length
  const clear = channel === 'engine' ? clearEngine : clearUi

  if (!open) return null

  return (
    <DialogShell
      label={t('logsDialogAria')}
      onClose={close}
      sizeClassName="h-[80vh] max-h-[900px] w-[900px] max-w-[calc(100vw-32px)]"
    >
        {/* Header — LogsDialog keeps its own bespoke header (title + tab
            switcher + Clear) rather than DialogShell.Header, which only
            covers the simple title/subtitle/✕ shape. The two-row layout
            keeps the title prominent with the channel tabs right below,
            like tabs in a browser dev panel. */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-foreground">
              {channel === 'engine' ? t('logsHeaderEngine') : t('logsHeaderUi')}
            </div>
            <div className="text-[11px] text-muted-foreground/80">
              {channel === 'engine'
                ? activeCount === 0
                  ? t('logsEngineEmpty')
                  : tf('logsEngineCount', { count: activeCount })
                : activeCount === 0
                  ? t('logsUiEmpty')
                  : tf('logsUiCount', { count: activeCount })}
            </div>
            <div className="mt-2 flex items-center gap-1">
              <TabButton
                active={channel === 'engine'}
                onClick={() => setChannel('engine')}
                count={engineEntries.length}
              >
                {t('logsTabEngine')}
              </TabButton>
              <TabButton
                active={channel === 'ui'}
                onClick={() => setChannel('ui')}
                count={uiEntries.length}
              >
                {t('logsTabUi')}
              </TabButton>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={clear}
              disabled={activeCount === 0}
              title={
                channel === 'engine'
                  ? t('logsClearTitleEngine')
                  : t('logsClearTitleUi')
              }
              className="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground/80 transition hover:border-input hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('logsClear')}
            </button>
            <button
              type="button"
              onClick={close}
              aria-label={t('logsClose')}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground/80 transition hover:bg-muted/80 hover:text-foreground"
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
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[12px] text-muted-foreground/80">
              <div className="font-medium text-muted-foreground">
                {t('logsEmptyTitle')}
              </div>
              <div className="whitespace-pre-line text-[11px] leading-relaxed text-muted-foreground/60">
                {t('logsEmptyHint')}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[auto_auto_auto_1fr] gap-x-3 px-4 py-2">
              <HeaderRow t={t} />
              {rows.map((r) => (
                <Row key={r.id} row={r} />
              ))}
            </div>
          )}
        </div>

        <DialogShell.Footer
          hint={t('logsFooterHint')}
          trailing={
            rows.length > 0
              ? tf('logsFooterSpan', {
                  span: formatMs(rows[rows.length - 1]!.fromStart)
                })
              : undefined
          }
        />
    </DialogShell>
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

/**
 * Pill-style tab toggle for the log channel switcher. Active tab gets a
 * solid bg + light text; inactive stays muted. The `count` chip lets
 * the user see at a glance whether the other channel has new events
 * worth checking even without switching to it.
 */
function TabButton({
  active,
  onClick,
  count,
  children
}: {
  active: boolean
  onClick: () => void
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium transition ' +
        (active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground/80')
      }
    >
      <span>{children}</span>
      <span
        className={
          'rounded px-1 text-[10px] tabular-nums ' +
          (active ? 'bg-secondary text-foreground' : 'bg-card text-muted-foreground/60')
        }
      >
        {count}
      </span>
    </button>
  )
}

function HeaderRow({
  t
}: {
  t: (key: import('../../i18n').StringKey) => string
}): React.JSX.Element {
  return (
    <>
      <div className="border-b border-border pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {t('logsColTime')}
      </div>
      <div className="border-b border-border pb-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {t('logsColDelta')}
      </div>
      <div className="border-b border-border pb-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {t('logsColFromStart')}
      </div>
      <div className="border-b border-border pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {t('logsColEvent')}
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
      <div className="py-0.5 text-muted-foreground/80">{formatClock(row.ts)}</div>
      <div
        className={
          'py-0.5 text-right tabular-nums ' +
          (slow ? 'font-semibold text-amber-300' : 'text-muted-foreground/60')
        }
      >
        {formatMs(row.deltaPrev)}
      </div>
      <div className="py-0.5 text-right tabular-nums text-muted-foreground/80">
        {formatMs(row.fromStart)}
      </div>
      <div className="py-0.5 text-foreground">
        <span className={labelColorClass(row.label)}>{row.label}</span>
        {row.details ? (
          <span className="ml-2 text-muted-foreground/80">{row.details}</span>
        ) : null}
        {row.sessionId ? (
          <span className="ml-2 text-muted-foreground/60">
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
  return 'text-foreground'
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
function formatDetails(
  details?: Record<string, unknown>
): string {
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
