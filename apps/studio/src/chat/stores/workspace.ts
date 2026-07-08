import { create } from 'zustand'

/**
 * Workspace state（统一会话管理，2026-07-07 起为「会话级工作区」模型）。
 *
 * `current` 仍是引擎默认工作区（桌面）的渲染侧镜像 —— App.tsx 从
 * `getWorkspace()` seed，WorkspaceTreePanel 读它来 scope 文件树。它不再
 * 代表「所有会话的 cwd」：每个会话有自己的工作区。
 *
 * 会话级状态分两张表：
 *   - `sessionWorkspaces`：磁盘上已有 transcript 的会话 → 归属工作区。
 *     由 FusionRuntimeProvider 在每次 listSessions 刷新时镜像
 *     （ThreadSummary.workspacePath），是「锁定态」的展示来源。出现在
 *     这张表 = 会话已开始对话 = 工作区不可再改。
 *   - `pendingChoices`：还没发过消息的新会话 → 用户在 composer 预选的
 *     目录。经 `chooseForSession`（SESSION_WORKSPACE_SET IPC）成功后
 *     记录；main 侧的锁定校验才是权威，这里只是 UI 乐观镜像。
 *
 * 旧的 `switchTo`（整窗切换工作区 + wipe 全部 store + runtime remount）
 * 已随会话级模型退役——「换目录」不再是窗口级动作。
 */

type WorkspaceStore = {
  /** 引擎默认工作区（桌面）。null = getWorkspace() 尚未返回。 */
  current: string | null
  /** 已有 transcript 的会话的归属工作区（listSessions 镜像，只读展示）。 */
  sessionWorkspaces: Record<string, string>
  /** 未开始对话的会话的用户预选目录（乐观镜像）。 */
  pendingChoices: Record<string, string>
  /**
   * 切换在途的会话 → 目标路径。覆盖 setSessionWorkspace IPC 从发出到
   * 落定的窗口——已有记录的会话走迁移（teardown 子进程 + 搬 transcript），
   * 耗时可感知。UI 靠它渲染 loading，send 路径靠它把「迁移中发消息」
   * 变成短暂排队（见 FusionRuntimeProvider.onNew）。成败都会清。
   */
  switching: Record<string, string>
  setCurrent: (path: string | null) => void
  /** listSessions 刷新时整表替换（来源是磁盘扫描，不做增量合并）。 */
  setSessionWorkspaces: (map: Record<string, string>) => void
  /**
   * 给一个新会话预选工作目录。round-trip 到 main（校验 + 锁定检查 +
   * 写入引擎 pendingWorkspace + 注册表登记），成功后记录乐观镜像。
   * main 拒绝（已有记录/路径非法）时抛出，调用方决定怎么提示。
   */
  chooseForSession: (sessionId: string, path: string) => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  current: null,
  sessionWorkspaces: {},
  pendingChoices: {},
  switching: {},

  setCurrent: (path) => set({ current: path }),

  setSessionWorkspaces: (map) => set({ sessionWorkspaces: map }),

  chooseForSession: async (sessionId, path) => {
    const api = window.chatApi
    if (!api) throw new Error('chatApi unavailable')
    set((s) => ({ switching: { ...s.switching, [sessionId]: path } }))
    try {
      await api.setSessionWorkspace({ sessionId, path })
      set((s) => ({
        pendingChoices: { ...s.pendingChoices, [sessionId]: path }
      }))
    } finally {
      // 成败都清：失败时 chip 回落到原目录展示，回落本身就是「没切成」
      // 的反馈（错误详情由调用方 console.warn，不弹窗打断输入）。
      set((s) => {
        const next = { ...s.switching }
        delete next[sessionId]
        return { switching: next }
      })
    }
  }
}))
