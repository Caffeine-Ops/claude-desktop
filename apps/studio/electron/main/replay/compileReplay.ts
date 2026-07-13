/**
 * 回放时间线编译器：convertSdkMessages 产出的 ThreadMessageLike[] +
 * 消息级时间戳 → ReplayTimeline（多轨、t 单调）。
 *
 * 设计要点：
 * - 【不】复制 transcript 解析逻辑——输入就是权威解析器 convertSdkMessages
 *   的产物（tool result 配对、workflow 卡、slash 清洗都已处理）。本模块只做
 *   「消息 → 表演 item」的时间编排。
 * - transcript 每行只有一个 timestamp（该消息写盘时刻）≈ 消息完成时刻。
 *   消息 i 的表演窗口取 [ts(i-1), ts(i)]，窗口内各内容块按字符数权重分摊
 *   durMs——块级真实节奏无从考证，字符比例是最不失真的近似。
 * - UI 轨反推：[[image-edit]] user 消息自带完整 ImageEditMeta（坐标/文字/
 *   extra），在该消息前合成一段面板表演。表演时长 clamp 后【倒推】起点，
 *   并夹在前一 item 之后——绝不为了表演把整条时间轴拉长。
 */
import type { ThreadMessageLike } from '@assistant-ui/react'

import { parseImageEditMessage } from '../../shared/messageMarkers'
import type {
  ReplayItem,
  ReplayUiItem,
  SerializedContentPart
} from '../../shared/replayTypes'
import type { WorkflowTask } from '../../shared/types'

/** 缺 timestamp 的行按前一行 + 3s 顺推（异常 transcript 的兜底，不该常见）。 */
const DEFAULT_GAP_MS = 3000
/** 消息表演窗口下限——两行写盘间隔可能只差几十 ms（纯工具 turn），给打字机留底。 */
const MIN_WINDOW_MS = 1200
/** tool 块在窗口权重分配里的「运行时间」等效字符数（args 很短的工具也占得到戏份）。 */
const TOOL_RUN_WEIGHT_CHARS = 400
/** UI 表演：输入条逐字节奏。 */
const UI_TYPE_MS_PER_CHAR = 80
/** UI 表演总时长的 clamp 区间。 */
const UI_PERF_MIN_MS = 3000
const UI_PERF_MAX_MS = 20_000
/** confirm_ui server.py 里 _log_result_snapshot 打的标记（见该文件注释）。 */
const CONFIRM_RESULT_MARKER = '[[confirm-result]]'

export interface CompiledReplay {
  items: ReplayItem[]
  realDurationMs: number
  messageCount: number
}

