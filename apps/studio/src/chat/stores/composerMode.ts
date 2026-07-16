import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Slides-session store（原 Composer mode store 瘦身，2026-07-16）。
 *
 * 曾经还持有全局 `mode`（通用 / 设计 / 幻灯片 / … 的 ComposerModePicker
 * 选项）——picker 退役后模式入口统一到 EmptyState ScenarioRail 的技能
 * chip（leading 斜杠命令即语义，见 FusionRuntimeProvider onNew），全局
 * mode 单例连同 setMode/ComposerModeId 一并删除，恢复从 git 历史。
 *
 * 现在只剩 `slidesSessions` —— "slides 会话" 的 id 集合：首条消息以
 * ppt-master 斜杠开头的会话在发送时被打上标记（onNew），ThreadView 的
 * 双分栏工作台 gate 在这个 per-session 标记上，与用户后来在 composer 里
 * 选什么无关；切会话时按各自标记翻单/双栏。
 *
 * Stored as a `Record<id, true>` (not a Set) so zustand `persist` can
 * JSON-serialise it without a custom replacer. Persisted to localStorage
 * so the binding survives reloads.
 */

interface ComposerModeState {
  /** Session ids that were started in slides mode. */
  slidesSessions: Record<string, true>
  /** Mark a session as a slides session (idempotent). */
  markSlidesSession: (sessionId: string) => void
  /**
   * Remove a session's slides mark. 回放专用：录像回放给 replay: 假会话
   * 打临时标记撑开双分栏，退出时必须摘掉——这个 map 持久化到 localStorage，
   * 不摘会永久残留死键（虽然无害，但脏）。真实会话的标记从不摘除。
   */
  unmarkSlidesSession: (sessionId: string) => void
  /** Whether a given session id is a slides session. */
  isSlidesSession: (sessionId: string | null | undefined) => boolean
}

export const useComposerModeStore = create<ComposerModeState>()(
  persist(
    (set, get) => ({
      slidesSessions: {},
      markSlidesSession: (sessionId) => {
        if (!sessionId) return
        if (get().slidesSessions[sessionId]) return
        set((s) => ({
          slidesSessions: { ...s.slidesSessions, [sessionId]: true }
        }))
      },
      unmarkSlidesSession: (sessionId) => {
        if (!sessionId || !get().slidesSessions[sessionId]) return
        set((s) => {
          const next = { ...s.slidesSessions }
          delete next[sessionId]
          return { slidesSessions: next }
        })
      },
      isSlidesSession: (sessionId) =>
        sessionId ? get().slidesSessions[sessionId] === true : false
    }),
    {
      name: 'claude-desktop:composer-mode',
      // Only persist the durable fields, not the function refs (zustand
      // handles that, but being explicit keeps the storage shape clean).
      partialize: (s) => ({ slidesSessions: s.slidesSessions }),
      // 回放临时标记的崩溃兜底：正常退出由 ReplayController.exit 的
      // unmark 摘除；强退/崩溃残留的 replay: 键在下次启动 rehydrate 后
      // 清掉，防止 localStorage 越积越脏。microtask 延迟避开 create()
      // 求值期的 TDZ（此刻 useComposerModeStore 变量还没赋值）。
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const dirty = Object.keys(state.slidesSessions).filter((k) =>
          k.startsWith('replay:')
        )
        if (dirty.length === 0) return
        queueMicrotask(() => {
          const next = { ...useComposerModeStore.getState().slidesSessions }
          for (const k of dirty) delete next[k]
          useComposerModeStore.setState({ slidesSessions: next })
        })
      }
    }
  )
)
