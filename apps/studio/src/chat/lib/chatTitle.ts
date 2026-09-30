/**
 * 会话标题的斜杠命令前缀拆分。
 *
 * `/claude-desktop:ppt-creator 武汉大学介绍`
 *   → chip `/ppt-creator`（冒号后短名，完整命令进 hover title）
 *   + 正文标题 `武汉大学介绍`
 *
 * 纯命令无参数、或非 '/' 开头的标题**不拆**——chip 只在「命令 + 参数」
 * 形态下才有语义（参数才是会话主题，命令只是它的来源标记）。
 *
 * 从 ThreadView 的渲染体里抽出来的（2026-09-30）：导出对话要用的标题
 * 必须和顶栏显示的**逐字一致**，不能一边拆一边不拆——「导出的和看到的
 * 不一样」正是导出功能最该避免的缺陷（2026-09-28 真机走查实锤）。
 * 抽成纯函数后顶栏和导出共用一个写手，顺带进了 bun test。
 */
import { condenseFileMentions } from './mentionDisplay'
import { stripMessageMarker } from './messageMarkers'

export interface SlashTitleParts {
  /** 完整命令（含命名空间），不拆时为 null。 */
  cmdFull: string | null
  /** 冒号后的短名，供 chip 显示；不拆时为 null。 */
  cmdShort: string | null
  /** 去掉命令前缀后的正文标题；不拆时等于原串。 */
  restTitle: string
}

/** `\S+` 吃命令、`\s+` 吃分隔空白、`\S[\s\S]*` 保证参数非空且可跨行。 */
const CMD_RE = /^\/(\S+)\s+(\S[\s\S]*)$/

export function splitSlashTitle(display: string): SlashTitleParts {
  const m = CMD_RE.exec(display)
  if (!m) return { cmdFull: null, cmdShort: null, restTitle: display }
  const full = m[1]
  return {
    cmdFull: '/' + full,
    cmdShort: '/' + (full.split(':').pop() ?? full),
    restTitle: m[2]
  }
}

export interface ChatHeaderTitle extends SlashTitleParts {
  /** 顶栏那行字的完整形态（含斜杠命令前缀）。 */
  display: string
  /**
   * 这个会话到底有没有标题（剥/压之后仍有非空内容）。`display` 落到兜底
   * 文案时为 false。
   *
   * **别用「display === 兜底文案」代替它**：真把会话命名成「新对话」的
   * 用户会被误判成没标题，重命名弹窗预填成空串。
   */
  hasTitle: boolean
}

/**
 * 顶栏标题的**完整派生链**，顶栏渲染与导出共用同一份结果。
 *
 * 四步，顺序不能乱：
 *   1. 剥消息内嵌协议标记（`[[sheet-selection]]`/`[[image-edit]]`）——必须
 *      在拆斜杠命令**之前**，否则表格「框选问 AI」这类消息的首条 prompt
 *      （marker JSON + 提示语 + TSV）会原样进标题，撑成一整行（2026-07-13 事故）
 *   2. 把 `@"绝对路径"` 压成 basename——带内联文件的会话，原始标题是一整条
 *      路径，顶栏一行放不下，也不该出现在导出文件名里
 *   3. 空标题兜底（调用方喂当前语言的「新对话 / New chat」）
 *   4. 拆斜杠命令前缀 → chip + 正文
 *
 * **为什么必须是一个函数而不是两边各算一遍**：导出用的标题一度是自己算的，
 * 结果导出文件的标题长出了屏幕上根本没有的命令前缀——「导出的和看到的不
 * 一样」（2026-09-28 真机走查实锤）。现在顶栏和 ⇧⌘E 都只读这一份。
 */
export function chatHeaderTitle(rawTitle: string | null, untitled: string): ChatHeaderTitle {
  const stripped = rawTitle ? stripMessageMarker(rawTitle) : rawTitle
  const condensed = stripped ? condenseFileMentions(stripped) : stripped
  const hasTitle = Boolean(condensed && condensed.trim())
  const display = hasTitle ? (condensed as string) : untitled
  return { display, hasTitle, ...splitSlashTitle(display) }
}
