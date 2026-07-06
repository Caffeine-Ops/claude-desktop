import { test, expect } from 'bun:test'
import { cosineTopK, fuseRRF, passagesToHits, filterHitsByScopes, fillHitsToK } from './proposalSemantic.core'
import type { SemanticHit } from '../../shared/kbIndex'

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

// ── filterHitsByScopes ─────────────────────────────────────────────────────────

function makeHit(productLine: string, product: string, mirrorPath: string, snippet = 'x'): SemanticHit {
  return { title: '', sourcePath: '', mirrorPath, productLine, product, text: snippet, snippet, score: 0 }
}

test('filterHitsByScopes: 只保留在域内的命中', () => {
  const hits = [
    makeHit('PL1', 'P1', '/a.md'),
    makeHit('PL2', 'P2', '/b.md'),
    makeHit('PL1', 'P3', '/c.md'),
  ]
  const scopes = [{ productLine: 'PL1', product: 'P1' }]
  const out = filterHitsByScopes(hits, scopes)
  expect(out.length).toBe(1)
  expect(out[0].mirrorPath).toBe('/a.md')
})

test('filterHitsByScopes: 空 scopes → 空结果', () => {
  const hits = [makeHit('PL1', 'P1', '/a.md')]
  expect(filterHitsByScopes(hits, [])).toEqual([])
})

test('filterHitsByScopes: 全命中在域内 → 全保留', () => {
  const hits = [makeHit('PL1', 'P1', '/a.md'), makeHit('PL2', 'P2', '/b.md')]
  const scopes = [{ productLine: 'PL1', product: 'P1' }, { productLine: 'PL2', product: 'P2' }]
  expect(filterHitsByScopes(hits, scopes).length).toBe(2)
})

// ── fillHitsToK ────────────────────────────────────────────────────────────────

test('fillHitsToK: primary 在前、去重 mirrorPath+snippet、总量 ≤ k', () => {
  const p1 = makeHit('PL1', 'P1', '/a.md', 'alpha')
  const p2 = makeHit('PL1', 'P1', '/b.md', 'beta')
  // backfill 含一条与 p1 重复（同 mirrorPath+snippet）、一条新
  const b1 = makeHit('PL1', 'P1', '/a.md', 'alpha')  // dup of p1
  const b2 = makeHit('PL1', 'P1', '/c.md', 'gamma')  // new
  const b3 = makeHit('PL1', 'P1', '/d.md', 'delta')  // new
  const out = fillHitsToK([p1, p2], [b1, b2, b3], 4)
  // primary 在前（/a /b），去重后补 /c /d，共 4
  expect(out.length).toBe(4)
  expect(out[0].mirrorPath).toBe('/a.md')
  expect(out[1].mirrorPath).toBe('/b.md')
  expect(out[2].mirrorPath).toBe('/c.md')
  expect(out[3].mirrorPath).toBe('/d.md')
})

test('fillHitsToK: k 限制上界', () => {
  const primaries = [makeHit('PL', 'P', '/a.md'), makeHit('PL', 'P', '/b.md')]
  const backs = [makeHit('PL', 'P', '/c.md')]
  // k=2，backfill 里的 /c 不应被纳入
  const out = fillHitsToK(primaries, backs, 2)
  expect(out.length).toBe(2)
})

test('fillHitsToK: primary 不足时补齐到 k', () => {
  const primary = [makeHit('PL', 'P', '/a.md')]
  const backs = [makeHit('PL', 'P', '/b.md'), makeHit('PL', 'P', '/c.md')]
  const out = fillHitsToK(primary, backs, 3)
  expect(out.length).toBe(3)
  expect(out[0].mirrorPath).toBe('/a.md')
})
