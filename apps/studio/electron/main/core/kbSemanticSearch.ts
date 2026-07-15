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

import { utilityProcess, type UtilityProcess } from 'electron'
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProposalProductScope } from './proposalPrompt'
import type { SemanticHit } from '../../shared/kbIndex'
import { readKbIndex, kbOutDir } from './kbIndexStore'
import { kbModelDir } from './kbModelDir'
import { retrievePassages } from './proposalRetrieve'
import { passagesToHits, fillHitsToK } from './proposalSemantic.core'

const SEARCH_TIMEOUT_MS = 1500
let worker: UtilityProcess | null = null
let ready = false
let stale = false
let seq = 0
// pending 回调第二参 failed：worker error / reset 排空等【基础设施失败】置 true——
// 响应路径据此打 degraded 旗标（F7），与「向量表行数不足 k 的正常补齐」区分开。
const pending = new Map<number, (hits: SemanticHit[], failed?: boolean) => void>()
// fork 时 index.json 的 mtime 快照——用于侦测「本地 bun scripts/build-kb-index.ts 重建」。
// 本地重建没有任何 IPC 事件（reset 钩子只覆盖配置变更/远程同步），旧 worker 端着旧内存表
// 或 stale latch 永不自愈；mtime 变了 = 索引换代 = 回收重 fork。
let forkedIndexMtime = 0

function indexJsonMtime(): number {
  try {
    return statSync(join(kbOutDir(), 'index.json')).mtimeMs
  } catch {
    return 0
  }
}

/**
 * mtime 自愈（F1）：index.json 的 mtime 与 fork 时快照不符 → 索引已被本地重建，
 * 立刻回收 worker 并后台重 warmup（模型重载 ~6s，不阻塞本次搜索——本次会落到
 * !ready 守卫走 BM25 降级）。statSync 约 µs 级，每次搜索付这一次可接受。
 */
function maybeRecycleWorker(): void {
  if (worker !== null && indexJsonMtime() !== forkedIndexMtime) {
    resetEmbedWorker()
    warmEmbedWorker()
  }
}

/** 空闲 warmup：fork worker 子进程预载模型+向量。绝不在首次用户查询同步路径里跑。 */
export function warmEmbedWorker(): void {
  if (worker) return
  const idx = readKbIndex()
  const fp = idx ? String(idx.builtAtMs) : ''
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'embedWorker.js') // out/main/embedWorker.js
  // fork+监听接线必须 try/catch（F9）：openSession 的调用点在任何 try 之外——fork 同步抛
  //（可执行文件缺失/资源耗尽等）会直接炸穿 openSession。吞掉并置空 worker，调用方自然降级 BM25。
  try {
    forkedIndexMtime = indexJsonMtime() // fork 时快照，供 maybeRecycleWorker 对比侦测本地重建
    worker = utilityProcess.fork(workerPath, [kbModelDir(), kbOutDir(), fp])
    worker.on('message', (msg: { type: string; id?: number; hits?: SemanticHit[] }) => {
      if (msg.type === 'ready') ready = true
      else if (msg.type === 'stale') { stale = true; ready = false }
      else if (msg.type === 'result' && msg.id != null) { pending.get(msg.id)?.(msg.hits ?? []); pending.delete(msg.id) }
      // error = worker 内部异常（模型推理崩等）——failed=true 让响应路径打 degraded 旗标
      else if (msg.type === 'error' && msg.id != null) { pending.get(msg.id)?.([], true); pending.delete(msg.id) }
    })
    // exit 时三态全复位：stale 属于「上一个 worker 生命周期」的判断——重建索引后再 fork 的
    // 新 worker 会用 fork 时新读的 fingerprint 重新校验，旧 latch 不能压住它（否则重建后
    // 永久降级 BM25，只有重启 app 才能恢复）。resetEmbedWorker 已同步清态，这里是幂等兜底
    //（也兜 worker 自行崩溃退出的情形）。
    worker.on('exit', () => { worker = null; ready = false; stale = false })
  } catch (err) {
    worker = null
    console.error('[kbSemanticSearch] embedWorker fork failed:', err)
  }
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
 * degraded=true（F7）＝命中来自 BM25-only 且原因是【基础设施状态】（worker 未就绪/stale/
 * 缺失、超时、error/kill）——面板据此提示「词面匹配」。空 scopes 短路是产品语义上的
 * no-op（没选产品），不算降级。
 *
 * 顺序不变量（见文件头注释 #1）：先判 !ready || stale || !worker → BM25，
 * 再向 worker 发 search。切勿调换顺序。
 *
 * 产品域过滤（F4，前置于 worker 打分）：
 *   scope 随 search 消息传入 worker，worker 在 cosine/BM25 两腿打分【之前】就把行集
 *   收窄到域内（cosineTopKRows）。旧方案是全库 top-k 后 main 侧后置过滤——窄产品域会被
 *   全库排名整体挤出 top-40，向量腿静默退化成纯 BM25（看着是语义检索，实际不是）。
 *   worker 命中已在域内，不再需要 workerK 多取与后置 filterHitsByScopes。
 */
