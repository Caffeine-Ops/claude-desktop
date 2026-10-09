/**
 * 用户气泡「复制」钮的判定与取文——文本进，「复制什么」或 null 出。
 *
 * 为什么不写在 UserMessage 里
 * ---------------------------
 * 组件那边已经按首行协议标记分流（`ClampedUserBubble`：表格框选 →
 * SheetSelectionCard，图片标记 → ImageEditCard，其余 → 普通气泡），看着
 * 顺手加个 `if` 就完事。但这类判定坏掉的方式是**静默多出一个钮**：以后
 * 新增一种协议标记卡片时忘了在这里排除，复制钮就长在卡片底下，按一下把
 * 内部 JSON 吐进剪贴板。手工走查碰不到它（得正好去框选一个表格区域问
 * AI 才复现），只有自动化测试抓得住——所以抠成 `src/chat/lib/` 下的纯
 * 函数，按项目约定（见根 CLAUDE.md「命令」小节）自动进 `bun test`。
 *
 * 本模块刻意零依赖：只吃 messageMarkers 的两个 marker 常量（那边本身是
 * 零依赖纯模块），不碰 store / React / i18n。
 *
 * 复制的是**原文**，不做任何归一化（2026-10-09 用户拍板）：`@"路径"`
 * 这种文件引用保持原始写法，粘回输入框时 mention chip 能原样恢复，改两个
 * 字就能重发——这正是「复制自己发的话」最主要的用途。压缩成文件名
 * （`condenseFileMentions`）粘到微信里好看，但粘回输入框就只剩一段死文字
 * 了，两者不可兼得，取重发。
 */

import { IMAGE_EDIT_MARKER, SHEET_SELECTION_MARKER } from './messageMarkers'

/**
 * 首行是否顶着某个协议 marker。
 *
 * 判定刻意复刻 messageMarkers 里两个 parse 函数各自的前置条件，而不是直接
 * 调用它们：parse 在 JSON 解析失败时返回 null（组件因此退回普通气泡，屏幕
 * 上就是半截 JSON），而那种消息同样不该有复制钮——「marker 认得出但 JSON
 * 被截断」是 stripMessageMarker 栽过两次的同一类坑（2026-07-13）。只看
 * marker 位置、不看 JSON 能不能解析，两种情况一起拦住。
 *
 * `allowSlashLead` 对应 image-edit 的放行规则：CLI 文本形态允许
 * `/claude-desktop:imagegen ` 这样的 skill slash 领跑（slash 必须占开头才能
 * 强制触发 skill）。sheet-selection 的协议要求顶格（parse 用的是
 * startsWith），所以传 false——两处判定跟着各自的协议走，免得漂移。
 */
function hasMarkerAtHead(
  raw: string,
  marker: string,
  allowSlashLead: boolean
): boolean {
  const nl = raw.indexOf('\n')
  const firstLine = nl === -1 ? raw : raw.slice(0, nl)
  const idx = firstLine.indexOf(marker)
  if (idx === -1) return false
  if (idx === 0) return true
  if (!allowSlashLead) return false
  // 除 `/xxx ` 之外的前缀一律不认——正文里引用 marker 字样
  // （「我看到 [[image-edit]] 是什么意思？」）不能被当成协议消息。
  return /^\/[\w.:-]+\s+$/.test(firstLine.slice(0, idx))
}

/**
 * 这条用户消息该复制什么。`null` = 不该长复制钮：
 *  - 空消息（纯图片消息的文本部分就是空的）
 *  - 两种首行协议标记消息（屏幕上渲染成卡片，原文是内部 JSON）
 */
export function userMessageCopyText(raw: string): string | null {
  if (raw.trim().length === 0) return null
  if (hasMarkerAtHead(raw, SHEET_SELECTION_MARKER, false)) return null
  if (hasMarkerAtHead(raw, IMAGE_EDIT_MARKER, true)) return null
  return raw
}
