import { useRef, useState } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { useAuiState } from '@assistant-ui/react'

import { useT, useTFormat } from '../../../i18n'
import {
  findSkillChipSpec,
  findSkillChipSpecInText
} from '../../../composer/skillChipRegistry'
import { SkillChipIcon } from '../SkillChipIcon'

/**
 * EmptyState 场景导航（原型 docs/empty-state-composer-prototype.html，参考
 * WorkBuddy 空态）：分类 tab + 一条「双态」chip 行，渲染在 hero composer
 * 卡片上方（Composer variant='hero' 时由 Composer 自己挂载，见其注释）。
 *
 * 双态 chip 行的单一真源是 composer.text 本身，不另设选中态 state：
 *
 *   - 点技能 chip → `onInsertSkill(value)` 把整个 input 重置为该技能的
 *     slash 原子节点（resetWithSlashCommand，与 `/` 菜单产出同款 chip）——
 *     旧正文一并清空，点技能=重开该技能流程（用户要求，2026-07-16）。
 *   - composer 以某个已注册技能开头且 chip 后正文为空（刚选完技能）→
 *     行切换为该技能的推荐 prompt；点一条 → `onFillPrompt(text)` 保留
 *     chip 填入正文（fillBody）→ 正文非空 → 行自动退回技能行。删掉
 *     chip（× 或 Backspace）或清空正文，行同样随 text 派生自动翻转。
 *
 * 技能的 label / 彩色图标一律从 skillChipRegistry 取（那是「哪些技能是
 * 产品表面」的唯一事实源）；这里只维护【分类归属】和【推荐 prompt 文案】。
 * 插入 value 用 bundled fusion-code 的 plugin 命名空间形态（registry 首选
 * 注册项）——与 SkillPickerPopover 动态源回传的命令名一致。
 *
 * 推荐 prompt 是中文内容配置（同 EmptyState 的 promo banner），不进 i18n
 * 翻译表；分类 tab 标签是 chrome 文案，走 t()。
 *
 * 视觉体系（2026-07-16 方案 B「同族渐进 + 技能锚点」，六方案对比稿见
 * docs/ui-prototype-scenario-rail-styles.html）：一个家族两档权重表层级——
 * 实心墨黑=「选中」（分类 tab 选中态、三级行首的技能锚点），柔底=「可点
 * 项」（技能 chip 与推荐 prompt，与 composer 内 chip 的柔底无边同族）；
 * 二级 vs 三级靠图标区分——技能带彩色图标、建议带品牌绿 ↘。原型里三级
 * 是更轻的幽灵档（无底色 + muted 文字，hover 才浮底），真机实测不清晰：
 * 散在页面上不像可点的东西（2026-07-16 用户反馈），升半档改柔底。此前
 * 三层各一种语言（墨黑 pill / 白卡描边 / 灰底 pill）且进三级后没有位置
 * 锚，是本次重做的两个动因。
 */

/* ───────────────────────── 数据 ───────────────────────── */

interface ScenarioPrompt {
  /** chip 上的短标签。 */
  label: string
  /** 点击后填入 composer 正文的完整 prompt 模板（单行）。 */
  text: string
}

/** 首层 chip：真实技能（插 slash chip）或直达示例 prompt（直接填正文）。 */
type ScenarioItem =
  | { kind: 'skill'; value: string }
  | { kind: 'prompt'; label: string; text: string }

type CategoryId = 'daily' | 'code' | 'design'

interface ScenarioCategory {
  id: CategoryId
  labelKey: 'scenarioCatDaily' | 'scenarioCatCode' | 'scenarioCatDesign'
  icon: React.ReactNode
  items: readonly ScenarioItem[]
}

/**
 * 技能 → 推荐 prompt。key 是【裸名】（去掉 `/` 与 plugin 命名空间），这样
 * 无论 chip 是命名空间形态还是裸名形态插入的都能命中同一份配置。
 */
