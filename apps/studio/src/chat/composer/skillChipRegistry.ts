import { PROPOSAL_WRITER_SLASH_NAMES } from '../lib/proposalSlash'
import { SCENARIO_SLASH_SPECS } from '../lib/scenarioSlash'

/**
 * Per-skill chip appearance registry.
 *
 * Every slash chip renders as the same bordered pill (see
 * `chipNodeView.ts`) — icon + label, hover reveals a × to delete. A
 * handful of *known* skills get a bespoke icon + friendly label instead
 * of the generic glyph + raw command name (e.g. `/ppt-creator` → PPT
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
  /** Literal chip value to match, e.g. `/ppt-creator`. */
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
  // ppt-creator — 2026-07-29 起这个 skill 不再随安装包发布，改为按需下载安装到
  // `~/.cowork/plugins/`（见 electron/main/services/pptSkillInstaller.ts），因此
  // 正式命令是 `/cowork:ppt-creator`；裸名 `/ppt-creator` 覆盖用户自装的同名副本。
  //
  // **旧名 ppt-master 必须继续注册**：历史会话里存的 chip value 就是
  // `/claude-desktop:ppt-master`，而 chip 存的是 wire 格式、绝不追溯改写。
  // 少了这两条，老会话里的「制作PPT」会退化成灰色的原始命令文本，用户会以为
  // 自己的历史记录坏了。它们只是显示别名——新会话不会再产生这两个 value。
  {
    match: '/cowork:ppt-creator',
    image: '/skill-icons/ppt.png',
    label: '制作PPT',
    description: '生成、编辑幻灯片演示文稿'
  },
  {
    match: '/ppt-creator',
    image: '/skill-icons/ppt.png',
    label: '制作PPT',
    description: '生成、编辑幻灯片演示文稿'
  },
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
  // imagegen — 生成图片。namespaced + 裸名双注册，理由同 ppt-creator。
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
  // spreadsheets — 处理表格。namespaced + 裸名双注册，理由同 ppt-creator。
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
  // remotion — 制作视频。namespaced + 裸名双注册，理由同 ppt-creator。
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
  // writing — 写作。namespaced + 裸名双注册，理由同 ppt-creator。
  // 与 proposal-writer（写方案）的分工：那个写商业方案/售前文档、有方案模式
  // 的双栏工作台并走客户端拦截；这个是通用内容写作（文案/小说/文章），是普通
  // skill，命令原样发给 CLI 不拦截。图标也刻意不同，两者会同时出现在斜杠菜单。
  {
    match: '/claude-desktop:writing',
    image: '/skill-icons/writing.png',
    label: '写作',
    description: '公众号文案、小说、文章的创作与改写'
  },
  {
    match: '/writing',
    image: '/skill-icons/writing.png',
    label: '写作',
    description: '公众号文案、小说、文章的创作与改写'
  },
  // proposal-writer — 写方案。namespaced + 裸名双注册，理由同 ppt-creator。
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
  // tender-review — 审标书。namespaced + 裸名双注册，理由同 ppt-creator。
  // 与 proposal-writer（写方案）是同一条业务链的上下游：先审标看清招标方的
  // 规则，再写标产出方案。但两者集成深度不同——写方案走客户端拦截 + 方案模式
  // 工作台，审标是普通 skill，命令原样发给 CLI 不拦截。
  {
    match: '/claude-desktop:tender-review',
    image: '/skill-icons/tender.png',
    label: '审标书',
    description: '审招标文件，产投标核对清单'
  },
  {
    match: '/tender-review',
    image: '/skill-icons/tender.png',
    label: '审标书',
    description: '审招标文件，产投标核对清单'
  },
  // doc-convert — 文档处理。namespaced + 裸名双注册，理由同 ppt-creator：
  // 技能命令有时带命名空间前缀有时不带，只注册一份会让另一种写法退化成
  // 光秃秃的英文命令（无中文标签、无图标）。
  {
    match: '/claude-desktop:doc-convert',
    image: '/skill-icons/doc-convert.png',
    label: '文档处理',
    description: '提取文字、表格台账、格式转换'
  },
  {
    match: '/doc-convert',
    image: '/skill-icons/doc-convert.png',
    label: '文档处理',
    description: '提取文字、表格台账、格式转换'
  },
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

const BUILTIN_BY_VALUE = new Map(SKILL_CHIP_SPECS.map((s) => [s.match, s]))

/**
 * 远端场景目录带来的 chip 外观覆盖层（2026-07-29）。后台在 sub2api 里配好
 * 的分类/技能条目携带 label + icon，经 `stores/scenarioCatalog.ts` 灌进来，
 * 于是「改一个 chip 的文案或图标」不再需要发版。
 *
 * 为什么是模块级可变量而不是 React state / context：这张表的消费方里有
 * `chipNodeView.ts`——ProseMirror 的 imperative NodeView，不在 React 树里，
 * 拿不到 hook。做成模块级查询函数，两类消费方（React 的 SkillChipIcon /
 * ScenarioRail，与 imperative 的 NodeView）继续共用同一个 `findSkillChipSpec`，
 * 谁都不用改调用方式。
 *
 * 已知取舍：**已经画在编辑器里的 chip 不会因为这次覆盖而重绘**（NodeView
 * 只在 mount/update 时读一次）。远端配置的到达时机是登录后/冷启动，那时
 * composer 里通常是空的；即便真有一个陈旧 chip，它的 value（wire 格式）
 * 仍然正确，只是文案还是旧的，下次插入即刷新。为此去给 NodeView 加一套
 * 订阅重绘不值当。
 *
 * 覆盖是**整表替换**而不是逐字段 merge：远端条目给了什么就是什么，没给的
 * 字段回落内置表里同 value 的那条（见 findSkillChipSpec 的查找顺序）。
 */
let remoteByValue: ReadonlyMap<string, SkillChipSpec> = new Map()

/** 灌入远端覆盖层（整表替换）。传空数组即恢复到纯内置表。 */
export function applyRemoteSkillChipSpecs(specs: readonly SkillChipSpec[]): void {
  remoteByValue = new Map(specs.map((s) => [s.match, s]))
}

/**
 * 只查内置表，**绕过远端覆盖**。构造覆盖层本身时要用它：远端条目没配
 * `icon` 时要回落到内置图标，此时若走 findSkillChipSpec 会读到上一轮的
 * 覆盖结果，几次刷新后图标就漂了。
 */
export function findBuiltinSkillChipSpec(value: string): SkillChipSpec | null {
  return BUILTIN_BY_VALUE.get(value) ?? null
}

/**
 * 远端条目既没配 `icon`、内置表里也查不到时的兜底图标——后台新加一个
 * 技能却忘了配图标，chip 也得画得出来（渲染不出图标的 chip 会被
 * ScenarioRail 整条跳过，等于「配了个看不见的技能」，那才是最难排查的）。
 */
export const FALLBACK_SKILL_ICON = '/skill-icons/petal.png'

/**
 * Look up a bespoke chip spec by its literal value, or `null`.
 * 远端覆盖优先，内置表兜底——远端没配过的技能（用户自己装的 skill、
 * proposal-writer 这类客户端拦截命令）照常走内置注册。
 */
export function findSkillChipSpec(value: string): SkillChipSpec | null {
  return remoteByValue.get(value) ?? BUILTIN_BY_VALUE.get(value) ?? null
}

/**
 * A leading slash command, e.g. `/claude-desktop:spreadsheets rest...`. Only
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
