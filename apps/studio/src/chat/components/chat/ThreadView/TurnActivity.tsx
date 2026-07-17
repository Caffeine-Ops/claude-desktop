import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useMessage } from '@assistant-ui/react'
import { motion, useReducedMotion } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'

import { useI18n, useT, useTFormat, type StringKey } from '../../../i18n'
import { useChatStore } from '../../../stores/chat'

/* ═══════════════════ 回合叙事：阶段分组 + 总状态行 ═══════════════════
 *
 * 出发点（2026-07-17 用户定稿，原型 docs/ui-prototype-turn-narrative.html
 * 变体 A）：满屏逐条平铺的工具行普通用户读不懂。这里做「语义翻译」而不是
 * 视觉降档——
 *
 *   1. 连续的 tool-call part 归成一个「工作阶段」；标题优先取 TodoWrite
 *      计划里 in_progress 项的人话文案（activeForm 进行时 / content 完成
 *      时），没有计划时按工具占比给一个动词短语兜底（查阅资料 / 编写文件…）。
 *   2. 阶段完成后自动收拢成一行摘要（"看了 3 个文件 · 6秒"），点开才看到
 *      步骤行；运行中的阶段保持展开，标题 shimmer。
 *   3. 回合顶部一条总状态行（"正在处理 · 1分24秒" → "已处理 4分32秒"），
 *      点击可折叠全部过程块只看结论（digest 模式）。
 *
 * 为什么不替换 MessagePrimitive.Parts 自己渲染：assistant-ui 的 Parts 携带
 * 文本流式、Empty 占位、per-part 状态一整套行为，重写等于自维护一个 fork。
 * 所以分组只做「逻辑层」：本文件的 Provider 从 useMessage() 的 content 算出
 * 每个 toolCallId 的组籍（组号 / 是否组首 / 是否隐藏），ToolCallCard 按组籍
 * 换装——组首行自己渲染 StageHeader，行体裹进高度动画容器。DOM 上行仍是
 * 兄弟节点，组感靠 .am-parts 的 data-stack 紧排规则（main.css）+ 连续的
 * border-l 竖线拼出来。
 *
 * 不进组的特例（保持现有独立卡渲染）：
 *   - AskUserQuestion：交互面，折进组里用户会找不到「等你回答」。
 *   - 图片生成 Bash（detectImageGen 命中）：产物卡（图）不能被收进折叠组。
 * TodoWrite 进组但 hidden——它的价值已经转化成阶段标题，再渲染一行
 * 「待办事项」就是重复噪音（权限待决时除外，锚点必须可见）。
 */

/* ───────────────────────── 类型 ───────────────────────── */

interface RawPart {
  type?: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
}

export interface StageGroup {
  /** 组键：首个 tool part 在 content 里的下标——流式只会追加 part，
   *  已有下标不动，所以键在整轮里稳定。 */
  key: string
  ids: string[]
  /** 可见行数（TodoWrite 隐藏行不计）。1 行的组不渲染阶段头——一条
   *  安静行本身就够轻，再压一个头反而比现状更吵。 */
  visibleCount: number
  settled: boolean
  hasError: boolean
  /** TodoWrite 计划给出的标题；null = 用 fallbackKey 兜底。 */
  titleActive: string | null
  titleDone: string | null
  /** 兜底标题的 i18n key 选择器（占比最高的工具类别）。 */
  fallbackKey: 'reading' | 'writing' | 'running' | 'searching' | 'working'
  /** 摘要计数（按类别），组头用 i18n 模板拼成人话。 */
  counts: { read: number; write: number; run: number; search: number; other: number }
}

export interface StageMember {
  group: StageGroup
  isFirst: boolean
  /** TodoWrite 行：组内隐藏（标题已消化其信息）。 */
  hidden: boolean
}

