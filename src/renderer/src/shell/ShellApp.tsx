import React from 'react'

/**
 * The shell BrowserWindow hosts nothing the user ever sees — the
 * active tab's WebContentsView covers the entire window area.
 * This component exists only so the shell's main webContents has
 * a valid React tree to mount; it renders nothing. The tab bar
 * itself lives inside each tab's own workspace renderer header
 * (see components/tabs/TabBar.tsx).
 */
export default function ShellApp(): React.ReactElement {
  return <></>
}
