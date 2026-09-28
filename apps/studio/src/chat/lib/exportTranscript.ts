/**
 * 「导出对话为 Markdown」的纯逻辑——消息数组进、Markdown 字符串出。
 *
 * 为什么抠成独立纯模块（而不是写在 ThreadView 里）
 * ------------------------------------------------
 * 导出功能最容易坏的地方是「某种消息块没处理到，导出文件缺一块」，而这类
 * 缺陷只有自动化测试抓得住——手工导出一遍用眼睛看，永远覆盖不到「只有思考
 * 没有正文的那条消息」这种边角。放在 `src/chat/lib/` 是按项目约定（见根
 * CLAUDE.md「命令」小节）：这个目录的纯函数会被 `bun test` 自动覆盖。
 *
 * 因此本模块**刻意零依赖**：不 import store、不 import React、不碰 i18n。
 * 弹保存框与写盘是副作用，留在 main 侧（TRANSCRIPT_EXPORT_MD 通道），与
 * 项目既有的 6 条导出通道同构（渲染层生成内容 + main 落盘）。
 */

import { stripMessageMarker } from './messageMarkers'

/**
 * 消息块的结构性最小契约。上游真实类型是 assistant-ui 的
 * `ThreadMessageLike['content'][number]`——一个十来种变体的可辨识联合，
 * 字段随 `type` 而变。这里刻意只声明 `type` + 索引签名而不复刻那个联合：
 * 复刻会让本模块跟着 assistant-ui 的版本升级一起改，而导出只关心「块是
 * 什么类型、里面那几个字段在不在」，属于结构性消费，不需要完整类型。
 */
export type TranscriptPart = {
  readonly type: string
  readonly [key: string]: unknown
}

/** 一条消息。`content` 允许裸字符串——ThreadMessageLike 本身就是这个联合。 */
export type TranscriptMessage = {
  readonly role: string
  readonly content: string | readonly TranscriptPart[]
}

export type BuildTranscriptOptions = {
  /** 会话标题（rail 与顶栏显示的那个）。空白时用兜底名。 */
  readonly title: string
  /** 导出时刻，只取日期部分。显式传入而不在函数内取 now()，否则不可测。 */
  readonly exportedAt: Date
}

const FALLBACK_TITLE = '未命名对话'

/**
 * 说话人抬头。只认 user / assistant 两种：system 提示词用户从没看过，
 * 导出里出现只会让人困惑（还可能把内部提示词泄露给收件人）。
 */
const SPEAKER: Readonly<Record<string, string>> = {
  user: '我',
  assistant: 'Claude'
}

/**
 * 零宽空格——`stores/chat.ts` 的 `REASONING_PLACEHOLDER`。思考块打开时
 * 会先塞这个占位符（assistant-ui 会过滤掉 trim 后为空的块，所以它必须是
 * 个「非空白的不可见字符」）。**不从 store import**：那会把 zustand 拖进
 * 这个零依赖纯模块。代价是一份重复的常量声明，换来的是测试不用起 store。
 */
const ZERO_WIDTH = /[​‌‍﻿]/g

/** 去掉零宽字符后还有实际内容吗。`'​'.trim()` 是不会变空的——零宽空格不算空白。 */
function hasText(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.replace(ZERO_WIDTH, '').trim().length > 0
}

/** `2026-09-28`。用本地日期（用户眼里的「今天」），不是 UTC。 */
function formatDay(at: Date): string {
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 摘要里单个参数值的显示上限。超了截断——一行摘要糊满半页就不是摘要了。 */
const VALUE_MAX = 48

/**
 * 参数值收拾成「能安全塞进一行反引号里」的样子：换行压成空格（否则会把
 * Markdown 引用块裂成多行，第二行丢掉 `> ` 前缀就不再是引用了），超长截断。
 * 非字符串（或空串）返回 null，调用方据此退回「只报工具名」。
 */
function inlineValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > VALUE_MAX ? `${flat.slice(0, VALUE_MAX)}…` : flat
}

/** 只取路径最后一段。导出是给人看的，`/Users/…/src/chat/x.tsx` 里有用的只有 `x.tsx`。 */
function baseName(raw: unknown): string | null {
  const v = inlineValue(raw)
  if (!v) return null
  const seg = v.split(/[/\\]/).pop()
  return seg || v
}

/**
 * 工具调用 → 一行人话摘要。
 *
 * 为什么不复用 `components/chat/ToolFormatters`
 * --------------------------------------------
 * 那套 formatter 的 `headline` 是 **React.ReactNode**（要渲染成带图标、带
 * 折叠面板的卡片），拿不到纯文本。导出要的是字符串，所以这里另起一份**纯
 * 文本**查表。两份表都只是「工具名 → 人话」的映射，没有共享逻辑可抽——硬
 * 抽一层会让两边都变难改。
 *
 * 表里没有的工具（每个 MCP 工具、冷门内置工具）兜底成「调用 {工具名}」，
 * 绝不抛错：一条摘要渲染失败不该让整个导出失败。
 */
