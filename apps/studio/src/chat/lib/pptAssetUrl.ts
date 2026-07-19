/**
 * 把「ppt-master 项目产物的绝对路径」转成 `pptasset://` URL 供 <img>/<use href>/
 * fetch 加载（main 侧 handler 见 electron/main/services/pptAssetProtocol.ts，
 * 授权判定是扩展名+目录片段白名单，不是单根守卫——项目根随会话变化）。
 *
 * 与 toBgAssetUrl 同款：调用点（rewriteAssetHrefs 改 SVG href、inlineIcons 拉
 * 图标源文件）总是拿着一个已知的绝对路径，不需要判定，直接构造。main 侧的
 * isPptAssetPath 才是真正的授权关卡——这里编码错误的路径只会在那边 403，
 * 不构成安全问题。
 */
export function toPptAssetUrl(absPath: string): string {
  return `pptasset://p/${encodeURIComponent(absPath)}`
}
