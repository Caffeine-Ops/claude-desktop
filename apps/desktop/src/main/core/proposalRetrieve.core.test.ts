import { describe, it, expect, test } from 'bun:test'

import {
  tokenize,
  chunkText,
  rankChunks,
  clampPassageText,
  CHUNK_MAX,
  PASSAGE_MAX_CHARS
} from './proposalRetrieve.core'

describe('tokenize', () => {
  it('CJK 取字符 bigram', () => {
    expect(tokenize('预问诊')).toEqual(['预问', '问诊'])
  })

  it('ASCII 按词小写', () => {
    expect(tokenize('Hello World-2')).toEqual(['hello', 'world', '2'])
  })

  it('中英混合 + 标点作分隔', () => {
    expect(tokenize('AI 问诊。')).toEqual(['ai', '问诊'])
  })

  it('单字 CJK 段退化为单字', () => {
    expect(tokenize('问 诊')).toEqual(['问', '诊'])
  })

  it('空串 → 空数组', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('chunkText', () => {
  it('按空行切段：两个均达下限的段落各自成块', () => {
    // 每段 ≥ CHUNK_MIN（90 字）→ 各自 flush 成块。
    const p1 = '第一段内容'.repeat(18) // 90 字
    const p2 = '第二段内容'.repeat(18)
    expect(chunkText(`${p1}\n\n${p2}`)).toHaveLength(2)
  })

  it('连续短段合并（总长 < CHUNK_MIN）', () => {
    // 三个短段累计仍 < CHUNK_MIN，合并为一块。
    expect(chunkText('短。\n\n更短。\n\n再短。')).toHaveLength(1)
  })

  it('超长单段按窗口硬切', () => {
    const long = '甲'.repeat(CHUNK_MAX * 2 + 10)
    const chunks = chunkText(long)
    expect(chunks.length).toBe(3)
    expect(chunks.every((c) => c.length <= CHUNK_MAX)).toBe(true)
  })

  it('空文本 → 空数组', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n   ')).toEqual([])
  })

  it('大表格不被窗口硬切，整块保留且分隔行完好', () => {
    // markdown 表格行间无空行 → 本是一个 block；其长度远超 CHUNK_MAX，
    // 旧逻辑会按 600 字窗口硬切（劈碎行/单元格），新逻辑应整块保留。
    const header = '| 指标 | 数值 | 说明 |\n| --- | --- | --- |\n'
    const row = '| 某项目某项目 | 一二三四五六 | 这是一行较长的说明文字用于把表格撑过长度上限 |\n'
    const table = header + row.repeat(40) // 约 1800+ 字，远超 CHUNK_MAX
    const chunks = chunkText(table)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('| --- | --- | --- |')
  })

  it('超长非表格段仍按窗口硬切（无回归，分割线 --- 不算表格）', () => {
    // 纯 --- 分隔线无管道符，不应被当作表格；超长纯文本仍按窗口切。
    const long = '甲'.repeat(CHUNK_MAX + 50) + '\n\n---\n\n' + '乙'.repeat(CHUNK_MAX + 50)
    const chunks = chunkText(long)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })
})

describe('rankChunks', () => {
  const chunks = [
    { text: '本平台的智能预问诊系统支持多轮对话与分诊建议，覆盖门诊全流程。', title: 'A', mirrorPath: '/a' },
    { text: '售后服务条款与质保期限说明。', title: 'B', mirrorPath: '/b' },
    { text: '智能预问诊系统的部署架构与安全合规要求。', title: 'C', mirrorPath: '/c' }
  ]

  it('相关块排前，无关块被过滤', () => {
    const out = rankChunks('智能预问诊系统', chunks)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(['A', 'C']).toContain(out[0].title)
    // 完全无关的 B（不含「预问诊」bigram）不应进结果。
    expect(out.find((p) => p.title === 'B')).toBeUndefined()
  })

  it('topK 截断', () => {
    expect(rankChunks('智能预问诊系统', chunks, { topK: 1 })).toHaveLength(1)
  })

  it('query 无 term → 空', () => {
    expect(rankChunks('', chunks)).toEqual([])
    expect(rankChunks('。、，', chunks)).toEqual([])
  })

  it('空语料 → 空', () => {
    expect(rankChunks('智能预问诊', [])).toEqual([])
  })

  it('零命中（query 与所有块无交集）→ 空', () => {
    expect(rankChunks('量子区块链元宇宙', chunks)).toEqual([])
  })
})

describe('clampPassageText（单片段注入上限·防巨表撑爆提示词）', () => {
  it('未超限 → 原样返回', () => {
    expect(clampPassageText('短表格内容')).toBe('短表格内容')
    const justUnder = 'x'.repeat(PASSAGE_MAX_CHARS)
    expect(clampPassageText(justUnder)).toBe(justUnder)
  })

  it('超限 → 截断、长度受控、带省略标记、保留头部（表头）', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `| 行${i} | 值 |`).join('\n')
    expect(big.length).toBeGreaterThan(PASSAGE_MAX_CHARS)
    const out = clampPassageText(big)
    expect(out.startsWith('| 行0 | 值 |')).toBe(true) // 表头/前部保留
    expect(out.endsWith('…（片段过长，余下已省略）')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(PASSAGE_MAX_CHARS + 20) // 截到上限内 + 短标记
  })

  it('超限时在换行边界截断，不切碎最后一行', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `| 行${i} | 值 |`).join('\n')
    const out = clampPassageText(big)
    const body = out.replace(/\n…（片段过长，余下已省略）$/, '')
    // 保留部分应以完整的一行结尾（最后一行不是被中途切断的半行）。
    expect(body.endsWith(' |')).toBe(true)
  })
})

import { chunkTextWithOffsets } from './proposalRetrieve.core'

test('chunkTextWithOffsets: offset 切片可回原文且与 text 一致', () => {
  const src = '第一段内容这里写满八十个字以上凑够最小块长度的要求一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥。\n\n第二段也要够长一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥再加一句话。'
  const chunks = chunkTextWithOffsets(src)
  expect(chunks.length).toBeGreaterThan(0)
  for (const c of chunks) {
    expect(c.charEnd).toBeGreaterThan(c.charStart)
    // 回切：用 offset 从原文截出的子串，trim 后等于 chunk.text
    expect(src.slice(c.charStart, c.charEnd).trim()).toBe(c.text)
  }
})

test('chunkText 仍等价于 chunkTextWithOffsets 的 text 投影', () => {
  const src = 'abc 一二三四五六七八九十甲乙丙丁戊己庚辛壬癸。\n\nxyz 子丑寅卯辰巳午未申酉戌亥一二三四五六。'
  const { chunkText } = require('./proposalRetrieve.core')
  expect(chunkText(src)).toEqual(chunkTextWithOffsets(src).map((c: { text: string }) => c.text))
})
