/**
 * REPLAY_OPEN 编排：选文件（或用调用方显式给的 path——内置演示/文件关联
 * 留口）→ openReplayPackage 解包+路径重写 → 只回 renderer 需要的
 * meta + timeline（完整 manifest 的 assets 清单是导入侧实现细节，不出 IPC）。
 */
import { dialog, type BrowserWindow } from 'electron'

import type { ReplayOpenResult } from '../../shared/ipc-channels'
import { REPLAY_FILE_EXT } from '../../shared/replayTypes'
import { openReplayPackage } from './replayPackage'

export async function openReplay(
  win: BrowserWindow,
  explicitPath?: string
): Promise<ReplayOpenResult> {
  let zipPath = explicitPath
  if (!zipPath) {
    const r = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Claude 演示录像', extensions: [REPLAY_FILE_EXT] }],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) {
      return { ok: false, cancelled: true }
    }
    zipPath = r.filePaths[0]
  }

  const opened = await openReplayPackage(zipPath)
  if (!opened.ok) return { ok: false, error: opened.error }
  return { ok: true, meta: opened.manifest.meta, timeline: opened.timeline }
}
