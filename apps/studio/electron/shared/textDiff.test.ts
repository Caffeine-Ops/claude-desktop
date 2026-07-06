import { describe, it, expect } from 'bun:test'

import { diffChars, type DiffSegment } from './textDiff'

// 把分段还原成两条流，验证「原文=equal+delete、改写后=equal+insert」都能无损拼回原串——
// 这是 diff 正确性的底线不变量：不管怎么切，去掉高亮都得还原两段原文。
const beforeStream = (segs: DiffSegment[]): string =>
  segs
    .filter((s) => s.op !== 'insert')
    .map((s) => s.text)
    .join('')
const afterStream = (segs: DiffSegment[]): string =>
  segs
    .filter((s) => s.op !== 'delete')
    .map((s) => s.text)
    .join('')

describe('diffChars', () => {
  it('完全相同 → 单个 equal，无高亮', () => {
    const segs = diffChars('本项目将于近期交付', '本项目将于近期交付')
    expect(segs).toEqual([{ op: 'equal', text: '本项目将于近期交付' }])
  })

  it('两侧空串边界', () => {
    expect(diffChars('', '')).toEqual([])
    expect(diffChars('abc', '')).toEqual([{ op: 'delete', text: 'abc' }])
    expect(diffChars('', 'abc')).toEqual([{ op: 'insert', text: 'abc' }])
  })

  it('中文替换：保留公共前缀、只标改动段', () => {
    const segs = diffChars('本项目将于近期交付', '本项目将于2026 Q3交付')
    // 公共前缀「本项目将于」与后缀「交付」应作为 equal 保留，中间「近期」删、「2026 Q3」增。
    expect(segs.some((s) => s.op === 'equal' && s.text.includes('本项目将于'))).toBe(true)
    expect(segs.some((s) => s.op === 'delete' && s.text === '近期')).toBe(true)
    expect(segs.some((s) => s.op === 'insert' && s.text === '2026 Q3')).toBe(true)
  })

  it('两条流都能无损还原原串（核心不变量）', () => {
    const before = '本项目将于近期交付，预计由团队负责。'
    const after = '本项目将于2026 Q3交付，由张工团队负责实施。'
    const segs = diffChars(before, after)
    expect(beforeStream(segs)).toBe(before)
    expect(afterStream(segs)).toBe(after)
  })

  it('折叠被改动夹住的孤字（防雪花）：不留单字 equal 岛', () => {
    // 「a1b」→「a2b」，中间无公共；构造夹住的单字公共：「Xa,bY」→「Xc,dY」，逗号是夹在
    // 改动中间的孤字，应被折进改动、不作为独立 equal 段留下。
    const segs = diffChars('好，坏', '棒，糟')
    const middleEqual = segs.find((s) => s.op === 'equal' && s.text === '，')
    expect(middleEqual).toBeUndefined()
    // 但还原不变量仍成立。
    expect(beforeStream(segs)).toBe('好，坏')
    expect(afterStream(segs)).toBe('棒，糟')
  })

  it('保留真·未改前后缀的公共段（别误折首尾）', () => {
    const segs = diffChars('前缀X后缀', '前缀Y后缀')
    expect(segs.some((s) => s.op === 'equal' && s.text === '前缀')).toBe(true)
    expect(segs.some((s) => s.op === 'equal' && s.text === '后缀')).toBe(true)
  })

  it('码点感知：不劈裂代理对（emoji）', () => {
    const segs = diffChars('a😀b', 'a😀c')
    // 😀 属于公共部分，应完整留在某个 equal 段里、不被切成半个。
    expect(segs.some((s) => s.op === 'equal' && s.text.includes('😀'))).toBe(true)
    expect(beforeStream(segs)).toBe('a😀b')
    expect(afterStream(segs)).toBe('a😀c')
  })
})
