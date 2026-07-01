import { describe, it, expect } from 'bun:test'
import { splitBlocks, joinBlocks, spliceBlocks } from './proposalBlocks'

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
