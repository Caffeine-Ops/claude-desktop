import { describe, expect, it } from 'bun:test'
import {
  isSelectionLongEnoughForFallback,
  resolveSelectionScope,
  sliceCoversSelection
} from './writingSelection'

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

  // 复审实测：旧的覆盖率判据得 0.882 → 放行。而这条测试的**上一版是靠切片短侥幸通过的**
  // ——把切片换成同样无关但更长的段落，纯子序列判据同样会放行（拉丁字符集小，见常量注释的
  // 蒙特卡洛表：12 字母 vs 600 字母切片假阳性 66%）。现在挡住它的是**拉丁档长度门槛**，
  // 不是子序列本身，故断言写成 known-limitation 的形式：短拉丁选区一律不予采信。
  it('英文短选区 vs 无关的英文长段 → 拒绝（靠的是拉丁档 80 字门槛，不是子序列）', () => {
    const longSlice =
      'The quarterly budget review has been moved to the last week of the month, and the finance team will circulate an updated agenda beforehand. Please make sure every department submits its headcount plan before the deadline, since the consolidated forecast has to reach the board by Friday afternoon at the latest.'
    expect(sliceCoversSelection(longSlice, 'deploy the new build')).toBe(false)
  })

  // 已知盲区，钉住现状而不是钉住「安全」：选区一旦越过拉丁档门槛，子序列对拉丁文本仍然偏弱
  // ——字符集只有 26 个，够长的无关文本几乎总能按序凑出任意字母串。
  // Task 11（源码级精确匹配）到位后整个兜底连同本函数一起删除；在那之前这条测试的作用是
  // 让接手的人一眼看到「门槛之上没有强度」，不要误以为子序列本身守得住拉丁文本。
  it('【已知盲区】越过门槛的拉丁长选区 vs 足够长的无关拉丁文本 → 仍会被放行', () => {
    const need = 'transitionplanningtodotracks'.repeat(3) // 84 字母，越过 80 门槛
    // 切片字符集覆盖不到选区时仍会拒（'i'/'p'/'l'… 不在 'trans' 里）：
    expect(sliceCoversSelection('trans'.repeat(400), need)).toBe(false)
    // 但只要切片够长、字符集覆盖得到，子序列就成立——这正是盲区：
    expect(sliceCoversSelection('abcdefghijklmnopqrstuvwxyz'.repeat(120), need)).toBe(true)
  })

  // 复审指出旧测试里那条「高频字」断言是空洞的：`'的了是在和有'` 就是长串的**字面前缀**，
  // 子序列必然成立，它只被长度门槛（6 < 12）拒掉，根本没检验到子序列那一层。
  // 改成 ≥12 字的高频字选区、且顺序与切片不同，把判定压到子序列层。
  it('高频字组成的长选区、顺序与切片对不上 → 拒绝（这一条真正检验的是子序列，不是长度门槛）', () => {
    const slice = '的了是在和有一二三四五六七八九十不我他这那你们就都要把上下'
    const need = '下上把要都就们你那这他我不十九八七六五四三二一有和在是了的'
    expect([...need].length).toBeGreaterThanOrEqual(12) // 确认没被长度门槛短路
    expect(sliceCoversSelection(slice, need)).toBe(false)
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

describe('isSelectionLongEnoughForFallback · 字符集自适应门槛', () => {
  it('纯中文 12 字 → 够长（中文档门槛 12）', () => {
    expect(isSelectionLongEnoughForFallback('把交付周期压到两周以内啦')).toBe(true)
  })

  it('纯中文 11 字 → 不够长', () => {
    expect(isSelectionLongEnoughForFallback('把交付周期压到两周以内')).toBe(false)
  })

  it('12 个拉丁字母 → 不够长（拉丁字符集小，同长度下假阳性率高两个数量级）', () => {
    expect(isSelectionLongEnoughForFallback('deploybuild!')).toBe(false)
  })

  it('80+ 个拉丁字母 → 够长', () => {
    expect(isSelectionLongEnoughForFallback('transitionplanningtodotracks'.repeat(3))).toBe(true)
  })

  // workplace-writing 快道（周报/述职）的典型选区：中文里嵌大量数字与百分号，
  // CJK 占比不到一半 → 落进拉丁档，按 80 判。
  it('数字密集的中文（CJK 占比 < 50%）落进拉丁档 → 14 字不够长', () => {
    expect(isSelectionLongEnoughForFallback('2026年Q3营收增长12%')).toBe(false)
    expect(isSelectionLongEnoughForFallback('12%毛利率38%客户91%')).toBe(false)
  })

  it('空白 / 空串 → 不够长', () => {
    expect(isSelectionLongEnoughForFallback('   \n  ')).toBe(false)
    expect(isSelectionLongEnoughForFallback('')).toBe(false)
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
