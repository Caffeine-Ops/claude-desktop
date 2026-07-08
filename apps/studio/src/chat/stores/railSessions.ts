import { create } from 'zustand'
import type { ThreadSummary } from '@desktop-shared/types'

/**
 * Rail 会话列表 store —— RailSessionList 的数据缓存层。
 *
 * 为什么是 store 而不是组件本地 state：RailSessionList 挂在 AppRail 的
 * `pathname.startsWith('/chat')` 三元里，chat ↔ 工作画布切面时被**整块
 * 卸载**。threads/loaded 若是组件 useState，每次切回都归零 → 骨架屏一拍
 * + 重新等 listShellSessions IPC（2026-07-08 用户反馈「每次切换页面都会
 * loading」）。与 2026-07-05「rail 选中态卸载丢失」同根：熬不过卸载的
 * 数据必须住进模块级 store。
 *
 * 语义是 stale-while-revalidate：重挂载首帧直接渲染缓存 threads（loaded
 * 一旦 true 跨挂载持久，不再回骨架屏），挂载 effect 照旧触发 reload——
 * 切面期间错过的列表变化（事件订阅已随卸载解除）由这次拉取补齐，数据
 * 到位后无感替换。骨架屏只在应用启动后的**第一次**拉取期间出现。
 *
 * SSR 安全：模块求值期不碰 window（与 unread.ts 同纪律，RailSessionList
 * 所在 layout 会被 SSR）；reload 运行时才探 window.tabApi。
 */
interface RailSessionsState {
  /** 会话列表（按 updatedAt 降序，reload 时排好）。 */
  threads: readonly ThreadSummary[]
  /**
   * 首次 listShellSessions 是否已返回（成功或失败都算）。没有它就分不清
   * 「IPC 还在路上」和「真的没有会话」——两者都是 threads=[]，而前者直接
   * 渲染空白会让 rail 看起来像坏了（2026-07-07 用户反馈），要给骨架屏。
   */
  loaded: boolean
  /** 从 main 拉全量列表。幂等，重复调用无害（多条刷新事件共用）。 */
  reload: () => void
  /** 乐观改标题：行文字立即更新，随后的 sessionListChanged / reload 校正。 */
  applyRename: (sessionId: string, title: string) => void
  /** 乐观移除：驱动行折叠退场动画，IPC 失败时 reload 把行拉回来。 */
  applyRemove: (sessionId: string) => void
}

export const useRailSessionsStore = create<RailSessionsState>((set) => ({
  threads: [],
  loaded: false,

  reload: () => {
    if (typeof window === 'undefined' || !window.tabApi?.listShellSessions) {
      // 浏览器直开等无 tabApi 场景：不会有数据到来，标记 loaded 让渲染走
      // 真空态（null）——否则骨架屏永远挂着。
      set({ loaded: true })
      return
    }
    // TODO(debug 2026-07-08): 「发送后列表不刷新」排查用临时日志，定位后删。
    console.log('[RailSessionList] reload fired')
    window.tabApi
      .listShellSessions()
      .then((r) => {
        console.log(
          '[RailSessionList] got',
          r.threads.length,
          'threads, top3:',
          r.threads.slice(0, 3).map((t) => `${t.id.slice(0, 8)}:${t.title || '(空)'}`)
        )
        set({ threads: [...r.threads].sort((a, b) => b.updatedAt - a.updatedAt) })
      })
      .catch((err: unknown) => console.warn('[RailSessionList] list failed', err))
      // 成功失败都收骨架：失败时留骨架等于用加载假象掩盖故障，宁可空白。
      .finally(() => set({ loaded: true }))
  },

  applyRename: (sessionId, title) =>
    set((s) => ({
      threads: s.threads.map((t) => (t.id === sessionId ? { ...t, title } : t))
    })),

  applyRemove: (sessionId) =>
    set((s) => ({ threads: s.threads.filter((t) => t.id !== sessionId) }))
}))
