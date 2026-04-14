import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { useWorkspaceStore } from '../../stores/workspace'
import { useT } from '../../i18n'

/**
 * Inline workspace switcher that sits above the composer dock. Replaces
 * the full-screen WorkspaceGate jump for mid-session switches — clicking
 * the pill opens a popover with the recent folders list plus a
 * "browse…" item that calls the native folder picker via IPC. Folder
 * drops are handled elsewhere (ThreadView global drop layer) so this
 * component is pure presentation + popover.
 *
 * Props
 * -----
 * - `onSwitch(path)` — parent-owned commit path. The pill only calls
 *   this with a resolved absolute path; the parent is responsible for
 *   wiping per-workspace stores and rebinding the engine cwd. Returning
 *   a promise lets the pill show a brief spinner during the IPC.
 * - `onDisconnect` — optional; hides the disconnect row when omitted.
 *   Currently unused by App.tsx but kept on the prop surface so a
 *   future "go back to gate" affordance can reuse the same popover.
 */
export function WorkspacePill({
  onSwitch,
  onDisconnect
}: {
  onSwitch: (path: string) => Promise<void> | void
  onDisconnect?: () => void
}): React.JSX.Element {
  const t = useT()
  const current = useWorkspaceStore((s) => s.current)
  const recent = useWorkspaceStore((s) => s.recent)
  // Store-owned switching state — set non-null by `switchTo` across
  // every entry point (pill, sidebar, drop layer, empty shell), so
  // the pill can show a single coherent loading state regardless of
  // which affordance triggered the commit. Local `busy` is gone.
  const switching = useWorkspaceStore((s) => s.switching)
  const busy = switching !== null
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click / Escape. Mounted only while the popover is
  // open so the listeners don't pay for the idle case.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Auto-collapse the popover the moment a switch lands. Without
  // this the popover stays open over the new (remounted) chat UI
  // until the user clicks elsewhere.
  useEffect(() => {
    if (busy) setOpen(false)
  }, [busy])

  const commit = useCallback(
    async (path: string) => {
      if (busy) return
      setError(null)
      try {
        await onSwitch(path)
        setOpen(false)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(
          msg.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
        )
      }
    },
    [busy, onSwitch]
  )

  const handleBrowse = useCallback(async () => {
    if (busy) return
    setError(null)
    try {
      const result = await window.chatApi.pickWorkspace()
      if (result.path) await commit(result.path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    }
  }, [busy, commit])

  const handleRecent = useCallback(
    (path: string) => {
      if (path === current) {
        setOpen(false)
        return
      }
      void commit(path)
    },
    [commit, current]
  )

  return (
    <div ref={rootRef} className="relative mx-auto mb-2 flex w-full max-w-3xl">
      <motion.button
        type="button"
        onClick={() => !busy && setOpen((v) => !v)}
        whileTap={busy ? undefined : { scale: 0.985 }}
        aria-expanded={open}
        aria-busy={busy}
        aria-label={t('workspacePillOpen')}
        disabled={busy}
        className={
          'group relative inline-flex max-w-full items-center gap-2 overflow-hidden rounded-full border px-3 py-1.5 text-[12px] shadow-sm backdrop-blur-sm transition-colors ' +
          (busy
            ? 'cursor-wait border-accent/60 bg-accent/10 text-foreground'
            : 'border-border/70 bg-card/70 text-muted-foreground hover:border-accent/50 hover:bg-card hover:text-foreground') +
          (open && !busy ? ' border-accent/60 text-foreground' : '')
        }
      >
        {/* Traveling shimmer — only visible while switching. A thin
            accent gradient slides across the pill on loop so even a
            fast IPC still reads as "something is happening". Pure
            visual; no layout impact. */}
        {busy && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-accent/25 to-transparent"
            initial={{ x: '-100%' }}
            animate={{ x: '100%' }}
            transition={{ duration: 1.3, repeat: Infinity, ease: 'linear' }}
          />
        )}
        <span
          className={
            'relative flex size-5 shrink-0 items-center justify-center rounded-md transition-colors ' +
            (busy
              ? 'bg-accent/25 text-accent'
              : 'bg-accent/15 text-accent group-hover:bg-accent/25')
          }
        >
          {busy ? (
            <Spinner />
          ) : (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
          )}
        </span>
        <AnimatePresence mode="wait" initial={false}>
          {busy ? (
            <motion.span
              key="busy"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="relative flex min-w-0 items-center gap-1.5"
            >
              <span className="shrink-0 font-medium text-foreground">
                {t('workspacePillSwitching')}
              </span>
              {switching && (
                <span className="truncate text-[11px] text-muted-foreground/90">
                  → {basename(switching)}
                </span>
              )}
              <BouncingDots />
            </motion.span>
          ) : (
            <motion.span
              key="idle"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="relative flex min-w-0 items-center gap-2"
            >
              <span className="truncate font-medium text-foreground/90">
                {current ? basename(current) : t('workspacePillEmpty')}
              </span>
              {current && (
                <span className="hidden shrink-0 truncate text-[11px] text-muted-foreground/70 md:inline">
                  {collapseHome(current)}
                </span>
              )}
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={
                  'ml-0.5 shrink-0 text-muted-foreground/60 transition-transform ' +
                  (open ? 'rotate-180 text-accent' : '')
                }
                aria-hidden
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="workspace-popover"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            role="menu"
            aria-label={t('workspacePillOpen')}
            className="absolute bottom-full left-0 z-40 mb-2 w-[320px] origin-bottom-left overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
          >
            {recent.length > 0 && (
              <div className="px-2 pt-2">
                <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                  {t('workspacePillRecent')}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {recent.map((path) => (
                    <li key={path}>
                      <button
                        type="button"
                        onClick={() => handleRecent(path)}
                        className={
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted ' +
                          (path === current
                            ? 'bg-accent/10 text-foreground'
                            : 'text-foreground/90')
                        }
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                          </svg>
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {basename(path)}
                          </div>
                          <div className="truncate text-[10.5px] text-muted-foreground/70">
                            {collapseHome(path)}
                          </div>
                        </div>
                        {path === current && (
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-accent">
                            {t('workspacePillCurrent')}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-col border-t border-border/60 p-2">
              <button
                type="button"
                onClick={handleBrowse}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-muted"
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-accent">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </span>
                {t('workspacePillBrowse')}
              </button>
              {onDisconnect && current && (
                <button
                  type="button"
                  onClick={() => {
                    onDisconnect()
                    setOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-red-400"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </span>
                  {t('workspacePillDisconnect')}
                </button>
              )}
            </div>
            {error && (
              <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
                {error}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const sep = trimmed.lastIndexOf('/') >= 0 ? '/' : '\\'
  const i = trimmed.lastIndexOf(sep)
  return i >= 0 ? trimmed.slice(i + 1) : trimmed
}

// `/Users/<name>/foo/bar` → `~/foo/bar`. Purely cosmetic shortening for
// the popover row labels — keeps long paths from blowing out the 320px
// popover width. No-op on Windows paths.
function collapseHome(p: string): string {
  const m = p.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/)
  if (m) return '~' + (m[1] ?? '')
  return p
}

function Spinner(): React.JSX.Element {
  return (
    <svg
      className="size-3 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.8" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Three-dot bounce — echoes the SessionLoadingOverlay language so
 * "switching workspace" and "opening session" feel like the same
 * family of loading indicators across the app. Intentionally tiny
 * (size-1 dots) to fit inside the pill without bumping its height.
 */
function BouncingDots(): React.JSX.Element {
  return (
    <span aria-hidden className="ml-0.5 flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-1 rounded-full bg-accent"
          animate={{ y: [0, -2, 0], opacity: [0.5, 1, 0.5] }}
          transition={{
            duration: 1,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.12
          }}
        />
      ))}
    </span>
  )
}
