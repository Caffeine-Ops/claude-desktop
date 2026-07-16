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
 * 标题级压缩：把文本里的文件 mention 换成 basename 纯文本——会话标题
 * （ChatHeader、侧栏行）容不下一整条绝对路径。`String.replace` 自管 /g
 * 的 lastIndex，与气泡的 exec 循环共用一个 RE 对象互不串扰（同步渲染，
 * 两者不会交错执行）。
 */
export function condenseFileMentions(text: string): string {
  return text.replace(FILE_MENTION_DISPLAY_RE, (_m, inner: string) =>
    basenameOf(mentionInnerToPath(inner))
  )
}
