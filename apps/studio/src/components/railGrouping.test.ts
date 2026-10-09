import { describe, expect, it } from 'bun:test'

import type { ThreadSummary } from '@desktop-shared/types'
import { buildItems } from './railGrouping'

/**
 * 侧栏列表的「拍平成一维数组喂虚拟滚动」那一步。原先内联在
 * RailSessionList.tsx 里，加置顶时抽出来——它是纯函数，而置顶最容易出
 * 的两个错（行在两个组里各出现一次、置顶组空着还画个标题）都只能靠
 * 断言守住，肉眼扫 UI 扫不出来。
 */

/**
 * 钉死的「现在」：2026-03-15 本地时间 12:00。
 *
 * **为什么必须钉死**（2026-10-08 修）：原先这里是 `const now = Date.now()`，
 * 夹具用 `now - 1.2 * DAY` 造「昨天」那条。这等于把「跑测试时是几点」
 * 偷偷变成了一个没人声明的测试输入——而 bun test 进程跑在 **UTC**：
 * UTC 凌晨 0:00–4:48 之间，往前推 28.8 小时会落到**前天**，`groupLabel`
 * 返回「本周」而不是「昨天」，6 条断言连锁失败。表现为「每天北京时间
 * 08:00–12:48 必红、其余时段全绿」，自 PR #71 合入后潜伏了 8 天。
 *
 * **为什么用本地时间构造而不是 `Date.UTC`**：`groupLabel` 走的是 Date 的
 * 本地方法（`toDateString` / `getDate`），本地正午在任何时区下都离日历
 * 边界 12 小时。写成 `Date.UTC(…, 12, 0)` 则在 UTC-12 时区恰好是本地
 * 午夜，同样的坑会换个时区复发。
 */
const FIXED_NOW = new Date(2026, 2, 15, 12, 0, 0).getTime()

function thread(id: string, updatedAt: number): ThreadSummary {
  return { id, title: id, updatedAt, turnCount: 1 }
}

/**
 * 以 `at` 为「现在」，造一组正好跨越四个日期组的会话（按 updatedAt 倒序）。
 *
 * 偏移刻意按**日历天**算（「N 天前的正午」）而不是「现在减 N 小时」：
 * 后者在日历边界附近会落进相邻的组，正是上面那个 bug 的直接成因。
 * 锚在正午则离前后两个午夜各 12 小时，`at` 是几点都不会越界。
 */
function fixtures(at: number): ThreadSummary[] {
  const d = new Date(at)
  const noonDaysAgo = (days: number): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() - days, 12, 0, 0).getTime()
  const midnightToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return [
    // 「今天」这条要的是「刚刚活动过」，所以用 at - 1 分钟而不是正午锚点
    // （正午在 at 早于中午时会落到未来，当 updatedAt 讲不通）。但裸的
    // at - 1 分钟在 at 恰为午夜整点时会退到昨天 23:59——**本行是四条夹具里
    // 唯一能越过日历边界的**，所以向今天 00:00 夹紧。代码评审发现，实测
    // at = 00:00:00 时 groupLabel 确实返回「昨天」。
    thread('today', Math.max(at - 60_000, midnightToday)),
    thread('yesterday', noonDaysAgo(1)),
    thread('week', noonDaysAgo(3)),
    thread('older', noonDaysAgo(30))
  ]
}

/** 只取标签文本，方便断言整体骨架。 */
function labels(items: ReturnType<typeof buildItems>): string[] {
  return items.filter((i) => i.kind === 'label').map((i) => i.text)
}
/** 只取行 id，按渲染顺序。 */
function rows(items: ReturnType<typeof buildItems>): string[] {
  return items.filter((i) => i.kind === 'row').map((i) => i.key)
}

// 输入一律按 updatedAt 倒序（列表本身就是这么给的）。
const ALL = fixtures(FIXED_NOW)

/** 所有断言都在同一个钉死的「现在」上做——别用裸的 buildItems(a, b)。 */
function build(
  threads: readonly ThreadSummary[],
  pinned: Readonly<Record<string, true>>
): ReturnType<typeof buildItems> {
  return buildItems(threads, pinned, FIXED_NOW)
}

describe('buildItems — 没有置顶时（回归保护）', () => {
  it('行为与加置顶之前逐项一致：按日期分组、顺序不变', () => {
    const items = build(ALL, {})
    expect(labels(items)).toEqual(['今天', '昨天', '本周', '更早'])
    expect(rows(items)).toEqual(['today', 'yesterday', 'week', 'older'])
  })

  it('不产生「置顶」标签', () => {
    expect(labels(build(ALL, {}))).not.toContain('置顶')
  })

  it('空列表产出空数组，不画任何标签', () => {
    expect(build([], {})).toEqual([])
  })
})

