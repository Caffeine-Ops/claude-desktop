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

/**
 * 方案的三个生成阶段 / 三类草稿节。封面→目录→正文有序推进，每个哨兵块按其到达时的
 * 阶段打 kind（见 stores/proposal.ts appendSections）。放 shared 是因为 store（renderer）
 * 与 docx 拼接器都要用，避免两端各写一份漂移。
 */
export type ProposalKind = 'cover' | 'toc' | 'content'

/**
 * 导出/预览时插在 kind 边界的「分页」标记。单独成行时 remark 解析为一个块级 html 节点，
 * proposalDocx 识别它产出真 PageBreak（封面单独一页、目录单独一页、正文起新页）。
 * 用 html 注释而非 thematicBreak：注释在 .md 里不可见、在 docx 里被我们专门拦截，
 * 不会污染正文，也不和用户写的 `---` 分割线冲突。
 */
export const PROPOSAL_PAGEBREAK = '<!--proposal-pagebreak-->'

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

/**
 * 把分节草稿拼成单串 markdown，供「导出 Word」与「真预览」同源消费（两处原先各自
 * `sections.map(s=>s.markdown).join('\n\n')`，现统一到此，保证预览=导出逐像素一致）。
 *
 * pageBreaks=true 时，在相邻节「kind 发生变化」的边界插入 PROPOSAL_PAGEBREAK——即
 * 封面→目录、目录→正文之间各一处分页（docx 渲染为真 PageBreak）。同 kind 的多节之间
 * 不插（正文各章连续排版）。pageBreaks=false（.md 导出）时纯空行拼接，不留任何标记。
 *
 * 纯函数，main 与 renderer 共享。空数组 → ''。
 */
export function buildProposalMarkdown(
  sections: Array<{ markdown: string; kind: ProposalKind }>,
  opts?: { pageBreaks?: boolean }
): string {
  const pageBreaks = opts?.pageBreaks ?? false
  const parts: string[] = []
  let prevKind: ProposalKind | null = null
  for (const sec of sections) {
    const md = sec.markdown.trim()
    if (!md) continue
    if (pageBreaks && prevKind !== null && sec.kind !== prevKind) {
      parts.push(PROPOSAL_PAGEBREAK)
    }
    parts.push(md)
    prevKind = sec.kind
  }
  return parts.join('\n\n').trim()
}
