/**
 * 「代码开发」场景伪命令（2026-07-16，EmptyState ScenarioRail 二级导航）。
 *
 * 日常开发 / 网站开发 / Agent 应用是【纯前端的场景导航标签】，不是 CLI 里
 * 真实存在的 skill：点场景 chip → composer 里出现黑色场景标签（与技能 chip
 * 同一套 slash 原子节点 + skillChipRegistry 渲染）→ ScenarioRail 显示该场景
 * 的推荐 prompt。发送时命令必须被剥掉——fusion-code 不认识 `/daily-dev`，
 * 原样发出去会被当成未知 slash 命令吞掉/报错。剥离发生在
 * FusionRuntimeProvider.onNew 的 baseText 构造处（stripScenarioSlash）。
 *
 * 形状对齐 proposalSlash.ts：命令名单是【唯一事实源】，skillChipRegistry 的
 * 场景 chip 注册与 ScenarioRail 的场景 items 都从这里派生——改名/加场景只改
 * 这里，漏同步会出现「chip 显示正常、发送却把伪命令直发 CLI」。
 *
 * 与 proposal 的差别：场景剥离没有任何模式激活语义，剥掉即完——场景信息
 * 已经蕴含在推荐 prompt 的正文里，标签只是导航痕迹。
 */

export interface ScenarioSlashSpec {
  /** 命令名（不含前导 `/`），也是 ScenarioRail 推荐 prompt 表的 key。 */
  name: string
  /** chip 上的中文标签。 */
  label: string
  /** public/skill-icons/ 下的切片图标。 */
  image: string
  description: string
}

export const SCENARIO_SLASH_SPECS: readonly ScenarioSlashSpec[] = [
  {
    name: 'daily-dev',
    label: '日常开发',
    image: '/skill-icons/code.png',
    description: '功能开发、重构、修 Bug、补测试'
  },
  {
    name: 'web-dev',
    label: '网站开发',
    image: '/skill-icons/web.png',
    description: '官网、后台、博客、电商页面'
  },
  {
    name: 'agent-app',
    label: 'Agent 应用',
    image: '/skill-icons/petal.png',
    description: 'Agent、聊天应用与智能客服'
  }
]

// 命令名字符集：判断前缀命中后的下一个字符是否还是「命令名的延续」——
// 与 proposalSlash 的宽边界规则一致（中文输入习惯里命令和需求文字之间
// 常常不打空格，`/daily-dev帮我修bug` 也要命中）。
const COMMAND_NAME_CHAR = /[a-z0-9_:-]/i

/**
 * 远端场景目录里标了 `pseudo: true` 的命令名（不含前导 `/`），由
 * `stores/scenarioCatalog.ts` 灌入。
 *
 * **这是接远端配置时最容易漏的一环**：后台在场景目录里加了一个新的导航
 * 标签，chip 能正常渲染（走 skillChipRegistry 的远端覆盖），但如果它没被
 * 登记到这里，发送时就剥不掉，`/新命令` 会原样发给 fusion-code 被当成未知
 * 命令。上面那份 SCENARIO_SLASH_SPECS 是内置兜底（未登录/离线时仍要能用），
 * 远端名单与它取并集——两边都可能有、都要剥。
 */
let remoteScenarioNames: readonly string[] = []

/** 灌入远端伪命令名单（整表替换）。传空数组即只剩内置三个。 */
export function applyRemoteScenarioSlashNames(names: readonly string[]): void {
  remoteScenarioNames = names
}

/**
 * 剥掉 leading 场景伪命令，返回剩余正文；不是场景命令返回 null。
 * 只匹配文本最开头的命令 token——`/` 出现在正文中间不受影响。
 */
export function stripScenarioSlash(text: string): { rest: string } | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const lower = trimmed.toLowerCase()
  const names = [...SCENARIO_SLASH_SPECS.map((s) => s.name), ...remoteScenarioNames]
  for (const name of names) {
    const cmd = `/${name.toLowerCase()}`
    if (!lower.startsWith(cmd)) continue
    const next = trimmed[cmd.length]
    if (next !== undefined && COMMAND_NAME_CHAR.test(next)) continue
    return { rest: trimmed.slice(cmd.length).trim() }
  }
  return null
}
