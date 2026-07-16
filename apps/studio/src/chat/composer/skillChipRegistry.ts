import { PROPOSAL_WRITER_SLASH_NAMES } from '../lib/proposalSlash'
import { SCENARIO_SLASH_SPECS } from '../lib/scenarioSlash'

/**
 * Per-skill chip appearance registry.
 *
 * Every slash chip renders as the same bordered pill (see
 * `chipNodeView.ts`) — icon + label, hover reveals a × to delete. A
 * handful of *known* skills get a bespoke icon + friendly label instead
 * of the generic glyph + raw command name (e.g. `/ppt-master` → PPT
 * icon + 「制作PPT」) — so the composer reads as a product surface
 * rather than a raw CLI prompt.
 *
 * This is the single place to register that. Adding a new skill means
 * appending ONE entry below; nothing in the NodeView changes. Keep the
 * registry purely declarative — no DOM, no React — so it stays a plain
 * data table that `chipNodeView.ts` reads.
 *
 *   - `match`: the chip's literal `value` (with leading `/`). The chip
 *     value is the verbatim text we serialize back to fusion-code, so
 *     matching on it keeps the wire format untouched — this is *only* a
 *     visual override.
 *   - `image`: public URL of the skill's colour icon (PNG with
 *     transparent background). 2026-07-16 起从 Icons8 Office 风格 SVG
 *     path 表换成定制雪碧图切片（public/skill-icons/，源图 4×2 网格，
 *     切图脚本见 docs/ui-prototype-update-toast.html 同期会话记录）。
 *     新增技能先切好透明底 PNG 放进 public/skill-icons/ 再注册；备用
 *     切片 code.png / web.png / petal.png 已就位。所有消费方（React 的
 *     SkillChipIcon 组件 + chipNodeView 的 imperative img）按此渲染。
 *   - `label`: the pill text. Defaults to the value minus its leading
 *     `/` (the raw skill name) when omitted.
 */

export interface SkillChipSpec {
  /** Literal chip value to match, e.g. `/ppt-master`. */
  match: string
  /** Public URL of the colour icon, e.g. `/skill-icons/ppt.png`. */
  image: string
  /** Pill text. Defaults to the value without its leading `/`. */
  label?: string
  /**
   * One-line blurb for surfaces that show more than a pill (the 技能 button's
   * SkillPickerPopover). Optional — the composer chip and the inline `/`
   * suggestion menu don't use it, only the dedicated picker does.
   */
  description?: string
}

/**
 * The registry. Order doesn't matter — lookup is by exact `value`.
 * Add new skills here; the NodeView picks them up automatically.
 */
export const SKILL_CHIP_SPECS: readonly SkillChipSpec[] = [
  // ppt-master — both the plugin-namespaced value (bundled fusion-code
  // exposes it as `claude-desktop:ppt-master`, so the chip value is
  // `/claude-desktop:ppt-master`) and the bare name (other backends /
  // user-installed copies surface it without the namespace).
  {
    match: '/claude-desktop:ppt-master',
    image: '/skill-icons/ppt.png',
    label: '制作PPT',
    description: '生成、编辑幻灯片演示文稿'
  },
  {
    match: '/ppt-master',
    image: '/skill-icons/ppt.png',
    label: '制作PPT',
    description: '生成、编辑幻灯片演示文稿'
  },
  // imagegen — 生成图片。namespaced + 裸名双注册，理由同 ppt-master。
  // 2026-07-09：「生成图片」按钮从 gpt-image-2 换绑到 imagegen（imagegen 已
  // 改造为纯标准库走同一 OpenAI 兼容网关，见 skills/imagegen/scripts/image_gen.py）。
  // gpt-image-2 skill 仍在仓库、仍可手动 /gpt-image-2 调用，只是不再是这个
  // 彩色按钮背后的那个 skill。
  {
    match: '/claude-desktop:imagegen',
    image: '/skill-icons/image.png',
    label: '生成图片',
    description: 'AI 图片生成与编辑'
  },
  {
    match: '/imagegen',
    image: '/skill-icons/image.png',
    label: '生成图片',
    description: 'AI 图片生成与编辑'
  },
  // spreadsheets — 处理表格。namespaced + 裸名双注册，理由同 ppt-master。
  {
    match: '/claude-desktop:spreadsheets',
    image: '/skill-icons/sheet.png',
    label: '处理表格',
    description: '生成、编辑 Excel 表格'
  },
  {
    match: '/spreadsheets',
    image: '/skill-icons/sheet.png',
    label: '处理表格',
    description: '生成、编辑 Excel 表格'
  },
  // remotion — 制作视频。namespaced + 裸名双注册，理由同 ppt-master。
  {
    match: '/claude-desktop:remotion',
    image: '/skill-icons/video.png',
    label: '制作视频',
    description: '用 React 生成动画短视频'
  },
  {
    match: '/remotion',
    image: '/skill-icons/video.png',
    label: '制作视频',
    description: '用 React 生成动画短视频'
  },
  // proposal-writer — 写方案。namespaced + 裸名双注册，理由同 ppt-master。
  // 注意：这个命令不会发给 fusion-code——FusionRuntimeProvider.onNew 会拦截它、
  // 激活方案模式（见 matchProposalSlash）。chip 只是让斜杠菜单里它长得像个产品功能。
  // 命令名从 PROPOSAL_WRITER_SLASH_NAMES 派生而非在此重写字面量：拦截识别集与
  // chip 注册必须永远同一份名单，否则改名漏同步会出现「chip 显示正常、点了却不
  // 拦截、静默直发 CLI」。
  ...PROPOSAL_WRITER_SLASH_NAMES.map(
    (name): SkillChipSpec => ({
      match: `/${name}`,
      image: '/skill-icons/write.png',
      label: '写方案',
      description: '起草文档、方案与报告'
    })
  ),
  // 代码开发场景伪命令（日常开发 / 网站开发 / Agent 应用）——ScenarioRail
  // 的二级导航标签，不是真实 CLI skill：发送时 FusionRuntimeProvider.onNew
  // 会把命令剥掉只发正文（stripScenarioSlash）。从 SCENARIO_SLASH_SPECS
  // 派生（同 proposal 的单一名单纪律），这里注册只为让 chip 渲染出中文
  // 标签 + 场景图标。
  ...SCENARIO_SLASH_SPECS.map(
    (s): SkillChipSpec => ({
      match: `/${s.name}`,
      image: s.image,
      label: s.label,
      description: s.description
    })
  )
]

const BY_VALUE = new Map(SKILL_CHIP_SPECS.map((s) => [s.match, s]))

/** Look up a bespoke chip spec by its literal value, or `null`. */
export function findSkillChipSpec(value: string): SkillChipSpec | null {
  return BY_VALUE.get(value) ?? null
}

/**
 * A leading slash command, e.g. `/claude-desktop:ppt-master rest...`. Only
 * the command token at the very start is matched — a `/` mid-text is left
 * alone. The command may carry a plugin namespace (`claude-desktop:`) and
 * hyphens. Shared by every consumer that recovers "which skill did this
 * message invoke" from raw text (message-bubble chip, composer's read-only
 * mode indicator) so the parsing rule has exactly one definition.
 */
export const LEADING_SLASH_COMMAND_RE = /^(\/[\w:-]+)(\s|$)/

/** Find the skill chip spec for a message's leading slash command, if any. */
export function findSkillChipSpecInText(text: string): SkillChipSpec | null {
  const match = LEADING_SLASH_COMMAND_RE.exec(text)
  return match ? findSkillChipSpec(match[1]!) : null
}
