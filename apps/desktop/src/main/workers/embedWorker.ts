// utilityProcess 入口：Node 环境，可 import transformers/fs。所有重活在此，main 只转发。
// 冷加载 ~6s——放子进程正是为了不冻 main（所有 tab 的 ChatEngine 跑在 main，一旦 main 卡住
// UI 全停）。Task 6 用 utilityProcess.fork('out/main/embedWorker.js') 启动本文件。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { rankChunks, type RetrievalChunk } from '../core/proposalRetrieve.core'
import { cosineTopKRows, fuseRRF } from '../core/proposalSemantic.core'
import { KB_MODEL_ID, type VectorStoreMeta, type VectorMeta, type SemanticHit } from '../../shared/kbIndex'

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
  // Buffer.slice 共享底层池、byteOffset 可能不是 4 的倍数（Node 小文件走池化分配），
  // Float32Array 视图要求 4 字节对齐——ArrayBuffer.slice 拷一份对齐的，代价只是小文件一次 memcpy。
  matrix = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  // 尺寸守卫（F3）：截断/位腐的 bin 过得了 fingerprint（fingerprint 只绑 builtAtMs，
  // 不校验内容）——越界读出 NaN 分数=静默垃圾排序，必须挡在 ready 之前。
  if (matrix.length !== meta.rows.length * DIM) {
    parentPort.postMessage({ type: 'stale', reason: 'vectors-size-mismatch' })
    return
  }
  rowChunks = meta.rows.map((m: VectorMeta, row) => ({
    text: m.text,
    title: m.title,
    mirrorPath: m.mirrorPath,
    row
  }))
  // 本地模型、零网络：localModelPath 下须有 <KB_MODEL_ID>/onnx/... + tokenizer.json
  // （见 Task 9 prebundle-kb-model，Task 6 把 modelDir 路径以 argv 传入）。
  // KB_MODEL_ID 来自 shared/kbIndex（模型 id 唯一事实源，F8）。
  env.allowRemoteModels = false
  env.localModelPath = modelDir
  extractor = await pipeline('feature-extraction', KB_MODEL_ID, { dtype: 'q8' })
  parentPort.postMessage({ type: 'ready' })
}

async function search(
  query: string,
  k: number,
  scopes: readonly { productLine: string; product: string }[]
): Promise<SemanticHit[]> {
  if (!extractor || !matrix || !meta) return []
  // scope 过滤前置于打分（F4）：行集先收窄到域内，再跑两腿排名——后置过滤的根本缺陷是
  // 窄产品域会被全库 top-40 整体挤出，向量腿静默退化成纯 BM25。空 scopes = 不过滤全表
  //（消息自描述，语义显式）。行集每请求构建一次，O(rows) 字符串拼接，几万行下仍是 µs~ms 级。
  let allowedRows: number[]
  if (scopes.length === 0) {
    allowedRows = meta.rows.map((_, i) => i)
  } else {
    // NUL 分隔符：productLine/product 均为路径片段，不含 NUL，键唯一
    const scopeSet = new Set(scopes.map((s) => `${s.productLine}\0${s.product}`))
    allowedRows = []
    for (let i = 0; i < meta.rows.length; i++) {
      const m = meta.rows[i]
      if (scopeSet.has(`${m.productLine}\0${m.product}`)) allowedRows.push(i)
    }
  }
  const out = await extractor(query, { pooling: 'mean', normalize: true })
  const qvec = out.data as Float32Array
  // N=40：两路在【域内子空间】各取前 40，RRF 融合后截 k。
  // vTop 用 cosineTopKRows（只对域内行打分），bm 走 BM25 rankChunks（proposalRetrieve.core，
  // 接受 RetrievalChunk[]，RowChunk 是结构子类型，spread {…c, score} 透传 row 字段到结果），
  // 输入同样先过滤到域内——两腿同基准，RRF 行号天然对齐。
  const N = 40
  const vTop = cosineTopKRows(qvec, matrix, allowedRows, DIM, N).map((h, i) => ({
    row: h.row,
    rank: i
  }))
  const allowedSet = new Set(allowedRows)
  const bmInput = scopes.length === 0 ? rowChunks : rowChunks.filter((c) => allowedSet.has(c.row))
  const bm = (rankChunks(query, bmInput, { topK: N }) as Array<RowChunk & { score: number }>).map(
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
      text: m.text,
      snippet: m.snippet,
      score
    }
  })
}

parentPort.on('message', async (e) => {
  const msg = e.data as {
    type: 'search'
    id: number
    query: string
    k: number
    scopes?: { productLine: string; product: string }[]
  }
  if (msg.type !== 'search') return
  try {
    // scopes 缺省容错为 []（全表）——防旧 main 与新 worker 版本错配时崩掉整个进程。
    parentPort.postMessage({
      type: 'result',
      id: msg.id,
      hits: await search(msg.query, msg.k, msg.scopes ?? [])
    })
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(err) })
  }
})

init().catch((err) => parentPort.postMessage({ type: 'stale', reason: String(err) }))