export function toolCallSummary(toolName: string, args: unknown): string {
  const bag = (args ?? {}) as Record<string, unknown>
  const fallback = `调用 ${toolName}`
  /** `读取 \`x.tsx\`` 这样的「动词 + 反引号值」；值缺失时退回兜底。 */
  const withValue = (verb: string, value: string | null): string =>
    value ? `${verb} \`${value}\`` : fallback

  switch (toolName) {
    case 'Read':
      return withValue('读取', baseName(bag.file_path))
    case 'Write':
      return withValue('写入', baseName(bag.file_path))
    case 'Edit':
    case 'MultiEdit':
      return withValue('编辑', baseName(bag.file_path))
    case 'NotebookEdit':
      return withValue('编辑', baseName(bag.notebook_path))
    case 'Bash': {
      // description 是给人看的一句话（「查看工作区状态」），比原始命令可读得多，
      // 所以优先；它本身已是人话，不套反引号。没有才退回命令本身（那是代码，套）。
      const desc = inlineValue(bag.description)
      if (desc) return `执行 ${desc}`
      return withValue('执行', inlineValue(bag.command))
    }
    case 'Grep':
      return withValue('搜索', inlineValue(bag.pattern))
    case 'Glob':
      return withValue('查找文件', inlineValue(bag.pattern))
    case 'WebSearch':
      return withValue('联网搜索', inlineValue(bag.query))
    case 'WebFetch':
      return withValue('抓取网页', inlineValue(bag.url))
    case 'ToolSearch':
      return withValue('加载工具', inlineValue(bag.query))
    case 'Skill':
      return withValue('调用技能', inlineValue(bag.skill))
    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskStop': {
      // description 同 Bash：已经是人话，不套反引号。
      const desc = inlineValue(bag.description)
      return desc ? `派出子任务 ${desc}` : '派出子任务'
    }
    case 'TodoWrite':
      return '更新任务清单'
    case 'AskUserQuestion':
      return '向我提问'
    default:
      return fallback
  }
}

/**
 * 「元信息行」——工具调用、图片、附件。它们不是对话正文，渲染成 Markdown
 * 引用块（`> `），在视觉上与正文分开。返回 null ＝这个块不进导出。
 */
function metaLine(part: TranscriptPart): string | null {
  switch (part.type) {
    case 'tool-call': {
      const name = typeof part.toolName === 'string' ? part.toolName : ''
      if (!name) return null
      // args 未解析完（流式中断）时退回 argsText 里能捞到的东西：捞不到就只报工具名。
      const args =
        part.args && typeof part.args === 'object' ? part.args : parseArgsText(part.argsText)
      return `🔧 ${toolCallSummary(name, args)}`
    }
    // 图片带不出去：Markdown 就是一个纯文本文件，装不了图（真要带图得导出成
    // 「文件夹 = md + 图片」，是另一个功能）。留占位符至少让读的人知道这里有张图。
    case 'image':
      return '［图片］'
    case 'file': {
      const name = inlineValue(part.filename) ?? inlineValue(part.name)
      return name ? `［附件：${name}］` : '［附件］'
    }
    default:
      return null
  }
}