interface TurnActivityValue {
  byId: ReadonlyMap<string, StageMember>
  /** 全回合可见工具行总数——TurnStatusRow 的显示门槛。 */
  visibleTotal: number
  digest: boolean
  toggleDigest: () => void
  /** 组是否处于收拢态（用户手动 > 落定自动）。 */
  isCollapsed: (key: string) => boolean
  toggleGroup: (key: string) => void
  /** 该组是否经历过「实时运行→落定」（驱动 pop/draw 入场动画；历史
   *  恢复整屏齐 pop 读作故障，同 ToolCallCard 的 sawRunning 原则）。 */
  sawLive: (key: string) => boolean
}

const TurnActivityContext = createContext<TurnActivityValue | null>(null)

/** ToolCallCard 查组籍；AssistantMessage 之外挂载（理论上没有）返回 null。 */
export function useStageMember(toolCallId: string): StageMember | null {
  const ctx = useContext(TurnActivityContext)
  return ctx?.byId.get(toolCallId) ?? null
}

export function useTurnActivityCtx(): TurnActivityValue | null {
  return useContext(TurnActivityContext)
}

/* ───────────────────── 分组计算 ───────────────────── */

/** 工具 → 摘要类别。与 stores/chat 的 toolActivityKey 同族但独立：那边服务
 *  composer 状态条的粗粒度活动名，这边服务阶段摘要计数，词表演进节奏不同。 */
function toolCategory(name: string | undefined): keyof StageGroup['counts'] {
  switch (name) {
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'NotebookRead':
      return 'read'
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'write'
    case 'Bash':
    case 'BashOutput':
      return 'run'
    case 'WebFetch':
    case 'WebSearch':
    case 'ToolSearch':
      return 'search'
    default:
      // MCP 文档/检索类（context7 等）也算查资料——mcp__server__name 形态。
      if (typeof name === 'string' && /^mcp__/.test(name)) return 'search'
      return 'other'
  }
}

/** 与 ToolCallCard.resultLooksError 同一启发式（复制而非导出共享：那边是
 *  模块私有，且两处对误判的容忍度一致——纯视觉）。 */
function looksError(result: unknown): boolean {
  if (result === undefined) return false
  const text =
    typeof result === 'string'
      ? result
      : typeof (result as { text?: string })?.text === 'string'
        ? (result as { text: string }).text
        : ''
  return /^\s*Error(\b|:)/.test(text)
}

/** 从 TodoWrite 的 args 里捞 in_progress 项的两种文案。args 流式期间可能
 *  是半开文本/缺字段，全程防御。 */
function todoTitles(args: unknown): { active: string | null; done: string | null } | null {
  if (!args || typeof args !== 'object') return null
  const todos = (args as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue
    const o = t as { status?: unknown; content?: unknown; activeForm?: unknown }
    if (o.status === 'in_progress') {
      const content = typeof o.content === 'string' ? o.content : null
      const active = typeof o.activeForm === 'string' ? o.activeForm : content
      return { active, done: content ?? active }
    }
  }
  return null
}

/** 图片生成 Bash 的轻量嗅探——决定「这条 Bash 不进组」。刻意不 import
 *  ImageGenCard.detectImageGen：那个函数要完整解析 stdout 拿成图路径，
 *  分组只需要「是不是图片生成调用」这一位信息，看命令特征就够，也避免
 *  分组层对结果解析逻辑的耦合。特征与 detectImageGen 的命令判定同源。 */
function isImageGenBash(name: string | undefined, args: unknown): boolean {
  if (name !== 'Bash' || !args || typeof args !== 'object') return false
  const cmd = (args as { command?: unknown }).command
  return typeof cmd === 'string' && /imagegen|gpt-image/.test(cmd)
}

interface ComputedGroups {
  byId: Map<string, StageMember>
  groups: StageGroup[]
  visibleTotal: number
}

