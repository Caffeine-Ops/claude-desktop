import { test, expect } from 'bun:test'
import { cosineTopK, fuseRRF, passagesToHits } from './proposalSemantic.core'

test('cosineTopK: 取最近邻、k 截断、降序', () => {
  // 3 行 2 维，已归一化
  const m = new Float32Array([1, 0, /*row0*/ 0, 1, /*row1*/ 0.7071, 0.7071 /*row2*/])
  const q = new Float32Array([1, 0])
  const top = cosineTopK(q, m, 3, 2, 2)
  expect(top.length).toBe(2)
  expect(top[0].row).toBe(0)            // 与 q 同向 → 最高
  expect(top[0].score).toBeCloseTo(1, 5)
  expect(top[1].row).toBe(2)            // 45° 次之
  expect(top[0].score).toBeGreaterThan(top[1].score)
})

test('fuseRRF: 公共 row 得分叠加、单路 row 也在、降序', () => {
  const bm25 = [{ row: 5, rank: 0 }, { row: 9, rank: 1 }]
  const vec  = [{ row: 5, rank: 0 }, { row: 7, rank: 1 }]
  const fused = fuseRRF(bm25, vec, 60)
  expect(fused[0].row).toBe(5)          // 两路都第 1 → 最高
  const rows = fused.map((f) => f.row).sort((a, b) => a - b)
  expect(rows).toEqual([5, 7, 9])       // 并集
  for (let i = 1; i < fused.length; i++) expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score)
})

test('passagesToHits: 非空 passages → 等长 hits、字段映射正确、snippet 截 160 字符', () => {
  // 构造超过 160 字符的文本，验证 snippet 被截断
  const longText = 'A'.repeat(200)
  const passages = [
    { text: longText, title: '标题一', mirrorPath: '/mirror/foo.md', score: 0.9 },
    { text: 'short', title: '标题二', mirrorPath: '/mirror/bar.md', score: 0.5 },
  ]
  const hits = passagesToHits(passages)
  // 等长：passage 数 = hit 数
  expect(hits.length).toBe(passages.length)
  // 字段携带正确
  expect(hits[0].title).toBe('标题一')
  expect(hits[0].mirrorPath).toBe('/mirror/foo.md')
  expect(hits[0].score).toBe(0.9)
  // snippet 截 160，text 保留全文（不截断）
  expect(hits[0].snippet).toBe(longText.slice(0, 160))
  expect(hits[0].snippet.length).toBe(160)
  expect(hits[0].text).toBe(longText)          // 全文注入字段不截断
  expect(hits[0].text.length).toBe(200)
  // BM25 腿不提供源路径 / 产品线 / 产品，置空字符串
  expect(hits[0].sourcePath).toBe('')
  expect(hits[0].productLine).toBe('')
  expect(hits[0].product).toBe('')
  // 短文本：text = snippet = 原文
  expect(hits[1].snippet).toBe('short')
  expect(hits[1].text).toBe('short')
})
