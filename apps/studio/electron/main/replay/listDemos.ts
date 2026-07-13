/**
 * 内置演示录像清单（REPLAY_LIST_DEMOS）——首页「看看它能做什么」演示区的
 * 数据源。
 *
 * 目录约定：把 .claudereplay 丢进 demos 目录即上架，删掉即下架，零代码：
 *   dev : apps/studio/demo-replays/
 *   prod: <resourcesPath>/demo-replays/（electron-builder extraResources 拷入）
 * 目录不存在 / 为空 → 返回空数组，首页演示区整个不渲染。
 *
 * 卡片时长角标读 manifest.meta.virtualDurationMs（导出时用 shared/
 * replayTiming 预算好）；旧包缺此字段时现读 timeline 用同一算法兜底——
 * 保证角标与实际播放时长永远一致。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import AdmZip from 'adm-zip'

import type { ReplayDemoInfo } from '../../shared/ipc-channels'
import type { ReplayManifest, ReplayTimeline } from '../../shared/replayTypes'
import { buildPlaybackSchedule } from '../../shared/replayTiming'

const TAG = '[replayDemos]'

export function demoReplaysDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'demo-replays')
    : join(app.getAppPath(), 'demo-replays')
}

export async function listReplayDemos(): Promise<ReplayDemoInfo[]> {
  let entries
  try {
    entries = await readdir(demoReplaysDir(), { withFileTypes: true })
  } catch (err) {
    console.warn(`${TAG} dir miss ${demoReplaysDir()}:`, err)
    return [] // 目录不存在 = 没有内置演示，首页不显示演示区
  }

  const out: ReplayDemoInfo[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.claudereplay')) continue
    const path = join(demoReplaysDir(), e.name)
    try {
      const zip = new AdmZip(path)
      const manifest = JSON.parse(
        zip.getEntry('manifest.json')?.getData().toString('utf8') ?? ''
      ) as ReplayManifest
      let virtualDurationMs = manifest.meta.virtualDurationMs
      if (typeof virtualDurationMs !== 'number') {
        const timeline = JSON.parse(
          zip.getEntry('timeline.json')?.getData().toString('utf8') ?? ''
        ) as ReplayTimeline
        virtualDurationMs = buildPlaybackSchedule(timeline.items).durationMs
      }
      out.push({
        path,
        title: manifest.meta.title,
        ...(manifest.meta.description
          ? { description: manifest.meta.description }
          : {}),
        virtualDurationMs,
        messageCount: manifest.meta.messageCount
      })
    } catch (err) {
      // 坏包跳过不上架——一个损坏文件不该拖垮整个演示区。
      console.warn(`${TAG} skip broken demo ${e.name}:`, err)
    }
  }
  // 稳定排序（按文件名）——上架顺序可用 01-xxx / 02-xxx 前缀控制。
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
