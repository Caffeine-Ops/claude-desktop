import { usePermissionBridge } from '../../stores/permissions'
import {
  usePermissionModeChangeBridge,
  usePermissionModePushOnMount
} from '../../stores/permissionMode'

/**
 * PermissionBridge
 * ----------------
 * Headless component. Mounts the permission store's IPC subscriber
 * exactly once at the root of the renderer so every tool card further
 * down the tree can look up its pending request by `toolUseId` without
 * each card touching the preload surface itself.
 *
 * Rendered instead of the old `<PermissionDialog />` modal in
 * `App.tsx`. The actual UI lives in `InlinePermissionPrompt`, which is
 * rendered inside each `ToolCallCard` in `ThreadView.tsx` whenever the
 * store contains a request whose `toolUseId` matches the card.
 *
 * Why a component and not a bare `useEffect` in App
 * -------------------------------------------------
 * The hook has to run *inside* the React tree (it calls `useEffect`
 * and reads `window.chatApi`), so we need a component wrapper. A
 * dedicated bridge keeps the subscription next to the permission
 * store instead of tangling it into `App.tsx`'s layout code.
 */
export function PermissionBridge(): null {
  usePermissionBridge()
  // Push the persisted UI permission mode (localStorage) back to main
  // on mount so the engine's field mirrors the renderer's source of
  // truth. Runs exactly once per mount — the next picker click goes
  // through `usePermissionModeStore.setMode` instead.
  usePermissionModePushOnMount()
  // Subscribe to main-initiated mode changes (ExitPlanMode auto
  // transition). Keeps the picker honest when the SDK flips its own
  // mode after the plan is approved.
  usePermissionModeChangeBridge()
  return null
}