/** 流式未完成的 tool-call 只有半截 JSON 文本；解析不出来就当没有参数。 */
function parseArgsText(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 一条消息渲染成若干个 Markdown 段落。返回空数组＝这条消息没有任何可导出
 * 内容（例如只有思考块），调用方据此整条跳过，不留一个空的「## Claude」。
 *
 * 连续的元信息行会聚成**一个**引用块（`> 🔧 a` / `> 🔧 b` 相邻两行），而不是
 * 各占一段——AI 连着调五个工具是常态，每个占一段会把回答撕得七零八落。
 */
function renderParts(content: TranscriptMessage['content']): string[] {
  if (typeof content === 'string') {
    const text = cleanText(content)
    return text ? [text] : []
  }
  const out: string[] = []
  let quote: string[] = []
  const flushQuote = (): void => {
    if (quote.length === 0) return
    out.push(quote.map((l) => `> ${l}`).join('\n'))
    quote = []
  }

  for (const part of content) {
    // 思考过程刻意丢弃：它是给本人看「AI 在想什么」的，导出给别人看时是噪音。
    if (part.type === 'reasoning') continue
    if (part.type === 'text') {
      const text = cleanText(part.text)
      if (!text) continue
      flushQuote()
      out.push(text)
      continue
    }
    const line = metaLine(part)
    if (line) quote.push(line)
  }
  flushQuote()
  return out
}

/**
 * 正文标题的降级量。文档标题占 `#`、说话人占 `##`，所以正文最浅只能是 `###`。
 */
const HEADING_SHIFT = 2

/** 围栏代码块的起止行（``` 或 ~~~，允许最多 3 个前导空格，按 CommonMark）。 */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/

/** ATX 标题行。`#` 后**必须**有空格才算标题——`#话题`、`#include` 都不是。 */
const ATX_HEADING = /^ {0,3}(#{1,6}) (.*)$/

/**
 * 把正文里的 Markdown 标题整体下移两级。
 *
 * 为什么必须做（2026-09-28 真机走查实锤）
 * ------------------------------------
 * AI 的长回答经常自带 `# 今日要闻简报` 这样的一级标题。屏幕上各条消息各自
 * 渲染，互不干扰；**但导出成一个文件后，它就和文档标题平级了**——在任何
 * Markdown 阅读器的大纲里，一份导出会散成好几篇文档。整体下移保住了
 * 「文档 → 说话人 → 正文小节」这一条唯一的大纲主干。
 *
 * 下移而非压平（`#`/`##` 都变 `###`）：压平会丢掉原文自己的层级关系，
 * 三级小节会全挤成一层。超过六级的封顶在六级（Markdown 没有七级）。
 *
 * 代码块内一律不动：那里的 `#` 是 shell 注释、C 预处理指令、Python 注释，
 * 改一个字就是改坏别人的代码。
 */
function demoteHeadings(text: string): string {
  const lines = text.split('\n')
  /** 当前所在围栏的标记字符（` 或 ~），不在围栏里时为 null。 */
  let fence: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const fenceHit = FENCE_LINE.exec(lines[i])
    if (fenceHit) {
      const marker = fenceHit[1][0]
      // 只有同种标记能关掉围栏（``` 开的块内出现 ~~~ 只是普通文本）。
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = ATX_HEADING.exec(lines[i])
    if (!heading) continue
    const level = Math.min(6, heading[1].length + HEADING_SHIFT)
    lines[i] = `${'#'.repeat(level)} ${heading[2]}`
  }
  return lines.join('\n')
}

/**
 * 正文文本清理。两件事：
 *
 * 1. `stripMessageMarker`——图片编辑、表格选区这类消息在会话里是带
 *    `[[image-edit]]{…JSON…}` 协议前缀存着的，界面上由专门的气泡组件渲染成
 *    人话，**裸导出会把内部协议原样漏给收件人**。
 * 2. 标题降级，见 demoteHeadings。
 */
function cleanText(raw: unknown): string | null {
  if (!hasText(raw)) return null
  const stripped = stripMessageMarker(raw).trim()
  return stripped ? demoteHeadings(stripped) : null
}

/**
 * 把一段对话渲染成 Markdown 全文。
 *
 * 输出形状（空行是 Markdown 的段落分隔，必须留）：
 *
 *     # 会话标题
 *
 *     > 导出于 2026-09-28 · Claude Desktop
 *
 *     ## 我
 *
 *     用户说的话
 *
 *     ## Claude
 *
 *     助手的回答
 */
export function buildTranscriptMarkdown(
  messages: readonly TranscriptMessage[],
  opts: BuildTranscriptOptions
): string {
  const title = opts.title.trim() || FALLBACK_TITLE
  const blocks: string[] = [`# ${title}`, `> 导出于 ${formatDay(opts.exportedAt)} · Claude Desktop`]

  for (const msg of messages) {
    const speaker = SPEAKER[msg.role]
    if (!speaker) continue
    const parts = renderParts(msg.content)
    if (parts.length === 0) continue
    blocks.push(`## ${speaker}`, ...parts)
  }

  // 段落间统一空行分隔，结尾恰好一个换行（POSIX 文本文件惯例，也让 git diff
  // 不报「no newline at end of file」）。
  return `${blocks.join('\n\n')}\n`
}

/**
 * 文件名里不能出现的字符。三平台取并集（Windows 最严）：`\ / : * ? " < > |`
 * 外加控制字符。**按最严的平台清洗**而不是按 macOS——同一个会话在 Windows
 * 上导出也得能存，而「保存框弹出来才报错」是最难查的那种问题。
 */
const ILLEGAL_IN_FILENAME = /[/\\:*?"<>| -]/g

/** 标题部分的长度上限。日期后缀 `-2026-09-28.md` 占 14，留足余量。 */
const FILENAME_STEM_MAX = 46

/**
 * 保存框的默认文件名：`会话标题-2026-09-28.md`。
 *
 * 带上日期是因为会话标题经常撞车（「帮我改一下」这种），同名文件在下载目录里
 * 会互相覆盖。
 */
export function transcriptFilename(title: string, at: Date): string {
  const flat = title.replace(/\s+/g, ' ').trim()
  const safe = flat.replace(ILLEGAL_IN_FILENAME, '-')
  // 清洗后只剩分隔符（标题形如 `///`）也算没有标题——否则文件名会长成 `---2026-09-28.md`。
  const meaningful = safe.replace(/[-\s]/g, '') ? safe : ''
  // Windows 不接受以点或空格结尾的文件名（资源管理器会静默改名）。
  const stem = (meaningful.slice(0, FILENAME_STEM_MAX) || FALLBACK_TITLE).replace(/[.\s]+$/, '')
  return `${stem || FALLBACK_TITLE}-${formatDay(at)}.md`
}
