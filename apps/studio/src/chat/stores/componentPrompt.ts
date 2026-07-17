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
  /** 「拒绝」这个组件：关窗 + 写 dismissed，功能门据此本次会话内不再提示。只给 idle/error 分支
   *  的 [暂不] 和 unavailable 分支的关闭用——那些场景里用户是真的在说「这个我不要」。 */
  close: () => void
  /** 「先收起」这个组件的弹窗：只清 openFor，不碰 dismissed。给 installing 分支的 [收起] 用——
   *  安装还在后台跑，用户只是不想看进度条，不是在拒绝这个组件。为什么必须和 close() 分开：如果
   *  installing 分支也调 close()，会把「暂时收起一个正在跑的安装」误记成「拒绝该组件」；若安装
   *  随后失败（error），功能门看到 dismissed[id]===true 就此不再提示，用户会在完全不知情的情况
   *  下被静默降级（例如 markitdown 装失败后同步悄悄退回 BM25，没有任何提示）。 */
  hide: () => void
  isDismissed: (id: string) => boolean
}

export const useComponentPromptStore = create<PromptState>((set, get) => ({
  openFor: null,
  dismissed: {},
  promptComponent: (id) => set({ openFor: id }),
  close: () => set((s) => (
    s.openFor ? { openFor: null, dismissed: { ...s.dismissed, [s.openFor]: true } } : { openFor: null }
  )),
  hide: () => set({ openFor: null }),
  isDismissed: (id) => !!get().dismissed[id],
}))

export function promptComponent(id: string): void {
  useComponentPromptStore.getState().promptComponent(id)
}
