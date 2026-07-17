import { create } from 'zustand'

export interface ToastItem { id: number; message: string; tone: 'ok' | 'err' | 'info' }

let seq = 0
// 6s(P1c 从 4s 加长):实机验证时用户切页错过 4s 的报喜 toast(2026-07-17 台账),报喜类
// 消息读完需要的窗口比确认类长。
const DURATION_MS = 6000

interface ToastState {
  toasts: ToastItem[]
  push: (message: string, tone?: ToastItem['tone']) => void
  dismiss: (id: number) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, tone = 'info') => {
    const id = ++seq
    set({ toasts: [...get().toasts, { id, message, tone }] })
    window.setTimeout(() => get().dismiss(id), DURATION_MS)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
}))

/** 便捷调用：toast('已就绪', 'ok')。 */
export function toast(message: string, tone: ToastItem['tone'] = 'info'): void {
  useToastStore.getState().push(message, tone)
}
