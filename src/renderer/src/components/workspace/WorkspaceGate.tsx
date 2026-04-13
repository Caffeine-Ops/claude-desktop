import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { useT } from '../../i18n'

/**
 * First-run workspace picker.
 *
 * Shown whenever `window.chatApi.getWorkspace()` returns `{ path: null }`,
 * which is the cold-start default on every new main-process lifetime.
 * The user drags a folder onto the window; we resolve it to an absolute
 * path via preload's `pathForFile` (Electron 33's webUtils bridge),
 * hand it to main over the WORKSPACE_SET IPC, and then call `onReady`
 * so App.tsx can swap this component out for the real chat UI.
 *
 * Why a drag-drop gate and not a native `dialog.showOpenDialog`:
 *  1. matches the "drop a folder on the window" product brief
 *  2. one fewer main↔renderer round-trip for the common flow
 *  3. lets us preventDefault global dragover to stop the renderer from
 *     navigating away if the user misses the drop zone
 *
 * Once the drop is accepted, this component unmounts. The sidebar's
 * workspace row can re-mount the gate later for a mid-session switch:
 * the engine soft-tears its live fusion-code child and `setWorkspace()`
 * rebinds the cwd in place, so no app restart is needed.
 */
export function WorkspaceGate({
  onReady
}: {
  onReady: (path: string) => void
}): React.JSX.Element {
  const t = useT()
  const [draggingOver, setDraggingOver] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Globally block the default drag/drop behavior so a misplaced drop
  // doesn't cause the Chromium renderer to navigate to `file://…`,
  // which would unload the app. We only install these while the gate
  // is mounted — the composer's own AttachmentDropzone wants normal
  // image-drop behavior once the gate is gone.
  useEffect(() => {
    const block = (e: DragEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDraggingOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent): void => {
    // Only clear the highlight when the cursor actually leaves the
    // outer target — not when it crosses into a child element, which
    // fires dragleave with relatedTarget still inside us.
    if (e.currentTarget === e.target) {
      setDraggingOver(false)
    }
  }, [])

  // Shared commit path used by both drop and click. Resolves through
  // the engine's setWorkspace IPC and surfaces any validation error in
  // the gate dialog. Pulled out so the click handler doesn't have to
  // duplicate the error-cleanup regex and `submitting` bookkeeping.
  const commitWorkspace = useCallback(
    (absPath: string): void => {
      if (submitting) return
      setSubmitting(true)
      setError(null)
      window.chatApi
        .setWorkspace({ path: absPath })
        .then((state) => {
          if (state.path) {
            onReady(state.path)
          } else {
            setError(t('gateErrorRejected'))
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          // electron IPC surfaces rejected handler errors as
          // "Error invoking remote method '…': Error: <actual>"; strip
          // the wrapper so the dialog shows just the engine's message.
          const cleaned = msg.replace(
            /^Error invoking remote method '[^']+':\s*Error:\s*/,
            ''
          )
          setError(cleaned)
        })
        .finally(() => setSubmitting(false))
    },
    [onReady, submitting, t]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setDraggingOver(false)

      if (submitting) return

      const items = Array.from(e.dataTransfer?.items ?? [])
      if (items.length === 0) {
        setError(t('gateErrorDropFolder'))
        return
      }

      // DataTransferItem.webkitGetAsEntry() is the only reliable way to
      // tell in the renderer whether a drop is a folder or a plain file
      // before we go to main. Without this, dropping a file would slip
      // through and hit the engine's statSync.isDirectory() rejection
      // with a less friendly error message.
      let dirFile: File | null = null
      for (const item of items) {
        if (item.kind !== 'file') continue
        const entry = item.webkitGetAsEntry?.()
        if (entry?.isDirectory) {
          dirFile = item.getAsFile()
          if (dirFile) break
        }
      }

      if (!dirFile) {
        setError(t('gateErrorNotFile'))
        return
      }

      const absPath = window.chatApi.pathForFile(dirFile)
      if (!absPath) {
        setError(t('gateErrorResolvePath'))
        return
      }

      commitWorkspace(absPath)
    },
    [commitWorkspace, submitting, t]
  )

  // Click-to-pick path. Asks main for a native folder dialog; on
  // cancel we leave the gate untouched, on pick we hand the absolute
  // path to the same commit code drop uses.
  const handleClickPick = useCallback((): void => {
    if (submitting) return
    setError(null)
    window.chatApi
      .pickWorkspace()
      .then((result) => {
        if (result.path) commitWorkspace(result.path)
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
      })
  }, [commitWorkspace, submitting])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('gateTitle')}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-background"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Ambient background — two soft accent blobs that drift and
          a fine dotted grid. Pure decoration, `pointer-events-none` so
          the drop target still catches the drag. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.035] dark:opacity-[0.06]"
          style={{
            backgroundImage:
              'radial-gradient(hsl(var(--foreground)) 1px, transparent 1px)',
            backgroundSize: '22px 22px'
          }}
        />
        <motion.div
          className="absolute -left-24 -top-24 size-[460px] rounded-full bg-accent/25 blur-[120px]"
          animate={{
            x: draggingOver ? 40 : 0,
            y: draggingOver ? 20 : 0,
            scale: draggingOver ? 1.08 : 1
          }}
          transition={{ type: 'spring', stiffness: 60, damping: 18 }}
        />
        <motion.div
          className="absolute -bottom-32 -right-24 size-[520px] rounded-full bg-sky-500/20 blur-[140px]"
          animate={{
            x: draggingOver ? -30 : 0,
            y: draggingOver ? -20 : 0,
            scale: draggingOver ? 1.1 : 1
          }}
          transition={{ type: 'spring', stiffness: 55, damping: 20 }}
        />
      </div>

      {/* Card — soft glass surface with animated entrance. */}
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 180, damping: 22 }}
        className={
          'relative w-[560px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[22px] border bg-card/80 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.55),0_10px_30px_-10px_rgba(0,0,0,0.3)] backdrop-blur-xl transition-colors ' +
          (draggingOver
            ? 'border-accent/70 ring-1 ring-accent/40'
            : 'border-border/70')
        }
      >
        {/* Animated top accent strip — hairline gradient that glows
            stronger during drag-over. */}
        <motion.div
          aria-hidden
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent to-transparent"
          animate={{ opacity: draggingOver ? 1 : 0.4 }}
          transition={{ duration: 0.25 }}
        />

        <div className="relative flex flex-col items-center px-10 py-14 text-center">
          {/* Icon + halo. Halo pulses while idle, locks to solid glow
              while the user is dragging. */}
          <div className="relative mb-6">
            <motion.div
              aria-hidden
              className="absolute inset-0 -m-3 rounded-3xl bg-accent/25 blur-2xl"
              animate={{
                opacity: draggingOver ? 0.9 : [0.35, 0.6, 0.35],
                scale: draggingOver ? 1.15 : [1, 1.08, 1]
              }}
              transition={
                draggingOver
                  ? { duration: 0.3 }
                  : { duration: 2.6, repeat: Infinity, ease: 'easeInOut' }
              }
            />
            <motion.div
              className={
                'relative flex size-16 items-center justify-center rounded-2xl border shadow-sm transition-colors ' +
                (draggingOver
                  ? 'border-accent/60 bg-accent/10 text-accent'
                  : 'border-border/80 bg-background/70 text-foreground/70')
              }
              animate={{
                y: draggingOver ? -4 : 0,
                rotate: draggingOver ? [0, -3, 3, 0] : 0
              }}
              transition={{
                y: { type: 'spring', stiffness: 220, damping: 15 },
                rotate: { duration: 0.5, ease: 'easeInOut' }
              }}
            >
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              </svg>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.35 }}
            className="mb-1.5 text-[16px] font-semibold tracking-tight text-foreground"
          >
            {t('gateTitle')}
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.14, duration: 0.35 }}
            className="mb-7 max-w-[380px] text-[12.5px] leading-relaxed text-muted-foreground"
          >
            {t('gateDescBefore')}
            <code className="mx-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              cwd
            </code>
            {t('gateDescAfter')}
          </motion.div>

          {/* Drop zone — dashed border, subtle hover lift, accent
              fill when a folder is being dragged over. */}
          <motion.button
            type="button"
            onClick={handleClickPick}
            disabled={submitting}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.4 }}
            whileHover={submitting ? undefined : { y: -2 }}
            whileTap={submitting ? undefined : { scale: 0.985 }}
            className={
              'group/drop relative w-full overflow-hidden rounded-2xl border-2 border-dashed px-6 py-9 text-[12.5px] transition-colors ' +
              (draggingOver
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-background/30 text-muted-foreground hover:border-input hover:bg-background/60 hover:text-foreground') +
              (submitting ? ' cursor-wait opacity-70' : ' cursor-pointer')
            }
          >
            {/* Sweep highlight on hover — a thin diagonal gradient
                slides across the drop zone. Pure visual flourish. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-foreground/[0.04] to-transparent transition-transform duration-700 ease-out group-hover/drop:translate-x-full"
            />

            <AnimatePresence mode="wait" initial={false}>
              {submitting ? (
                <motion.span
                  key="checking"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="inline-flex items-center gap-2"
                >
                  <Spinner />
                  {t('gateChecking')}
                </motion.span>
              ) : draggingOver ? (
                <motion.span
                  key="release"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.2 }}
                  className="inline-flex items-center gap-2 font-medium"
                >
                  <motion.span
                    className="inline-block size-1.5 rounded-full bg-accent"
                    animate={{ scale: [1, 1.4, 1], opacity: [1, 0.6, 1] }}
                    transition={{ duration: 1.2, repeat: Infinity }}
                  />
                  {t('gateReleaseToSet')}
                </motion.span>
              ) : (
                <motion.span
                  key="idle"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="block"
                >
                  <span className="block text-[13px] font-semibold text-foreground">
                    {t('gateClickToBrowse')}
                  </span>
                  <span className="mt-1 block text-muted-foreground/90">
                    {t('gateOrDrop')}
                  </span>
                </motion.span>
              )}
            </AnimatePresence>
          </motion.button>

          <AnimatePresence>
            {error && (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: -6, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: -6, height: 0 }}
                transition={{ duration: 0.22 }}
                className="mt-5 w-full overflow-hidden rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-left text-[12px] text-red-400"
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.4 }}
            className="mt-7 text-[11px] text-muted-foreground/70"
          >
            {t('gateSwitchHint')}
          </motion.div>
        </div>
      </motion.div>
    </div>
  )
}

/**
 * Small inline spinner for the submitting state. Pure CSS rotation
 * so it keeps spinning during React's commit phase without fighting
 * motion's transition system.
 */
function Spinner(): React.JSX.Element {
  return (
    <svg
      className="size-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeOpacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
