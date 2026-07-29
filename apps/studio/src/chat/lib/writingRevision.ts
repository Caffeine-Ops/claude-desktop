import {
  splitBlocks,
  spliceBlocks,
  locateBlockRangeByTextWithHint
} from '@desktop-shared/proposalBlocks'
import { WRITING_REVISION_BEGIN, WRITING_REVISION_END } from '@desktop-shared/writing'

/** 一次改写的目标。`selectedText` 是排队重定位的依据，见 relocateTarget。 */
export interface WritingRevisionTarget {
  sectionName: string
  range: { start: number; end: number }
  selectedText: string
}

/**
 * 组装发给 AI 的改写请求。
 *
 * 三个要素缺一不可：**本节全文**（AI 要看上下文才知道语气与前后衔接）、**选中块原文**
 * （明确改哪一段）、**哨兵格式要求**（前端据此抽取结果）。外加一句「不要修改任何文件」——
 * AI 手上有 Edit 工具，不明确禁止它会直接改盘，那样就绕过了「先对照再应用」这一步，
 * 用户点「放弃」也已经晚了。
 *
 * 返回 null = 不发这一轮（空指令 / 区间越界）。
 */
export function buildRevisionMessage(input: {
  sectionMarkdown: string
  target: WritingRevisionTarget
  instruction: string
}): string | null {
  const instruction = input.instruction.trim()
  if (!instruction) return null

  const blocks = splitBlocks(input.sectionMarkdown)
  const { start, end } = input.target.range
  if (start < 0 || start >= blocks.length || end < start || end >= blocks.length) return null
  const selected = blocks.slice(start, end + 1).join('\n\n')
  if (!selected.trim()) return null

  return [
    '请按我的要求改写下面这段文字。',
    '',
    '【本节全文（供你把握上下文与前后衔接，不要改动选中范围之外的内容）】',
    input.sectionMarkdown,
    '',
    '【要改的那一段】',
    selected,
    '',
    '【我的要求】',
    instruction,
    '',
    '【输出格式（必须严格遵守）】',
    `把改写后的文字包在下面这对标记之间，标记各占一行，中间只放正文，不要解释、不要加标题：`,
    WRITING_REVISION_BEGIN,
    '（改写后的正文）',
    WRITING_REVISION_END,
    '',
    '【重要】不要修改任何文件。改写结果由我确认后再落地。'
  ].join('\n')
}

/** 把改后文本替换进指定块区间，返回重拼后的整节 markdown。 */
export function applyRevision(
  sectionMarkdown: string,
  range: { start: number; end: number },
  replacement: string
): string {
  return spliceBlocks(sectionMarkdown, range, replacement)
}

/**
 * 用「当初选中的原文」在最新内容里重新定位块区间。
 *
 * 为什么需要：改写请求可能在队列里等过一阵（AI 当时在写下一节），期间前面的改写已经落地、
 * 块序号会漂到别处。直接用入队时的序号，改的就是隔壁段落。原文多处命中时，用入队时的
 * 区间当提示选最近的一处（`locateBlockRangeByTextWithHint` 已实现这个裁决）。
 *
 * 返回 null = 那段原文已经不存在（被 AI 重写了），调用方应丢弃这次改写并告知用户。
 */
export function relocateTarget(
  sectionMarkdown: string,
  target: WritingRevisionTarget
): { start: number; end: number } | null {
  return locateBlockRangeByTextWithHint(sectionMarkdown, target.selectedText, target.range)
}