const PROMPTS_BY_SKILL: Record<string, readonly ScenarioPrompt[]> = {
  'proposal-writer': [
    {
      label: '项目投标方案',
      text: '给【客户名称】写一份项目投标方案，包含需求理解、技术方案、实施计划、报价构成四部分。'
    },
    {
      label: '产品需求文档',
      text: '把【功能想法】整理成一份 PRD，包含背景、目标用户、功能清单、验收标准。'
    },
    {
      label: '活动策划案',
      text: '帮我写一份【活动主题】的策划方案，覆盖目标、流程安排、物料清单和预算。'
    }
  ],
  'ppt-master': [
    {
      label: 'AI 发展历程 PPT',
      text: '请生成一个 AI 人工智能发展历程的 PPT，从图灵测试讲到大语言模型，每页一个里程碑，配时间轴。'
    },
    {
      // 修改现有文件：【PPT 文件】是 filePlaceholderPlugin 的文件槽（点击
      // 选文件换成 mention chip）；直接拖 pptx 进输入框同样以 @"path" chip
      // 混排进正文。文案刻意不带「拖入/点击」动作词（用户拍板 2026-07-16）
      // ——槽自己的虚线 pill 形态已表达「这里放文件」。
      label: '修改PPT文件',
      text: '帮我修改【PPT 文件】：【说明要改什么，例如换主题色、更新第 3 页数据、统一字体】，其余保持原样。'
    },
    {
      label: '季度业务汇报',
      text: '帮我生成一套季度业务汇报 PPT，包含业绩回顾、关键项目、问题与风险、下季度规划四个章节。'
    },
    {
      label: '产品介绍页',
      text: '为【产品名称】做一份 10 页以内的产品介绍 PPT，突出核心卖点和客户案例。'
    }
  ],
  spreadsheets: [
    {
      // 「【…文件】」结尾 = filePlaceholderPlugin 的文件槽（点击选文件）。
      label: 'Excel 数据清洗',
      text: '帮我清洗【Excel 文件】：去重、补全缺失值、统一日期与金额格式，输出干净的新表并说明改动。'
    },
    {
      label: '销售数据透视',
      text: '基于【Excel 文件】生成透视汇总：按月份和区域统计销售额，标出环比变化最大的三项。'
    },
    {
      label: '发票台账整理',
      text: '把【发票信息】批量整理成 Excel 台账，包含日期、金额、税率、销售方，最后输出汇总合计。'
    },
    {
      label: '可视化表格',
      text: '把【Excel 文件】里的数据做成图表：自动挑选合适的图表类型（柱状/折线/饼图），配好标题、图例和数据标签。'
    },
    {
      label: '智能分析',
      text: '帮我分析【Excel 文件】：找出关键趋势、异常波动和相关性，用一页摘要给出结论和建议。'
    },
    {
      label: '表格生成PPT',
      text: '把【Excel 文件】里的数据整理成一套汇报 PPT：关键指标做成图表页，最后一页给出结论与建议。'
    },
    {
      label: '表格美化',
      text: '帮我美化【Excel 文件】的排版：统一字体、配色、边框和列宽，重点数据用条件格式高亮，不改动数据本身。'
    },
    {
      label: '会计统计',
      text: '基于【记账明细文件】做会计统计：按科目汇总收支，生成月度损益表和往来账龄分析。'
    },
    {
      label: '财务预算表',
      text: '帮我做一份【部门/项目】年度预算表：按科目列支出计划，自动汇总总额与分月分布。'
    },
    {
      label: '库存统计',
      text: '基于【库存明细文件】统计出入库：按商品汇总期初、入库、出库、期末结存，标出库存预警项。'
    },
    {
      label: '考勤统计',
      text: '基于【考勤记录文件】统计出勤：按人员汇总出勤、迟到、请假天数，生成月度考勤汇总表。'
    },
    {
      label: '进度跟踪表',
      text: '帮我做一份【项目名称】进度跟踪表：任务、负责人、起止时间、完成率，用条件格式标出延期项。'
    },
    {
      label: '数据对比分析',
      text: '基于【Excel 文件】做多期对比：把本期和上期数据放在一起，算出差值和增长率，标出变动最大的项。'
    },
    {
      label: '排班表',
      text: '帮我做一份【团队/门店】排班表：覆盖一整月，自动避开同一人连续排班冲突，统计每人总班次。'
    }
  ],
  imagegen: [
    {
      // 【图片文件】是 filePlaceholderPlugin 的文件槽（「图片」关键词 →
      // 选择器限定 image/*）；选完/拖入后点 chip 还能开右栏图片编辑面板。
      label: '编辑修改图片',
      text: '帮我修改【图片文件】：【说明要改什么，例如去掉背景、调整色调、加一行文字】，其余保持原样。'
    },
    {
      // 融合＝多图合一，所以放两个文件槽（都含「图片」关键词 → 都限定
      // image/*，见 filePlaceholderPlugin 的 ACCEPT_BY_KEYWORD）；用户也可
      // 以直接拖多张图进输入框，两条路都汇进同一次生成。
      label: '融合图片',
      text: '把【图片文件】和【另一张图片文件】融合成一张：【说明想要的效果，例如把人物放进这个背景、两张图的元素合成一幅、统一整体光影风格】，输出一张自然协调的合成图。'
    },
    {
      label: '活动海报',
      text: '为【活动主题】生成一张竖版活动海报，主视觉醒目，留出时间地点文字区域。'
    },
    {
      label: '公众号头图',
      text: '生成一张公众号头图，主题是【文章主题】，简洁大气，宽幅横版构图。'
    },
    {
      label: '产品示意图',
      text: '为【产品/功能】生成一张干净的概念示意图，白底，适合放进 PPT。'
    }
  ],
  remotion: [
    {
      label: '产品宣传短片',
      text: '根据【产品介绍】生成一支 30 秒左右的产品宣传短视频，节奏明快，结尾带行动号召。'
    },
    {
      label: '数据动画',
      text: '把【这组数据】做成一段动态图表短视频，逐项展示增长趋势。'
    }
  ],
  // ── 代码开发场景（伪命令，见 lib/scenarioSlash.ts）────────────────
  'daily-dev': [
    {
      label: '新增功能开发',
      text: '在【项目/模块】里新增【功能描述】：先说明改动方案，确认后实现并跑通类型检查。'
    },
    {
      label: '代码重构优化',
      text: '重构【目标文件/模块】：按职责拆分、消除重复，保持对外接口不变，改完列出改动清单。'
    },
    {
      label: '修复Bug',
      text: '这个 bug 的表现是：【现象描述】。帮我定位根因并修复，附上验证方式。'
    },
    {
      label: '性能优化',
      text: '分析【页面/接口】的性能瓶颈，量化每个热点的开销，按收益排序逐个优化。'
    },
    {
      label: '补充单元测试',
      text: '为【模块/函数】补充单元测试，覆盖正常路径、边界条件和报错分支。'
    },
    {
      label: '排查报错修复',
      text: '这是报错信息：【粘贴报错】。帮我定位到源码位置，解释原因并修复。'
    }
  ],
  'web-dev': [
    {
      label: '企业官网开发',
      text: '帮我搭一个企业官网：首页 + 产品介绍 + 关于我们 + 联系方式，响应式布局，先出首页。'
    },
    {
      label: '后台管理系统',
      text: '初始化一个后台管理系统：登录、侧边导航、数据表格增删改查，用【技术栈】。'
    },
    {
      label: '个人博客网站',
      text: '帮我做一个个人博客网站：文章列表、详情页、标签分类，支持 Markdown 写作。'
    },
    {
      label: '电商首页开发',
      text: '开发一个电商首页：轮播 banner、商品分类栅格、推荐位，移动端优先。'
    }
  ],
  'agent-app': [
    {
      label: 'Agent应用开发',
      text: '帮我开发一个 Agent 应用来解决【要处理的任务】，包含工具调用和多轮对话能力。'
    },
    {
      label: '聊天应用初始化',
      text: '初始化一个 AI 聊天应用：流式回复、会话历史、Markdown 渲染，用【技术栈】。'
    },
    {
      label: '客户端Agent应用',
      text: '做一个桌面端 Agent 应用骨架：本地运行、系统托盘、可调用本地文件与命令。'
    },
    {
      label: '智能客服Agent',
      text: '搭建一个智能客服 Agent：接入【知识库/FAQ】，支持转人工和多轮追问。'
    }
  ]
}