function computeGroups(
  content: readonly unknown[] | undefined,
  /** 消息是否仍在流式中。false 时所有组强制落定——中断的回合只有
   *  endedAt 清扫、result 永远缺席（见 stores/chat useTurnActivity 的
   *  settlement sweep 注释），按 result 判会让阶段头在死回合上转圈到永远。 */
  messageRunning: boolean
): ComputedGroups {
  const byId = new Map<string, StageMember>()
  const groups: StageGroup[] = []
  let visibleTotal = 0
  if (!Array.isArray(content)) return { byId, groups, visibleTotal }

  // 顺扫累积「当前计划标题」——TodoWrite 出现即更新；组的标题取组内/组前
  // 最近一次的值（组内更新覆盖组前，进行中的阶段随计划推进换标题）。
  let curTitle: { active: string | null; done: string | null } | null = null
  let run: { firstIdx: number; parts: { id: string; part: RawPart }[] } | null = null

  const flush = (): void => {
    if (!run || run.parts.length === 0) {
      run = null
      return
    }
    const counts = { read: 0, write: 0, run: 0, search: 0, other: 0 }
    let settled = !messageRunning
    let hasError = false
    let visibleCount = 0
    const ids: string[] = []
    const hiddenIds = new Set<string>()
    for (const { id, part } of run.parts) {
      ids.push(id)
      if (messageRunning && part.result === undefined) settled = false
      if (looksError(part.result)) hasError = true
      if (part.toolName === 'TodoWrite') {
        hiddenIds.add(id)
        continue
      }
      visibleCount++
      counts[toolCategory(part.toolName)]++
    }
    // 兜底标题 = 占比最高的类别；全 other/并列取先到者。
    let fallbackKey: StageGroup['fallbackKey'] = 'working'
    let best = 0
    for (const [k, v] of [
      ['reading', counts.read],
      ['writing', counts.write],
      ['running', counts.run],
      ['searching', counts.search]
    ] as const) {
      if (v > best) {
        best = v
        fallbackKey = k
      }
    }
    const group: StageGroup = {
      key: `g${run.firstIdx}`,
      ids,
      visibleCount,
      settled,
      hasError,
      titleActive: curTitle?.active ?? null,
      titleDone: curTitle?.done ?? null,
      fallbackKey,
      counts
    }
    groups.push(group)
    visibleTotal += visibleCount
    let seenFirstVisible = false
    for (const id of ids) {
      const hidden = hiddenIds.has(id)
      // 组首 = 第一个「可见」行——隐藏的 TodoWrite 当组首会把阶段头一起
      // 藏掉。全隐藏组（纯计划更新）没有组首，也就没有头，符合预期。
      const isFirst = !hidden && !seenFirstVisible
      if (isFirst) seenFirstVisible = true
      byId.set(id, { group, isFirst, hidden })
    }
    run = null
  }

  for (let i = 0; i < content.length; i++) {
    const part = content[i] as RawPart
    if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') {
      flush()
      continue
    }
    if (part.toolName === 'TodoWrite') {
      const t = todoTitles(part.args)
      if (t) curTitle = t
    }
    // 交互面 / 产物卡不进组：断开当前组，自己保持独立卡（不进 byId）。
    if (part.toolName === 'AskUserQuestion' || isImageGenBash(part.toolName, part.args)) {
      flush()
      continue
    }
    if (!run) run = { firstIdx: i, parts: [] }
    run.parts.push({ id: part.toolCallId, part })
  }
  flush()
  return { byId, groups, visibleTotal }
}

/* ───────────────────── Provider ───────────────────── */

