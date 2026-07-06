/**
 * 「写方案」斜杠入口的命令识别。与 FusionRuntimeProvider 的 matchSlashCommand
 * 平行存在而不塞进它：那个函数的返回值是 DialogKind（开本地对话框），而本命令
 * 的动作是激活方案模式 + 可选直发尾随文字，语义不同、别硬挤一个 switch。
 *
 * 算法也刻意与 matchSlashCommand 不同（终审 finding #4）：那边是「空白切词取
 * 命令头」，这边是「已知命令名的前缀 + 边界匹配」。原因是中文输入习惯里命令和
 * 需求文字之间常常不打空格（`/proposal-writer给XX医院写方案`），切词法会把整串
 * 当命令头、静默不命中——而本命令失手的代价是整条方案硬门纪律没激活、消息被当
 * 普通聊天发出，比 /skill 失手（只是不弹对话框）重得多，所以边界放宽到「命令名
 * 后第一个字符不是命令名字符即算边界」。/skill 等既有命令维持原约定不动。
 */

/**
 * 「写方案」的全部可识别命令名（不含前导 `/`）。chip 从斜杠菜单插入的是 plugin
 * 命名空间形态 `claude-desktop:proposal-writer`（bundled fusion-code 回传的命令
 * 名），用户手敲或其它后端下则是裸名 `proposal-writer`。
 *
 * 这是命令名的【唯一事实源】：skillChipRegistry 的两条「写方案」chip 注册从这里
 * 派生（终审 finding #7——此前两处各自硬编码同一对字符串，改名漏同步会出现
 * 「chip 显示正常、点了却不拦截、静默直发 CLI」）。改名/加别名只改这里。
 * 顺序有讲究：更长的命名空间形态在前，前缀匹配时先试长的，避免短名吞掉长名。
 */
export const PROPOSAL_WRITER_SLASH_NAMES = [
  'claude-desktop:proposal-writer',
  'proposal-writer'
] as const

// 命令名字符集：用于判断前缀命中后的下一个字符是否还是「命令名的延续」。
// `/proposal-writerx` 的 x 属于该集 → 不算边界、不命中（那是另一个命令）；
// `/proposal-writer给` 的「给」不属于 → 算边界、命中且「给…」进 rest。
const COMMAND_NAME_CHAR = /[a-z0-9_:-]/i

export function matchProposalSlash(text: string): { rest: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const lower = trimmed.toLowerCase()
  for (const name of PROPOSAL_WRITER_SLASH_NAMES) {
    const cmd = `/${name}`
    if (!lower.startsWith(cmd)) continue
    const next = trimmed[cmd.length]
    // 命中前缀但后面还是命令名字符 → 是别的更长命令（如 /proposal-writerx），放行。
    if (next !== undefined && COMMAND_NAME_CHAR.test(next)) continue
    // rest = 命令名之后的全部文字（保留内部换行，作首条消息直发）。
    return { rest: trimmed.slice(cmd.length).trim() }
  }
  return null
}