export function compileReplayTimeline(
  messages: readonly ThreadMessageLike[],
  tsByUuid: ReadonlyMap<string, number>
): CompiledReplay {
  const items: ReplayItem[] = []
  let seq = 0
  const nextId = (): string => `i${seq++}`

  // 绝对时间起点：第一条有时间戳的消息。全部缺失时从 0 顺推。
  let t0: number | null = null
  for (const m of messages) {
    const ts = tsByUuid.get(String(m.id))
    if (ts !== undefined) {
      t0 = ts
      break
    }
  }

  /** 上一条消息的（相对）完成时刻——下一条消息的窗口起点。 */
  let prevEnd = 0
  /** 已排入的最后一个 item 的 t（单调化基准）。 */
  let lastT = 0

  const push = <T extends ReplayItem>(item: T): void => {
    // t 单调不减：窗口倒推/时间戳异常（时钟回拨、迁移过的 transcript）都
    // 在这里兜底夹平，播放端可以放心按顺序 + t 差值走。
    if (item.t < lastT) item.t = lastT
    lastT = item.t
    items.push(item)
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const rawTs = tsByUuid.get(String(m.id))
    const tsAbs = rawTs !== undefined && t0 !== null ? rawTs - t0 : null
    const end = Math.max(tsAbs ?? prevEnd + DEFAULT_GAP_MS, prevEnd)
    const parts = normalizeParts(m.content)

    if (m.role === 'user') {
      // [[image-edit]] 消息 → 先插面板表演（倒推起点），消息本体在表演结束落卡。
      const firstText = parts.find(
        (p): p is { type: 'text'; text: string } =>
          p.type === 'text' && typeof (p as { text?: unknown }).text === 'string'
      )
      // 有标记或有「额外编辑」都值得表演（只填 extra 不打标记是合法用法，
      // 面板照样打开、底栏逐字输入、按发送）。
      const meta = firstText ? parseImageEditMessage(firstText.text) : null
      if (meta && meta.path && (meta.edits.length > 0 || meta.extra)) {
        for (const ui of buildImageEditPerformance(meta, prevEnd, end, nextId)) {
          push(ui)
        }
      }
      push({ id: nextId(), t: end, track: 'chat', op: 'user_message', content: parts })
      prevEnd = end
      continue
    }

    // assistant：窗口 [prevEnd, end] 按块权重分摊。
    const windowMs = Math.max(end - prevEnd, MIN_WINDOW_MS)
    const blocks = collectBlocks(parts)
    const totalWeight = blocks.reduce((s, b) => s + b.weight, 0) || 1
    let cursor = prevEnd

    push({
      id: nextId(),
      t: cursor,
      track: 'chat',
      op: 'turn_start',
      messageId: String(m.id)
    })

    for (const b of blocks) {
      const durMs = Math.round((windowMs * b.weight) / totalWeight)
      if (b.kind === 'text') {
        push({
          id: nextId(),
          t: cursor,
          track: 'chat',
          op: 'text',
          messageId: String(m.id),
          text: b.text,
          durMs
        })
      } else if (b.kind === 'thinking') {
        push({
          id: nextId(),
          t: cursor,
          track: 'chat',
          op: 'thinking',
          messageId: String(m.id),
          text: b.text,
          durMs
        })
      } else {
        // args 流出占小头、工具运行占大头——粗分即可，播放端还会按倍速/上限再 cap。
        const argsDurMs = Math.round(durMs * 0.35)
        push({
          id: nextId(),
          t: cursor,
          track: 'chat',
          op: 'tool',
          messageId: String(m.id),
          toolUseId: b.toolUseId,
          toolName: b.toolName,
          argsJson: b.argsJson,
          argsDurMs,
          runDurMs: durMs - argsDurMs,
          ...(b.result !== undefined ? { result: b.result } : {}),
          ...(b.tasks ? { tasks: b.tasks } : {})
        })
        // 「问题」tab 表演反推：借用这个 tool block 自己的时间窗口
        // [cursor, cursor+durMs]，绝不额外拉伸时间轴（同 image-edit 的
        // 「倒推起点」原则，这里窗口本来就是 tool 的运行时段）。
        if (b.toolName === 'AskUserQuestion') {
          for (const ui of buildAskQuestionPerformance(b.argsJson, b.result, cursor, durMs, nextId)) {
            push(ui)
          }
        } else if (b.toolName === 'Bash') {
          const stageResult = extractConfirmStageResult(b.result)
          if (stageResult) {
            for (const ui of buildConfirmPerformance(b.toolUseId, stageResult, cursor, durMs, nextId)) {
              push(ui)
            }
          }
        }
      }
      cursor += durMs
    }

    // turn 边界 = 下一条消息是 user（或到结尾）。连续 assistant 行同属一个
    // turn：live 语义是每条 assistant 消息一个 'start'、整 turn 一个 'end'。
    const next = messages[i + 1]
    if (!next || next.role === 'user') {
      push({
        id: nextId(),
        t: Math.max(end, cursor),
        track: 'chat',
        op: 'turn_end',
        messageId: String(m.id)
      })
    }
    prevEnd = end
  }

  return {
    items,
    realDurationMs: lastT,
    messageCount: messages.length
  }
}

/* ─────────────────── 内容块收集 ─────────────────── */

type Block =
  | { kind: 'text'; text: string; weight: number }
  | { kind: 'thinking'; text: string; weight: number }
  | {
      kind: 'tool'
      toolUseId: string
      toolName: string
      argsJson: string
      result?: unknown
      tasks?: WorkflowTask[]
      weight: number
    }

