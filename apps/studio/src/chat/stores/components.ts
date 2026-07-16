import { create } from 'zustand'
import { initialComponentState, type ComponentState, type ComponentTable } from '@desktop-shared/componentDownload'

interface ComponentsState {
  table: ComponentTable
  init: () => () => void
  stateOf: (id: string) => ComponentState
}

export const useComponentStore = create<ComponentsState>((set, get) => ({
  table: {},
  init: () => {
    void window.chatApi.componentStatusGet().then((t) => set({ table: t }))
    const off = window.chatApi.onComponentStatus((t) => set({ table: t }))
    return off
  },
  stateOf: (id) => get().table[id] ?? initialComponentState(id),
}))
