import { create } from 'zustand'

export interface ToastItem { id: number; message: string; tone: 'ok' | 'err' | 'info' }

let seq = 0
const DURATION_MS = 4000

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
