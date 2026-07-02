import { create } from 'zustand'

/**
 * Settings view visibility. When `open` is true the SettingsView component
 * takes over the chat area as a fullscreen overlay.
 *
 * `initialCategory`：打开时定位到的分类。为什么需要它：右上角齿轮如今打开的是 Open Design
 * 的 web 设置弹窗，本原生设置页没有常驻入口（GUI 走查发现：出图 API 表单做在了一个到不了
 * 的页面上）——功能侧的「去设置」引导按钮就是它的唯一入口，必须能带着目标分类（如
 * 'configuration'）直达，而不是每次都落在默认的 appearance。null = 沿用默认分类。
 */
interface SettingsState {
  open: boolean
  initialCategory: string | null
  openSettings: (category?: string) => void
  closeSettings: () => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  initialCategory: null,
  openSettings: (category) => set({ open: true, initialCategory: category ?? null }),
  closeSettings: () => set({ open: false, initialCategory: null })
}))
