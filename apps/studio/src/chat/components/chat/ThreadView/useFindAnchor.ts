import { useMessage } from '@assistant-ui/react'

import { useChatStore } from '../../../stores/chat'
import { useThreadFindStore } from '../../../stores/threadFind'

/**
 * 给一条消息挂上「对话内查找」的定位锚点与高亮标记。
 * UserMessage / AssistantMessage 各自把返回值摊进自己的 MessagePrimitive.Root。
 *
 * ⚠️ 下标换算是这里唯一容易写错的地方
 * ------------------------------------
 * assistant-ui 的 `message.index` 是「这条消息在 **runtime 拿到的那个数组**
 * 里的位置」，而 FusionRuntimeProvider 喂给 runtime 的是
 * `messages.slice(historyWindowStart)`（见那边第 431 行）——长对话默认只喂
 * 最近 30 条。所以库给的是**相对下标**，而查找命中记的是**完整数组下标**
 * （lib/threadFind 搜的是完整数组），两者差一个 `historyWindowStart`。
 *
 * 加回去之后是自洽的：用户点「显示更早」后 windowStart 变小、同一条消息的
 * 相对 index 等量变大，和仍然等于它在完整数组里的位置。
 */
export function useFindAnchor(): Record<string, string | number> {
  const localIndex = useMessage((m) => (m as { index?: number }).index ?? 0)
  const windowStart = useChatStore((s) => s.historyWindowStart)
  const fullIndex = localIndex + windowStart
  // 只订阅「我是不是当前命中」这个布尔，不订阅 activeMessageIndex 本身——
  // 后者每跳一次都变，会把整屏消息全部重渲染一遍。
  const active = useThreadFindStore((s) => s.activeMessageIndex === fullIndex)

  return active
    ? { 'data-find-index': fullIndex, 'data-find-active': 'true' }
    : { 'data-find-index': fullIndex }
}

/** 当前命中那条消息的高亮。整行淡底色（像 IDE 高亮当前行）而不是描边：
 *  用户气泡右对齐、AI 回复左对齐，一个描边框住整行宽度会在两种消息上
 *  长成两种形状；淡底色两边都读作「就是这一条」。 */
export const FIND_ACTIVE_CLASS =
  'rounded-lg transition-colors duration-200 data-[find-active]:bg-accent/10'
