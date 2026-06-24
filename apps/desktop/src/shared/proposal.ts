// 方案正文哨兵 + 抽取器。main 与 renderer 共享此文件，保证两端用同一份标记。
//
// 问题背景：方案提示词（proposalPrompt.ts 规则 5）要求 AI「先问用户该部分关键要点，
// 再起草」。如果右侧文档面板把每条 assistant 消息的全部文本无差别累积进去，AI 的
// 澄清提问、过程确认也会被当成正文写进草稿、随导出落进 .md，污染文档。
//
// 解法：AI 只把「最终要收入文档的正文」包在这对哨兵之间；提问 / 过程对话不包哨兵。
// renderer 的 'end' 处理只抽取哨兵之间的内容累积——不带哨兵的输出自然被排除。
//
// 哨兵选型：`===…===` 形式在聊天里会作为普通文本显示（react-markdown 无 rehype-raw，
// 不会被当 HTML/setext 解析——整行含 CJK 字符，不是纯 `=` 的 setext 下划线），自解释、
// 与方案正文几乎不可能冲突，且不含正则元字符，indexOf 扫描即可、无需转义。
export const PROPOSAL_DRAFT_BEGIN = '===方案正文开始==='
export const PROPOSAL_DRAFT_END = '===方案正文结束==='

export interface ProposalDraftExtraction {
  /** 已闭合哨兵块（定稿正文段），顺序与出现一致。 */
  blocks: string[]
  /**
   * 截断残文：有【起始哨兵但其后再无结束哨兵】（流被截断 / 超 token / AI 漏写）时，
   * 起始哨兵之后到结尾的内容（trim 后非空）；否则 null。
   *
   * 为什么要单独返回它，而不像抽取器那样直接忽略：忽略会让调用侧把「截断」误判成
   * 「纯对话轮」→ 记账 + 永久丢弃半截正文，用户既看不到也无从补回（评审 B2）。
   * 暴露此标志后，调用侧可降级恢复（恢复成一节并标记疑似截断），绝不静默丢内容。
   */
  truncated: string | null
}

/**
 * 抽取「方案正文」结构：闭合哨兵块数组 + 截断残文标志。main 与 renderer 共享的纯函数。
 *
 * - 每个闭合哨兵块 = 一节（定稿正文）。
 * - 完全无起始哨兵 → { blocks: [], truncated: null }（纯提问 / 过程对话）。
 * - 有起始哨兵但无结束哨兵 → truncated 带回残文，blocks 为该残块之前已闭合的部分。
 */
export function extractProposalDraftResult(text: string): ProposalDraftExtraction {
  if (!text) return { blocks: [], truncated: null }
  const blocks: string[] = []
  let from = 0
  let truncated: string | null = null
  for (;;) {
    const b = text.indexOf(PROPOSAL_DRAFT_BEGIN, from)
    if (b < 0) break
    const contentStart = b + PROPOSAL_DRAFT_BEGIN.length
    const e = text.indexOf(PROPOSAL_DRAFT_END, contentStart)
    if (e < 0) {
      // 未闭合 = 截断。恢复残文交调用侧降级，而非丢弃（B2 核心修复）。
      const tail = text.slice(contentStart).trim()
      truncated = tail || null
      break
    }
    const section = text.slice(contentStart, e).trim()
    if (section) blocks.push(section)
    from = e + PROPOSAL_DRAFT_END.length
  }
  return { blocks, truncated }
}

/**
 * 抽取所有「方案正文」段（哨兵之间内容）为数组，顺序与出现顺序一致。
 * 分节化的来源：每个闭合哨兵块 = 一节。无哨兵对 → []。未闭合残块忽略（截断恢复
 * 走 extractProposalDraftResult，本函数维持「只取定稿块」的旧语义、向后兼容）。
 * 纯函数，main 与 renderer 共享。
 */
export function extractProposalDraftBlocks(text: string): string[] {
  return extractProposalDraftResult(text).blocks
}

/**
 * 流式进度探针：在一条【尚未结束】的 assistant 消息文本里数哨兵，给右侧面板的
 * 生成进度条用——不等 'end' 就能知道「现在在写第几部分」。与上面的抽取器同源，
 * 避免两套数法漂移。
 *
 * - completed：已闭合的哨兵块数 = 本轮已起草完的部分数。
 * - drafting：是否存在一个【已开始但未闭合】的哨兵块 = 此刻正在起草中。
 *
 * 注意语义差异：抽取器对「未闭合残块」是忽略（要的是定稿正文，不猜边界）；进度探针
 * 对未闭合块记为 drafting（要的是「正在发生什么」）。目的不同，故各自都正确。
 */
export function countProposalDraftProgress(text: string): {
  completed: number
  drafting: boolean
} {
  if (!text) return { completed: 0, drafting: false }
  let completed = 0
  let from = 0
  let drafting = false
  for (;;) {
    const b = text.indexOf(PROPOSAL_DRAFT_BEGIN, from)
    if (b < 0) break
    const contentStart = b + PROPOSAL_DRAFT_BEGIN.length
    const e = text.indexOf(PROPOSAL_DRAFT_END, contentStart)
    if (e < 0) {
      drafting = true // 起始哨兵后还没收到结束哨兵 → 正在写这一块
      break
    }
    completed++
    from = e + PROPOSAL_DRAFT_END.length
  }
  return { completed, drafting }
}

/**
 * 从一条 assistant 消息文本里抽取所有「方案正文」段（哨兵之间的内容）并拼接。
 *
 * - 无任何完整哨兵对 → 返回 ''（纯提问 / 过程对话不含哨兵，不会被收入草稿）。
 * - 支持一条消息里多个哨兵块（AI 一次推进多个部分时）。
 * - 容错：起始哨兵后找不到结束哨兵（流式截断 / AI 漏写）→ 该残块忽略，不猜测边界。
 *
 * 向后兼容：把各正文段以空行拼成单串。行为与重构前一致。
 */
export function extractProposalDraft(text: string): string {
  return extractProposalDraftBlocks(text).join('\n\n').trim()
}
