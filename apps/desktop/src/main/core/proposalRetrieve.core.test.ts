import { describe, it, expect } from 'bun:test'

import { tokenize, chunkText, rankChunks, CHUNK_MAX } from './proposalRetrieve.core'

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
