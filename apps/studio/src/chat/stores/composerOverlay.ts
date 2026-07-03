import { create } from 'zustand'

/**
 * Tracks whether any composer popover (the mode picker / permission-mode
 * picker, which open UPWARD over the area just above the input) is currently
 * open.
 *
 * Why this exists: the composer dock has a frosted transition strip above it
 * (a backdrop-blur band in ThreadView). backdrop-filter blurs whatever is
 * behind it in paint order — and these popovers, though z-40, render in a
 * sibling subtree the strip ends up compositing over, so the strip sliced a
 * blurred band straight across the open menu. Rather than fight the
 * backdrop-filter/z-index interaction, the strip simply hides itself while a
 * popover is open (subscribing to `count > 0`); the menu then renders clean.
 *
 * A counter, not a boolean, so two pickers opening/closing can't race each
 * other into a stuck-open state — each increments on open, decrements on
 * close, and the strip hides whenever the count is positive.
 */
interface ComposerOverlayState {
  /** Number of composer popovers currently open. */
  openCount: number
  /** Reflect a popover's open/closed state (idempotent per caller via effect). */
  setOpen: (open: boolean) => void
}

export const useComposerOverlayStore = create<ComposerOverlayState>((set) => ({
  openCount: 0,
  setOpen: (open) =>
    set((s) => ({ openCount: Math.max(0, s.openCount + (open ? 1 : -1)) }))
}))
