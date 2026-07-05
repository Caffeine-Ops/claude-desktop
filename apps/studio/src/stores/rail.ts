import { create } from 'zustand'

/**
 * Rail（左侧全局导航栏 AppRail）的折叠状态。
 *
 * 落点在 src/stores 而非 chat/stores：AppRail 是 chat 与 canvas 两面共享的
 * 根层外壳（渲染在根 layout，见 RailShell / layout.tsx），它的折叠状态不属于
 * 任何一面，塞进 chat 私有 store 会让画布面读不到。
 *
 * **刻意不 persist**（2026-07-05 用户要求：每次启动默认展开，收起只在当前
 * 会话有效）。所以这里是最朴素的 zustand，不挂 persist 中间件——若日后要
 * 跨重启记住，仿 chat/stores/composerMode.ts 的 persist 范式加回即可。
 *
 * `collapsed` 只表达「用户是否把 rail 收起」这个持久意图；收起后 hover
 * 左边缘让 rail 临时「浮出」是 RailShell 自己的本地 UI 态（peek），不进这里
 * ——peek 是转瞬即逝的悬停预览，和「收起意图」是两码事，混在一起会让 toggle
 * 图标的高亮态跟着 hover 抖动。
 */
interface RailState {
  collapsed: boolean
  toggle: () => void
  setCollapsed: (collapsed: boolean) => void
}

export const useRailStore = create<RailState>((set) => ({
  collapsed: false,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
  setCollapsed: (collapsed) => set({ collapsed })
}))
