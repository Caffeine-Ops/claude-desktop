import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { UiPermissionMode } from '../../../shared/ipc-channels'

/**
 * UI permission mode store.
 *
 * Who owns the value
 * ------------------
 * The renderer is the source of truth. The selected mode is persisted
 * to localStorage via zustand `persist` so the user's choice survives
 * reloads and process restarts. Main's engine field is a *mirror* —
 * on renderer mount we push the persisted value back to main via the
 * `setPermissionMode` IPC so the next session spawn picks it up.
 *
 * Why not the other way around
 * ----------------------------
 * Main doesn't see localStorage (the renderer owns it), and we don't
 * want to add a main-side config file just for one picker value. A
 * push-on-mount is one round-trip at cold start and keeps main
 * storage-free.
 *
 * Flow
 * ----
 *   1. User opens the app → `persist` rehydrates `mode` from
 *      localStorage (default `'default'` on a fresh install).
 *   2. `usePermissionModePushOnMount()` fires once, calls
 *      `window.chatApi.setPermissionMode({ mode })`, main stores it.
 *   3. User flips the picker → `setMode()` updates local state AND
 *      pushes to main. Main forwards to every live SDK runtime via
 *      `query.setPermissionMode()` so the active turn switches mode
 *      mid-session.
 */

interface PermissionModeState {
  mode: UiPermissionMode
  /**
   * User-initiated change: update local state, persist to
   * localStorage (via `persist` middleware), and push to main.
   */
  setMode: (mode: UiPermissionMode) => Promise<void>
  /**
   * Main-initiated change: update local state + persist only. Does
   * NOT push back to main — the value already came from main, and
   * re-pushing would close a feedback loop.
   *
   * Currently the only trigger is the ExitPlanMode auto-transition:
   * engine flips itself out of `plan` after the user approves the
   * tool, broadcasts `PERMISSION_MODE_CHANGED`, and the bridge hook
   * calls this action. Keeping it distinct from `setMode` is what
   * breaks the loop.
   */
  applyFromMain: (mode: UiPermissionMode) => void
}

export const usePermissionModeStore = create<PermissionModeState>()(
  persist(
    (set, get) => ({
      mode: 'bypassPermissions',
      setMode: async (mode) => {
        if (get().mode === mode) return
        set({ mode })
        try {
          await window.chatApi.setPermissionMode({ mode })
        } catch (err) {
          console.error('[permissionMode] setPermissionMode failed', err)
        }
      },
      applyFromMain: (mode) => {
        if (get().mode === mode) return
        set({ mode })
      }
    }),
    {
      name: 'claude-desktop:permission-mode',
      version: 2,
      migrate: (state, fromVersion) => {
        if (fromVersion < 2 && (state as PermissionModeState | undefined)?.mode === 'default') {
          return { ...(state as PermissionModeState), mode: 'bypassPermissions' }
        }
        return state as PermissionModeState
      }
    }
  )
)

/**
 * Mount-time side effect: push the persisted mode to main so the
 * engine field mirrors the renderer's value on cold start. Call once
 * at the app root. Safe to call from a component that unmounts during
 * hot-reload — the effect re-fires on next mount and just overwrites
 * main's current value with the same one.
 */
export function usePermissionModePushOnMount(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    const mode = usePermissionModeStore.getState().mode
    void window.chatApi.setPermissionMode({ mode }).catch((err) => {
      console.error('[permissionMode] initial push failed', err)
    })
  }, [])
}

/**
 * Subscribe the store to main-initiated permission-mode change
 * broadcasts. Fires when engine flips its own field (ExitPlanMode
 * auto-transition) and pushes the new mode to every open window.
 *
 * Uses `applyFromMain` so the change stays one-way — we do NOT
 * re-invoke `setPermissionMode` IPC from here, otherwise the engine
 * → renderer → engine loop would ping-pong forever.
 */
export function usePermissionModeChangeBridge(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    const unsub = window.chatApi.onPermissionModeChanged((mode) => {
      usePermissionModeStore.getState().applyFromMain(mode)
    })
    return unsub
  }, [])
}
