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
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col bg-background">
      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          className="flex max-w-[460px] flex-col items-center text-center"
        >
          <div className="flex size-16 items-center justify-center rounded-[22px] bg-muted/60 text-foreground/75">
            <svg
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
          </div>

          <h1
            className="mt-7 font-semibold text-foreground"
            style={{
              fontSize: '32px',
              lineHeight: 1.1,
              letterSpacing: '-0.012em'
            }}
          >
            {t('emptyWorkspaceTitle')}
          </h1>

          <p
            className="mt-3 max-w-[400px] text-muted-foreground"
            style={{
              fontSize: '15px',
              lineHeight: 1.47,
              letterSpacing: '-0.012em'
            }}
          >
            {t('emptyWorkspaceDesc')}
          </p>

          <motion.button
            type="button"
            onClick={pick}
            disabled={busy}
            whileTap={busy ? undefined : { scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="mt-8 inline-flex items-center justify-center rounded-full bg-[#0071e3] px-[22px] py-[11px] font-normal text-white transition-colors hover:bg-[#0077ed] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-70"
            style={{ fontSize: '15px', letterSpacing: '-0.012em' }}
          >
            {t('emptyWorkspaceButton')}
          </motion.button>

          <p
            className="mt-5 text-muted-foreground/60"
            style={{ fontSize: '12px', letterSpacing: '-0.01em' }}
          >
            {t('emptyWorkspaceDragHint')}
          </p>

          {error && (
            <div
              className="mt-5 w-full rounded-lg bg-red-500/10 px-3 py-2 text-red-500"
              style={{ fontSize: '12px', lineHeight: 1.47 }}
            >
              {error}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}