export function TurnActivityProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const message = useMessage()
  const content = (message as { content?: readonly unknown[] }).content
  const messageRunning =
    (message as { status?: { type?: string } }).status?.type === 'running'

  // 结构键：分组只关心 part 的「骨架」（类型/id/落定与否/标题源），不关心
  // argsText 每个 delta。context value 若每次流式 delta 都换新引用，会把
  // Parts 对未变化行的 memo 全部打穿——整屏工具行陪着正文重渲染。
  const structureKey = useMemo(() => {
    if (!Array.isArray(content)) return ''
    let key = ''
    let title = ''
    for (const raw of content) {
      const p = raw as RawPart
      if (p?.type !== 'tool-call') {
        key += `|${p?.type ?? '?'}`
        continue
      }
      key += `|t:${p.toolCallId}:${p.result !== undefined ? 1 : 0}:${looksError(p.result) ? 1 : 0}`
      if (p.toolName === 'TodoWrite') {
        const t = todoTitles(p.args)
        if (t) title = `${t.active ?? ''}~${t.done ?? ''}`
      }
      if (p.toolName === 'AskUserQuestion' || isImageGenBash(p.toolName, p.args)) key += ':x'
    }
    return key + '#' + title
  }, [content])

  const computed = useMemo(
    () => computeGroups(content, messageRunning),
    // eslint 风格上这里依赖 content，但刻意只认 structureKey——见上注释。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey, messageRunning]
  )

  // ── 折叠状态机 ──
  // manual：用户点过的组，尊重到底（true=收拢）。
  // liveSeen（ref，渲染期写入）：本次挂载期间见过「未落定」状态的组 =
  //   实时组。挂载即已落定的组永远不进这个集合。
  // settleAcked：实时组落定后延迟 ~650ms 进入（给「勾 pop + 摘要浮现」
  //   一个可读的落定瞬间，再播收拢动画）。
  //
  // 默认收拢的判定是**渲染期同步**的：settled && (非实时组 || 已 ack)。
  // 非实时组（历史恢复/切会话）首帧就直接是收拢终态——如果把这个判定
  // 放进 effect，首帧会先画成展开、effect 后才收拢，整屏历史消息齐播
  // 一次收拢动画（零动画方针，同 tc-row-in 的 enteredLive gate）。
  const [manual, setManual] = useState<Record<string, boolean>>({})
  const [settleAcked, setSettleAcked] = useState<Record<string, true>>({})
  const [digest, setDigest] = useState(false)
  const liveSeen = useRef<Set<string>>(new Set())
  const ackTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  for (const g of computed.groups) {
    if (!g.settled) liveSeen.current.add(g.key)
  }

  useEffect(() => {
    const timers = ackTimers.current
    for (const g of computed.groups) {
      if (!g.settled || settleAcked[g.key] || timers.has(g.key)) continue
      // 只有实时组需要「落定停顿→收拢」的延迟动画；非实时组在渲染期
      // 已按收拢处理，无需 ack。
      if (!liveSeen.current.has(g.key)) continue
      const id = setTimeout(() => {
        timers.delete(g.key)
        setSettleAcked((prev) => ({ ...prev, [g.key]: true }))
      }, 650)
      timers.set(g.key, id)
    }
  }, [computed, settleAcked])
  useEffect(() => {
    const timers = ackTimers.current
    return () => {
      for (const id of timers.values()) clearTimeout(id)
    }
  }, [])

  const value = useMemo<TurnActivityValue>(() => {
    const groupByKey = new Map(computed.groups.map((g) => [g.key, g]))
    const defaultCollapsed = (key: string): boolean => {
      const g = groupByKey.get(key)
      if (!g?.settled) return false
      return settleAcked[key] === true || !liveSeen.current.has(key)
    }
    return {
      byId: computed.byId,
      visibleTotal: computed.visibleTotal,
      digest,
      toggleDigest: () => setDigest((d) => !d),
      isCollapsed: (key) => manual[key] ?? defaultCollapsed(key),
      toggleGroup: (key) =>
        setManual((prev) => {
          const cur = prev[key] ?? defaultCollapsed(key)
          return { ...prev, [key]: !cur }
        }),
      sawLive: (key) => liveSeen.current.has(key)
    }
  }, [computed, manual, settleAcked, digest])

  return (
    <TurnActivityContext.Provider value={value}>
      {children}
    </TurnActivityContext.Provider>
  )
}

/* ───────────────────── 计时 ───────────────────── */

