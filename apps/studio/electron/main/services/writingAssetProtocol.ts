/**
 * `writingasset://` 自定义协议 —— 让渲染进程显示写作项目里的配图
 * （`<项目>/images/` 下的 AI 生图与用户放进去的图）。
 *
 * 与 kbasset:// / proposalasset:// 的区别、以及为什么另起一个 scheme 而不是
 * 复用 pptasset://（它现有的白名单其实已经能命中写作项目的 images/）：命名语义
 * 与爆炸半径。让写作的图走一个叫 pptasset 的协议，下一个读代码的人会误判归属；
 * 且日后收紧任一侧白名单不会误伤另一侧。
 *
 * 守卫模式与 pptasset:// 同源：写作项目建在用户自己选的目录下，main 进程没有
 * 「枚举所有项目根」的办法，所以不传 resolveRoot 单根守卫，改传 validate
 * 白名单谓词（扩展名 + 路径必须含 /images/）。真正防目录穿越的仍是
 * localAssetProtocol 里对解码后路径的 normalize；白名单只收窄「服务哪些文件」。
 *
 * URL 形：`writingasset://w/<encodeURIComponent(图的绝对路径)>`，
 * 渲染侧由 toWritingAssetUrl 构造（见 src/chat/lib/writingAssetUrl.ts）。
 */

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const WRITING_ASSET_SCHEME = 'writingasset'

import { sep } from 'node:path'
import { registerLocalAssetProtocol } from './localAssetProtocol'

// 只服务位图与 svg。刻意不含视频/音频（pptasset 才需要）——写作正文里放不了它们，
// 白名单越窄，协议被当成通用读盘口子的余地越小。
const ALLOWED_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

// 写作项目的配图只会出现在项目内的 images/ 下（project_manager.py 的 SUBDIRS 建的
// 就是它，正文里的相对路径恒为 ../images/）。
const IMAGES_SEGMENT = `${sep}images${sep}`

/** writingasset:// 的授权判定：扩展名 + 目录片段双重白名单。见文件头注释的取舍说明。 */
export function isWritingAssetPath(absPath: string): boolean {
  if (!absPath || !ALLOWED_EXT_RE.test(absPath)) return false
  // Windows 反斜杠归一化：正文里写的是 posix 分隔符，落盘路径可能是反斜杠，
  // 不归一化会让 win32 上的合法图被判越界（同 shared/proposalAsset 的处理）。
  return absPath.replace(/\//g, sep).includes(IMAGES_SEGMENT)
}

/**
 * 注册 writingasset:// handler。app.whenReady() 之后调用一次；
 * registerSchemesAsPrivileged 必须已在 ready 前跑过（见 index.ts）。
 * `resolveRoot` 传空串占位——validate 存在时 localAssetProtocol 完全不看它。
 */
export async function registerWritingAssetProtocol(): Promise<void> {
  await registerLocalAssetProtocol(WRITING_ASSET_SCHEME, () => '', isWritingAssetPath)
}