function collectBlocks(parts: SerializedContentPart[]): Block[] {
  const out: Block[] = []
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string' && p.text.length > 0) {
      out.push({ kind: 'text', text: p.text, weight: p.text.length })
      continue
    }
    if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.length > 0) {
      out.push({ kind: 'thinking', text: p.text, weight: p.text.length })
      continue
    }
    if (p.type === 'tool-call' && typeof p.toolCallId === 'string') {
      const argsJson = safeStringify(p.args ?? {})
      out.push({
        kind: 'tool',
        toolUseId: p.toolCallId,
        toolName: typeof p.toolName === 'string' ? p.toolName : 'tool',
        argsJson,
        ...(p.result !== undefined ? { result: p.result } : {}),
        ...(Array.isArray(p.tasks) && p.tasks.length > 0
          ? { tasks: p.tasks as WorkflowTask[] }
          : {}),
        weight: argsJson.length + TOOL_RUN_WEIGHT_CHARS
      })
      continue
    }
    // image part 等其余类型没有流式表演形态，忽略（user_message 整条落卡时
    // 才会带 image part）。
  }
  return out
}

function normalizeParts(
  content: ThreadMessageLike['content']
): SerializedContentPart[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (Array.isArray(content)) return content as SerializedContentPart[]
  return []
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '{}'
  } catch {
    return '{}'
  }
}

/* ─────────────────── UI 轨：图片编辑面板表演 ─────────────────── */

/**
 * 从 ImageEditMeta 反推一段面板表演，时间落在 [prevEnd, msgEnd] 窗口的
 * 尾部（倒推起点）。自然节奏先生成、总长超 clamp 上限时整体等比压缩——
 * 保证任何标记数量/文字长度下表演都是完整且有限的。
 */
function buildImageEditPerformance(
  meta: NonNullable<ReturnType<typeof parseImageEditMessage>>,
  prevEnd: number,
  msgEnd: number,
  nextId: () => string
): ReplayUiItem[] {
  // 先按自然节奏铺相对偏移（0 起点）。
  type Step = { rel: number; make: (t: number) => ReplayUiItem }
  const steps: Step[] = []
  let rel = 0

  steps.push({
    rel,
    make: (t) => ({ id: nextId(), t, track: 'ui', op: 'imageEdit.open', path: meta.path })
  })
  rel += 900 // 面板挂载 + 原图读盘落定的观感缓冲

  for (const e of meta.edits) {
    const edit = e
    steps.push({
      rel,
      make: (t) => ({
        id: nextId(),
        t,
        track: 'ui',
        op: 'imageEdit.addMarker',
        x: edit.x,
        y: edit.y,
        ...(edit.w !== undefined ? { w: edit.w } : {}),
        ...(edit.h !== undefined ? { h: edit.h } : {})
      })
    })
    rel += 350
    const typeMs = Math.max(edit.note.length * UI_TYPE_MS_PER_CHAR, 300)
    steps.push({
      rel,
      make: (t) => ({
        id: nextId(),
        t,
        track: 'ui',
        op: 'imageEdit.typeNote',
        text: edit.note,
        durMs: typeMs
      })
    })
    rel += typeMs + 250
    steps.push({
      rel,
      make: (t) => ({ id: nextId(), t, track: 'ui', op: 'imageEdit.commitMarker' })
    })
    rel += 400
  }

  if (meta.extra) {
    const typeMs = Math.max(meta.extra.length * UI_TYPE_MS_PER_CHAR, 300)
    steps.push({
      rel,
      make: (t) => ({
        id: nextId(),
        t,
        track: 'ui',
        op: 'imageEdit.typeExtra',
        text: meta.extra,
        durMs: typeMs
      })
    })
    rel += typeMs + 250
  }

  steps.push({
    rel,
    make: (t) => ({ id: nextId(), t, track: 'ui', op: 'imageEdit.pressSend' })
  })
  rel += 450
  steps.push({
    rel,
    make: (t) => ({ id: nextId(), t, track: 'ui', op: 'imageEdit.close' })
  })

  const naturalMs = rel
  // clamp 总时长：过短没戏剧性、过长喧宾夺主；再受实际消息间隔约束（不为
  // 表演拉长时间轴——间隔太窄时压着演）。
  const target = Math.min(
    Math.max(naturalMs, UI_PERF_MIN_MS),
    UI_PERF_MAX_MS,
    Math.max(msgEnd - prevEnd, UI_PERF_MIN_MS)
  )
  const scale = target / naturalMs
  const start = Math.max(prevEnd, msgEnd - target)

  return steps.map((s) => {
    const item = s.make(start + Math.round(s.rel * scale))
    // durMs 同步缩放（超长 note 在压缩后仍与整体节奏一致）。
    if ('durMs' in item) {
      item.durMs = Math.max(Math.round(item.durMs * scale), 120)
    }
    return item
  })
}