/**
 * 一组 toolCallId 的时间包络：最早 startedAt / 最晚 endedAt / 未结束数。
 * assistant-ui 的 content part 不携带时间戳（Fallback 契约外的字段被
 * fromThreadMessageLike 剥掉），所以走 chat store——与 useToolCallTiming
 * 同一间接层。全标量返回喂 useShallow（禁新建对象/数组，见那边注释）。
 */
function useIdsTiming(idsKey: string): {
  first: number
  last: number
  open: number
} {
  return useChatStore(
    useShallow((s) => {
      if (!idsKey) return { first: 0, last: 0, open: 0 }
      const want = new Set(idsKey.split(','))
      let first = Infinity
      let last = 0
      let open = 0
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const raw of m.content as readonly unknown[]) {
          const p = raw as {
            type?: string
            toolCallId?: string
            startedAt?: unknown
            endedAt?: unknown
          }
          if (p.type !== 'tool-call' || !p.toolCallId || !want.has(p.toolCallId))
            continue
          if (typeof p.startedAt === 'number') first = Math.min(first, p.startedAt)
          if (typeof p.endedAt === 'number') last = Math.max(last, p.endedAt)
          else open++
        }
      }
      return { first: Number.isFinite(first) ? first : 0, last, open }
    })
  )
}

