/**
 * 语义检索纯核：余弦 top-k + RRF 融合 + BM25 降级映射。无 fs/electron，可 bun test 直测。
 * 调用方（kbSemanticSearch/embedWorker）保证传入向量【已 L2 归一化】，故余弦=点积。
 */
import type { SemanticHit } from '../../shared/kbIndex'
import type { RetrievedPassage } from './proposalRetrieve.core'

/**
 * BM25 降级腿的 passage→SemanticHit 映射。抽成纯函数放 core：kbSemanticSearch 本体
 * import electron 进不了 bun test，降级「不返空、字段映射正确」的可测部分收敛在这里。
 * sourcePath/productLine/product 置空——BM25 腿只有镜像路径与标题（meta 表是向量腿才有）。
 */
export function passagesToHits(passages: readonly RetrievedPassage[]): SemanticHit[] {
  return passages.map((p) => ({
    title: p.title, sourcePath: '', mirrorPath: p.mirrorPath,
    productLine: '', product: '', text: p.text, snippet: p.text.slice(0, 160), score: p.score
  }))
}

/** 对归一化向量矩阵（行优先，rows×dim）算与 query 的点积，返回降序 top-k。 */
export function cosineTopK(
  query: Float32Array, matrix: Float32Array, rows: number, dim: number, k: number
): { row: number; score: number }[] {
  const scored: { row: number; score: number }[] = new Array(rows)
  for (let r = 0; r < rows; r++) {
    let s = 0
    const base = r * dim
    for (let d = 0; d < dim; d++) s += query[d] * matrix[base + d]
    scored[r] = { row: r, score: s }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

/**
 * 命中按产品域过滤：只留 (productLine,product) 落在 scopes 集内的。
 * 空 scopes → 返空（调用方先短路：scopes.length===0 时不应走到这里，调用方保证）。
 * 接受结构子类型 { productLine, product } 让纯核不 import proposalPrompt（含 electron）。
 */
export function filterHitsByScopes(
  hits: readonly SemanticHit[],
  scopes: readonly { productLine: string; product: string }[]
): SemanticHit[] {
  if (scopes.length === 0) return []
  // NUL 分隔符：productLine/product 均为路径片段，不含 NUL，键唯一
  const set = new Set(scopes.map((s) => `${s.productLine}\0${s.product}`))
  return hits.filter((h) => set.has(`${h.productLine}\0${h.product}`))
}

/**
 * 主结果不足 k 时用备选补齐。去重键 = mirrorPath+snippet（同文件同片段=同 chunk）。
 * 主结果在前，备选追加，总量 ≤ k。
 */
export function fillHitsToK(
  primary: readonly SemanticHit[],
  backfill: readonly SemanticHit[],
  k: number
): SemanticHit[] {
  const seen = new Set(primary.map((h) => `${h.mirrorPath}\0${h.snippet}`))
  const result: SemanticHit[] = [...primary]
  for (const h of backfill) {
    if (result.length >= k) break
    const key = `${h.mirrorPath}\0${h.snippet}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(h)
    }
  }
  return result.slice(0, k)
}

/**
 * Reciprocal Rank Fusion：两路命中按各自 rank（0-based）给分 1/(k+rank)，按 row 合并相加、
 * 降序。row = vectors-meta 行号，两路天然对齐（同一张分块表）。k 默认 60（RRF 惯例）。
 */
export function fuseRRF(
  bm25: { row: number; rank: number }[], vector: { row: number; rank: number }[], k = 60
): { row: number; score: number }[] {
  const acc = new Map<number, number>()
  for (const { row, rank } of bm25) acc.set(row, (acc.get(row) ?? 0) + 1 / (k + rank))
  for (const { row, rank } of vector) acc.set(row, (acc.get(row) ?? 0) + 1 / (k + rank))
  return [...acc.entries()].map(([row, score]) => ({ row, score })).sort((a, b) => b.score - a.score)
}
