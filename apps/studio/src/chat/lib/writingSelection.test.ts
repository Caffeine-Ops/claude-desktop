import { describe, expect, it } from 'bun:test'
import { resolveSelectionScope } from './writingSelection'

describe('resolveSelectionScope', () => {
  it('同节内正序选区 → 起止块区间原样保留', () => {
    expect(
      resolveSelectionScope(
        { sectionName: '1-a.md', blockIndex: 1 },
        { sectionName: '1-a.md', blockIndex: 3 }
      )
    ).toEqual({ sectionName: '1-a.md', range: { start: 1, end: 3 } })
  })

  it('从下往上拖（终点块号小于起点）→ 区间归一成 start<=end', () => {
    expect(
      resolveSelectionScope(
        { sectionName: '1-a.md', blockIndex: 4 },
        { sectionName: '1-a.md', blockIndex: 2 }
      )
    ).toEqual({ sectionName: '1-a.md', range: { start: 2, end: 4 } })
  })

  it('单块选区 → 起止同一块', () => {
    expect(
      resolveSelectionScope(
        { sectionName: '2-b.md', blockIndex: 0 },
        { sectionName: '2-b.md', blockIndex: 0 }
      )
    ).toEqual({ sectionName: '2-b.md', range: { start: 0, end: 0 } })
  })

  it('跨节选区吸附到【起点所在节】，且退化为单块 —— 绝不把终点节的块号当本节块号用', () => {
    expect(
      resolveSelectionScope(
        { sectionName: '1-a.md', blockIndex: 2 },
        { sectionName: '2-b.md', blockIndex: 5 }
      )
    ).toEqual({ sectionName: '1-a.md', range: { start: 2, end: 2 } })
  })

  it('终点没落在任何块上（拖过纸面底部）→ 按同起点单块处理', () => {
    expect(resolveSelectionScope({ sectionName: '1-a.md', blockIndex: 3 }, null)).toEqual({
      sectionName: '1-a.md',
      range: { start: 3, end: 3 }
    })
  })

  it('起点不在任何块上 → null（不成立的选区，不发改写）', () => {
    expect(resolveSelectionScope(null, { sectionName: '1-a.md', blockIndex: 1 })).toBeNull()
  })

  it('起点块号是 NaN（脏 data 属性）→ null，不让 NaN 漏进下游的越界检查', () => {
    expect(resolveSelectionScope({ sectionName: '1-a.md', blockIndex: NaN }, null)).toBeNull()
  })

  it('终点块号是 NaN → 忽略终点、退化为起点单块，而不是整体作废', () => {
    expect(
      resolveSelectionScope(
        { sectionName: '1-a.md', blockIndex: 1 },
        { sectionName: '1-a.md', blockIndex: NaN }
      )
    ).toEqual({ sectionName: '1-a.md', range: { start: 1, end: 1 } })
  })

  it('负块号 → null（data 属性异常，宁可不改）', () => {
    expect(resolveSelectionScope({ sectionName: '1-a.md', blockIndex: -1 }, null)).toBeNull()
  })
})
