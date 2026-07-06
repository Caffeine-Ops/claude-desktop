/**
 * 把方案 markdown 里的「KB 图绝对路径」转成 `kbasset://` URL，供渲染进程 <img> 加载
 * （见 main 的 kbAssetProtocol.ts）。只转换命中 KB assets 特征的路径，普通 http(s) 图与
 * 非 KB 本地路径原样返回——避免误伤外链图。
 *
 * 为什么只在渲染时转、不改存储 markdown：导出 Word（main，proposalDocx）要直读绝对路径过
 * ImageRun 嵌图；存储层保持绝对路径这一份真相，预览端按需适配。
 */

// KB 镜像图都落在 <userData>/kb-index/assets/ 下，故以这个路径片段作判定特征。
const KB_ASSET_MARKER = '/kb-index/assets/'

/**
 * 判定前把 win32 反斜杠归一成 `/` 再比 marker——与 shared/proposalAsset 的 toPosix 同款
 * 处理（评审发现：marker 硬编 `/`，反斜杠路径三处判定全失效）。归一只用于判定，
 * 返回/编码仍用原始 src。
 */
export function isKbAssetPath(src: string): boolean {
  if (!src) return false
  return src.replace(/\\/g, '/').includes(KB_ASSET_MARKER)
}

export function toKbAssetUrl(src: string): string {
  if (isKbAssetPath(src)) return `kbasset://kb/${encodeURIComponent(src)}`
  return src
}
