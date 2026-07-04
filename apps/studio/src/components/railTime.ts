/**
 * rail 列表共用的时间工具 —— RailSessionList（聊天会话）与 RailProjectList
 * （画布项目）两个列表的分组标签与行尾相对时间必须同一套节奏，抽出来
 * 单一源头。纯函数模块，无 window 依赖（rail 挂在根 layout 会被 SSR）。
 */

/** updatedAt → 时间分组。 */
export function groupLabel(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  // 标签叫「本周」但语义是滚动 7 天（与 shell-floating 原型的分组名对齐；
  // 真按日历周切，周一早上「上周五」会瞬移进「更早」，反而反直觉）。
  if (now.getTime() - ms < 7 * 24 * 60 * 60 * 1000) return '本周'
  return '更早'
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** updatedAt → 行尾相对时间（原型 .session-row .time：刚刚 / N 分钟前 /
 * N 小时前 / 昨天 / 周X / M月D日）。只在列表 reload 时重算——与分组标签
 * 同一刷新节奏，不为「3 分钟前变 4 分钟前」挂定时器。 */
export function relativeTime(ms: number): string {
  const now = new Date()
  const d = new Date(ms)
  const diffMin = Math.floor((now.getTime() - ms) / 60_000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (d.toDateString() === now.toDateString()) return `${Math.floor(diffMin / 60)} 小时前`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  if (now.getTime() - ms < 7 * 24 * 60 * 60 * 1000) return WEEKDAYS[d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
