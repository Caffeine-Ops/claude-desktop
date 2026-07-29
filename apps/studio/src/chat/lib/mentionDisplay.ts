/**
 * 文件 mention 的【展示层】识别与压缩（2026-07-16）。
 *
 * 背景：occupier pill / 拖拽内联出的 `@"path"` mention 常与中文正文零空格
 * 相邻（「帮我修改@/a/b.pptx：…」）。旧的展示正则要求 @ 前必须是行首/
 * 空白，这种文本不命中 → 气泡/标题把整条绝对路径裸铺出来；而且旧 bare
 * 分支用 `@\S+`（\S 含中文），一旦命中会把「：【说明…】」整段中文吞进
 * mention。这里统一成一份宽松而有截断的规则：
 *
 *   - quoted `@"…"`：引号是明确的 mention 意图，任意位置命中；
 *   - bare `@…`：@ 前不能是单词字符或引号（lookbehind——email 的
 *     user@host 被拒，中文前缀放行），路径体在空白与常见中文标点处截断
 *     （路径里不该有「：，。」等，文件名极端含中文括号的场景由发送侧
 *     needsQuoting 扩容兜底，见 fileMentionAdapter）。
 *
 * 消费方：UserMessage 气泡（mention → 文件 chip）、ChatHeader / 侧栏
 * RailSessionList 标题（mention → basename 纯文本，condenseFileMentions）。
 * 这只是展示变换——store/wire 里的文本原样保留 `@"path"`。
 */

export const FILE_MENTION_DISPLAY_RE =
  /(?<![\w"])@("[^"]+"|[^\s，。：:；;、！？（）【】「」"']+)/g

/** m[1]（带引号或裸的内容）→ 纯路径。 */
export function mentionInnerToPath(inner: string): string {
  return inner.startsWith('"') && inner.endsWith('"') ? inner.slice(1, -1) : inner
}

export function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return name || path
}

/**
 * 内置模版 mention 的裸路径识别（2026-07-22 起，无 `@` 前缀——理由见
 * ProseMirrorComposerInput.tsx 的 onTemplatePicked 注释：ppt-master 只要
 * 目录路径字面量出现在消息里就触发分发，`@` 前缀会让 fusion-code 的
 * extractAtMentionedFiles 把目录当"要读内容的附件"处理，行为不可控）。
 * chipNodeView（composer 内实时渲染）与本文件的展示层识别（气泡/标题
 * 重新解析已发送文本）共用同一份判定，单一定义。
 */
export type TemplateMentionKind = 'brand' | 'layout' | 'deck'
export function templateKindFromPath(path: string): TemplateMentionKind | null {
  if (path.includes('/templates/brands/')) return 'brand'
  if (path.includes('/templates/layouts/')) return 'layout'
  if (path.includes('/templates/decks/')) return 'deck'
  return null
}

/**
 * 裸路径（无 `@` 前缀）形式的内置模版 mention 展示正则——与
 * FILE_MENTION_DISPLAY_RE 同一套边界/截断规则（词首 lookbehind、常见中文
 * 标点截断路径体），只是匹配目标换成"路径里含 /templates/(brands|layouts|
 * decks)/ 片段的绝对路径"。没有 `@` 可用来标记 mention 意图，靠目录片段
 * 本身识别。
 */
export const TEMPLATE_MENTION_DISPLAY_RE =
  /(?<![\w"])\/[^\s，。：:；;、！？（）【】「」"']*\/templates\/(?:brands|layouts|decks)\/[^\s，。：:；;、！？（）【】「」"']+/g

/** 内置模版 mention 的专属图标（public/skill-icons/，同 skill chip 一套渲染）。 */
export const TEMPLATE_MENTION_ICON = '/skill-icons/template.png'

/**
 * 标题级压缩：把文本里的文件 mention / 内置模版 mention 都换成 basename
 * 纯文本——会话标题（ChatHeader、侧栏行）容不下一整条绝对路径。两个
 * regex 各自 `String.replace`，互不依赖顺序（文件 mention 要求 `@` 前缀、
 * 模版 mention 要求裸路径，两者的匹配串不可能重叠）。
 */
export function condenseFileMentions(text: string): string {
  const withFileMentions = text.replace(FILE_MENTION_DISPLAY_RE, (_m, inner: string) =>
    basenameOf(mentionInnerToPath(inner))
  )
  return withFileMentions.replace(TEMPLATE_MENTION_DISPLAY_RE, (m) => basenameOf(m))
}
