import { useRef, useState } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { useAuiState } from '@assistant-ui/react'
import type { ScenarioCatalogCategory } from '@desktop-shared/ipc-channels'

import { useT, useTFormat, type StringKey } from '../../../i18n'
import {
  findSkillChipSpec,
  findSkillChipSpecInText
} from '../../../composer/skillChipRegistry'
import {
  scenarioPromptsFor,
  useScenarioCatalogStore
} from '../../../stores/scenarioCatalog'
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
 * 产品表面」的唯一事实源）。插入 value 用 bundled fusion-code 的 plugin
 * 命名空间形态（registry 首选注册项）——与 SkillPickerPopover 动态源回传
 * 的命令名一致。
 *
 * **分类归属与推荐 prompt 已不在本文件（2026-07-29）**：它们来自
 * `stores/scenarioCatalog`——后台（sub2api 管理端）下发的一份 JSON，拉不到
 * 时回落 `lib/scenarioCatalogDefaults.ts` 的内置默认表（内容就是原先写在
 * 这里的那两张常量表，原样搬过去的）。本组件退化成纯渲染：拿到什么画什么。
 *
 * 分类 tab 标签：远端给了 `label` 用远端的，没给则按 id 回落 i18n
 * （`scenarioCat*`，只覆盖内置三个分类）——后台自定义的新分类必须自带
 * label，否则退化成显示 id 本身（刻意不静默隐藏：一个配了却看不见的分类
 * 比一个显示成 `xxx` 的分类更难查）。推荐 prompt 是中文内容配置（同
 * EmptyState 的 promo banner），不进 i18n 翻译表。
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

/* ───────────────────────── 数据 ─────────────────────────
 * 2026-07-29 起分类归属与推荐 prompt 已不在本文件，见文件头注释——来自
 * stores/scenarioCatalog，拉不到时回落 lib/scenarioCatalogDefaults.ts。
 *
 * main 上并行的 writing 推荐区改造（合并「改写/体检优化」为「优化 / 改写」+
 * 新增「职场文档」「去 AI 味」+「文章」改名「干货 / 观点长文」）与本次远端化
 * 重构在这个文件里冲突——两边都改了同一批硬编码常量，一边删掉整块搬去
 * scenarioCatalogDefaults.ts，一边在原地新增条目。已把 main 的新增内容原样
 * 移植进 scenarioCatalogDefaults.ts 的 WRITING_PROMPTS，这里维持删除。
 */
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

/**
 * 分类 tab 图标：目录里只下发**图标名**（`'coffee'`），不下发 SVG。远端配置
 * 决定一段 markup 等于把 XSS 面交给后台，且这三个图标本就属于产品 chrome、
 * 不该随内容配置漂移。未知名字回落到通用点阵——后台配了个没有的图标名时
 * tab 仍然画得出来。
 */
const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  // 咖啡杯
  coffee: (
    <svg {...STROKE_ICON_PROPS}>
      <path d="M4 6h9v5.5A3.5 3.5 0 0 1 9.5 15h-2A3.5 3.5 0 0 1 4 11.5V6Z" />
      <path d="M13 7.5h1.2a1.8 1.8 0 0 1 0 3.6H13M6.5 3.5v1M9 3v1.5M11.5 3.5v1" />
    </svg>
  ),
  // </> 尖括号
  code: (
    <svg {...STROKE_ICON_PROPS}>
      <path d="m6 5.5-3.5 3.5L6 12.5M12 5.5l3.5 3.5L12 12.5" />
    </svg>
  ),
  // 调色板
  palette: (
    <svg {...STROKE_ICON_PROPS}>
      <path d="M9 2.5a6.5 6.5 0 1 0 0 13c1 0 1.4-.6 1.4-1.3 0-1.1-1-1.5-.4-2.5.5-.9 3-.2 4.3-1.5.9-.9.2-7.7-5.3-7.7Z" />
      <circle cx="5.8" cy="7" r=".9" />
      <circle cx="9" cy="5.3" r=".9" />
      <circle cx="12.2" cy="7" r=".9" />
    </svg>
  )
}

