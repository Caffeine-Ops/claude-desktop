import { useCallback, useEffect, useState } from 'react'

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
 * Once the drop is accepted, this component unmounts and the gate is
 * gone for the rest of the session — the engine rejects setWorkspace()
 * a second time, and changing workspace mid-session would require
 * killing the already-spawned fusion-code child anyway.
 */
export function WorkspaceGate({
  onReady
}: {
  onReady: (path: string) => void
}): React.JSX.Element {
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

  const handleDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setDraggingOver(false)

      if (submitting) return

      const items = Array.from(e.dataTransfer?.items ?? [])
      if (items.length === 0) {
        setError('Drop a folder onto the window.')
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
        setError('Drop a folder, not a file.')
        return
      }

      const absPath = window.chatApi.pathForFile(dirFile)
      if (!absPath) {
        setError(
          'Could not resolve the folder path. Try dragging from Finder / File Explorer.'
        )
        return
      }

      setSubmitting(true)
      setError(null)
      window.chatApi
        .setWorkspace({ path: absPath })
        .then((state) => {
          if (state.path) {
            onReady(state.path)
          } else {
            setError('Main process did not accept the workspace.')
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
    [onReady, submitting]
  )

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a workspace"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#050508]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Card — mirrors the aesthetic of SkillsDialog / PermissionDialog:
          zinc border, deep-black fill, soft shadow. Borders become
          brighter while the user is dragging over. */}
      <div
        className={
          'flex w-[560px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border bg-[#0e0e11] shadow-[0_24px_80px_rgba(0,0,0,0.7)] transition-colors ' +
          (draggingOver
            ? 'border-emerald-500/80'
            : 'border-zinc-800 hover:border-zinc-700')
        }
      >
        <div className="flex flex-col items-center px-10 py-14 text-center">
          <div
            className={
              'mb-5 flex size-14 items-center justify-center rounded-2xl border transition-colors ' +
              (draggingOver
                ? 'border-emerald-500/80 bg-emerald-500/10 text-emerald-300'
                : 'border-zinc-800 bg-zinc-900/60 text-zinc-400')
            }
            aria-hidden
          >
            {/* Folder glyph — pure SVG, no icon dep. */}
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
          </div>

          <div className="mb-1 text-[15px] font-semibold text-zinc-100">
            Pick a workspace to start
          </div>
          <div className="mb-6 max-w-[380px] text-[12.5px] leading-relaxed text-zinc-500">
            Drag a folder from Finder / File Explorer onto this window.
            Claude will run inside that directory — it becomes the{' '}
            <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300">
              cwd
            </code>{' '}
            for every tool call in this session.
          </div>

          <div
            className={
              'w-full rounded-xl border-2 border-dashed px-6 py-8 text-[12.5px] transition-colors ' +
              (draggingOver
                ? 'border-emerald-500/80 bg-emerald-500/5 text-emerald-200'
                : 'border-zinc-800 text-zinc-500')
            }
          >
            {submitting ? (
              <span>Checking folder…</span>
            ) : draggingOver ? (
              <span>Release to set workspace</span>
            ) : (
              <span>Drop folder anywhere on the window</span>
            )}
          </div>

          {error && (
            <div className="mt-5 w-full rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-left text-[12px] text-red-300">
              {error}
            </div>
          )}

          <div className="mt-6 text-[11px] text-zinc-600">
            Session-scoped · restart the app to pick a different folder
          </div>
        </div>
      </div>
    </div>
  )
}
