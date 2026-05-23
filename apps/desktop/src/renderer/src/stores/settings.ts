import { create } from 'zustand'

/**
 * Settings view visibility. Just a boolean for now — when `open` is
 * true the SettingsView component takes over the chat area as a
 * fullscreen overlay. Active category lives inside the view as local
 * state because nothing outside it cares.
 */
interface SettingsState {
  open: boolean
  openSettings: () => void
  closeSettings: () => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false })
}))
