import { describe, it, expect } from 'bun:test'

import { parseCitations, trigramOverlap } from './proposal'

describe('parseCitations', () => {
  it('无引用 → 空数组', () => {
    expect(parseCitations('这是一段没有任何来源标注的正文。')).toEqual([])
    expect(parseCitations('')).toEqual([])
  })

  it('单条引用 → 一段正文 + 单文件', () => {
    const out = parseCitations('智能预问诊系统支持多轮对话。（据《产品白皮书》）')
    expect(out).toHaveLength(1)
    expect(out[0].files).toEqual(['产品白皮书'])
    expect(out[0].paragraph).toBe('智能预问诊系统支持多轮对话。')
  })

  it('一组多文件（空格 / 顿号分隔都识别）', () => {
    expect(parseCitations('正文。（据《A》《B》）')[0].files).toEqual(['A', 'B'])
    expect(parseCitations('正文。（据《A》、《B》）')[0].files).toEqual(['A', 'B'])
  })

  it('组内同名文件去重', () => {
    expect(parseCitations('正文。（据《A》《A》）')[0].files).toEqual(['A'])
  })

  it('相邻两段：各自正文归属到各自引用之前', () => {
    const out = parseCitations('第一段内容。（据《A》）\n\n第二段内容。（据《B》《C》）')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ paragraph: '第一段内容。', files: ['A'] })
    expect(out[1]).toEqual({ paragraph: '第二段内容。', files: ['B', 'C'] })
  })

  it('空引用组（无《》）跳过', () => {
    expect(parseCitations('正文。（据无名）')).toEqual([])
  })
})

describe('trigramOverlap', () => {
  it('全等 → 1', () => {
    expect(trigramOverlap('智能预问诊系统', '智能预问诊系统')).toBe(1)
  })

  it('完全无重叠 → 0', () => {
    expect(trigramOverlap('aaaa', 'bbbb')).toBe(0)
  })

  it('部分重叠 → 介于 0 和 1（且高于阈值）', () => {
    const o = trigramOverlap(
      '智能预问诊系统支持多轮对话',
      '本平台的智能预问诊系统支持多轮对话与分诊建议，覆盖门诊全流程'
    )
    expect(o).toBeGreaterThan(0.5)
    expect(o).toBeLessThanOrEqual(1)
  })

  it('短串（<3字）退化为子串判定', () => {
    expect(trigramOverlap('预诊', '智能预诊流程')).toBe(1)
    expect(trigramOverlap('问诊', '智能预诊流程')).toBe(0)
  })

  it('空串 → 0', () => {
    expect(trigramOverlap('', 'abc')).toBe(0)
    expect(trigramOverlap('abc', '')).toBe(0)
  })

  it('忽略空白后比较', () => {
    expect(trigramOverlap('智 能 预 问 诊', '智能预问诊')).toBe(1)
  })
})
