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

  it('7 天内 → 周几', () => {
    expect(relativeTime(noonDaysAgo(3), NOW)).toBe('周四')
    expect(relativeTime(noonDaysAgo(6), NOW)).toBe('周一')
  })

  it('超过 7 天 → M月D日', () => {
    expect(relativeTime(noonDaysAgo(30), NOW)).toBe('2月13日')
  })

  it('与 groupLabel 同口径：同一个时刻不会一个说「昨天」另一个说「N 小时前」', () => {
    // 两个函数各写了一份「昨天」判断，口径必须一致，否则行尾文案会和
    // 它所在的分组自相矛盾（用户看到「本周」组里有一行写着「昨天」）。
    const justBeforeMidnight = new Date(2026, 2, 14, 23, 59, 0).getTime()
    expect(groupLabel(justBeforeMidnight, NOW)).toBe('昨天')
    expect(relativeTime(justBeforeMidnight, NOW)).toBe('昨天')
  })
})
