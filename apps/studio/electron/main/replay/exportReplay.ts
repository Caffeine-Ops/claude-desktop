/**
 * REPLAY_EXPORT 编排：读 transcript → 编译时间线 → 收集资产 → 保存对话框
 * → 写 .claudereplay。纯读侧（transcript 只读不写），任何一步失败都返回
 * 明确错误而不是半个包。
 */
import { readFile } from 'node:fs/promises'
import { app, dialog, type BrowserWindow } from 'electron'

import {
  findSessionJsonlGlobal,
  loadSession
} from '../core/sessionStore'
import {
  REPLAY_FILE_EXT,
  REPLAY_FORMAT_VERSION,
  type ReplayManifest,
  type ReplayTimeline
} from '../../shared/replayTypes'
import { buildPlaybackSchedule } from '../../shared/replayTiming'
import { compileReplayTimeline } from './compileReplay'
import { collectAssets, collectConfirmSnapshots, deriveSlides, writeReplayPackage } from './replayPackage'

const TAG = '[replayExport]'

export type ExportReplayResult =
  | { ok: true; path: string; skippedAssets: string[] }
  | { ok: true; path: null } // 用户取消保存对话框
  | { ok: false; error: string }

export async function exportReplay(
  win: BrowserWindow,
  sessionId: string,
  title?: string,
  mode?: 'slides'
): Promise<ExportReplayResult> {
  // 1. 消息级时间戳：SDK 的 getSessionMessages 类型不带 timestamp，从 jsonl
  //    原文自建 uuid → ms 映射（transcript 每行都有 ISO timestamp）。
  const jsonlPath = await findSessionJsonlGlobal(sessionId)
  if (!jsonlPath) {
    return { ok: false, error: '找不到该会话的记录文件（可能已被删除）。' }
  }
  const tsByUuid = new Map<string, number>()
  try {
    const text = await readFile(jsonlPath, 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const entry = JSON.parse(line) as { uuid?: string; timestamp?: string }
        if (typeof entry.uuid !== 'string' || typeof entry.timestamp !== 'string') {
          continue
        }
        const ms = Date.parse(entry.timestamp)
        if (!Number.isNaN(ms)) tsByUuid.set(entry.uuid, ms)
      } catch {
        /* 坏行跳过——编译器对缺时间戳的消息按默认间隔顺推 */
      }
    }
  } catch (err) {
    console.warn(`${TAG} read jsonl failed:`, err)
    // 时间戳全缺也能导出（顺推节奏），不视为致命。
  }

  // 2. 权威解析（tool result 配对 / workflow 卡 / slash 清洗都在这一步）。
  // mergeTurns:false——回放编译按每条 assistant 条目的 uuid→timestamp
  // 分配表演窗口，聊天恢复用的回合合并会把整轮压进一个窗口，节奏失真。
  const messages = await loadSession(sessionId, { mergeTurns: false })
  if (messages.length === 0) {
    return { ok: false, error: '该会话没有可导出的消息。' }
  }

  // 3. 编译 + 收资产。
  const compiled = compileReplayTimeline(messages, tsByUuid)
  const timeline: ReplayTimeline = {
    version: REPLAY_FORMAT_VERSION,
    items: compiled.items
  }
  const timelineJson = JSON.stringify(timeline)
  const collected = await collectAssets(timelineJson)
  // slides 会话：落定权威幻灯片清单（顺带把盘上有、消息里没扫到的最终页
  // 补进 collected）。必须在解构 assets/files 之前调——deriveSlides 会
  // mutate collected。
  const slides = mode === 'slides' ? await deriveSlides(collected) : undefined
  const confirmSnapshots = collectConfirmSnapshots(compiled.items)
  const { assets, files, skipped } = collected

  // 4. 保存对话框（锚定发起窗口）。
  const safeTitle = (title || '会话演示').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
  const r = await dialog.showSaveDialog(win, {
    filters: [{ name: 'Claude 演示录像', extensions: [REPLAY_FILE_EXT] }],
    defaultPath: `${safeTitle}.${REPLAY_FILE_EXT}`
  })
  if (r.canceled || !r.filePath) return { ok: true, path: null }

  const manifest: ReplayManifest = {
    version: REPLAY_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    meta: {
      title: title || safeTitle,
      sourceSessionId: sessionId,
      realDurationMs: compiled.realDurationMs,
      messageCount: compiled.messageCount,
      // 首页演示卡的时长角标数据源（与播放端同一套 shared 调度算法）。
      virtualDurationMs: buildPlaybackSchedule(compiled.items).durationMs,
      ...(mode ? { mode } : {}),
      ...(slides ? { slides } : {}),
      ...(confirmSnapshots.length > 0 ? { confirmSnapshots } : {})
    },
    assets
  }

  try {
    await writeReplayPackage(r.filePath, manifest, timelineJson, files)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `写录像文件失败：${m}` }
  }
  return { ok: true, path: r.filePath, skippedAssets: skipped }
}
