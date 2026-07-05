'use client'

/**
 * Message-queue panel — the turns the user submitted while a reply was
 * still streaming. Rendered as the TOP SEGMENT *inside* the composer card
 * (see Composer.tsx's single-container layout): the card owns the rounded
 * outer frame + border, and this panel is a plain content section with NO
 * frame of its own — just its header + list. A hairline divider (added by
 * the parent) separates it from the status/input segments below. This is
 * the fix for the old "stacked rounded boxes with negative margins" that
 * clipped the status row and doubled up borders. Mirrors
 * docs/ui-prototype-message-queue.html, trimmed to the core loop: list +
 * remove / edit / move-to-top. Drag-reorder and steer are deliberately out
 * of this first cut.
 *
 * Data flow: the queue lives in main (engine `pendingTurns`); this panel
 * reads the renderer mirror (`useSessionQueue`) and its row actions call
 * `window.chatApi.queue*`, which mutate the authoritative queue and echo
 * a fresh `queue_changed` snapshot back into the mirror. So every action
 * here is optimistic-free on the store side — we just fire the IPC and
 * let the echo repaint.
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ListPlus, Pencil, Trash2, X } from 'lucide-react'

import { useSessionQueue } from '../../../stores/messageQueue'
import { updateQueuedTurnText } from '../../../runtime/FusionRuntimeProvider'
import { Button } from '@/src/components/ui/button'
import { Input } from '@/src/components/ui/input'
import { cn } from '@/src/lib/utils'

export function QueuePanel({
  sessionId
}: {
  sessionId: string | null
}): React.JSX.Element | null {
  const queue = useSessionQueue(sessionId)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const editInputRef = useRef<HTMLInputElement | null>(null)

  // Focus + select the edit field when a row enters edit mode.
  useEffect(() => {
    if (editingId == null) return
    const t = window.setTimeout(() => {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [editingId])

  // A row can vanish (drained into the active turn / removed elsewhere)
  // while it's being edited — close the editor if its target left.
  useEffect(() => {
    if (editingId && !queue.some((q) => q.messageId === editingId)) {
      setEditingId(null)
    }
  }, [queue, editingId])

  if (!sessionId || queue.length === 0) return null

  const remove = (messageId: string): void => {
    void window.chatApi.queueRemove({ sessionId, messageId })
  }
  const promote = (messageId: string): void => {
    void window.chatApi.queuePromote({ sessionId, messageId })
  }
  const beginEdit = (messageId: string, text: string): void => {
    setDraft(text)
    setEditingId(messageId)
  }
  const commitEdit = (): void => {
    const messageId = editingId
    if (!messageId) return
    const text = draft.trim()
    setEditingId(null)
    // Empty text deletes the entry (engine editQueued mirrors this) — a
    // send with nothing left to say shouldn't linger as a blank row.
    void window.chatApi.queueEdit({ sessionId, messageId, text })
    // Keep the renderer's stash (which feeds the transcript when this
    // turn eventually runs) in sync with the new wording — otherwise the
    // drained bubble would show the pre-edit text.
    updateQueuedTurnText(sessionId, messageId, text)
  }
  const cancelEdit = (): void => setEditingId(null)

  return (
    // Plain content segment — NO frame of its own. The composer card supplies
    // the rounded border + background; this just paints the queue header and
    // list, and the parent draws a hairline divider below it. No rounded
    // corners, no border, no negative margin (that combo clipped the status
    // row before). The list still caps its own height so a long queue scrolls
    // internally instead of shoving the input off-screen.
    <div className="pt-2.5">
      <div className="flex items-center gap-2 px-4 pb-1.5 text-[12px] text-muted-foreground">
        <ListPlus className="size-3.5" />
        <span className="font-medium">消息队列</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 tabular-nums">
          {queue.length}
        </span>
        <span className="opacity-75">回复完成后按顺序自动发送</span>
      </div>
      {/* Cap the visible height at ~4.5 rows so a long queue scrolls
          internally and reveals a half-row hint of more below. */}
      <ul className="flex max-h-[198px] flex-col gap-0.5 overflow-y-auto px-2">
        {queue.map((item, idx) => {
          const editing = item.messageId === editingId
          return (
            <li
              key={item.messageId}
              className={cn(
                'group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[14px]',
                !editing && 'hover:bg-secondary/70'
              )}
            >
              {editing ? (
                <Input
                  ref={editInputRef}
                  value={draft}
                  maxLength={4000}
                  aria-label="编辑排队消息"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitEdit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelEdit()
                    }
                  }}
                  className="h-7 min-w-0 flex-1 text-[13px]"
                />
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate" title={item.text}>
                    {item.text || (item.imageCount > 0 ? '（仅图片）' : '')}
                  </span>
                  {item.imageCount > 0 && (
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {item.imageCount} 图
                    </span>
                  )}
                </>
              )}

              <span className="flex shrink-0 items-center gap-0.5">
                {editing ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="保存"
                      onClick={commitEdit}
                      className="size-7 text-brand hover:bg-brand/12 hover:text-brand"
                    >
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="取消编辑"
                      onClick={cancelEdit}
                      className="size-7 text-muted-foreground"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {idx > 0 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="移到最前"
                        title="移到最前"
                        onClick={() => promote(item.messageId)}
                        className="size-7 text-muted-foreground hover:text-foreground"
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="编辑"
                      title="编辑"
                      onClick={() => beginEdit(item.messageId, item.text)}
                      className="size-7 text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="删除"
                      title="删除"
                      onClick={() => remove(item.messageId)}
                      className="size-7 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
