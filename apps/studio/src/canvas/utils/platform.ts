export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

/**
 * True when this web app is running inside the Electron desktop shell
 * (vs. a plain browser).
 *
 * 两条判定，对应两代架构：
 * 1. `window.chatApi` —— 单视图 studio（现行形态）：preload 往整个
 *    document 注入 chatApi，canvas 与 chat 同处一树，这就是宿主信号。
 *    rail 左下角已有「设置」入口，画布自己的齿轮（AvatarMenu）是重复
 *    chrome，必须隐藏（2026-07-04 用户点名去掉）。
 * 2. `?host=desktop` 查询参数 —— 旧双 WebContentsView 的 web tab：那个
 *    view 不带 preload、无任何注入全局，URL 参数是唯一信号（desktop
 *    openDesignServices.resolveWebTabUrl 追加，路由跨页保留）。
 *
 * Used to hide UI that would duplicate the shell's own chrome — e.g. the
 * settings gear (ProjectView / EntryShell 的 AvatarMenu)。
 */
export function isEmbeddedInDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as { chatApi?: unknown }).chatApi) return true;
  return new URLSearchParams(window.location.search).get('host') === 'desktop';
}
