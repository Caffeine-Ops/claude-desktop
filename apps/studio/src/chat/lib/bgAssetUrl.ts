/**
 * 把「背景主题图绝对路径」转成 `bgasset://` URL 供 CSS `background-image`/<img> 加载
 * （main 侧 handler 见 electron/main/services/bgAssetProtocol.ts）。
 *
 * 与 toKbAssetUrl/toProposalAssetUrl 不同——那两个要在任意 markdown 文本里自动判定
 * 「这段路径是不是 KB/草稿图」，因为调用点不知道来源。这里的调用点（backgroundArt
 * applier）总是拿着一个已知来自 BackgroundThemeMeta 的绝对路径，不需要判定，直接构造。
 */
export function toBgAssetUrl(absPath: string): string {
  return `bgasset://local/${encodeURIComponent(absPath)}`
}
