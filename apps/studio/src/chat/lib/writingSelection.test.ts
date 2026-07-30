import { describe, expect, it } from 'bun:test'
import { resolveSelectionScope, sliceCoversSelection } from './writingSelection'

describe('sliceCoversSelection', () => {
  it('纯文字块 + 选中其中一句 → 通过', () => {
    expect(
      sliceCoversSelection('我们这个季度的目标是把交付周期压到两周以内。', '交付周期压到两周以内')
    ).toBe(true)
  })

  it('块里带 **加粗** 而选中的是渲染文本 → 仍通过（这正是兜底存在的意义，包含判定会误拒）', () => {
    expect(
      sliceCoversSelection('本季度**核心目标**是把交付周期压到两周。', '本季度核心目标是把交付周期压到两周。')
    ).toBe(true)
  })

  it('块里带行内代码与链接标记 → 仍通过', () => {
    expect(
      sliceCoversSelection('先运行 `bun test`，详见[部署手册](https://x)。', '先运行 bun test，详见部署手册。')
    ).toBe(true)
  })

  it('列表源码 vs 两个列表项的渲染文本 → 通过', () => {
    expect(sliceCoversSelection('- 第一条要点\n- 第二条要点', '第一条要点 第二条要点')).toBe(true)
  })

  it('切成了完全不同的段落 → 拒绝', () => {
    expect(sliceCoversSelection('今天天气很好我们去公园散步吧。', '产品需求文档的初稿')).toBe(false)
  })

  it('只有一半字符对得上 → 拒绝（覆盖率不到阈值）', () => {
    expect(sliceCoversSelection('交付周期', '交付周期压到两周以内')).toBe(false)
  })

  it('高频字的偶然重合不足以蒙混过关', () => {
    expect(sliceCoversSelection('的了是在和有', '的了是在和有一二三四五六七八')).toBe(false)
  })

  it('切片为空（兜底 range 越界）→ 拒绝', () => {
    expect(sliceCoversSelection('', '任何选中文字')).toBe(false)
  })

  it('选中文字为空 → 拒绝（没有可校验的依据）', () => {
    expect(sliceCoversSelection('一段正文', '   ')).toBe(false)
  })

  it('同一个字在选区里出现多次、块里只有一个 → 按出现次数消耗，不放行', () => {
    expect(sliceCoversSelection('好', '好好好好好')).toBe(false)
  })
})

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
