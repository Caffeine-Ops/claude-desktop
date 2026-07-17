// 渐进式组件下载弹窗的开关背板。promptComponent(id) 打开、指向某个缺失组件；弹窗自身订阅
// 组件状态表反映进度。一次只弹一个（openFor 单值），避免多弹窗叠。
import { create } from 'zustand'

interface PromptState {
  openFor: string | null
  promptComponent: (id: string) => void
  close: () => void
}

export const useComponentPromptStore = create<PromptState>((set) => ({
  openFor: null,
  promptComponent: (id) => set({ openFor: id }),
  close: () => set({ openFor: null }),
}))

export function promptComponent(id: string): void {
  useComponentPromptStore.getState().promptComponent(id)
}
