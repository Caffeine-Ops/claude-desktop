import { useCallback, useState } from 'react'
import { motion } from 'motion/react'

import { useT } from '../../i18n'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * Cold-start placeholder rendered inside `<main>` when no workspace
 * has been picked yet. Replaces the old full-screen WorkspaceGate so
 * the first-run experience lives *inside* the chat layout instead of
 * feeling like a separate "pick a folder" page.
 *
 * What's here vs what's NOT:
 *
 *   - The chat header is rendered by App.tsx above this shell, so we
 *     only own the main content area.
 *   - The FusionRuntimeProvider is NOT mounted yet because the engine
 *     rejects `send()` until a workspace is committed. Instead we draw
 *     a chat-like skeleton with a disabled composer, a greeting card,
 *     and the native WorkspacePill-equivalent picker button.
 *   - The global WorkspaceDropLayer (mounted in App.tsx at the root
 *     level) is still listening for folder drags anywhere in the
 *     window, so dropping a folder commits through the same
 *     `switchTo` path.
 *
 * The picker button calls `pickWorkspace` → `switchTo` directly; on
 * success, App.tsx's store subscription flips `workspace` and mounts
 * the real runtime in place of this shell.
 */
export function EmptyWorkspaceShell(): React.JSX.Element {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pick = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.chatApi.pickWorkspace()
      if (result.path) {
        await useWorkspaceStore.getState().switchTo(result.path)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        msg.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
      )
    } finally {
      setBusy(false)
    }
  }, [busy])

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col bg-transparent">
      {/* Ambient background — two soft accent blobs + a fine dotted
          grid. Pure decoration. */}
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
          className="absolute -left-24 -top-24 size-[460px] rounded-full bg-accent/20 blur-[120px]"
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -bottom-32 -right-24 size-[520px] rounded-full bg-sky-500/15 blur-[140px]"
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      {/* Message area — matches the real ThreadView viewport vibe so
          cold start reads as "empty chat" not "separate page". */}
      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="flex max-w-md flex-col items-center gap-5 text-center"
        >
          <motion.div
            animate={{ y: [0, -4, 0] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
            className="flex size-14 items-center justify-center rounded-2xl border border-border/80 bg-background/70 text-foreground/70 shadow-sm"
          >
            <svg
              width="26"
              height="26"
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
          <div>
            <div className="text-[15px] font-semibold tracking-tight text-foreground">
              {t('emptyWorkspaceTitle')}
            </div>
            <div className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
              {t('emptyWorkspaceDesc')}
            </div>
          </div>
          <motion.button
            type="button"
            onClick={pick}
            disabled={busy}
            whileHover={busy ? undefined : { y: -1 }}
            whileTap={busy ? undefined : { scale: 0.985 }}
            className="group relative inline-flex items-center gap-2 rounded-full border border-accent/30 bg-gradient-to-br from-accent/15 to-accent/5 px-5 py-2.5 text-[13px] font-semibold text-foreground shadow-sm transition-colors hover:border-accent/50 hover:from-accent/20 hover:to-accent/8 disabled:cursor-wait disabled:opacity-70"
          >
            <span className="flex size-4 items-center justify-center text-accent">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              </svg>
            </span>
            {t('emptyWorkspaceButton')}
          </motion.button>
          <div className="text-[11.5px] text-muted-foreground/70">
            {t('emptyWorkspaceDragHint')}
          </div>
          {error && (
            <div className="w-full rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-400">
              {error}
            </div>
          )}
        </motion.div>
      </div>

      {/* Disabled composer stand-in — reads as "chat page, waiting
          for a folder" instead of a dead empty state. No runtime is
          mounted, so this is purely visual. */}
      <div className="relative shrink-0 bg-background/45 px-6 py-4 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto w-full max-w-3xl">
          <div className="pointer-events-none rounded-2xl border border-border/60 bg-card/60 px-4 py-3 shadow-sm">
            <div className="text-[13px] text-muted-foreground/70">
              {t('emptyWorkspaceComposerHint')}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
