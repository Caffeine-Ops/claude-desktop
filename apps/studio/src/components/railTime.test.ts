import { describe, expect, it } from 'bun:test'

import { groupLabel, relativeTime } from './railTime'

/**
 * rail 列表的时间文案。两个函数都读「现在」，所以两个都接受可注入的
 * `nowMs`——测试一律把它钉死。
 *
 * 这份测试 2026-10-08 补齐，起因是 railGrouping.test.ts 的时间炸弹
 * （夹具用 `Date.now() - 1.2 天` 造「昨天」，测试进程跑 UTC 时每天上午
 * 必红）。修那个 bug 时给 relativeTime 也加了 `nowMs`，但当时没有任何
 * 调用方或测试在用它——**一个没人用的参数等于没被验证过的参数**，
 * 代码评审就是这么点出来的。这里把它补成真的有人用。
 *
 * 锚点刻意选 2026-03-15（周日）本地 12:00：正午离前后两个午夜各 12 小时，
 * 任何时区下都不会让下面的相对偏移越过日历边界。
 */
const NOW = new Date(2026, 2, 15, 12, 0, 0).getTime()
const MIN = 60 * 1000
const HOUR = 60 * MIN

/** 「N 天前的正午」——跨日的用例一律锚在正午，理由同上。 */
function noonDaysAgo(days: number): number {
  return new Date(2026, 2, 15 - days, 12, 0, 0).getTime()
}

describe('groupLabel', () => {
  it('同一日历天 → 今天（哪怕只差一分钟，也哪怕差了十小时）', () => {
    expect(groupLabel(NOW - MIN, NOW)).toBe('今天')
    expect(groupLabel(NOW - 11 * HOUR, NOW)).toBe('今天')
  })

  it('判的是日历天而不是 24 小时：差 13 小时但跨了午夜 → 昨天', () => {
    // 这正是那个 flaky bug 的本质——「多久以前」和「哪一天」是两件事。
    expect(groupLabel(new Date(2026, 2, 14, 23, 0, 0).getTime(), NOW)).toBe('昨天')
  })

  it('前天到 7 天内 → 本周（标签叫本周，语义是滚动 7 天）', () => {
    expect(groupLabel(noonDaysAgo(2), NOW)).toBe('本周')
    expect(groupLabel(noonDaysAgo(6), NOW)).toBe('本周')
  })

  it('超过 7 天 → 更早', () => {
    expect(groupLabel(noonDaysAgo(8), NOW)).toBe('更早')
    expect(groupLabel(noonDaysAgo(30), NOW)).toBe('更早')
  })

  it('整 7 天整是「更早」侧（边界取不到）', () => {
    expect(groupLabel(NOW - 7 * 24 * HOUR, NOW)).toBe('更早')
    expect(groupLabel(NOW - 7 * 24 * HOUR + MIN, NOW)).toBe('本周')
  })
})

