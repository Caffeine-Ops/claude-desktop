import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { useT } from '../../i18n'

/**
 * Full-window overlay that intercepts folder drops while the chat UI
 * is mounted. Sits inside `<main>` as a sibling of the runtime tree
 * with `fixed inset-0 pointer-events-none` by default — only flipping
 * to `pointer-events-auto` once a drag carrying a directory entry is
 * detected, so image drops still fall through to the composer's
 * AttachmentDropzone.
 *
 * Why this and not the WorkspaceGate's own drop handler: the gate is
 * only mounted at cold start (`workspace === null`). After the first
 * commit the gate unmounts and the user would lose the drag-a-folder
 * affordance. Mounting this layer alongside the chat UI restores it
 * without having the gate's full-screen chrome re-appear.
 *
 * Heuristic for "is this a folder drag":
 *   - `dataTransfer.items[i].webkitGetAsEntry()?.isDirectory`
 *   - Chrome exposes `webkitGetAsEntry` during dragover on macOS for
 *     Finder drags. When a drag contains at least one directory we
 *     show the overlay; otherwise we ignore the event so composer
 *     image drops keep working.
 */
export function WorkspaceDropLayer({
  onDropFolder
}: {
  onDropFolder: (absPath: string) => Promise<void> | void
}): React.JSX.Element {
  const t = useT()
  const [active, setActive] = useState(false)
  // Ref pinning so the effect below can have `[]` deps and still
  // call the latest prop / read the live `active` state without
  // tearing down the window listeners mid-drag. The old version
  // depended on `[active, onDropFolder]`, which meant every
  // setActive(true) unsubscribed and re-subscribed — losing drop
  // events in the window between the teardown and the re-attach.
  const activeRef = useRef(false)
  const dragCounterRef = useRef(0)
  const onDropFolderRef = useRef(onDropFolder)
  useEffect(() => {
    onDropFolderRef.current = onDropFolder
  }, [onDropFolder])

  useEffect(() => {
    // During dragover, Chromium puts DataTransferItem into "protected
    // mode" — `webkitGetAsEntry()` returns null. So we CANNOT use
    // the entry check to decide whether to preventDefault. Instead we
    // use the coarse `types.includes('Files')` signal: any file drag
    // gets preventDefault (blocks file:// navigation) and shows the
    // overlay. At drop time, protected mode is lifted and we finally
    // check `webkitGetAsEntry().isDirectory` to filter out plain file
    // drops (those are a no-op so image drags fall through to the
    // composer dropzone). This matches the behavior pattern used by
    // the old WorkspaceGate, which worked reliably.
    const carriesFiles = (dt: DataTransfer | null): boolean => {
      if (!dt) return false
      const types = dt.types
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true
      }
      return false
    }

    const show = (): void => {
      if (!activeRef.current) {
        activeRef.current = true
        setActive(true)
      }
    }
    const hide = (): void => {
      if (activeRef.current) {
        activeRef.current = false
        setActive(false)
      }
    }

    const onDragEnter = (e: DragEvent): void => {
      if (!carriesFiles(e.dataTransfer)) return
      e.preventDefault()
      // Counter instead of relatedTarget so dragenter/dragleave over
      // nested children doesn't flicker the overlay. Each dragenter
      // bumps the counter, each dragleave decrements; we only hide
      // when the counter hits zero (cursor actually left the window).
      dragCounterRef.current += 1
      show()
    }

    const onDragOver = (e: DragEvent): void => {
      if (!carriesFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (e: DragEvent): void => {
      if (!carriesFiles(e.dataTransfer)) return
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
      if (dragCounterRef.current === 0) hide()
    }

    const onDrop = (e: DragEvent): void => {
      if (!carriesFiles(e.dataTransfer)) return
      // Reset the counter + overlay regardless of outcome — a drop
      // always ends the drag session.
      dragCounterRef.current = 0
      hide()

      // Find the first directory-like item. webkitGetAsEntry is
      // trustworthy at drop time (outside protected mode).
      const items = Array.from(e.dataTransfer?.items ?? [])
      let dirFile: File | null = null
      for (const item of items) {
        if (item.kind !== 'file') continue
        const entry = item.webkitGetAsEntry?.()
        if (entry?.isDirectory) {
          dirFile = item.getAsFile()
          if (dirFile) break
        }
      }

      // No directory in the payload — let the event bubble so the
      // composer dropzone can handle image drops. We intentionally
      // do NOT preventDefault here so image drops keep working.
      if (!dirFile) return

      e.preventDefault()
      e.stopPropagation()
      const abs = window.chatApi.pathForFile(dirFile)
      if (!abs) return
      const cb = onDropFolderRef.current
      void Promise.resolve(cb(abs)).catch((err) => {
        console.error('[WorkspaceDropLayer] switchTo failed', err)
      })
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="workspace-drop-layer"
          role="dialog"
          aria-label={t('workspaceDropRelease')}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="pointer-events-none fixed inset-0 z-[45] flex items-center justify-center bg-background/70 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.96, y: 6 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, y: 4 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-accent/70 bg-accent/10 px-16 py-12 text-center shadow-[0_30px_80px_-20px_rgba(0,0,0,0.55)]"
          >
            <motion.div
              animate={{ y: [0, -4, 0] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              className="flex size-16 items-center justify-center rounded-2xl border border-accent/60 bg-accent/15 text-accent"
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
                <path d="M12 11v6" />
                <path d="m9 14 3 3 3-3" />
              </svg>
            </motion.div>
            <div className="text-[14px] font-semibold text-foreground">
              {t('workspaceDropRelease')}
            </div>
            <div className="text-[12px] text-muted-foreground">
              {t('workspaceDropHint')}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
