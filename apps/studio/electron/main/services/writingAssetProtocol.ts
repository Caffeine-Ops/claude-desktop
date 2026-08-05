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
 * 白名单谓词（扩展名 + 路径必须含 /images/）。
 *
 * 关于「纵深防御第二层」的一条更正（2026-08-03 code review CONFIRMED）：本文件
 * 曾经的注释声称「真正防目录穿越的仍是 localAssetProtocol 里对解码后路径的
 * normalize」——这是错的，实话是：validate 模式下 localAssetProtocol 完全不做
 * 根包含检查（isPathInsideRoot 只在 resolveRoot 模式下跑），而且 normalize 运行在
 * validate 判定**之后**，不参与授权决策。也就是说如果 isWritingAssetPath 本身放行
 * 了一个借 `..` 逃逸出 images/ 的路径（如 `/a/images/../../../../Users/k/Private/x.png`
 * ——含 `/images/` 片段、`.png` 扩展名，字面上满足两条白名单），normalize 只会
 * 老老实实把它规整成 `/Users/k/Private/x.png` 再读盘，不会拒绝。真正堵住这条路的是
 * 下面 isWritingAssetPath 自己拒绝任何含 `..` 段的输入——这不是第二层防御，是唯一
 * 一层。（实际增量风险为零：pptasset:// 现有白名单本就已经放行 /images/ 下的任意
 * 文件，可达文件集合与本协议加固前后不变，这里收紧只是不让注释继续撒谎。）
 *
 * URL 形：`writingasset://w/<encodeURIComponent(图的绝对路径)>`，
 * 渲染侧由 toWritingAssetUrl 构造（见 src/chat/lib/writingAssetUrl.ts）。
 */

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const WRITING_ASSET_SCHEME = 'writingasset'

import { registerLocalAssetProtocol } from './localAssetProtocol'

// 只服务位图与 svg。刻意不含视频/音频（pptasset 才需要）——写作正文里放不了它们，
// 白名单越窄，协议被当成通用读盘口子的余地越小。
const ALLOWED_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

// 写作项目的配图只会出现在项目内的 images/ 下（project_manager.py 的 SUBDIRS 建的
// 就是它，正文里的相对路径恒为 ../images/）。用 posix 片段判定——见下方 toPosix。
const IMAGES_SEGMENT = '/images/'

/**
 * win32 反斜杠路径 → 正斜杠副本，仅供判定用，不改原始字符串（读盘仍用 normalize 后的
 * 原路径）。与 shared/proposalAsset.ts、src/chat/lib/kbAssetUrl.ts 的 toPosix 同款
 * 处理——统一「判定前先转 posix 再比 marker」这个仓库惯例，避免 win32 反斜杠路径被
 * 误判越界（2026-08-03 code review 指出此前这里是反方向的 `/`→sep，方向记反了，
 * 功能上两种分隔符形态凑巧都能命中但注释与实现对不上，这里改成正确且一致的写法）。
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 路径的任一段（按 posix `/` 切分）是否为 `..`——含此段即视为越界尝试，直接拒绝。 */
function hasParentSegment(p: string): boolean {
  return toPosix(p).split('/').some((seg) => seg === '..')
}

/** writingasset:// 的授权判定：扩展名 + 目录片段白名单 + 拒绝任何 `..` 段。见文件头注释。 */
export function isWritingAssetPath(absPath: string): boolean {
  if (!absPath || !ALLOWED_EXT_RE.test(absPath)) return false
  if (hasParentSegment(absPath)) return false
  return toPosix(absPath).includes(IMAGES_SEGMENT)
}

/**
 * 注册 writingasset:// handler。app.whenReady() 之后调用一次；
 * registerSchemesAsPrivileged 必须已在 ready 前跑过（见 index.ts）。
 * `resolveRoot` 传空串占位——validate 存在时 localAssetProtocol 完全不看它。
 */
export async function registerWritingAssetProtocol(): Promise<void> {
  await registerLocalAssetProtocol(WRITING_ASSET_SCHEME, () => '', isWritingAssetPath)
}
