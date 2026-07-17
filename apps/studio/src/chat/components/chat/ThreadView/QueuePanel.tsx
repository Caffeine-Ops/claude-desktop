'use client'

/**
 * Message-queue panel — the turns the user submitted while a reply was
 * still streaming. Rendered as the TOP SEGMENT *inside* the composer card
 * (see Composer.tsx's single-container layout): the card owns the rounded
 * outer frame + border, and this panel is a plain content section with NO
 * frame of its own. This panel owns its bottom hairline divider so the
 * whole block (header + list + divider) enters and exits as ONE animated
 * unit — the parent no longer renders a separate `hasQueue && divider`
 * (that pair used to pop in/out un-animated).
 *
 * 2026-07-16 redesign (prototype docs/ui-prototype-composer-states.html):
 *
 *   - COLLAPSED BY DEFAULT. The header doubles as a summary row —
 *     "队列 N · 下一条：…" — so a long queue costs ONE row of card height
 *     instead of shoving the input off-screen (the original complaint).
 *     Clicking the header (or the chevron) toggles the list open; the
 *     expanded/collapsed choice is per-mount component state, deliberately
 *     not persisted — a fresh session starts quiet again.
 *   - Compact rows: index number + single-line truncate + hover-revealed
 *     actions (move-to-top / edit / delete), and a header-level 清空.
 *   - Motion: segment enter/exit and expand/collapse animate height via
 *     motion/react springs (bounce 0 — a queue is bookkeeping, not a toy);
 *     row add/remove uses layout animations so siblings glide instead of
 *     snapping.
 *
 * Data flow: the queue lives in main (engine `pendingTurns`); this panel
 * reads the renderer mirror (`useSessionQueue`) and its row actions call
 * `window.chatApi.queue*`, which mutate the authoritative queue and echo
 * a fresh `queue_changed` snapshot back into the mirror. So every action
 * here is optimistic-free on the store side — we just fire the IPC and
 * let the echo repaint.
 */

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownRight,
  ListPlus,
  Pencil,
  Trash2,
  X
} from 'lucide-react'

import { useSessionQueue } from '../../../stores/messageQueue'
import { updateQueuedTurnText } from '../../../runtime/FusionRuntimeProvider'
import { Button } from '@/src/components/ui/button'
import { Input } from '@/src/components/ui/input'
import { cn } from '@/src/lib/utils'

/** 段落/列表的高度动画：bounce 0 的利落 spring——队列是记账不是玩具。 */
const SEG_SPRING = { type: 'spring', bounce: 0, visualDuration: 0.3 } as const

export function QueuePanel({
  sessionId
}: {
  sessionId: string | null
}): React.JSX.Element | null {
  const queue = useSessionQueue(sessionId)
  // 默认折叠（重设计的核心）：摘要行一行代替整个列表。会话内记住手动
  // 展开的选择；组件不随会话重挂载，所以换会话时用 effect 收回折叠态。
  const [collapsed, setCollapsed] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const editInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setCollapsed(true)
  }, [sessionId])

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

  const remove = (messageId: string): void => {
    if (!sessionId) return
    void window.chatApi.queueRemove({ sessionId, messageId })
  }
  const removeAll = (): void => {
    if (!sessionId) return
    for (const item of queue) {
      void window.chatApi.queueRemove({ sessionId, messageId: item.messageId })
    }
  }
  const promote = (messageId: string): void => {
    if (!sessionId) return
    void window.chatApi.queuePromote({ sessionId, messageId })
  }
  const beginEdit = (messageId: string, text: string): void => {
    setDraft(text)
    setEditingId(messageId)
    // 编辑必须看得见列表——从摘要行的场景进入编辑不存在（编辑按钮只在
    // 展开列表的行上），但保险起见保证展开。
    setCollapsed(false)
  }
  const commitEdit = (): void => {
    const messageId = editingId
    if (!messageId || !sessionId) return
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

  const show = sessionId !== null && queue.length > 0
  const next = queue[0]

  return (
    // 段落进出由本组件自己动画（AnimatePresence + height:auto）——divider
    // 包在动画块内，出现/消失时整块一起滑动，不再各自弹跳。
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key="queue-seg"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={SEG_SPRING}
          className="overflow-hidden"
        >
          {/* 头部 = 折叠态的摘要行：整行可点切换展开。行内的清空按钮
              stopPropagation，避免点操作误触折叠。 */}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开消息队列' : '折叠消息队列'}
            className="group/qhead flex w-full items-center gap-2 px-4 pb-1.5 pt-2.5 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ListPlus className="size-3.5 shrink-0" />
            <span className="shrink-0 font-medium text-foreground">队列</span>
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 tabular-nums">
              {queue.length}
            </span>
            {collapsed && next ? (
              // 摘要：下一条预览。折叠时这一行就是队列的全部占位。
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <CornerDownRight className="size-3 shrink-0 text-brand" />
                <span className="truncate text-foreground">
                  {next.text || (next.imageCount > 0 ? '（仅图片）' : '')}
                </span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate opacity-75">
                回复完成后按顺序自动发送
              </span>
            )}
            <span
              role="button"
              tabIndex={-1}
              aria-label="清空队列"
              onClick={(e) => {
                e.stopPropagation()
                removeAll()
              }}
              className="shrink-0 rounded-md px-2 py-0.5 text-[11px] opacity-0 transition-opacity hover:bg-secondary hover:text-destructive group-hover/qhead:opacity-100"
            >
              清空
            </span>
            {/* chevron 自己的小 hover 格（原型 .queue-toggle）——整行虽可点，
                但指到箭头上要有「这是开关」的直接反馈。 */}
            <span className="grid size-6 shrink-0 place-items-center rounded-md transition-colors group-hover/qhead:bg-secondary">
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-300',
                  collapsed && '-rotate-180'
                )}
              />
            </span>
          </button>

          {/* 列表：展开/收起同一套 height:auto spring；行的增删走 layout
              动画（新行滑入、删行后兄弟行滑拢）。 */}
          <AnimatePresence initial={false}>
            {!collapsed ? (
              <motion.div
                key="queue-list"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={SEG_SPRING}
                className="overflow-hidden"
              >
                {/* Cap the visible height at ~4.5 compact rows so a long queue
                    scrolls internally and reveals a half-row hint of more. */}
                <ul className="flex max-h-[158px] flex-col gap-0.5 overflow-y-auto px-2 pb-2">
                  {/* popLayout：被删的行立即让出布局（absolute 弹出淡走），
                      兄弟行同帧 layout 滑拢——默认模式要等 exit 播完才补位，
                      看起来像卡了一拍。 */}
                  <AnimatePresence initial={false} mode="popLayout">
                    {queue.map((item, idx) => {
                      const editing = item.messageId === editingId
                      return (
                        <motion.li
                          key={item.messageId}
                          layout
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.98 }}
                          transition={SEG_SPRING}
                          className={cn(
                            'group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]',
                            !editing && 'hover:bg-secondary/70'
                          )}
                        >
                          <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70">
                            {idx + 1}
                          </span>
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
                        </motion.li>
                      )
                    })}
                  </AnimatePresence>
                </ul>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* 段落自带的底部 hairline——随整块一起进出。 */}
          <div className="h-px bg-border/70" />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
