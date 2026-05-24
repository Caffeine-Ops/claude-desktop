import React, { useEffect } from 'react'

import TabBar from '../components/tabs/TabBar'
import { UserInfoBar } from '../components/chat/UserInfoBar'
import { useApplyAppearance } from '../stores/appearance.applier'
import { hydrateAppearanceFromDaemon } from '../stores/appearance'

/**
 * Shell renderer — mounted by the shell BrowserWindow's own
 * webContents (loaded with `?shell=1`).
 *
 * It now owns the **persistent chrome tab strip** pinned to the top
 * of the window. Every content tab's WebContentsView is laid out
 * starting at `y = TAB_BAR_HEIGHT` (44px, see tabRegistry), so this
 * strip is the only band of the shell renderer the user ever sees —
 * the rest sits underneath the active content view.
 *
 * Why the strip lives here and not inside each tab's header anymore:
 * the Open Design web tab loads an external origin with no
 * chatApi/tabApi preload, so it cannot render a TabBar of its own.
 * When that tab was foreground the user lost every way to switch
 * back. A single shell-owned strip is always visible/clickable no
 * matter which tab is foreground. See tabRegistry's TAB_BAR_HEIGHT
 * comment for the full rationale.
 *
 * The strip reuses the exact same `<TabBar />` component the
 * workspace header used to host, so pill styling / notification
 * badges / the `+` button behave identically — only the mount point
 * moved. `window.tabApi` is available here because the shell window
 * is created with the standard preload (see createShellWindow).
 */
export default function ShellApp(): React.ReactElement {
  // The shell renderer is its own webContents with its own appearance store
  // instance, so it needs the same theming wiring the chat App has — otherwise
  // the tab strip keeps whatever theme it booted with (main.tsx's bootAppearance
  // applied the localStorage cache once at startup, but nothing updates it at
  // runtime). useApplyAppearance keeps <html> in sync with this renderer's
  // store; the effect below seeds that store from the daemon on mount and
  // re-pulls whenever main broadcasts a change (theme switched in the settings
  // overlay / a tab). Without this the strip was the one surface that didn't
  // follow a live theme switch.
  useApplyAppearance()

  useEffect(() => {
    void hydrateAppearanceFromDaemon()
    if (!window.chatApi?.onAppearanceChanged) return
    return window.chatApi.onAppearanceChanged(() => {
      void hydrateAppearanceFromDaemon()
    })
  }, [])

  return (
    <div className="shell-chrome">
      <TabBar />
      {/* Settings menu — pinned to the far right of the tab strip. Moved
          here from the chat sidebar's bottom-left footer so it's reachable
          from any tab (including the Open Design web tab, which renders no
          chrome of its own). Its chat-tab actions route through
          window.tabApi.triggerMenuAction → the active chat tab. */}
      <UserInfoBar />
    </div>
  )
}
