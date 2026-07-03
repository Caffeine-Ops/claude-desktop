import { join } from 'node:path'
import { statSync, existsSync, readFileSync } from 'node:fs'
import { app } from 'electron'

import { runKbSync } from './kbSync'
import type { KbSyncStatus } from '../../shared/kbSyncStatus'
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
  void runKbSync({
    outDir: kbOutDir(),
    stateDir: stateDir(),
    remote,
    nowMs: () => Date.now(), // 注入点在这里、不在引擎——保引擎可测（规矩同 build 脚本）
    onStatus: (s: KbSyncStatus) => broadcastKbSyncStatus(s)
  }).then((final) => {
    running = false
    broadcastKbSyncStatus(final)
  })
  return 'started'
}

export function startKbSyncScheduler(): void {
  setTimeout(() => void triggerKbSyncNow(), 30_000)
  setInterval(() => void triggerKbSyncNow(), 6 * 3600_000)
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
