/**
 * 回放虚拟时间轴的纯计算——ReplayController（renderer 播放）与导出/演示
 * 清单（main 侧标注时长角标）共用一套常数和调度算法，两边永不漂移。
 *
 * 时间模型：录像 item.t/durMs 是真实毫秒；播放前先把块时长 cap 出 effDur
 * （超长打字/分钟级工具运行压到演示友好的上限），相邻 item 的【空闲间隔】
 * （扣除前块 effDur 后的部分）再 cap 到 GAP_CAP——生图 2 分钟的等待压到
 * 2.5s。倍速只影响推进速率，不改这条轴。
 */
import type { ReplayItem } from './replayTypes'

/** 相邻 item 间「空闲」（扣除表演时长后）的虚拟上限。 */
export const GAP_CAP_MS = 2500
/** 正文/思考打字机的播放期节奏上限。 */
export const TEXT_MS_PER_CHAR = 25
export const TEXT_MAX_MS = 8000
/** 工具 args 流式的节奏上限。 */
export const ARGS_MS_PER_CHAR = 12
export const ARGS_MAX_MS = 4000
/** 工具「运行中」的虚拟上限——快进的主要来源（真实可能是分钟级）。 */
export const RUN_MAX_MS = 4000

export interface ScheduledReplayItem {
  item: ReplayItem
  /** 虚拟时间轴上的开播时刻。 */
  startV: number
  /** 虚拟表演时长（瞬时 item = 0）。 */
  effDur: number
}

/** 单个 item 的虚拟表演时长。 */
export function effDurOf(item: ReplayItem): number {
  if (item.track === 'ui') {
    return 'durMs' in item ? item.durMs : 0
  }
  switch (item.op) {
    case 'text':
    case 'thinking':
      return Math.min(item.durMs, item.text.length * TEXT_MS_PER_CHAR, TEXT_MAX_MS)
    case 'tool': {
      const argsEff = Math.min(
        item.argsDurMs,
        item.argsJson.length * ARGS_MS_PER_CHAR,
        ARGS_MAX_MS
      )
      return argsEff + Math.min(item.runDurMs, RUN_MAX_MS)
    }
    default:
      return 0
  }
}

export function buildPlaybackSchedule(items: readonly ReplayItem[]): {
  schedule: ScheduledReplayItem[]
  durationMs: number
} {
  const schedule: ScheduledReplayItem[] = []
  let acc = 0
  let prevT = items.length > 0 ? items[0].t : 0
  let prevEff = 0
  for (const item of items) {
    const realGap = Math.max(item.t - prevT, 0)
    // 空闲间隔 = 真实间隔扣掉前块的虚拟表演时长，再 cap；表演本身不压
    //（它已经被 effDur 的 per-char/上限 cap 过了）。
    const idle = Math.max(realGap - prevEff, 0)
    acc += Math.min(realGap, prevEff + Math.min(idle, GAP_CAP_MS))
    const effDur = effDurOf(item)
    schedule.push({ item, startV: acc, effDur })
    prevT = item.t
    prevEff = effDur
  }
  const last = schedule[schedule.length - 1]
  return { schedule, durationMs: last ? last.startV + last.effDur : 0 }
}
