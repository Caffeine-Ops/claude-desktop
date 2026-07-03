import { useEffect, useState } from 'react'
import { DialogShell } from '@open-design/ui'

import type { SessionMeta } from '@desktop-shared/types'
import { useDialogStore } from '../../stores/dialogs'

/**
 * SkillsDialog
 * ------------
 * Triggered by typing `/skill` (or `/skills`) in the composer. Mirrors
 * the fusion-code CLI's terminal `/skill` menu, ported to a DOM modal.
 *
 * The full skill list comes from the cached `SessionMeta.skills` array,
 * which is populated when fusion-code sends its `system init` SDK
 * message on first warmup. If the user opens this dialog before any
 * message has been sent, the cache is empty and we show a friendly
 * "send a message first" empty state — fusion-code's cold start is
 * triggered by the first user turn, so there's nothing to display
 * until then.
 *
 * Future work
 * -----------
 * The CLI version supports fuzzy filter, arrow-key navigation, and
 * "select to inject `/<skill>` into the prompt". This first cut just
 * lists everything; the slot is wired so we can layer that on without
 * changing how the dialog opens.
 */
export function SkillsDialog(): React.JSX.Element | null {
  const open = useDialogStore((s) => s.open === 'skills')
  const close = useDialogStore((s) => s.closeDialog)

  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  // Pull session meta whenever the dialog opens. We re-fetch every
  // time so newly-warmed sessions reflect immediately.
  useEffect(() => {
    if (!open) {
      setFilter('')
      return
    }
    setLoading(true)
    window.chatApi
      .getSessionMeta()
      .then(setMeta)
      .catch((err) => {
        console.error('[SkillsDialog] getSessionMeta failed', err)
      })
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const allSkills = meta?.skills ?? []
  const filtered = filter
    ? allSkills.filter((s) => s.toLowerCase().includes(filter.toLowerCase()))
    : allSkills
  const isEmptyOnLoad = !loading && allSkills.length === 0

  return (
    <DialogShell
      label="Skills picker"
      onClose={close}
      sizeClassName="h-[70vh] max-h-[640px] w-[560px] max-w-[calc(100vw-32px)]"
    >
      <DialogShell.Header
        title="Skills"
        subtitle={
          loading
            ? 'Loading…'
            : isEmptyOnLoad
              ? 'No skills loaded yet'
              : `${filtered.length} of ${allSkills.length} skills`
        }
        onClose={close}
      />

      {/* Filter input — visible only when there's actually content. */}
      {!isEmptyOnLoad && (
        <div className="border-b border-border px-5 py-2">
          <input
            autoFocus
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Type to filter…"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:border-input focus:outline-none"
          />
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && (
            <div className="px-3 py-4 text-[12.5px] text-muted-foreground/80">
              Loading skills…
            </div>
          )}

          {isEmptyOnLoad && (
            <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground/80">
              <div className="mb-2 font-medium text-muted-foreground">
                No skills loaded yet
              </div>
              <div className="text-[11.5px] text-muted-foreground/60">
                Send any message first to start fusion-code, then re-open
                <br />
                this dialog. Skills will populate from the session's first
                <br />
                <code className="rounded bg-card px-1 py-0.5 font-mono text-[10.5px]">
                  system init
                </code>{' '}
                message.
              </div>
            </div>
          )}

          {!loading && !isEmptyOnLoad && filtered.length === 0 && (
            <div className="px-3 py-4 text-[12.5px] text-muted-foreground/80">
              No matches for{' '}
              <code className="rounded bg-card px-1 py-0.5 font-mono text-[11px] text-foreground/80">
                {filter}
              </code>
            </div>
          )}

          {!loading && filtered.length > 0 && (
            <ul className="space-y-0.5">
              {filtered.map((skill) => (
                <li key={skill}>
                  <div className="flex items-center gap-3 rounded-md px-3 py-1.5 text-[13px] hover:bg-muted/60">
                    <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/80" />
                    <span className="truncate font-mono text-foreground">
                      {skill}
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