/** value（可能带命名空间）→ PROMPTS_BY_SKILL 的裸名 key。 */
function bareSkillName(value: string): string {
  return value.replace(/^\//, '').replace(/^[\w-]+:/, '')
}

const STROKE_ICON_PROPS = {
  width: 15,
  height: 15,
  viewBox: '0 0 18 18',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

const CATEGORIES: readonly ScenarioCategory[] = [
  {
    id: 'daily',
    labelKey: 'scenarioCatDaily',
    // 咖啡杯
    icon: (
      <svg {...STROKE_ICON_PROPS}>
        <path d="M4 6h9v5.5A3.5 3.5 0 0 1 9.5 15h-2A3.5 3.5 0 0 1 4 11.5V6Z" />
        <path d="M13 7.5h1.2a1.8 1.8 0 0 1 0 3.6H13M6.5 3.5v1M9 3v1.5M11.5 3.5v1" />
      </svg>
    ),
    items: [
      { kind: 'skill', value: '/claude-desktop:ppt-master' },
      { kind: 'skill', value: '/claude-desktop:spreadsheets' },
      { kind: 'skill', value: '/claude-desktop:proposal-writer' }
    ]
  },
  {
    id: 'code',
    labelKey: 'scenarioCatCode',
    // </> 尖括号
    icon: (
      <svg {...STROKE_ICON_PROPS}>
        <path d="m6 5.5-3.5 3.5L6 12.5M12 5.5l3.5 3.5L12 12.5" />
      </svg>
    ),
    // 代码开发的首层是三个【场景伪命令】（日常开发/网站开发/Agent 应用，
    // 见 lib/scenarioSlash.ts）：点击同技能 chip 一样插黑标签、进二级推荐
    // prompt；发送时 onNew 剥掉伪命令只发正文。
    items: [
      { kind: 'skill', value: '/daily-dev' },
      { kind: 'skill', value: '/web-dev' },
      { kind: 'skill', value: '/agent-app' }
    ]
  },
  {
    id: 'design',
    labelKey: 'scenarioCatDesign',
    // 调色板
    icon: (
      <svg {...STROKE_ICON_PROPS}>
        <path d="M9 2.5a6.5 6.5 0 1 0 0 13c1 0 1.4-.6 1.4-1.3 0-1.1-1-1.5-.4-2.5.5-.9 3-.2 4.3-1.5.9-.9.2-7.7-5.3-7.7Z" />
        <circle cx="5.8" cy="7" r=".9" />
        <circle cx="9" cy="5.3" r=".9" />
        <circle cx="12.2" cy="7" r=".9" />
      </svg>
    ),
    items: [
      { kind: 'skill', value: '/claude-desktop:imagegen' },
      { kind: 'skill', value: '/claude-desktop:remotion' },
      { kind: 'skill', value: '/claude-desktop:ppt-master' }
    ]
  }
]

/* ───────────────────────── 组件 ───────────────────────── */

/** 「填入输入框」的 ↘ 隐喻。方案 B 里推荐 prompt 行把它前置并染品牌绿
 * （建议行唯一的色彩信号）；一级直达 prompt 项仍用默认的尾置灰箭头。 */
function FillArrowIcon({
  className = 'shrink-0 opacity-60'
}: {
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M4.5 4.5 11.5 11.5M11.5 6v5.5H6" />
    </svg>
  )
}

/** 展开/收起推荐 prompt 行的尾置箭头：朝下=可展开，展开后翻转朝上=可
 *  收起——用旋转而不是换图标，状态切换时是一次连续的转动而非跳变。 */
function ExpandChevronIcon({ expanded }: { expanded: boolean }): React.JSX.Element {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 transition-transform duration-200"
      style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
    >
      <path d="M4.5 6.75 9 11.25l4.5-4.5" />
    </svg>
  )
}

/**
 * 分类 tab 的滑动高亮：不再靠 className 硬切 bg-foreground（那样切 tab
 * 背景是瞬间跳变），改成一个带 layoutId 的绝对定位块——只有当前选中的
 * tab 渲染它，切换时旧的卸载、新的挂载，Motion 认出同一个 layoutId 自动
 * 补出中间的位移/尺寸过渡，是 segmented control 的标准手法，不需要额外
 * state。
 */
const TAB_HIGHLIGHT_TRANSITION = { type: 'spring', bounce: 0.2, visualDuration: 0.4 } as const

/**
 * 外层容器的 `layout` 过渡：一级技能行（单行）↔ 三级推荐行（技能锚点+
 * 分隔线+多条 prompt，常换行成两行）高度不同，交给 Motion 的自动布局
 * 动画顺滑插值，而不是让高度硬跳、把下面的 composer 卡片瞬间顶下去。
 * 用软阻尼弹簧（低 bounce）避免高度变化本身也弹一下。
 */
const LAYOUT_TRANSITION = { type: 'spring', bounce: 0.15, visualDuration: 0.3 } as const

/**
 * chip 行的进出场编排：整行一次性淡入淡出（跟子项一样纯 opacity，无
 * 位移/弹簧），staggerChildren 只给子项之间错开个 20ms，不足以造成
 * 「一个个蹦出来」的观感，只是让一整排不是死板地同时刷新。exit 不需要
 * 错峰——退场很快，同时一起淡出比反向交错更干净。
 */
const ROW_VARIANTS: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { duration: 0.16, ease: [0.4, 0, 0.2, 1], staggerChildren: 0.02 }
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.1, ease: [0.4, 0, 1, 1] }
  }
}