describe('buildItems — 置顶', () => {
  it('置顶组排在最前，其余日期组顺序不变', () => {
    const items = build(ALL, { week: true })
    expect(labels(items)).toEqual(['置顶', '今天', '昨天', '更早'])
  })

  it('置顶的行从它原来的日期组里拿走，不在两处重复出现', () => {
    const items = build(ALL, { week: true })
    expect(rows(items)).toEqual(['week', 'today', 'yesterday', 'older'])
    expect(rows(items).filter((id) => id === 'week')).toHaveLength(1)
  })

  it('某个日期组被置顶掏空后，不留下空标题', () => {
    // 'today' 是「今天」组里唯一一条，置顶它之后该组应整个消失。
    const items = build(ALL, { today: true })
    expect(labels(items)).toEqual(['置顶', '昨天', '本周', '更早'])
  })

  it('多条置顶时，置顶组内仍按 updatedAt 倒序（与其它组同一节奏）', () => {
    const items = build(ALL, { older: true, today: true })
    expect(rows(items)).toEqual(['today', 'older', 'yesterday', 'week'])
    expect(labels(items)).toEqual(['置顶', '昨天', '本周'])
  })

  it('全部置顶时只剩一个置顶组，没有任何日期组', () => {
    const items = build(ALL, {
      today: true,
      yesterday: true,
      week: true,
      older: true
    })
    expect(labels(items)).toEqual(['置顶'])
    expect(rows(items)).toEqual(['today', 'yesterday', 'week', 'older'])
  })
})

describe('buildItems — 陈旧的置顶键', () => {
  it('置顶的会话已被删除（id 不在列表里）时，不画一个空的置顶组', () => {
    // localStorage 里的置顶键会比会话活得久（在别处删了、换了机器同步过来）。
    const items = build(ALL, { 'deleted-session': true })
    expect(labels(items)).toEqual(['今天', '昨天', '本周', '更早'])
    expect(rows(items)).toEqual(['today', 'yesterday', 'week', 'older'])
  })

  it('陈旧键与有效键混在一起时，只有有效的那条进置顶组', () => {
    const items = build(ALL, { 'deleted-session': true, week: true })
    expect(labels(items)).toEqual(['置顶', '今天', '昨天', '更早'])
    expect(rows(items)).toEqual(['week', 'today', 'yesterday', 'older'])
  })
})

describe('buildItems — key 唯一性（虚拟滚动按 key 取项）', () => {
  it('所有项的 key 互不重复', () => {
    const items = build(ALL, { today: true })
    const keys = items.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

/**
 * 这一组守的不是 buildItems 的功能，而是**这份测试自己**。
 *
 * 2026-10-08 之前，上面那些断言会随「跑测试时是几点」时红时绿（夹具用
 * `Date.now() - 1.2 天` 造「昨天」，UTC 凌晨会落到前天）。那种缺陷最坏的
 * 地方是它不随机——它跟着真实时钟走，于是在 CI 上表现为「偶发」，在本地
 * 表现为「上午复现、下午好了」，查起来极费时间。
 *
 * 所以这里把一天里的几个关键时刻（含午夜刚过、凌晨、正午、深夜）都扫一遍：
 * 只要分组逻辑或夹具构造再次把「现在几点」偷偷变成输入，这条就会红。
 */
describe('分组不随「跑测试时是几点」漂移（防 flaky 回归）', () => {
  /**
   * `[小时, 分钟]`。**午夜整点 `[0, 0]` 是必须留着的那一格**：它是全天唯一
   * 会让「刚刚活动」那条夹具退到前一天的时刻（代码评审发现，见 fixtures
   * 里的注释）。只扫「每点 30 分」会漏掉它——而漏掉的恰好是边界本身。
   */
  const MOMENTS = [
    [0, 0],
    [0, 30],
    [1, 30],
    [4, 30],
    [5, 30],
    [11, 59],
    [12, 0],
    [20, 30],
    [23, 59]
  ] as const

  it('一天里的任意时刻，四个日期组的骨架都一样', () => {
    for (const [hour, minute] of MOMENTS) {
      const at = new Date(2026, 2, 15, hour, minute, 0).getTime()
      const items = buildItems(fixtures(at), {}, at)
      expect({ hour, minute, labels: labels(items) }).toEqual({
        hour,
        minute,
        labels: ['今天', '昨天', '本周', '更早']
      })
    }
  })

  it('置顶把某组掏空后的骨架，同样不随时刻漂移', () => {
    for (const [hour, minute] of MOMENTS) {
      const at = new Date(2026, 2, 15, hour, minute, 0).getTime()
      const items = buildItems(fixtures(at), { today: true }, at)
      expect({ hour, minute, labels: labels(items) }).toEqual({
        hour,
        minute,
        labels: ['置顶', '昨天', '本周', '更早']
      })
    }
  })

  it('跨月边界也成立：从 3 月 1 日往前 30 天要退到 1 月 30 日（2026 年 2 月只有 28 天，跨的是两个月）', () => {
    const at = new Date(2026, 2, 1, 0, 30, 0).getTime()
    const items = buildItems(fixtures(at), {}, at)
    expect(labels(items)).toEqual(['今天', '昨天', '本周', '更早'])
  })
})
