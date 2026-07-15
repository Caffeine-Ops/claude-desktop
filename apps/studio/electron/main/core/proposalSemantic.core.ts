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
  // 委托 cosineTopKRows（allowedRows=全行）：只留一份点积内核，两函数永不漂移。
  // 行号数组的分配代价相对逐行 dim 次乘加可忽略。
  const all = new Array<number>(rows)
  for (let r = 0; r < rows; r++) all[r] = r
  return cosineTopKRows(query, matrix, all, dim, k)
}

/**
 * 与 cosineTopK 同语义，但只对 allowedRows 里的行打分——scope 过滤放在打分前，
 * 窄产品域不会被全库 top-k 挤出（后置过滤的根本缺陷：语义相近的他域行占满 top-k 名额，
 * main 侧再过滤只剩空壳，向量腿静默退化成纯 BM25）。allowedRows 为行号数组。
 * （旧的后置过滤 filterHitsByScopes 已随之删除——worker 内前置过滤全面取代它。）
 */
export function cosineTopKRows(
  query: Float32Array, matrix: Float32Array, allowedRows: readonly number[], dim: number, k: number
): { row: number; score: number }[] {
  const scored: { row: number; score: number }[] = new Array(allowedRows.length)
  for (let i = 0; i < allowedRows.length; i++) {
    const r = allowedRows[i]
    let s = 0
    const base = r * dim
    for (let d = 0; d < dim; d++) s += query[d] * matrix[base + d]
    scored[i] = { row: r, score: s }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
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

// ── P1 cross-encoder 二阶段重排的选择纯核 ────────────────────────────────────
// RRF 是【排名融合】，重排是对 (query, passage) 联合编码【重算相关性】——两者正交。
// 这两个纯函数只管「送哪些进重排」「重排分出来后怎么取 top-k」，不碰模型（推理在
// embedWorker 里跑，见 Task 4）。抽出来是为了让选择逻辑能被 bun test 钉死。

/**
 * 过量召回窗口：从 RRF 融合结果里取【前 M 行】送 cross-encoder 重排。候选已在产品域内
 * 收窄，M 取 30 足够（参 AnythingLLM 的 max(10,min(50,…))，但我们域已窄，上限更小）。
 * 保 RRF 序返回行号；fused 少于 M 则全取。M≤0 → 空（负数经 max(0,m) 归零）。
 */
export function rerankWindow(fused: readonly { row: number; score: number }[], m: number): number[] {
  return fused.slice(0, Math.max(0, m)).map((f) => f.row)
}

/**
 * 用 reranker 分对候选行重排、取 top-k。`scores[i]` 对应 `candidateRows[i]`。
 * 稳定降序：同分按原下标（即入参的 RRF 序）升序，保留融合排名当 tie-break。
 *
 * 【长度不匹配或空 → 返回空数组】：这是给上游的失败信号——reranker 输出条数与候选
 * 错位（推理异常/截断）时，调用方据「空」回落到未重排的 RRF top-k，绝不拿错位分排序。
 */
export function applyRerank(
  candidateRows: readonly number[], scores: readonly number[], k: number
): { row: number; score: number }[] {
  if (candidateRows.length === 0 || candidateRows.length !== scores.length) return []
  return candidateRows
    .map((row, i) => ({ row, score: scores[i]!, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k)
    .map(({ row, score }) => ({ row, score }))
}