/**
 * 单个 chip 的入场：位移+弹簧+错峰的组合试了两版都不理想——popLayout 下
 * 旧行退场时还留在画面里（脱离文档流悬浮），跟正在淡入的新行重叠了一瞬
 * 间，纯视觉上像重影/糊在一起；弹簧的回弹感在这么小的元素上又显得过于
 * 「Q 弹」。收回最朴素的纯透明度淡出淡入，不带位移、不带缩放、不带
 * 弹簧——安静的一次性交叉淡化，跟这一行紧挨 composer 的克制气质更配。 */
const CHIP_VARIANTS: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.14, ease: [0.4, 0, 0.2, 1] } },
  exit: { opacity: 0, transition: { duration: 0.08 } }
}

/** chip 悬停/按下反馈：轻微缩放 + 弹簧，用户快速划过多个 chip 时不会有
 *  动画排队感（每次手势都能打断上一次）。 */
const CHIP_HOVER = { scale: 1.035, transition: { type: 'spring', stiffness: 480, damping: 28 } } as const
const CHIP_TAP = { scale: 0.965, transition: { type: 'spring', stiffness: 520, damping: 30 } } as const

/** 推荐 prompt 超过这个数量才折叠——数量少的技能（proposal-writer 3 条、
 *  remotion 2 条等）永远全展开，折叠交互只在场景多的技能（如 spreadsheets）
 *  上出现，不给简单技能徒增一次多余的点击。 */
