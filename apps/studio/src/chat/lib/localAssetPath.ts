/**
 * 本地资产路径（KB 图 / 草稿产出图）的渲染层公共判定 + src 解码。
 *
 * 为什么需要解码（评审 CONFIRMED，实证过）：react-markdown 10 经 mdast-util-to-hast 的
 * normalizeUri 会把 img src 百分号编码——空格→%20、CJK→%E…。而存储 markdown、
 * shared/proposal.parseImages、点图手术（proposalImageOps）用的都是原始字节。macOS 的
 * userData 恒含空格（~/Library/Application Support/…），不解码则：产出图协议二次编码 403、
 * 删/换图静默 no-op、改图 IPC 拿 %20 路径 readFile ENOENT——整条点图链失效。
 * 消费方（AssistantMarkdown img override / urlTransform）必须先过 safeDecodeUri 还原。
 *
 * 为什么需要 isLocalAssetPath（评审 CONFIRMED，实证过）：react-markdown 的
 * defaultUrlTransform 把 win32 盘符路径（C:\… 与 C:/… 都算）当未知协议整体清空成 ''，
 * 图连 src 都拿不到，商标/工具栏/改换删全部不可达。渲染时对本地资产路径绕过默认
 * sanitize（见 AssistantMarkdown 的 urlTransform），其余 URL 照走默认防 javascript: 注入。
 */
import { isProposalAssetPath } from '@desktop-shared/proposalAsset'
import { isKbAssetPath } from './kbAssetUrl'

/**
 * decodeURIComponent 的不抛版：非法转义序列（如文件名里字面量的 `100%.png`）原样返回。
 * 已知残余边界：文件名若「恰好长得像合法转义」（字面量 `%20`）会被误解码——极罕见，接受。
 */
export function safeDecodeUri(u: string): string {
  try {
    return decodeURIComponent(u)
  } catch {
    return u
  }
}

/** KB 图或草稿产出图。两谓词内部都做了 win32 反斜杠归一。 */
export function isLocalAssetPath(p: string): boolean {
  return isKbAssetPath(p) || isProposalAssetPath(p)
}
