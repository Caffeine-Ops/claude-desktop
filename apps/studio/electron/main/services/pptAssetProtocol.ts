/**
 * `pptasset://` 自定义协议 —— 让渲染进程加载 ppt-master 项目产物（svg_output/ 的
 * SVG 引用的图片/媒体、templates/icons/ 的图标源文件）而不必经 IPC 逐个搬字节。
 *
 * 与 kbasset:// / proposalasset:// 的关键区别：那两个各守一个**固定**根目录
 * （KB 镜像目录、`<userData>/proposal-drafts`），pptasset 服务的却是**任意会话的
 * ppt-master 项目目录**——项目根由聊天会话决定，main 进程没有「枚举所有项目根」的
 * 办法。所以这里不传 `resolveRoot`（那个参数在 validate 模式下被忽略），改传
 * `validate`：扩展名白名单 + 路径必须含 ppt-master 产物目录的已知路径片段——防御纵深，
 * 不是单根守卫。真正防目录穿越的仍是 localAssetProtocol 里对解码后路径的 normalize；
 * 这里的白名单只是收窄「服务哪些文件」，不是唯一的安全边界。
 *
 * 具体实现收口在 localAssetProtocol.ts。URL 形：
 * `pptasset://p/<encodeURIComponent(文件的绝对路径)>`，渲染侧由 toPptAssetUrl 构造。
 */

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const PPT_ASSET_SCHEME = 'pptasset'

import { sep } from 'node:path'
import { registerLocalAssetProtocol } from './localAssetProtocol'

const ALLOWED_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mp3|wav|m4a)$/i

// ppt-master 产物只会出现在这四类目录之一：项目内的 images/ assets/ svg_output/，
// 或技能自带的 templates/icons/ 图标库（跨项目共享，不在任何项目目录之下）。
const ALLOWED_SEGMENTS = [
  `${sep}images${sep}`,
  `${sep}assets${sep}`,
  `${sep}svg_output${sep}`,
  `${sep}templates${sep}icons${sep}`
]

/** pptasset:// 的授权判定：扩展名 + 目录片段双重白名单。见文件头注释的取舍说明。 */
export function isPptAssetPath(absPath: string): boolean {
  if (!absPath || !ALLOWED_EXT_RE.test(absPath)) return false
  return ALLOWED_SEGMENTS.some((seg) => absPath.includes(seg))
}

/**
 * 注册 pptasset:// handler。app.whenReady() 之后调用一次；
 * registerSchemesAsPrivileged 必须已在 ready 前跑过（见 index.ts）。
 * `resolveRoot` 传空串占位——validate 存在时 localAssetProtocol 完全不看它。
 */
export async function registerPptAssetProtocol(): Promise<void> {
  await registerLocalAssetProtocol(PPT_ASSET_SCHEME, () => '', isPptAssetPath)
}
