import { describe, it, expect } from 'bun:test'
import {
  splitBlocks,
  joinBlocks,
  spliceBlocks,
  locateBlockRangeByTextWithHint
} from './proposalBlocks'

describe('splitBlocks', () => {
  it('空行分隔的段落各自成块', () => {
    expect(splitBlocks('第一段。\n\n第二段。')).toEqual(['第一段。', '第二段。'])
  })
  it('标题单独成块', () => {
    expect(splitBlocks('## 章节标题\n\n正文。')).toEqual(['## 章节标题', '正文。'])
  })
  it('围栏代码整体一块（内部空行不切）', () => {
    const md = '```mermaid\ngraph TD\n\nA-->B\n```'
    expect(splitBlocks(md)).toEqual([md])
  })
  it('GFM 表格整体一块', () => {
    const table = '| 列1 | 列2 |\n|---|---|\n| a | b |'
    expect(splitBlocks(`前言。\n\n${table}`)).toEqual(['前言。', table])
  })
  it('紧凑列表整体一块', () => {
    const list = '- 一\n- 二\n- 三'
    expect(splitBlocks(list)).toEqual([list])
  })
  it('松散列表（项间空行）不被拆散', () => {
    const list = '- 一\n\n- 二'
    expect(splitBlocks(list)).toEqual([list])
  })
  it('保留段末来源标注与图片行', () => {
    const md = '这段有依据。（据《白皮书》）\n\n![图](<kbasset://x/y.png>)'
    expect(splitBlocks(md)).toEqual(['这段有依据。（据《白皮书》）', '![图](<kbasset://x/y.png>)'])
  })
})

describe('joinBlocks 往返 + 幂等', () => {
  it('join(split(md)) 规范化后可再次 split 回同样的块（幂等）', () => {
    const md = '## 标题\n\n第一段。\n\n\n\n第二段。\n'
    const once = joinBlocks(splitBlocks(md))
    expect(once).toBe('## 标题\n\n第一段。\n\n第二段。')
    expect(joinBlocks(splitBlocks(once))).toBe(once)
  })
  it('保留 GFM 行尾两空格硬换行（不被 trim 吃掉）', () => {
    // 「第一行␠␠\n第二行」是一段（硬换行），整段应原样留存，split/join 往返不丢行尾空格。
    const md = '第一行  \n第二行'
    expect(splitBlocks(md)).toEqual([md])
    expect(joinBlocks(splitBlocks(md))).toBe(md)
  })
})

describe('spliceBlocks', () => {
  const md = 'A 段。\n\nB 段。\n\nC 段。'
  it('替换单块（start===end）只动那一块', () => {
    expect(spliceBlocks(md, { start: 1, end: 1 }, 'B 改。')).toBe('A 段。\n\nB 改。\n\nC 段。')
  })
  it('替换块区间为多块产出', () => {
    expect(spliceBlocks(md, { start: 0, end: 1 }, 'X1。\n\nX2。')).toBe('X1。\n\nX2。\n\nC 段。')
  })
  it('越界端点被夹紧', () => {
    expect(spliceBlocks(md, { start: 2, end: 99 }, 'C 改。')).toBe('A 段。\n\nB 段。\n\nC 改。')
  })
})

describe('locateBlockRangeByTextWithHint', () => {
  const md = ['# 标题', '第一段讲的是产品背景。', '第二段讲的是技术方案。', '第三段讲的是落地计划。'].join('\n\n')
  const H = { start: 0, end: 0 } // 单处命中时 hint 无影响，用零位占位

  it('单块命中：定位到该块', () => {
    expect(locateBlockRangeByTextWithHint(md, '第二段讲的是技术方案。', { start: 2, end: 2 })).toEqual({ start: 2, end: 2 })
  })

  it('选区文本的空白被折叠也能命中（换行 vs 源码空行）', () => {
    // 浏览器选区常把块间空行变成一个空格或直接相连
    expect(locateBlockRangeByTextWithHint(md, '第一段讲的是产品背景。 第二段讲的是技术方案。', H)).toEqual({ start: 1, end: 2 })
  })

  it('跨块选区：返回覆盖它的最小连续区间', () => {
    expect(locateBlockRangeByTextWithHint(md, '技术方案。第三段', H)).toEqual({ start: 2, end: 3 })
  })

  it('文字已不存在：返回 null', () => {
    expect(locateBlockRangeByTextWithHint(md, '这段文字草稿里根本没有', H)).toBeNull()
  })

  it('空 markdown / 空选区：返回 null', () => {
    expect(locateBlockRangeByTextWithHint('', '任意', H)).toBeNull()
    expect(locateBlockRangeByTextWithHint(md, '   ', H)).toBeNull()
  })

  const dup = ['复用段。', '中间段甲。', '复用段。', '中间段乙。', '复用段。'].join('\n\n')

  it('多处命中：选起点块离 hint 最近的一处', () => {
    // hint 指向第 2 处（块 2），应命中块 2 而非块 0
    expect(locateBlockRangeByTextWithHint(dup, '复用段。', { start: 2, end: 2 })).toEqual({ start: 2, end: 2 })
    // hint 指向末处（块 4）
    expect(locateBlockRangeByTextWithHint(dup, '复用段。', { start: 4, end: 4 })).toEqual({ start: 4, end: 4 })
  })

  it('单处命中：hint 无影响', () => {
    const m = ['甲。', '乙。', '丙。'].join('\n\n')
    expect(locateBlockRangeByTextWithHint(m, '乙。', { start: 0, end: 0 })).toEqual({ start: 1, end: 1 })
  })

  it('多处命中但离 hint 都很远：返回 null（复审 M4·防远处重复文字被误当目标）', () => {
    // dup 的命中在块 0/2/4；hint 指向块 20，最近命中（块 4）距离 16 > 5 上限 → 判原文已不在
    expect(locateBlockRangeByTextWithHint(dup, '复用段。', { start: 20, end: 20 })).toBeNull()
  })
})
