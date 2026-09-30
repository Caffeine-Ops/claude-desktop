import { describe, expect, it } from 'bun:test'

import type { ThreadSummary } from '@desktop-shared/types'
import { buildItems } from './railGrouping'

/**
 * 侧栏列表的「拍平成一维数组喂虚拟滚动」那一步。原先内联在
 * RailSessionList.tsx 里，加置顶时抽出来——它是纯函数，而置顶最容易出
 * 的两个错（行在两个组里各出现一次、置顶组空着还画个标题）都只能靠
 * 断言守住，肉眼扫 UI 扫不出来。
 */

const DAY = 24 * 60 * 60 * 1000
/** 固定"现在"附近的相对时刻，避免测试在跨日那一刻抖动。 */
const now = Date.now()

function thread(id: string, agoMs: number): ThreadSummary {
  return { id, title: id, updatedAt: now - agoMs, turnCount: 1 }
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
const TODAY = thread('today', 60 * 1000)
const YESTERDAY = thread('yesterday', 1.2 * DAY)
const THIS_WEEK = thread('week', 3 * DAY)
const OLDER = thread('older', 30 * DAY)
const ALL = [TODAY, YESTERDAY, THIS_WEEK, OLDER] as const

describe('buildItems — 没有置顶时（回归保护）', () => {
  it('行为与加置顶之前逐项一致：按日期分组、顺序不变', () => {
    const items = buildItems(ALL, {})
    expect(labels(items)).toEqual(['今天', '昨天', '本周', '更早'])
    expect(rows(items)).toEqual(['today', 'yesterday', 'week', 'older'])
  })

  it('不产生「置顶」标签', () => {
    expect(labels(buildItems(ALL, {}))).not.toContain('置顶')
  })

  it('空列表产出空数组，不画任何标签', () => {
    expect(buildItems([], {})).toEqual([])
  })
})

describe('buildItems — 置顶', () => {
  it('置顶组排在最前，其余日期组顺序不变', () => {
    const items = buildItems(ALL, { week: true })
    expect(labels(items)).toEqual(['置顶', '今天', '昨天', '更早'])
  })

  it('置顶的行从它原来的日期组里拿走，不在两处重复出现', () => {
    const items = buildItems(ALL, { week: true })
    expect(rows(items)).toEqual(['week', 'today', 'yesterday', 'older'])
    expect(rows(items).filter((id) => id === 'week')).toHaveLength(1)
  })

  it('某个日期组被置顶掏空后，不留下空标题', () => {
    // 'today' 是「今天」组里唯一一条，置顶它之后该组应整个消失。
    const items = buildItems(ALL, { today: true })
    expect(labels(items)).toEqual(['置顶', '昨天', '本周', '更早'])
  })

  it('多条置顶时，置顶组内仍按 updatedAt 倒序（与其它组同一节奏）', () => {
    const items = buildItems(ALL, { older: true, today: true })
    expect(rows(items)).toEqual(['today', 'older', 'yesterday', 'week'])
    expect(labels(items)).toEqual(['置顶', '昨天', '本周'])
  })

  it('全部置顶时只剩一个置顶组，没有任何日期组', () => {
    const items = buildItems(ALL, {
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
    const items = buildItems(ALL, { 'deleted-session': true })
    expect(labels(items)).toEqual(['今天', '昨天', '本周', '更早'])
    expect(rows(items)).toEqual(['today', 'yesterday', 'week', 'older'])
  })

  it('陈旧键与有效键混在一起时，只有有效的那条进置顶组', () => {
    const items = buildItems(ALL, { 'deleted-session': true, week: true })
    expect(labels(items)).toEqual(['置顶', '今天', '昨天', '更早'])
    expect(rows(items)).toEqual(['week', 'today', 'yesterday', 'older'])
  })
})

describe('buildItems — key 唯一性（虚拟滚动按 key 取项）', () => {
  it('所有项的 key 互不重复', () => {
    const items = buildItems(ALL, { today: true })
    const keys = items.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