export async function kbSemanticSearch(
  query: string, scopes: readonly ProposalProductScope[], k = 5
): Promise<{ hits: SemanticHit[]; staleIndex: boolean; degraded: boolean }> {
  // 回收检查放最顶：本地重建后 worker 端着旧内存表，哪怕本次是空 scopes 短路也应尽早重热。
  maybeRecycleWorker()
  if (!worker) warmEmbedWorker()
  // 空作用域：没有选中产品，语义检索全表无意义；直接 BM25——retrievePassages(empty scopes)
  // 同样返回 []，与旧语义一致（保向后兼容）。这是设计使然的 no-op，不算 degraded。
  if (scopes.length === 0) return { hits: bm25Fallback(query, scopes, k), staleIndex: stale, degraded: false }
  // 顺序不变量：ready/stale 检查必须在 postMessage 之前——worker 在 ready 前回空数组（Task 5 实测）
  if (!ready || stale || !worker) return { hits: bm25Fallback(query, scopes, k), staleIndex: stale, degraded: true }
  const id = ++seq
  const res = await new Promise<{ hits: SemanticHit[]; degraded: boolean }>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ hits: bm25Fallback(query, scopes, k), degraded: true }) }, SEARCH_TIMEOUT_MS)
    pending.set(id, (rawHits, failed) => {
      clearTimeout(timer)
      // worker 命中已按域过滤（F4）。不足 k 才【惰性】跑 bm25Fallback（F5）：向量表可能
      // 滞后于镜像（新文档已转换未向量化），BM25 即时分块补齐。够 k 时零磁盘读——旧实现
      // 每次响应都急切扫全部域内镜像，纯浪费。
      // failed=true（worker error / reset 排空）→ rawHits 为空、补齐结果=纯 BM25 → degraded。
      const filled = rawHits.length >= k ? rawHits.slice(0, k) : fillHitsToK(rawHits, bm25Fallback(query, scopes, k), k)
      resolve({ hits: filled, degraded: !!failed })
    })
    worker!.postMessage({ type: 'search', id, query, k, scopes: scopes.map((s) => ({ productLine: s.productLine, product: s.product })) })
  })
  return { hits: res.hits, staleIndex: false, degraded: res.degraded }
}

/**
 * 回收 worker 让下一次搜索/预热重新 fork——KB 根切换/远程配置变更/同步落盘/本地重建后，
 * 旧 worker 端着旧内存表(或 stale latch)不会自愈。幂等：无 worker 时是 no-op。
 */
export function resetEmbedWorker(): void {
  const w = worker
  // 同步清态：kill 的 exit 事件是异步的——不先清，紧随其后的搜索仍会 post 给垂死进程、
  // 白等 1500ms 超时。pending 立即以 failed=true 回调（响应路径把空当作 BM25 补齐并打
  // degraded 旗标），不悬挂。exit 处理器保留为幂等兜底。
  worker = null; ready = false; stale = false
  for (const cb of pending.values()) cb([], true)
  pending.clear()
  w?.kill()
}
