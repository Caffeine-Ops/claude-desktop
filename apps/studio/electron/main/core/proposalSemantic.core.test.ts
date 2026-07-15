import { test, expect } from 'bun:test'
import {
  cosineTopK,
  cosineTopKRows,
  fuseRRF,
  passagesToHits,
  fillHitsToK,
  rerankWindow,
  applyRerank
} from './proposalSemantic.core'
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

// ── cosineTopKRows ─────────────────────────────────────────────────────────────
// filterHitsByScopes（后置过滤）已删：scope 过滤改在 worker 打分前做（cosineTopKRows），
// 窄产品域不再被全库 top-k 挤出。这里只测新的前置过滤内核。

test('cosineTopKRows: 只对 allowedRows 打分，域外行绝不出现', () => {
  // 3 行 2 维，已归一化。row1 与 q 完全同向（全库最高分），但不在 allowedRows —— 必须被排除。
  const m = new Float32Array([0.7071, 0.7071, /*row0*/ 1, 0, /*row1*/ 0, 1 /*row2*/])
  const q = new Float32Array([1, 0])
  const top = cosineTopKRows(q, m, [0, 2], 2, 3)
  expect(top.length).toBe(2)                       // 只有 2 行可打分，k=3 也只回 2
  expect(top.map((h) => h.row)).not.toContain(1)   // 全库最高分行被域过滤挡在打分之外
  expect(top[0].row).toBe(0)                       // 45° 优于 90°
  expect(top[0].score).toBeCloseTo(0.7071, 4)
  expect(top[1].row).toBe(2)
  expect(top[1].score).toBeCloseTo(0, 5)
  expect(top[0].score).toBeGreaterThan(top[1].score)
})

test('cosineTopKRows: 空 allowedRows → 空结果', () => {
  const m = new Float32Array([1, 0, 0, 1])
  const q = new Float32Array([1, 0])
  expect(cosineTopKRows(q, m, [], 2, 5)).toEqual([])
})

test('cosineTopKRows: allowedRows=全行 时与 cosineTopK 等价', () => {
  const m = new Float32Array([1, 0, 0, 1, 0.7071, 0.7071])
  const q = new Float32Array([0.6, 0.8])
  const all = cosineTopKRows(q, m, [0, 1, 2], 2, 3)
  const ref = cosineTopK(q, m, 3, 2, 3)
  expect(all).toEqual(ref)
})

function makeHit(productLine: string, product: string, mirrorPath: string, snippet = 'x'): SemanticHit {
  return { title: '', sourcePath: '', mirrorPath, productLine, product, text: snippet, snippet, score: 0 }
}

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

// ── P1 cross-encoder 重排选择纯核 ────────────────────────────────────────────

test('rerankWindow: 取融合结果前 M 行、保序、不足 M 全取', () => {
  const fused = [{ row: 7, score: 3 }, { row: 2, score: 2 }, { row: 5, score: 1 }]
  expect(rerankWindow(fused, 2)).toEqual([7, 2])   // 前 2，保 RRF 序
  expect(rerankWindow(fused, 10)).toEqual([7, 2, 5]) // 不足 M → 全取
  expect(rerankWindow([], 5)).toEqual([])            // 空融合 → 空
  expect(rerankWindow(fused, 0)).toEqual([])         // M=0 → 空（负数亦然，见实现 max(0,m)）
})

test('applyRerank: 按 reranker 分降序取 top-k、score 用 reranker 分', () => {
  const rows = [7, 2, 5]
  const scores = [0.1, 0.9, 0.5] // row2 最相关、row5 次、row7 最低
  expect(applyRerank(rows, scores, 2)).toEqual([
    { row: 2, score: 0.9 },
    { row: 5, score: 0.5 }
  ])
})

test('applyRerank: 同分保留输入(RRF)序——稳定降序', () => {
  expect(applyRerank([7, 2], [0.5, 0.5], 2)).toEqual([
    { row: 7, score: 0.5 },
    { row: 2, score: 0.5 }
  ])
})

test('applyRerank: 长度不匹配 / 空 → 空数组（调用方据此回落 RRF）', () => {
  expect(applyRerank([7, 2], [0.5], 2)).toEqual([]) // reranker 输出与候选错位 → 视为失败
  expect(applyRerank([], [], 5)).toEqual([])
})