const COLLAPSED_PROMPT_COUNT = 6

interface ScenarioRailProps {
  /**
   * 选定技能：整 input 重置为该技能的 slash chip（resetWithSlashCommand）。
   * 旧正文一并清空——点技能=重开该技能流程，随后正文为空、推荐行出现。
   */
  onInsertSkill: (value: string) => void
  /** 保留 leading chip、把推荐 prompt 填进正文（fillBody）。 */
  onFillPrompt: (text: string) => void
  /** 当前 doc 的不透明快照（snapshotDoc），切 tab 时保存。 */
  snapshotDraft: () => unknown | null
  /** 恢复某 tab 的快照；null = 该 tab 无草稿 → 清空输入（restoreDoc）。 */
  restoreDraft: (snapshot: unknown | null) => void
}

export function ScenarioRail({
  onInsertSkill,
  onFillPrompt,
  snapshotDraft,
  restoreDraft
}: ScenarioRailProps): React.JSX.Element {
  const t = useT()
  const tFormat = useTFormat()
  const [catId, setCatId] = useState<CategoryId>('daily')
  // 展开态存的是「哪个技能被展开过」而不是一个裸 boolean：与 activeSpec.match
  // 比较自动实现按技能重置——切到另一个技能推荐行默认回到折叠态，不用额外
  // 布线；同一技能内退出再进入则记得上次的展开选择（同会话内的临时偏好）。
  const [expandedPromptSkill, setExpandedPromptSkill] = useState<string | null>(null)

  // 每个分类 tab 一份独立草稿（PM doc 快照）：切走时 stash 当前输入、切到的
  // tab 有存货就原样恢复、没有就清空——三个 tab 各自是一张独立的「工作台」。
  // chip 行的双态不用额外处理：restoreDraft 走正常事务派发 → composer.text
  // writeback → 本组件订阅的 text 变化自动翻态。ref 不进渲染；EmptyState 卸载
  // （发送/切会话）后草稿随之丢弃，这是会话内的临时台面，不做持久化。
  const draftsRef = useRef<Partial<Record<CategoryId, unknown>>>({})
  const switchCategory = (next: CategoryId): void => {
    if (next === catId) return
    draftsRef.current[catId] = snapshotDraft()
    setCatId(next)
    restoreDraft(draftsRef.current[next] ?? null)
  }

  // composer.text 是双态判定的唯一真源（与 ProseMirrorComposerInput 同一
  // 订阅方式）：以已注册技能开头且【chip 后正文为空】→ 显示推荐 prompt 行。
  // 正文非空（点过一条推荐、或用户自己敲了字）就退回一级技能行——推荐
  // prompt 的使命是帮忙起草正文，正文有了它就完成了；清掉正文（保留 chip）
  // 会重新露出推荐行，可以再挑。全部由 text 派生，不设「已填充」标记。
  const composerText = useAuiState(
    (s) => ((s as { composer?: { text?: string } }).composer?.text as string | undefined) ?? ''
  )
  const activeSpec = findSkillChipSpecInText(composerText)
  const activePrompts = activeSpec ? PROMPTS_BY_SKILL[bareSkillName(activeSpec.match)] : undefined
  const bodyAfterChip = activeSpec ? composerText.slice(activeSpec.match.length).trim() : ''

  // 折叠态派生：数量不超阈值时 visiblePrompts === activePrompts（toggle 不
  // 渲染，见下方 JSX）；超阈值且未展开则只切前 COLLAPSED_PROMPT_COUNT 条。
  const promptsExpanded = activeSpec != null && expandedPromptSkill === activeSpec.match
  const hiddenPromptCount = activePrompts ? activePrompts.length - COLLAPSED_PROMPT_COUNT : 0
  const visiblePrompts =
    activePrompts && !promptsExpanded && hiddenPromptCount > 0
      ? activePrompts.slice(0, COLLAPSED_PROMPT_COUNT)
      : activePrompts

  const category = CATEGORIES.find((c) => c.id === catId) ?? CATEGORIES[0]!
  // 命中了技能但没配推荐 prompt（用户手敲了别的命令）→ 同样维持技能行。
  const showPrompts =
    activeSpec != null &&
    activePrompts != null &&
    activePrompts.length > 0 &&
    bodyAfterChip === ''

  return (
    <motion.div layout transition={LAYOUT_TRANSITION}>
      {/* 分类 tab 组：浅灰 pill 容器，选中项一个共享 layoutId 的墨黑块在
          tab 间滑动（bg-foreground 暗色下自动反转为白底黑字——原型 Tweaks
          里验证过的 ink 选中态）。 */}
      <div className="inline-flex gap-1 rounded-[14px] bg-foreground/[0.045] p-1">
        {CATEGORIES.map((cat) => {
          const active = cat.id === catId
          return (
            <motion.button
              key={cat.id}
              type="button"
              whileTap={{ scale: 0.96 }}
              className={
                'relative flex items-center gap-1.5 rounded-[10px] px-[13px] py-[7px] text-[13.5px] transition-colors ' +
                (active
                  ? 'font-semibold text-background'
                  : 'font-medium text-muted-foreground hover:text-foreground')
              }
              onClick={() => switchCategory(cat.id)}
            >
              {active && (
                <motion.span
                  layoutId="scenario-cat-highlight"
                  className="absolute inset-0 rounded-[10px] bg-foreground shadow-sm"
                  transition={TAB_HIGHLIGHT_TRANSITION}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                {cat.icon}
                {t(cat.labelKey)}
              </span>
            </motion.button>
          )
        })}
      </div>

      {/* 双态 chip 行：key 随内容源翻转触发 AnimatePresence 进出场。
          mode="wait" 让旧行完全淡出之后新行才开始淡入——两者绝不同屏，
          没有 popLayout 那种「旧行悬浮着跟新行撞在一起」的重影感。行高
          变化（一行 vs 两行）交给外层 <motion.div layout> 顺滑过渡，
          不需要在这里额外处理塌陷/撑开。 */}
      <AnimatePresence mode="wait">
        <motion.div
          key={showPrompts ? `prompts:${activeSpec.match}` : `cat:${catId}`}
          variants={ROW_VARIANTS}
          initial="hidden"
          animate="show"
          exit="exit"
          className="mt-8 flex min-h-[40px] flex-wrap items-center gap-2.5"
        >
          {showPrompts ? (
            <>
              {/* 技能锚点：当前技能的墨黑 pill 常驻三级行首——与选中 tab 同一
                  「实心=选中」语言，回答「我在哪」；点击退出该技能、回技能行。
                  此前进三级后技能行整行消失，rail 上没有任何位置锚（重做动因
                  之一）。退出=清空输入：restoreDraft(null) 就是「无草稿」的清空
                  恢复路径；showPrompts 成立时正文必为空，清掉只丢 chip，无损。 */}
              <motion.button
                type="button"
                title="退出该技能"
                variants={CHIP_VARIANTS}
                whileHover={CHIP_HOVER}
                whileTap={CHIP_TAP}
                className="group flex items-center gap-1.5 rounded-[10px] bg-foreground px-3 py-[7px] text-[13.5px] font-semibold text-background shadow-sm"
                onClick={() => {
                  setExpandedPromptSkill(null)
                  restoreDraft(null)
                }}
              >
                <SkillChipIcon src={activeSpec.image} size={15} />
                {activeSpec.label ?? activeSpec.match.slice(1)}
                <svg
                  width={11}
                  height={11}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  aria-hidden="true"
                  className="opacity-55 transition-opacity group-hover:opacity-100"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </motion.button>
              <motion.span
                variants={CHIP_VARIANTS}
                className="h-[18px] w-px bg-border"
                aria-hidden="true"
              />
              {visiblePrompts!.map((p) => (
                <motion.button
                  key={p.label}
                  type="button"
                  variants={CHIP_VARIANTS}
                  whileHover={CHIP_HOVER}
                  whileTap={CHIP_TAP}
                  className="flex items-center gap-1.5 rounded-[10px] bg-foreground/[0.05] px-[13px] py-2 text-[13.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.09] dark:bg-white/[0.08] dark:hover:bg-white/[0.13]"
                  onClick={() => onFillPrompt(p.text)}
                >
                  <FillArrowIcon className="shrink-0 text-brand" />
                  {p.label}
                </motion.button>
              ))}
              {/* 折叠/展开 toggle：只在超过 COLLAPSED_PROMPT_COUNT 时出现。故意
                  不用内容 chip 那套柔底样式（无底色 + 虚线描边），一眼区分「这
                  是行为控制」而不是又一条可以直接填正文的 prompt。 */}
              {hiddenPromptCount > 0 && (
                <motion.button
                  type="button"
                  variants={CHIP_VARIANTS}
                  whileHover={CHIP_HOVER}
                  whileTap={CHIP_TAP}
                  className="flex items-center gap-1 rounded-[10px] border border-dashed border-border px-[13px] py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
                  onClick={() =>
                    setExpandedPromptSkill(promptsExpanded ? null : (activeSpec?.match ?? null))
                  }
                >
                  {promptsExpanded
                    ? t('scenarioPromptCollapse')
                    : tFormat('scenarioPromptMore', { count: hiddenPromptCount })}
                  <ExpandChevronIcon expanded={promptsExpanded} />
                </motion.button>
              )}
            </>
          ) : (
            category.items.map((item) => {
              if (item.kind === 'skill') {
                const spec = findSkillChipSpec(item.value)
                if (!spec) return null // registry 里被移除的技能静默跳过
                return (
                  <motion.button
                    key={item.value}
                    type="button"
                    variants={CHIP_VARIANTS}
                    whileHover={CHIP_HOVER}
                    whileTap={CHIP_TAP}
                    className="flex items-center gap-2 rounded-[10px] bg-foreground/[0.05] px-[13px] py-2 text-[13.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.09] dark:bg-white/[0.08] dark:hover:bg-white/[0.13]"
                    onClick={() => onInsertSkill(item.value)}
                  >
                    <SkillChipIcon src={spec.image} size={16} />
                    {spec.label ?? item.value.slice(1)}
                  </motion.button>
                )
              }
              return (
                <motion.button
                  key={item.label}
                  type="button"
                  variants={CHIP_VARIANTS}
                  whileHover={CHIP_HOVER}
                  whileTap={CHIP_TAP}
                  className="flex items-center gap-1.5 rounded-[10px] bg-foreground/[0.05] px-[13px] py-2 text-[13.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.09] dark:bg-white/[0.08] dark:hover:bg-white/[0.13]"
                  onClick={() => onFillPrompt(item.text)}
                >
                  {item.label}
                  <FillArrowIcon />
                </motion.button>
              )
            })
          )}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  )
}
