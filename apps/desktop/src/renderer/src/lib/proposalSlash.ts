/**
 * 「写方案」斜杠入口的命令识别。与 FusionRuntimeProvider 的 matchSlashCommand
 * 平行存在而不塞进它：那个函数的返回值是 DialogKind（开本地对话框），而本命令
 * 的动作是激活方案模式 + 可选直发尾随文字，语义不同、别硬挤一个 switch。
 *
 * 两个命令名都认：chip 从斜杠菜单插入的是 plugin 命名空间形态
 * `/claude-desktop:proposal-writer`（bundled fusion-code 回传的命令名），用户手敲
 * 或其它后端下则是裸名 `/proposal-writer`——与 skillChipRegistry 的双注册同一理由。
 */
const PROPOSAL_SLASH_NAMES = new Set(['proposal-writer', 'claude-desktop:proposal-writer'])

export function matchProposalSlash(text: string): { rest: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  // head = 第一个空白前的命令名；rest = 其后全部文字（保留内部换行，作首条消息直发）。
  const m = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  if (!PROPOSAL_SLASH_NAMES.has(m[1].toLowerCase())) return null
  return { rest: (m[2] ?? '').trim() }
}
