import type { ThreadSummary } from '@desktop-shared/types'

import { groupLabel } from './railTime'

/**
 * 侧栏会话列表的分组拍平——把「一串按 updatedAt 倒序的会话」变成虚拟
 * 滚动能直接按 index 取的一维数组（标签与行混在同一个数组里，渲染端按
 * kind 分支）。
 *
 * 2026-09-30 从 RailSessionList.tsx 里抽出来，同时长出置顶支持。抽出来
 * 的理由不是文件太大，是**这段逻辑只能靠断言守住**：置顶最容易出的两个
 * 错——同一行在置顶组和日期组里各画一次、某个日期组被掏空后还留着空
 * 标题——在 UI 上都得凑齐特定数据才看得见，肉眼走查撞不上。搬进这里
 * 之后它进了 bun test（package.json 的 test 脚本同期加了 src/components）。
 */
export type RailItem =
  | { kind: 'label'; key: string; text: string }
  | { kind: 'row'; key: string; thread: ThreadSummary }

/** 置顶组的标签文本。与「今天/昨天/本周/更早」同一套纯文本视觉语言。 */
const PINNED_LABEL = '置顶'

/**
 * @param threads 已按 updatedAt 倒序的会话列表（调用方保证顺序）
 * @param pinned  置顶集合，`Record<sessionId, true>`（见 stores/pinnedSessions）
 * @param nowMs   「现在」，默认当前时刻。生产调用方一律不传——它只为让测试
 *                能钉死日历边界而存在（见 railTime.ts 的 groupLabel 注释）。
 *
 * 置顶的会话**从原日期组里移走**收进最前面的置顶组，不在两处重复出现；
 * 组内仍按 updatedAt 倒序——沿用输入顺序即可，不需要再排一次。
 *
 * `pinned` 里可能有**陈旧键**（会话在别处被删了，localStorage 里的标记还
 * 在），所以置顶组是否成立必须看「实际命中了几行」，不能看 pinned 的
 * 键数——否则会画出一个空的置顶标题。
 */
export function buildItems(
  threads: readonly ThreadSummary[],
  pinned: Readonly<Record<string, true>>,
  nowMs: number = Date.now()
): RailItem[] {
  const pinnedThreads: ThreadSummary[] = []
  const rest: ThreadSummary[] = []
  for (const t of threads) {
    if (pinned[t.id]) pinnedThreads.push(t)
    else rest.push(t)
  }

  const items: RailItem[] = []
  if (pinnedThreads.length > 0) {
    items.push({ kind: 'label', key: `g:${PINNED_LABEL}`, text: PINNED_LABEL })
    for (const t of pinnedThreads) items.push({ kind: 'row', key: t.id, thread: t })
  }

  // 日期分组只在剩下的行上做——这正是「今天」组被置顶掏空后自动消失的
  // 原因：标签是遇到第一行该组的行才插的，没有行就没有标签。
  let lastGroup: string | null = null
  for (const t of rest) {
    const g = groupLabel(t.updatedAt, nowMs)
    if (g !== lastGroup) {
      lastGroup = g
      items.push({ kind: 'label', key: `g:${g}`, text: g })
    }
    items.push({ kind: 'row', key: t.id, thread: t })
  }
  return items
}
