// utilityProcess 入口：Node 环境，可 import transformers/fs。所有重活在此，main 只转发。
// 冷加载 ~6s——放子进程正是为了不冻 main（所有 tab 的 ChatEngine 跑在 main，一旦 main 卡住
// UI 全停）。Task 6 用 utilityProcess.fork('out/main/embedWorker.js') 启动本文件。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { rankChunks, type RetrievalChunk } from '../core/proposalRetrieve.core'
import { cosineTopK, fuseRRF } from '../core/proposalSemantic.core'
import type { VectorStoreMeta, VectorMeta, SemanticHit } from '../../shared/kbIndex'

// ── process.parentPort 类型注记 ──────────────────────────────────────────────
// Electron 把 `parentPort: Electron.ParentPort` 追加到 NodeJS.Process（electron.d.ts
// 顶层 declare namespace NodeJS { interface Process { parentPort: Electron.ParentPort } }）。
// 然而 tsconfig.node.json 只声明 types:["node"]，electron.d.ts 通过模块解析（其他文件
// import from 'electron'）进入编译单元，其顶层 `declare namespace Electron` 是全局
// ambient 声明，因此 Electron.ParentPort 在整个 tsconfig scope 内全局可见。
// `ParentPort` 本身不是 'electron' 模块的具名导出（export = CrossProcessExports
// 里没有 re-export），所以不能 import type { ParentPort } from 'electron'。
// 结论：直接用全局 Electron.ParentPort，不需要 import；一次明确 cast 胜过 any。
const parentPort = (process as typeof process & { parentPort: Electron.ParentPort }).parentPort

const DIM = 512
const MODEL_ID = 'bge-small-zh-v1.5'
// fork 时通过 argv 传入：[modelDir, kbOutDir, expectedFingerprint]
const [modelDir, kbOutDir, expectedFp] = process.argv.slice(2)

type RowChunk = RetrievalChunk & { row: number }
let extractor: FeatureExtractionPipeline | null = null
let matrix: Float32Array | null = null
let meta: VectorStoreMeta | null = null
let rowChunks: RowChunk[] = []

async function init(): Promise<void> {
  const metaPath = join(kbOutDir, 'vectors-meta.json')
  const binPath = join(kbOutDir, 'vectors.bin')
  if (!existsSync(metaPath) || !existsSync(binPath)) {
    parentPort.postMessage({ type: 'stale', reason: 'no-vectors' })
    return
  }
  meta = JSON.parse(readFileSync(metaPath, 'utf8')) as VectorStoreMeta
  if (meta.version !== 2 || meta.dim !== DIM || meta.fingerprint !== expectedFp) {
    parentPort.postMessage({ type: 'stale', reason: 'fingerprint' })
    return
  }
  const buf = readFileSync(binPath)
  matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  rowChunks = meta.rows.map((m: VectorMeta, row) => ({
    text: m.text,
    title: m.title,
    mirrorPath: m.mirrorPath,
    row
  }))
  // 本地模型、零网络：localModelPath 下须有 <MODEL_ID>/onnx/... + tokenizer.json
  // （见 Task 9 prebundle-kb-model，Task 6 把 modelDir 路径以 argv 传入）。
  env.allowRemoteModels = false
  env.localModelPath = modelDir
  extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
  parentPort.postMessage({ type: 'ready' })
}

async function search(query: string, k: number): Promise<SemanticHit[]> {
  if (!extractor || !matrix || !meta) return []
  const out = await extractor(query, { pooling: 'mean', normalize: true })
  const qvec = out.data as Float32Array
  // N=40：两路各取前 40，RRF 融合后截 k。
  // vTop 用 cosineTopK（已在 proposalSemantic.core 验证 512-dim 一致性），
  // bm 走 BM25 rankChunks（proposalRetrieve.core，接受 RetrievalChunk[]，
  // RowChunk 是结构子类型，spread {…c, score} 透传 row 字段到结果）。
  const N = 40
  const vTop = cosineTopK(qvec, matrix, meta.rows.length, DIM, N).map((h, i) => ({
    row: h.row,
    rank: i
  }))
  const bm = (rankChunks(query, rowChunks, { topK: N }) as Array<RowChunk & { score: number }>).map(
    (p, i) => ({ row: p.row, rank: i })
  )
  const fused = fuseRRF(bm, vTop).slice(0, k)
  return fused.map(({ row, score }) => {
    const m = meta!.rows[row]
    return {
      title: m.title,
      sourcePath: m.sourcePath,
      mirrorPath: m.mirrorPath,
      productLine: m.productLine,
      product: m.product,
      snippet: m.snippet,
      score
    }
  })
}

parentPort.on('message', async (e) => {
  const msg = e.data as { type: 'search'; id: number; query: string; k: number }
  if (msg.type !== 'search') return
  try {
    parentPort.postMessage({ type: 'result', id: msg.id, hits: await search(msg.query, msg.k) })
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(err) })
  }
})

init().catch((err) => parentPort.postMessage({ type: 'stale', reason: String(err) }))
