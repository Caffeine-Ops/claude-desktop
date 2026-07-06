import { join } from 'node:path'
import { statSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { app } from 'electron'

import { runKbSync } from './kbSync'
import type { KbSyncStatus } from '../../shared/kbSyncStatus'
import { resetEmbedWorker } from './kbSemanticSearch'
import { parseKbManifest } from '../../shared/kbManifest'
import { getKbConfig, kbOutDir } from './kbIndexStore'
import { broadcastKbSyncStatus } from '../tabRegistry'

/**
 * KB 同步调度器（app 级单例，engine-free）。
 * 触发时机三条（spec ③）：启动后延迟 30s（不挤冷启动的事件循环——spawn warmup、
 * 协议注册都在前 30s）、每 6h 定时、设置页手动。单飞行锁：手动+定时撞车时后来者
 * 直接返回 alreadyRunning，绝不并行跑两轮（两个进程同写 .part 会互相踩）。
 */
let running = false

const stateDir = (): string => join(app.getPath('userData'), 'kb-sync')

export function triggerKbSyncNow(): 'started' | 'alreadyRunning' | 'noRemote' {
  const { remote } = getKbConfig()
  if (!remote) return 'noRemote'
  if (running) return 'alreadyRunning'
  running = true
  // 纵深防御（M3）：runKbSync 的契约是「绝不 reject，终态=返回值」，正常情况下
  // 只会走 onFulfilled。但契约是人写的、未来编辑可能悄悄破坏它——若真的 reject，
  // 缺 onRejected 会让 `running` 永久卡 true，单飞行锁从此死锁、再也不会有新的
  // 同步跑起来（且不会有任何用户可见的错误提示）。onRejected 只做日志兜底；
  // `running` 复位挪到 finally，保证无论 resolve/reject 哪条路径都会释放锁。
  void runKbSync({
    outDir: kbOutDir(),
    stateDir: stateDir(),
    remote,
    nowMs: () => Date.now(), // 注入点在这里、不在引擎——保引擎可测（规矩同 build 脚本）
    onStatus: (s: KbSyncStatus) => broadcastKbSyncStatus(s)
  })
    .then(
      (final) => {
        broadcastKbSyncStatus(final)
        // 同步成功时重置 embed worker——旧 worker 端着旧内存表，kill 触发 exit 三态复位，
        // 下次搜索 fork 新进程用新 fingerprint 重校验（见 resetEmbedWorker 注释）。
        // 门控 state==='success'：KbSyncStatus success 无 downloaded/deleted 计数字段，
        // 以 success 为判据（代价：磁盘未变的成功同步也会重置，每 6h 付一次 ~7s 模型冷载，
        // 属可接受的误触——相比静默带着旧向量表的 stale latch 更安全）。
        if (final.state === 'success') resetEmbedWorker()
      },
      (err) => console.error('[kb-sync] runKbSync 违反绝不reject契约', err)
    )
    .finally(() => {
      running = false
    })
  return 'started'
}

export function startKbSyncScheduler(): void {
  setTimeout(() => void triggerKbSyncNow(), 30_000)
  setInterval(() => void triggerKbSyncNow(), 6 * 3600_000)
}

/**
 * 作废同步基准（stateDir/manifest.json）。基准是「上次同步后磁盘长什么样」的断言，
 * 只在磁盘唯一写方是同步引擎时成立——用户切到本地模式（随后可能跑本地构建）或
 * 重新选择本地源目录时，这个前提失效，必须删基准让下一轮远程同步退回磁盘对账
 * （scanDiskAsManifest 全量 sha1 校对，代价=模式切换这种罕见动作付一次秒级扫描）。
 */
export function invalidateKbSyncBaseline(): void {
  try {
    rmSync(join(stateDir(), 'manifest.json'), { force: true })
  } catch {
    // 删不掉（权限等）最坏也就是下轮增量基于旧基准——与修复前等价，不值得让调用方炸。
  }
}

/** 上次成功同步：基准 manifest 的 mtime（何时同步的）+ builtAtMs（内容多新）。 */
export function lastKbSyncInfo(): { atMs: number; builtAtMs: number } | null {
  const p = join(stateDir(), 'manifest.json')
  if (!existsSync(p)) return null
  try {
    const m = parseKbManifest(JSON.parse(readFileSync(p, 'utf8')))
    if (!m) return null
    return { atMs: statSync(p).mtimeMs, builtAtMs: m.builtAtMs }
  } catch {
    return null
  }
}