/* ─────────────────── UI 轨：AskUserQuestion 表演 ─────────────────── */

/** parseQuestions 的 main-side 等价物（renderer 侧那份在
 *  src/chat/components/permissions/AskUserQuestionView.tsx，依赖 React
 *  环境不便跨进程共用；这里只读字段提取，逻辑简单到不值得抽 shared）。 */
function extractQuestions(
  argsJson: string
): { question: string; options: string[] }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) return []
  const out: { question: string; options: string[] }[] = []
  for (const q of parsed.questions) {
    if (!isRecord(q) || typeof q.question !== 'string' || !Array.isArray(q.options)) continue
    const options: string[] = []
    for (const o of q.options) {
      if (isRecord(o) && typeof o.label === 'string') options.push(o.label)
    }
    if (options.length > 0) out.push({ question: q.question, options })
  }
  return out
}

/** tool_result → {answers} 字典。result 可能是 stringified JSON（Bash 走的
 *  文本合并路径）或已经是对象（部分工具结果原样透传）——两种都要认。 */
function extractAnswers(result: unknown): Record<string, string> {
  let data: unknown = result
  if (typeof result === 'string') {
    try {
      data = JSON.parse(result)
    } catch {
      return {}
    }
  }
  if (!isRecord(data) || !isRecord(data.answers)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data.answers)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * AskUserQuestion 的 args（问题列表）+ result（{answers}）都在 transcript
 * 里，反推数据总是齐全——不像 confirm_ui 需要额外日志兜底。表演塞进该
 * tool block 自己的 [start,start+windowMs] 窗口内，问题未回答（result
 * 缺失，如中途取消）时只演 open，不强演不存在的选择。
 */
function buildAskQuestionPerformance(
  argsJson: string,
  result: unknown,
  start: number,
  windowMs: number,
  nextId: () => string
): ReplayUiItem[] {
  const questions = extractQuestions(argsJson)
  if (questions.length === 0) return []
  const answers = extractAnswers(result)

  type Step = { rel: number; make: (t: number) => ReplayUiItem }
  const steps: Step[] = []
  let rel = 0
  steps.push({
    rel,
    make: (t) => ({ id: nextId(), t, track: 'ui', op: 'askQuestion.open', questionsJson: argsJson })
  })
  rel += 500

  const answeredQuestions = questions.filter((q) => typeof answers[q.question] === 'string')
  if (answeredQuestions.length === 0) return finalizeUiSteps(steps, start, windowMs)

  for (const q of answeredQuestions) {
    const label = answers[q.question]
    if (q.options.includes(label)) {
      steps.push({
        rel,
        make: (t) => ({ id: nextId(), t, track: 'ui', op: 'askQuestion.select', question: q.question, label })
      })
      rel += 500
    } else {
      // 不在预置选项里 = 用户走了「其他」自由文本。
      const typeMs = Math.max(label.length * UI_TYPE_MS_PER_CHAR, 300)
      steps.push({
        rel,
        make: (t) => ({
          id: nextId(),
          t,
          track: 'ui',
          op: 'askQuestion.typeOther',
          question: q.question,
          text: label,
          durMs: typeMs
        })
      })
      rel += typeMs + 300
    }
  }
  steps.push({ rel, make: (t) => ({ id: nextId(), t, track: 'ui', op: 'askQuestion.submit' }) })

  return finalizeUiSteps(steps, start, windowMs)
}

/* ─────────────────── UI 轨：ppt-master 八项确认表演 ─────────────────── */

/**
 * 从 Bash 工具的 result 文本里判定这次调用是否命中了
 * confirm_ui/server.py 打的 `[[confirm-result]]{...}` 日志行——只要「是
 * 否命中 + stage」，不在这里解析完整快照（那份含 recommendations 的完整
 * 数据走 replayPackage.ts 的 collectConfirmSnapshots，随 manifest 传给
 * CanvasConfirm 做离线渲染；这里只需要 result.json 的【最终选择】来编排
 * 「选中哪个字段」这段表演节奏）。
 */
function extractConfirmStageResult(
  result: unknown
): { stage: 'tier1' | 'final'; fields: Record<string, string> } | null {
  const text = typeof result === 'string' ? result : ''
  if (!text.includes(CONFIRM_RESULT_MARKER)) return null
  for (const line of text.split('\n')) {
    const idx = line.indexOf(CONFIRM_RESULT_MARKER)
    if (idx === -1) continue
    const jsonStr = line.slice(idx + CONFIRM_RESULT_MARKER.length).trim()
    try {
      const data = JSON.parse(jsonStr) as unknown
      if (!isRecord(data) || (data.stage !== 'tier1' && data.stage !== 'final')) continue
      if (!isRecord(data.result)) continue
      const fields: Record<string, string> = {}
      for (const [k, v] of Object.entries(data.result)) {
        if (k === 'stage' || k === 'status' || k === 'confirmed_at') continue
        if (typeof v === 'string') fields[k] = v
      }
      return { stage: data.stage, fields }
    } catch {
      /* 这一行不是合法 JSON——继续找下一行，容忍日志里混了别的输出。 */
    }
  }
  return null
}

/**
 * 八项确认的 tier1/final 各自独立编译成一段表演（同一 turn 内可能有两次
 * Bash 调用，分别命中 tier1 和 final）。confirm.select/typeText 只带字段名
 * +值——真正的选项列表/推荐星标由 CanvasConfirm 从随包传入的
 * ReplayConfirmSnapshot.recommendations 离线渲染，播放端只管把已渲染好的
 * 选项「点亮」。
 */
function buildConfirmPerformance(
  toolUseId: string,
  stageResult: { stage: 'tier1' | 'final'; fields: Record<string, string> },
  start: number,
  windowMs: number,
  nextId: () => string
): ReplayUiItem[] {
  const entries = Object.entries(stageResult.fields)
  if (entries.length === 0) return []
  const tier = stageResult.stage === 'tier1' ? 1 : 2

  type Step = { rel: number; make: (t: number) => ReplayUiItem }
  const steps: Step[] = []
  let rel = 0
  steps.push({ rel, make: (t) => ({ id: nextId(), t, track: 'ui', op: 'confirm.open', toolUseId, tier }) })
  rel += 600

  for (const [field, value] of entries) {
    // 短值（catalog id/枚举）当选卡表演；长值（audience 之类自由描述）
    // 当输入框逐字表演——阈值粗放即可，两条渲染路径都合法降级。
    if (value.length <= 24) {
      steps.push({ rel, make: (t) => ({ id: nextId(), t, track: 'ui', op: 'confirm.select', field, value }) })
      rel += 450
    } else {
      const typeMs = Math.max(value.length * UI_TYPE_MS_PER_CHAR, 300)
      steps.push({
        rel,
        make: (t) => ({ id: nextId(), t, track: 'ui', op: 'confirm.typeText', field, text: value, durMs: typeMs })
      })
      rel += typeMs + 300
    }
  }

  if (tier === 1) {
    steps.push({ rel, make: (t) => ({ id: nextId(), t, track: 'ui', op: 'confirm.advanceTier2' }) })
  } else {
    steps.push({ rel, make: (t) => ({ id: nextId(), t, track: 'ui', op: 'confirm.submitFinal' }) })
  }

  return finalizeUiSteps(steps, start, windowMs)
}

/** image-edit 表演沿用的「自然节奏铺 rel → clamp 总时长 → 整体等比压缩」
 *  收尾，抽成共用尾巴给 askQuestion/confirm 表演复用（三段表演的 clamp
 *  策略完全一致，唯独 buildImageEditPerformance 因为要【倒推起点】——
 *  它演在 user 消息之前——没有复用这个签名，保留原样）。 */
function finalizeUiSteps(
  steps: { rel: number; make: (t: number) => ReplayUiItem }[],
  start: number,
  windowMs: number
): ReplayUiItem[] {
  const naturalMs = steps.length > 0 ? steps[steps.length - 1].rel + 400 : 0
  if (naturalMs === 0) return []
  const target = Math.min(Math.max(naturalMs, UI_PERF_MIN_MS), UI_PERF_MAX_MS, Math.max(windowMs, UI_PERF_MIN_MS))
  const scale = target / naturalMs
  return steps.map((s) => {
    const item = s.make(start + Math.round(s.rel * scale))
    if ('durMs' in item) {
      item.durMs = Math.max(Math.round(item.durMs * scale), 120)
    }
    return item
  })
}
