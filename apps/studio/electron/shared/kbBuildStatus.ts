/** 构建状态纯核：runner（main）与 P2 的进度 UI 共用。reducer 化是为了 bun 直测单飞行+尾随的状态转移。 */
export interface KbBuildStatus {
  running: boolean
  queued: boolean
  phase: { phase: 'convert' | 'vectors'; done: number; total: number } | null
  lastError: string | null
  lastFinishedAtMs: number | null
}

export type KbBuildEvent =
  | { type: 'start' }
  | { type: 'queue' }
  | { type: 'progress'; phase: 'convert' | 'vectors'; done: number; total: number }
  | { type: 'exit'; ok: boolean; error: string | null; atMs: number }

export const initialKbBuildStatus: KbBuildStatus = {
  running: false, queued: false, phase: null, lastError: null, lastFinishedAtMs: null
}

export function reduceKbBuildStatus(s: KbBuildStatus, e: KbBuildEvent): KbBuildStatus {
  switch (e.type) {
    case 'start':
      // 启动即消费尾随标记：这一轮会看到排队时刻之后的所有改动（构建按 store 现状扫盘）
      return { ...s, running: true, queued: false, phase: null }
    case 'queue':
      return s.running ? { ...s, queued: true } : s
    case 'progress':
      return { ...s, phase: { phase: e.phase, done: e.done, total: e.total } }
    case 'exit':
      // queued 保留：失败也不吞尾随意图，runner 看到 queued 立即再排一轮
      return { ...s, running: false, phase: null, lastError: e.ok ? null : e.error, lastFinishedAtMs: e.atMs }
  }
}