/** 时长人话：zh「4分32秒 / 32秒」，en「4m 32s / 32s」。<1s 不值一提。 */
function fmtDuration(ms: number, zh: boolean): string | null {
  if (!Number.isFinite(ms) || ms < 1000) return null
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (zh) return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/* ───────────────────── 小图形件 ───────────────────── */

/** 运行中弧线（复用 main.css 的 .tc-spin 描边动画语言）。 */
export function ArcSpinner({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 15 15"
      style={{ width: size, height: size }}
      className="shrink-0"
      aria-hidden
    >
      <circle className="tc-spin" cx="7.5" cy="7.5" r="6" />
    </svg>
  )
}

/**
 * 阶段/回合的落定记号：细描边环 + 勾（原型定稿的 12px「细线索引」，
 * 不是行级那颗 15px 实心盘——绿的浓度从「每行打卡」降到「每阶段一个」）。
 * `animate` 时环盘 pop、勾画线（tc-pop / tc-draw，main.css 已有）。
 */
export function StageTick({
  animate,
  warn,
  size = 14
}: {
  animate: boolean
  warn?: boolean
  size?: number
}): React.JSX.Element {
  if (warn) {
    return (
      <svg
        viewBox="0 0 24 24"
        style={{ width: size, height: size }}
        className={'shrink-0 text-amber-500' + (animate ? ' tc-pop' : '')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M10.3 3.9 2.6 17.3a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 15 15"
      style={{ width: size, height: size }}
      className={'shrink-0' + (animate ? ' tc-pop' : '')}
      aria-hidden
    >
      <circle
        cx="7.5"
        cy="7.5"
        r="6.1"
        fill="none"
        className="stroke-brand/50"
        strokeWidth="1.3"
      />
      <path
        d="M4.6 7.8l2 2 3.7-4.2"
        fill="none"
        className={'stroke-brand' + (animate ? ' tc-draw' : '')}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 行级工具灰图标（14px 线性）——替换组内行的实心绿盘。词表按类别而不是
 * 逐工具：普通用户分不清 Grep 和 Glob，但分得清「在看东西」和「在写东西」。
 */
export function ToolGlyph({ toolName }: { toolName: string }): React.JSX.Element {
  const cat = toolCategory(toolName)
  const paths: Record<string, React.JSX.Element> = {
    read: (
      <>
        <path d="M13 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M13 2v6h6" />
      </>
    ),
    write: (
      <>
        <path d="M17 3a2.85 2.85 0 1 1 4 4L8 20.5 3 22l1.5-5z" />
      </>
    ),
    run: (
      <>
        <path d="m5 16 5-5-5-5" />
        <path d="M12 19h8" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </>
    ),
    other: (
      <>
        <circle cx="12" cy="12" r="2.6" />
        <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
      </>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[14px] shrink-0 text-muted-foreground/80"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[cat]}
    </svg>
  )
}

/* ───────────────────── 阶段头 ───────────────────── */

/**
 * 组首行渲染的阶段头。运行中：弧线 + shimmer 标题；落定：勾 pop + 摘要
 * blur-in + 时长。整行是 toggle 按钮。digest 时随行体一起被外层折掉
 * （本组件不自己处理 digest——组首行的折叠容器包住头+行）。
 */
export function StageHeader({ group }: { group: StageGroup }): React.JSX.Element {
  const ctx = useTurnActivityCtx()
  const t = useT()
  const tf = useTFormat()
  const lang = useI18n((s) => s.lang)
  const reduce = useReducedMotion()
  const running = !group.settled
  const collapsed = ctx?.isCollapsed(group.key) ?? group.settled
  // pop/draw 只给「实时看着它落定」的组——sawLive + 已落定。
  const animateTick = Boolean(ctx?.sawLive(group.key)) && group.settled

  const timing = useIdsTiming(group.ids.join(','))
  const dur =
    group.settled && timing.first > 0 && timing.last > timing.first
      ? fmtDuration(timing.last - timing.first, lang === 'zh')
      : null

  const title = running
    ? (group.titleActive ?? t(`stageTitle_${group.fallbackKey}`))
    : (group.titleDone ?? t(`stageTitle_${group.fallbackKey}`))

  // 摘要：非零类别按「看了 N 个文件、写了 N 个文件…」拼接，最多取前两类
  // ——组头是一行扫读的东西，三段起就读成报表了。
  const summary = useMemo(() => {
    if (running) return null
    const parts: string[] = []
    const order: [keyof StageGroup['counts'], StringKey][] = [
      ['read', 'stageSumRead'],
      ['write', 'stageSumWrite'],
      ['run', 'stageSumRun'],
      ['search', 'stageSumSearch'],
      ['other', 'stageSumOther']
    ]
    for (const [k, key] of order) {
      if (group.counts[k] > 0)
        parts.push(tf(key, { count: group.counts[k] }))
      if (parts.length === 2) break
    }
    if (group.hasError) parts.push(t('stageSumError'))
    return parts.join(lang === 'zh' ? '、' : ', ')
  }, [running, group, tf, t, lang])

  return (
    <button
      type="button"
      onClick={() => ctx?.toggleGroup(group.key)}
      aria-expanded={!collapsed}
      className="group/stage flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left transition-colors hover:bg-hover/60"
    >
      <span className="grid size-[15px] shrink-0 place-items-center">
        {running ? (
          <ArcSpinner />
        ) : (
          <StageTick animate={animateTick} warn={group.hasError} />
        )}
      </span>
      {running ? (
        <span className="shimmer-text min-w-0 truncate text-[13px] font-medium">
          {title}
        </span>
      ) : (
        <span className="min-w-0 shrink-0 truncate text-[13px] font-medium text-foreground">
          {title}
        </span>
      )}
      {summary && (
        <motion.span
          initial={
            animateTick && !reduce
              ? { opacity: 0, y: 2, filter: 'blur(2px)' }
              : false
          }
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
          className="min-w-0 truncate text-[12px] text-muted-foreground"
        >
          {summary}
        </motion.span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {dur && (
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {dur}
          </span>
        )}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={
            'size-[11px] text-muted-foreground/50 transition-transform duration-200 ' +
            (collapsed ? '' : 'rotate-90')
          }
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </span>
    </button>
  )
}

/* ───────────────────── 回合总状态行 ───────────────────── */

/**
 * 「正在处理 · 1分24秒 → 已处理 4分32秒」。只在回合的可见工具行 ≥ 2 时
 * 出现——一两步的轻回合加个总头是净噪音。点击切 digest（折叠全部过程块，
 * 只留正文）。运行中 1s 心跳刷新计时；落定后冻结、零定时器。
 */
export function TurnStatusRow(): React.JSX.Element | null {
  const ctx = useTurnActivityCtx()
  const message = useMessage()
  const t = useT()
  const lang = useI18n((s) => s.lang)
  const running =
    (message as { status?: { type?: string } }).status?.type === 'running'

  const allIdsKey = useMemo(() => {
    if (!ctx) return ''
    const ids: string[] = []
    for (const [id] of ctx.byId) ids.push(id)
    return ids.join(',')
  }, [ctx])
  const timing = useIdsTiming(allIdsKey)

  // 1s 心跳：只在运行中且有起点时跳（同 ToolElapsed 的「零定时器落定」原则，
  // 但这里 1s 粒度就够——总时长按秒读，100ms 刷新是浪费）。
  const [, setTick] = useState(0)
  const live = running && timing.first > 0
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [live])

  // pop 只给实时落定瞬间：挂载时就 settled 的历史消息静态呈现。
  const sawRunning = useRef(running)
  if (running) sawRunning.current = true
  const animateTick = sawRunning.current && !running

  if (!ctx || ctx.visibleTotal < 2) return null

  const durMs = running
    ? timing.first > 0
      ? Date.now() - timing.first
      : 0
    : timing.first > 0 && timing.last > timing.first
      ? timing.last - timing.first
      : 0
  const dur = fmtDuration(durMs, lang === 'zh')

  return (
    <div className="flex items-center border-b border-border/50 pb-2">
      <button
        type="button"
        onClick={ctx.toggleDigest}
        aria-expanded={!ctx.digest}
        title={t('turnDigestHint')}
        className="-ml-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-hover/60"
      >
        <span className="grid size-[15px] shrink-0 place-items-center">
          {running ? <ArcSpinner /> : <StageTick animate={animateTick} />}
        </span>
        {running ? (
          <span className="shimmer-text font-medium">
            {t('turnWorking') + (dur ? ` · ${dur}` : '')}
          </span>
        ) : (
          <span className="font-medium">
            {t('turnDone') + (dur ? ` · ${dur}` : '')}
          </span>
        )}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={
            'size-[10px] text-muted-foreground/50 transition-transform duration-200 ' +
            (ctx.digest ? '-rotate-90' : '')
          }
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
  )
}

/* ───────────────────── 折叠容器 ───────────────────── */

/**
 * 组内行/阶段头共用的高度折叠容器。展开用带一点回弹的 spring、收拢用
 * 无回弹（收起时的 overshoot 会露出一条内容闪边）；reduced-motion 直接
 * 瞬切。`initial={false}`：挂载即处于终态——历史恢复的收拢组不播动画。
 *
 * 间距语义（配合 main.css 的 .am-parts 规则）：
 *   - `stack`   → data-stack，相邻 stack 块紧排（2px），拼出组内行的
 *                 连续 border-l 竖线。
 *   - 折叠时挂 data-folded → 自身 margin-top 归零。没有这条，digest
 *                 模式下每个 0 高度块仍占 12px 兄弟间距，正文段落之间
 *                 会莫名撑出一串死空隙。margin 归零是 CSS 瞬切，但
 *                 .am-parts > * 带 margin-top transition，与高度动画
 *                 同拍收敛。
 */
export function FoldRegion({
  folded,
  stack,
  children
}: {
  folded: boolean
  stack?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const reduce = useReducedMotion()
  return (
    <motion.div
      data-stack={stack ? 'true' : undefined}
      data-folded={folded ? 'true' : 'false'}
      initial={false}
      animate={{ height: folded ? 0 : 'auto', opacity: folded ? 0 : 1 }}
      transition={
        reduce
          ? { duration: 0 }
          : folded
            ? { type: 'spring', bounce: 0, visualDuration: 0.3 }
            : { type: 'spring', bounce: 0.16, visualDuration: 0.42 }
      }
      style={{ overflow: 'hidden' }}
      // 收拢态从 tab 序里摘掉内部行（display 仍在，height 0 也可聚焦）。
      inert={folded ? true : undefined}
    >
      {children}
    </motion.div>
  )
}
