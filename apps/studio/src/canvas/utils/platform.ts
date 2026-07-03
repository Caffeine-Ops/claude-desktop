export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

/**
 * True when this web app is running inside the Electron desktop shell's
 * embedded web tab (vs. a plain browser).
 *
 * The desktop shell appends `?host=desktop` to the web tab URL (see desktop
 * openDesignServices.resolveWebTabUrl). That query param is the ONLY host
 * signal available here: the embedded web tab is loaded with no preload, so
 * none of the usual injected globals (`__od__` / `electronSettings` /
 * `chatApi`) exist. The desktop router preserves the query across in-app
 * navigation, so this stays true after view switches.
 *
 * Used to hide UI that would duplicate the shell's own chrome — e.g. the
 * settings gear, which the shell already pins in its top tab strip
 * (UserInfoBar).
 */
export function isEmbeddedInDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('host') === 'desktop';
}
