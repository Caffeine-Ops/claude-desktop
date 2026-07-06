/**
 * kbSemanticSearch — main 进程薄包装：warmup / 超时 / BM25 降级 / stale 旗标。
 *
 * 硬不变量（Task 5 实测事实，勿改）：
 *   1. worker 在 ready 前收到 search 消息会返回空数组（不报错）。因此本包装在
 *      !ready 时必须直接走 BM25 降级，绝不向 worker 发 search——保留下面 if (!ready…) 的顺序。
 *   2. worker init 永久挂起（模型文件损坏等）→ 永远收不到 ready →
 *      wrapper 永久停在 BM25 降级。这是接受的设计：fallback-by-default 比
 *      main 侧 init 计时器（没人调参）更安全稳定。
 */

import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProposalProductScope } from './proposalPrompt'
import type { SemanticHit } from '../../shared/kbIndex'
import { readKbIndex, kbOutDir } from './kbIndexStore'
import { retrievePassages } from './proposalRetrieve'
import { passagesToHits } from './proposalSemantic.core'

const SEARCH_TIMEOUT_MS = 1500
let worker: UtilityProcess | null = null
let ready = false
let stale = false
let seq = 0
const pending = new Map<number, (hits: SemanticHit[]) => void>()

/**
 * 模型/向量目录解析：
 *   打包 = resourcesPath/kb-model
 *   dev   = <repo>/apps/desktop/kb-model
 *
 * dev 路径推导（该模块打包到 out/main/index.js）：
 *   dirname(import.meta.url) = apps/desktop/out/main
 *   ../../kb-model            = apps/desktop/out/main/../../kb-model
 *                             = apps/desktop/kb-model  ✓
 *
 * 三层 '../../../' 会多跳一级到 apps/kb-model（错）——只用两层。
 * workerPath = join(dirname, 'embedWorker.js') 指向 out/main/embedWorker.js（Task 5 输出，正确）。
 */
function modelDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'kb-model')
  // out/main → out → apps/desktop（两层 ..）
  return join(dirname(fileURLToPath(import.meta.url)), '../../kb-model')
}

/** 空闲 warmup：fork worker 子进程预载模型+向量。绝不在首次用户查询同步路径里跑。 */
export function warmEmbedWorker(): void {
  if (worker) return
  const idx = readKbIndex()
  const fp = idx ? String(idx.builtAtMs) : ''
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'embedWorker.js') // out/main/embedWorker.js
  worker = utilityProcess.fork(workerPath, [modelDir(), kbOutDir(), fp])
  worker.on('message', (msg: { type: string; id?: number; hits?: SemanticHit[] }) => {
    if (msg.type === 'ready') ready = true
    else if (msg.type === 'stale') { stale = true; ready = false }
    else if (msg.type === 'result' && msg.id != null) { pending.get(msg.id)?.(msg.hits ?? []); pending.delete(msg.id) }
    else if (msg.type === 'error' && msg.id != null) { pending.get(msg.id)?.([]); pending.delete(msg.id) }
  })
  // exit 时三态全复位：stale 属于「上一个 worker 生命周期」的判断——重建索引后再 fork 的
  // 新 worker 会用 fork 时新读的 fingerprint 重新校验，旧 latch 不能压住它（否则重建后
  // 永久降级 BM25，只有重启 app 才能恢复）。
  worker.on('exit', () => { worker = null; ready = false; stale = false })
}

/**
 * BM25-only 降级：复用现有即时召回，经 passagesToHits 转成 SemanticHit。
 * passagesToHits 抽在 proposalSemantic.core（纯函数，无 electron），可 bun test 直测。
 */
function bm25Fallback(query: string, scopes: readonly ProposalProductScope[], k: number): SemanticHit[] {
  return passagesToHits(retrievePassages(query, scopes, { topK: k }))
}

/**
 * 混合语义检索。worker 未就绪/超时/stale → 降级 BM25-only（绝不返空、绝不阻塞等模型）。
 * staleIndex=true 仅供面板提示重建；engine 自动召回忽略它。
 *
 * 顺序不变量（见文件头注释 #1）：先判 !ready || stale || !worker → BM25，
 * 再向 worker 发 search。切勿调换顺序。
 */
export async function kbSemanticSearch(
  query: string, scopes: readonly ProposalProductScope[], k = 5
): Promise<{ hits: SemanticHit[]; staleIndex: boolean }> {
  if (!worker) warmEmbedWorker()
  // 顺序不变量：ready/stale 检查必须在 postMessage 之前——worker 在 ready 前回空数组（Task 5 实测）
  if (!ready || stale || !worker) return { hits: bm25Fallback(query, scopes, k), staleIndex: stale }
  const id = ++seq
  const hits = await new Promise<SemanticHit[]>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(bm25Fallback(query, scopes, k)) }, SEARCH_TIMEOUT_MS)
    pending.set(id, (h) => { clearTimeout(timer); resolve(h.length ? h : bm25Fallback(query, scopes, k)) })
    worker!.postMessage({ type: 'search', id, query, k })
  })
  return { hits, staleIndex: false }
}
