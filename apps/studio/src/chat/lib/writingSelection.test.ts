import { describe, expect, it } from 'bun:test'
import { resolveSelectionScope, sliceCoversSelection } from './writingSelection'

describe('sliceCoversSelection · 良性侧（必须放行，否则兜底就白设了）', () => {
  it('纯文字块 + 选中其中一句 → 通过', () => {
    expect(
      sliceCoversSelection(
        '我们这个季度的目标是把交付周期压到两周以内，同时把线上故障率打对折。',
        '把交付周期压到两周以内，同时把线上故障率打对折'
      )
    ).toBe(true)
  })

  it('块里带 **加粗** 而选中的是渲染文本 → 仍通过（这正是兜底存在的意义，包含判定会误拒）', () => {
    expect(
      sliceCoversSelection(
        '本季度**核心目标**是把交付周期压缩到两周以内。',
        '本季度核心目标是把交付周期压缩到两周以内。'
      )
    ).toBe(true)
  })

  it('块里带行内代码与链接标记 → 仍通过', () => {
    expect(
      sliceCoversSelection(
        '发布前先运行 `bun test`，详见[部署手册](https://example.com/deploy)。',
        '发布前先运行 bun test，详见部署手册。'
      )
    ).toBe(true)
  })

  it('列表源码 vs 两个列表项的渲染文本 → 通过', () => {
    expect(
      sliceCoversSelection(
        '- 第一条要点是收敛接口\n- 第二条要点是补上回归测试',
        '第一条要点是收敛接口 第二条要点是补上回归测试'
      )
    ).toBe(true)
  })
})

describe('sliceCoversSelection · 真实风险侧（长切片 vs 短选区、同话题平行段）', () => {
  // 复审实测：旧的「字符覆盖率 ≥ 0.8」判据在这条上得 0.923 → 放行错块 → 相邻段被整块覆盖。
  it('同话题句式平行的相邻段 → 拒绝（顺序对不上：选区的「四周」在切片里根本没有）', () => {
    expect(
      sliceCoversSelection(
        '下季度目标是把交付周期从两周压缩到一周，同时保持质量不滑坡。',
        '把交付周期从四周压缩到两周'
      )
    ).toBe(false)
  })

  // 复审实测：旧判据得 1.000 → 放行。现在被最小长度门槛挡下。
  it('4 字短选区 vs 无关中文长段 → 拒绝（短选区在字符层面恒真，一律不予采信）', () => {
    expect(
      sliceCoversSelection(
        '今天团队讨论了压缩排期的可能性，两周之内很难压到位，需要再评估。',
        '压到两周'
      )
    ).toBe(false)
  })

  // 复审实测：旧判据得 0.882 → 放行。英文字母集小，覆盖率判据在英文上尤其失真。
  it('英文短选区 vs 完全无关的英文长段 → 拒绝', () => {
    expect(
      sliceCoversSelection(
        'The quarterly budget review has been moved to the last week of the month, and the finance team will circulate an updated agenda beforehand.',
        'deploy the new build'
      )
    ).toBe(false)
  })

  // 复审指出旧测试里那条「高频字」断言是空洞的：反过来写（长切片 vs 短选区）旧判据得 1.000。
  it('高频字堆成的长切片 vs 由高频字组成的短选区 → 拒绝（这正是旧判据被打穿的方向）', () => {
    expect(
      sliceCoversSelection('的了是在和有一二三四五六七八九十不我他这那你们就都要把上下', '的了是在和有')
    ).toBe(false)
  })

  it('长切片 vs 刚好够长但顺序被打乱的选区 → 拒绝（子序列要求保序，不是凑字数）', () => {
    expect(
      sliceCoversSelection(
        '把交付周期压到两周以内，同时把线上故障率打对折，这是本季度的硬指标。',
        '内以周两到压期周付交把折对打率障故'
      )
    ).toBe(false)
  })
})

describe('sliceCoversSelection · 平凡边界', () => {
  it('切成了完全不同的段落 → 拒绝', () => {
    expect(
      sliceCoversSelection('今天天气很好我们去公园散步吧。', '产品需求文档的初稿已经写完并同步给了客户')
    ).toBe(false)
  })

  it('切片比选区短、缺字 → 拒绝', () => {
    expect(sliceCoversSelection('交付周期', '把交付周期压到两周以内再看看')).toBe(false)
  })

  it('切片为空（兜底 range 越界）→ 拒绝', () => {
    expect(sliceCoversSelection('', '任何选中文字都不该在空切片上成立')).toBe(false)
  })

  it('选中文字为空 → 拒绝（没有可校验的依据）', () => {
    expect(sliceCoversSelection('一段正文', '   ')).toBe(false)
  })

  it('选中文字不足最小长度 → 一律拒绝，哪怕它确实就在切片里', () => {
    expect(sliceCoversSelection('把交付周期压到两周以内再看看', '交付周期压到')).toBe(false)
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
