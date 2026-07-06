import { test, expect } from 'bun:test'
import { cosineTopK, fuseRRF } from './proposalSemantic.core'

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
