/**
 * 构建编排（main 侧薄壳）：单飞行 + 尾随。所有状态转移在 shared/kbBuildStatus 纯核，
 * 这里只做 fork/转发/回调。为什么不复用 kbSyncScheduler：sync 是定时拉取（周期驱动），
 * build 是写操作驱动（事件驱动），两者唯一的共同点「单飞行」已经薄到不值得抽象。
 */
import { app, utilityProcess } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initialKbBuildStatus, reduceKbBuildStatus, type KbBuildEvent, type KbBuildStatus
} from '../../shared/kbBuildStatus'
import { kbOutDir, kbStoreDir } from './kbIndexStore'
import { resetEmbedWorker, warmEmbedWorker } from './kbSemanticSearch'

let status: KbBuildStatus = initialKbBuildStatus
const listeners = new Set<(s: KbBuildStatus) => void>()

function dispatch(e: KbBuildEvent): void {
  status = reduceKbBuildStatus(status, e)
  for (const cb of listeners) cb(status)
}

/** 模型目录解析与 kbSemanticSearch.modelDir 同式（打包=resourcesPath，dev=apps/desktop/kb-model）。 */
function modelDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'kb-model')
  return join(dirname(fileURLToPath(import.meta.url)), '../../kb-model')
}

function start(): void {
  dispatch({ type: 'start' })
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'kbBuildWorker.js')
  const child = utilityProcess.fork(workerPath, [kbStoreDir(), kbOutDir(), String(Date.now()), modelDir()])
  let done = false
  child.on('message', (msg: { type: string; phase?: 'convert' | 'vectors'; done?: number; total?: number; ok?: boolean; error?: string; line?: string }) => {
    if (msg.type === 'progress' && msg.phase) {
      dispatch({ type: 'progress', phase: msg.phase, done: msg.done ?? 0, total: msg.total ?? 0 })
    } else if (msg.type === 'log' && msg.line) {
      console.log(`[kb-build] ${msg.line}`)
    } else if (msg.type === 'done') {
      done = true
      finish(msg.ok === true, msg.error ?? null)
    }
  })
  // worker 崩溃（OOM/被杀）不会发 done——exit 兜底把状态收敛，否则 running 永远卡 true
  child.on('exit', () => { if (!done) finish(false, 'kbBuildWorker 异常退出') })

  function finish(ok: boolean, error: string | null): void {
    dispatch({ type: 'exit', ok, error, atMs: Date.now() })
    if (ok) {
      // 新 builtAtMs → 旧 embedWorker 的向量 fingerprint 必 stale：杀掉重温，
      // 让语义检索在重建后自动恢复（而不是降级到重启 app 为止）
      resetEmbedWorker()
      warmEmbedWorker()
    }
    if (status.queued) start() // 尾随：构建期间的写操作合并成一轮
  }
}

/** 写操作后调用。运行中则置尾随标记（一轮扫盘会看到所有排队改动，天然合并）。 */
export function scheduleKbBuild(): void {
  if (status.running) dispatch({ type: 'queue' })
  else start()
}

export function getKbBuildStatus(): KbBuildStatus {
  return status
}

export function onKbBuildStatus(cb: (s: KbBuildStatus) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
