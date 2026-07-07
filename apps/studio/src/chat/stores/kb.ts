import { create } from 'zustand'
import type { KbTree, KbToolingStatus } from '@desktop-shared/kbAdmin'
import type { KbBuildStatus } from '@desktop-shared/kbBuildStatus'

/**
 * 知识库管理页数据背板。与 stores/settings 同款「全屏视图开关」模型：open=true 时
 * KbManagerView 接管聊天区。数据流：openManager 时 refresh 拉一次 docs-list+tooling+build，
 * 写操作后组件各自 await 完再调 refresh()；构建状态走 onKbBuildStatus 推送（每次 success
 * 后也 refresh，因为 index.json 变了、树要重拉）。
 */
interface KbState {
  open: boolean
  tree: KbTree | null
  readOnly: boolean
  total: number
  tooling: KbToolingStatus | null
  build: KbBuildStatus | null
  loading: boolean
  openManager: () => void
  closeManager: () => void
  refresh: () => Promise<void>
  subscribeBuild: () => () => void
}

export const useKbStore = create<KbState>((set, get) => ({
  open: false,
  tree: null,
  readOnly: false,
  total: 0,
  tooling: null,
  build: null,
  loading: false,
  openManager: () => {
    set({ open: true })
    void get().refresh()
  },
  closeManager: () => set({ open: false }),
  refresh: async () => {
    set({ loading: true })
    try {
      const [list, tooling, build] = await Promise.all([
        window.chatApi.kbDocsList(),
        window.chatApi.kbToolingCheck(),
        window.chatApi.kbBuildStatusGet()
      ])
      set({ tree: list.tree, readOnly: list.readOnly, total: list.total, tooling, build, loading: false })
    } catch (err) {
      console.error('[kb] refresh failed', err)
      set({ loading: false })
    }
  },
  subscribeBuild: () => {
    const off = window.chatApi.onKbBuildStatus((s) => {
      const prev = get().build // 必须先读旧值：set 之后 get().build 就是 s 本身，边沿判断失效
      set({ build: s })
      // 一轮构建刚结束（running: true→false 且无错）→ index.json 已换代，重拉树。
      if (prev?.running && !s.running && !s.lastError) void get().refresh()
    })
    return off
  }
}))
