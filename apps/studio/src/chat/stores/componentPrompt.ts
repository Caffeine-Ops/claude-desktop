// 渐进式组件下载弹窗的开关背板。promptComponent(id) 打开、指向某个缺失组件；弹窗自身订阅
// 组件状态表反映进度。一次只弹一个（openFor 单值），避免多弹窗叠。
import { create } from 'zustand'

interface PromptState {
  openFor: string | null
  /** 本次会话里用户已经关掉过其提示的组件 id（[暂不] 或成功淡出都算）。功能门据此只拦第一次，
   *  之后照旧走既有的静默降级——否则 [暂不] 等于永久拦死该功能，比没这个组件还糟。
   *  只存内存、不持久化：重启后再提醒一次是可接受的，用户也可能已经装好了。 */
  dismissed: Record<string, boolean>
  promptComponent: (id: string) => void
  close: () => void
  isDismissed: (id: string) => boolean
}

export const useComponentPromptStore = create<PromptState>((set, get) => ({
  openFor: null,
  dismissed: {},
  promptComponent: (id) => set({ openFor: id }),
  close: () => set((s) => (
    s.openFor ? { openFor: null, dismissed: { ...s.dismissed, [s.openFor]: true } } : { openFor: null }
  )),
  isDismissed: (id) => !!get().dismissed[id],
}))

export function promptComponent(id: string): void {
  useComponentPromptStore.getState().promptComponent(id)
}
