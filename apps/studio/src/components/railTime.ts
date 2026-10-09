/**
 * rail 列表共用的时间工具 —— RailSessionList（聊天会话）与 RailProjectList
 * （画布项目）两个列表的分组标签与行尾相对时间必须同一套节奏，抽出来
 * 单一源头。纯函数模块，无 window 依赖（rail 挂在根 layout 会被 SSR）。
 */

/**
 * updatedAt → 时间分组。
 *
 * `nowMs` 默认取当前时刻，生产调用方一律不传。它存在**只为可测性**：
 * 分组边界是「昨天 / 今天」这类日历边界，断言必须能钉死「现在是几点」，
 * 否则测试夹具里的相对偏移（`now - 1.2 天`）会随运行时刻落进不同的组——
 * 2026-10-08 实测：测试进程跑在 UTC，于是这批断言每天北京时间
 * 08:00–12:48 必红、其余时段全绿，潜伏了 8 天才被发现。
 * 见 railGrouping.test.ts 顶部的 FIXED_NOW 注释。
 */
export function groupLabel(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms)
  const now = new Date(nowMs)
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
export function relativeTime(ms: number, nowMs: number = Date.now()): string {
  const now = new Date(nowMs)
  const d = new Date(ms)
  const diffMin = Math.floor((now.getTime() - ms) / 60_000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (d.toDateString() === now.toDateString()) return `${Math.floor(diffMin / 60)} 小时前`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  // ⚠️ 已知毛刺（2026-10-09 代码评审发现，刻意暂不修）：这里的窗口是
  // 滚动 7 天，而星期名只有 7 个——于是 6~7 天前的条目会显示成**今天
  // 这个星期几**。实测 now = 周日 12:00、条目 = 上周日 13:00（相差 167
  // 小时）时行尾是「周日」，读起来像今天的会话。要修就把这个分支收到
  // 6 天以内（第 7 天落回「M月D日」），但那是改用户可见文案，按仓库
  // 纪律要与重构分开一次做。railTime.test.ts 有一条特征化测试锁住现状。
  if (now.getTime() - ms < 7 * 24 * 60 * 60 * 1000) return WEEKDAYS[d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
