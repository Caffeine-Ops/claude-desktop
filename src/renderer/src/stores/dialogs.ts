import { create } from 'zustand'

/**
 * Modal dialog state for client-side slash commands.
 *
 * The renderer intercepts a small whitelist of `/<cmd>` inputs in
 * FusionRuntimeProvider's onNew callback before they're sent to
 * fusion-code, and dispatches them to one of these dialog kinds.
 * Adding a new slash command is a two-step change:
 *
 *   1. Add a string here (e.g. `'help'`).
 *   2. Add a switch case in FusionRuntimeProvider's slash dispatch.
 *   3. Mount the corresponding dialog component in App.tsx.
 *
 * Only one dialog can be open at a time. Opening a new one replaces
 * whichever was open before — `null` means none.
 */
export type DialogKind = 'skills' | 'mcp' | null

interface DialogState {
  open: DialogKind
  openDialog: (kind: Exclude<DialogKind, null>) => void
  closeDialog: () => void
}

export const useDialogStore = create<DialogState>((set) => ({
  open: null,
  openDialog: (kind) => set({ open: kind }),
  closeDialog: () => set({ open: null })
}))
