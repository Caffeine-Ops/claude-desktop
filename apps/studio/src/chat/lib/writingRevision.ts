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
  // NaN 防护：NaN 参与的比较全为 false（NaN<0、NaN>=n、NaN<start 都不成立），会让下面这行
  // 越界检查整体失效、静默切出错误区间。上游理论上不该传 NaN，但这里是最后一道闸，不能省。
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || start >= blocks.length || end < start || end >= blocks.length) return null
  const selected = blocks.slice(start, end + 1).join('\n\n')
  // 这条防御目前打不到：splitBlocks 保证每个块 trim 后非空，join 出的 selected 不可能是空白。
  // 保留它是防止「splitBlocks 非空块」这条不变量将来被改动时，这里跟着静默出错——别当死代码删掉。
  if (!selected.trim()) return null

  return [
    // 禁令放在最前面，且在结尾再重复一次：AI 手上有 Edit/Write 工具，而「先对照再应用」
    // 的全部保护都建立在「AI 不自己改盘」这个前提上——它一旦擅自落地，用户点「放弃」时
    // 内容已被覆盖、无法挽回。单条位于长消息尾部的禁令会被上文冲淡，故首尾双写。
    '【最高优先级】这一轮不要调用 Edit、Write 或任何会修改文件的工具。',
    '改写结果由用户在界面上确认后才落地；你若擅自改盘，用户选择「放弃」时内容已经被覆盖，无法挽回。',
    '',
    '请按我的要求改写下面这段文字。',
    '',
    '【本节全文（仅供你把握上下文与前后衔接，不要改动选中范围之外的内容）】',
    input.sectionMarkdown,
    '',
    '【要改的那一段（只改这一段）】',
    selected,
    '',
    '【我的要求】',
    instruction,
    '',
    '【输出格式（必须严格遵守）】',
    '把「要改的那一段」改写后的结果包在下面这对标记之间，标记各占一行。',
    // 显式排除「整节重写」这种解读：若 AI 把整节全文塞进哨兵，落地时会被当作选中块的替换内容
    // 整体插进选段位置，结果是「选段处凭空多出一份重复的整节」——这是会真正损坏正文的误解。
    '标记之间只放这一段的改写结果 —— 不要放整节全文，不要加标题，不要写解释。',
    WRITING_REVISION_BEGIN,
    '（把这行替换成你改写后的正文，不要保留这行说明文字）',
    WRITING_REVISION_END,
    '',
    '【再次强调】不要调用任何会修改文件的工具，只把结果放进上面那对标记里。'
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