/** 未知/缺省图标名的兜底：三个点，中性、不暗示任何语义。 */
const FALLBACK_CATEGORY_ICON = (
  <svg {...STROKE_ICON_PROPS}>
    <circle cx="4.5" cy="9" r="1.1" />
    <circle cx="9" cy="9" r="1.1" />
    <circle cx="13.5" cy="9" r="1.1" />
  </svg>
)

/**
 * 内置三个分类的 i18n key。远端自定义分类不在此表内，必须自带 `label`。
 * 注意这里只认 id，不认远端 label——远端给了 label 就直接用它（见
 * categoryLabel），i18n 只是内置分类的默认文案来源。
 */
const BUILTIN_CATEGORY_LABEL_KEYS: Record<string, StringKey> = {
  daily: 'scenarioCatDaily',
  code: 'scenarioCatCode',
  design: 'scenarioCatDesign'
}

/**
 * tab 文案的三级回落：远端 label → 内置分类的 i18n → id 原文。
 * 最后那级是刻意的（而不是隐藏该 tab）：后台配了个没写 label 的自定义
 * 分类时，屏幕上出现一个写着 id 的 tab，一眼就知道漏了什么；静默隐藏则
 * 会变成「我明明配了怎么没有」的无头案子。
 */
function categoryLabel(
  cat: ScenarioCatalogCategory,
  t: (key: StringKey) => string
): string {
  if (cat.label) return cat.label
  const key = BUILTIN_CATEGORY_LABEL_KEYS[cat.id]
  return key ? t(key) : cat.id
}


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
  const catalog = useScenarioCatalogStore((s) => s.catalog)
  const categories = catalog.categories
  // 选中分类存 id 而不是下标：远端刷新可能增删/重排分类，下标会指到别的
  // 分类上去。id 找不到时（该分类被后台删了）回落第一个，见下面的 category。
  const [catId, setCatId] = useState<string>(() => categories[0]?.id ?? 'daily')
  // 展开态存的是「哪个技能被展开过」而不是一个裸 boolean：与 activeSpec.match
  // 比较自动实现按技能重置——切到另一个技能推荐行默认回到折叠态，不用额外
  // 布线；同一技能内退出再进入则记得上次的展开选择（同会话内的临时偏好）。
  const [expandedPromptSkill, setExpandedPromptSkill] = useState<string | null>(null)

  // 每个分类 tab 一份独立草稿（PM doc 快照）：切走时 stash 当前输入、切到的
  // tab 有存货就原样恢复、没有就清空——每个 tab 各自是一张独立的「工作台」。
  // chip 行的双态不用额外处理：restoreDraft 走正常事务派发 → composer.text
  // writeback → 本组件订阅的 text 变化自动翻态。ref 不进渲染；EmptyState 卸载
  // （发送/切会话）后草稿随之丢弃，这是会话内的临时台面，不做持久化。
  const draftsRef = useRef<Record<string, unknown>>({})
  const switchCategory = (next: string): void => {
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
  const activePrompts = activeSpec ? scenarioPromptsFor(catalog, activeSpec.match) : undefined
  const bodyAfterChip = activeSpec ? composerText.slice(activeSpec.match.length).trim() : ''

  // 折叠态派生：数量不超阈值时 visiblePrompts === activePrompts（toggle 不
  // 渲染，见下方 JSX）；超阈值且未展开则只切前 COLLAPSED_PROMPT_COUNT 条。
  const promptsExpanded = activeSpec != null && expandedPromptSkill === activeSpec.match
  const hiddenPromptCount = activePrompts ? activePrompts.length - COLLAPSED_PROMPT_COUNT : 0
  const visiblePrompts =
    activePrompts && !promptsExpanded && hiddenPromptCount > 0
      ? activePrompts.slice(0, COLLAPSED_PROMPT_COUNT)
      : activePrompts

  // 远端刷新可能删掉当前选中的分类——回落第一个而不是渲染空行。
  const category = categories.find((c) => c.id === catId) ?? categories[0]
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
        {categories.map((cat) => {
          const active = cat.id === (category?.id ?? catId)
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
                {(cat.icon ? CATEGORY_ICONS[cat.icon] : undefined) ?? FALLBACK_CATEGORY_ICON}
                {categoryLabel(cat, t)}
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
            (category?.items ?? []).map((item) => {
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