describe('relativeTime', () => {
  it('不到一分钟 → 刚刚', () => {
    expect(relativeTime(NOW - 30 * 1000, NOW)).toBe('刚刚')
  })

  it('一小时内 → N 分钟前', () => {
    expect(relativeTime(NOW - MIN, NOW)).toBe('1 分钟前')
    expect(relativeTime(NOW - 59 * MIN, NOW)).toBe('59 分钟前')
  })

  it('同一天且超过一小时 → N 小时前', () => {
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('3 小时前')
  })

  it('跨到前一天 → 昨天（不再说「N 小时前」）', () => {
    expect(relativeTime(new Date(2026, 2, 14, 23, 0, 0).getTime(), NOW)).toBe('昨天')
    expect(relativeTime(noonDaysAgo(1), NOW)).toBe('昨天')
  })

  // 窗口是 6 天不是 7 天（2026-10-09 收窄，理由见 railTime.ts 注释与下方
  // 「第 7 天那一档」那条）。整 6 天是取不到的边界，所以这里取 3 天与 5 天。
  it('6 天内 → 周几', () => {
    expect(relativeTime(noonDaysAgo(3), NOW)).toBe('周四')
    expect(relativeTime(noonDaysAgo(5), NOW)).toBe('周二')
  })

  it('超过 7 天 → M月D日', () => {
    expect(relativeTime(noonDaysAgo(30), NOW)).toBe('2月13日')
  })

  /**
   * 与 groupLabel 的口径差异——**已知、刻意，不是 bug**。
   *
   * 这条原本写成「两个函数对同一时刻必须说同一个词」，是错的：
   * relativeTime 的 `diffMin < 60` 分支排在所有日历判断**之前**，所以
   * 午夜刚过时两者必然分叉。而且原来只探一个正午的点，那个点上永远
   * 分叉不了——**一条结构上不可能失败的测试，比没有测试更坏**，它提供
   * 的是虚假的安全感。代码评审点出来后改成下面这样：钉在真正会分叉的
   * 时刻上，把实际契约写清楚。
   *
   * 为什么不改代码去消除分叉：分组回答的是「哪一天」，行尾回答的是
   * 「多久以前」，本来就是两个问题。一条 31 分钟前的会话显示「31 分钟前」
   * 比显示「昨天」有用得多，哪怕它确实归在「昨天」组下。
   */
  it('午夜刚过时与 groupLabel 刻意分叉：分组说「昨天」，行尾说「31 分钟前」', () => {
    const justAfterMidnight = new Date(2026, 2, 15, 0, 30, 0).getTime()
    const lastNight = new Date(2026, 2, 14, 23, 59, 0).getTime()
    expect(groupLabel(lastNight, justAfterMidnight)).toBe('昨天')
    expect(relativeTime(lastNight, justAfterMidnight)).toBe('31 分钟前')
  })

  it('离午夜够远时两者才一致（这正是原测试唯一探过的那种点）', () => {
    const lastNight = new Date(2026, 2, 14, 23, 59, 0).getTime()
    expect(groupLabel(lastNight, NOW)).toBe('昨天')
    expect(relativeTime(lastNight, NOW)).toBe('昨天')
  })

  /**
   * 星期名窗口（6 天）比分组窗口（7 天）窄一天，所以第 7 天那一档落到
   * 「M月D日」——这是刻意的，见 railTime.ts 里的注释。修的是：原先两个
   * 窗口一样宽时，第 7 天会显示成**今天这个星期几**（今天周日、上周日的
   * 会话也写「周日」），读起来像今天的。
   */
  it('第 7 天那一档给日期而不是星期（否则会和今天同名）', () => {
    const lastSunday = new Date(2026, 2, 8, 13, 0, 0).getTime() // NOW 本身是周日
    expect(groupLabel(lastSunday, NOW)).toBe('本周') // 分组仍是 7 天窗口
    expect(relativeTime(lastSunday, NOW)).toBe('3月8日') // 行尾不再说「周日」
  })

  it('6 天这条边界：差一点不到 6 天给星期，刚过 6 天给日期', () => {
    const SIX_DAYS = 6 * 24 * HOUR
    expect(relativeTime(NOW - SIX_DAYS + MIN, NOW)).toBe('周一')
    expect(relativeTime(NOW - SIX_DAYS - MIN, NOW)).toBe('3月9日')
  })

  /**
   * 这条才是真正守住修复的那一条：**穷举**窗口内的每一档，断言没有任何
   * 一档会显示成今天的星期名。单点断言挡不住「有人把 6 改回 7」——穷举
   * 能，因为只要窗口放宽一天，同名那档立刻落回来。
   */
  it('窗口内任何一档都不会显示成今天这个星期几', () => {
    const todayName = '周日' // NOW = 2026-03-15 是周日
    for (let h = 1; h <= 7 * 24; h++) {
      const label = relativeTime(NOW - h * HOUR, NOW)
      if (label === todayName) {
        throw new Error(`${h} 小时前的条目显示成了今天的星期名「${todayName}」`)
      }
    }
  })
})
