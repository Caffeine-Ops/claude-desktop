import { create } from 'zustand'

/**
 * Settings view visibility + 一次性的目标分类。
 * pendingCategory(P1c):打开设置页时想直达的分类 id(如 'components')。SettingsBody 的
 * activeCategory 是组件内 local state(头注释:nothing outside it cares)——外部唯一的定位
 * 通道就是这个「便签」:openSettings('components') 写下,SettingsBody 挂载/变化时读走并清空。
 * 为什么不直接把 activeCategory 提升进 store:全仓只有「打开时定位一次」这一个外部诉求,
 * 提升整个分类状态会让每次点分类都走 store、扩大耦合面(Task 9 评审记录里的非侵入修法)。
 * 类型用 string 而非 CategoryId:store 反向 import 视图组件的类型会引环,消费端窄化。
 */
interface SettingsState {
  open: boolean
  pendingCategory: string | null
  openSettings: (category?: string) => void
  closeSettings: () => void
  clearPendingCategory: () => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  pendingCategory: null,
  openSettings: (category) => set({ open: true, pendingCategory: category ?? null }),
  closeSettings: () => set({ open: false }),
  clearPendingCategory: () => set({ pendingCategory: null })
}))
