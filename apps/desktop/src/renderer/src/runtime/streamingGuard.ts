import { useChatStore } from '../stores/chat'
import { useI18n } from '../i18n'

/**
 * Streaming-interrupt guard.
 *
 * Several user actions — switching to a different chat, creating a new
 * chat, switching workspace — are destructive when a turn is mid-flight:
 * the running CLI gets torn down, deltas in the buffer are discarded,
 * and any tool calls Claude was about to fire never happen. Without a
 * confirm step, an accidental click silently kills work the user just
 * waited 30+ seconds for.
 *
 * This helper is a single chokepoint that all those entry points call
 * before they actually do their thing:
 *
 *   1. If `chat.streaming` is false → returns true immediately, the
 *      caller proceeds. No dialog, no abort. (Cold-start auto-select
 *      paths hit this branch and don't get a spurious confirm.)
 *
 *   2. If `chat.streaming` is true → shows a native confirm with the
 *      current language's message. On accept, fires `chatApi.abort`
 *      against the active session id so the engine cleans up cleanly
 *      before the caller swaps state. On decline, returns false and
 *      the caller bails out.
 *
 * Returns a Promise so callers can `await` it inline before mutating
 * state. The abort step is awaited too — without that, the new
 * session/workspace would race the cleanup of the old one and the
 * UI could end up subscribed to events from the dying CLI.
 */
export async function confirmStreamingInterrupt(): Promise<boolean> {
  const { streaming, sessionId } = useChatStore.getState()
  if (!streaming) return true

  const lang = useI18n.getState().lang
  const message =
    lang === 'zh'
      ? '当前对话还在进行中，继续将中断本次回合。确定吗？'
      : 'A chat turn is still in progress. Continuing will interrupt it. Are you sure?'
  const ok = window.confirm(message)
  if (!ok) return false

  if (sessionId !== null && typeof window !== 'undefined' && window.chatApi) {
    try {
      await window.chatApi.abort({ sessionId })
    } catch (err) {
      // Abort failures are non-fatal here — the engine may already be
      // tearing down. We log and let the caller proceed; the worst
      // case is a redundant abort on the next session swap.
      console.error('[streamingGuard] abort failed:', err)
    }
  }
  return true
}
