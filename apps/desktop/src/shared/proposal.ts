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

/**
 * 方案的三个生成阶段 / 三类草稿节。封面→目录→正文有序推进。放 shared 是因为 store
 * （renderer）与 docx 拼接器都要用，避免两端各写一份漂移。
 */
export type ProposalKind = 'cover' | 'toc' | 'content'

// 三对【按 kind 区分】的哨兵：哨兵自带 kind 标签，AI 用哪对就说明这段是封面/目录/正文。
// 旧设计只有一对「方案正文」哨兵，块的 kind 取自外部全局 phase——而 phase 只有右侧按钮
// 能推进；用户在聊天里自行驱动阶段（确认封面→让 AI 生成目录）时 phase 卡在 cover，目录
// 块被错标成 cover、塞进封面区，用户以为「没同步」遂重发，得到重复目录（本次修复的根因）。
// 改为哨兵自描述后，归档只看哨兵类型、与 phase 解耦，按钮流和聊天流都正确归档。
export const PROPOSAL_DRAFT_BEGIN: Record<ProposalKind, string> = {
  cover: '===方案封面开始===',
  toc: '===方案目录开始===',
  content: '===方案正文开始==='
}
export const PROPOSAL_DRAFT_END: Record<ProposalKind, string> = {
  cover: '===方案封面结束===',
  toc: '===方案目录结束===',
  content: '===方案正文结束==='
}

// 抽取时按此顺序找「位置最靠前」的起始哨兵（顺序本身不影响正确性，只是遍历用）。
const KIND_SCAN_ORDER: ProposalKind[] = ['cover', 'toc', 'content']

/**
 * 导出/预览时插在 kind 边界的「分页」标记。单独成行时 remark 解析为一个块级 html 节点，
 * proposalDocx 识别它产出真 PageBreak（封面单独一页、目录单独一页、正文起新页）。
 * 用 html 注释而非 thematicBreak：注释在 .md 里不可见、在 docx 里被我们专门拦截，
 * 不会污染正文，也不和用户写的 `---` 分割线冲突。
 */
export const PROPOSAL_PAGEBREAK = '<!--proposal-pagebreak-->'

/**
 * 区段起始标记（begin-only）：docx 导出/预览时插在每个 kind 区段的最前，让
 * proposalDocx 在丢失 kind 的扁平 markdown 里重新识别「这段是封面/目录/正文」，
 * 据此为每段构造独立 Word Section（封面竖向居中、目录注标题、正文带页码）。
 *
 * 与 PROPOSAL_PAGEBREAK 同款：单独成行的 HTML 注释 → remark 解析为块级 html 节点，
 * 在聊天/.md 里不可见。取代了旧的「kind 边界插 PROPOSAL_PAGEBREAK」——分页改由 Word
 * 分节天然完成（每个 section 默认起新页），不必再单独插分页标记。
 */
export const PROPOSAL_SECTION_MARK = (kind: ProposalKind): string =>
  `<!--proposal-section:${kind}-->`

/** 反解析区段标记（proposalDocx 侧 trim 后整行匹配）。 */
export const PROPOSAL_SECTION_RE = /^<!--proposal-section:(cover|toc|content)-->$/

/** 一个已抽取的草稿块：正文 + 它自带的 kind（来自哨兵类型，不再依赖外部 phase）。 */
export interface ProposalDraftBlock {
  markdown: string
  kind: ProposalKind
}

export interface ProposalDraftExtraction {
  /** 已闭合哨兵块（定稿正文段），顺序与出现一致，每块带自身 kind。 */
  blocks: ProposalDraftBlock[]
  /**
   * 截断残文：有【起始哨兵但其后再无同类结束哨兵】（流被截断 / 超 token / AI 漏写）时，
   * 起始哨兵之后到结尾的内容（trim 后非空）连同该起始哨兵的 kind；否则 null。
   *
   * 为什么要单独返回它，而不像抽取器那样直接忽略：忽略会让调用侧把「截断」误判成
   * 「纯对话轮」→ 记账 + 永久丢弃半截正文，用户既看不到也无从补回（评审 B2）。
   * 暴露此标志后，调用侧可降级恢复（恢复成一节并标记疑似截断），绝不静默丢内容。
   */
  truncated: ProposalDraftBlock | null
}

/**
 * 剥离方案正文里的 HTML 标签。AI 有时会为「封面居中」自作主张输出 `<div align="center">`、
 * `<br>`、`</div>` 之类的裸 HTML（提示词规则 8 已明令禁止，但这里再兜一道底）：预览用的
 * react-markdown 未启用 rehype-raw，这些标签会原样当成纯文本显示在草稿里（见用户反馈截图），
 * 导出 Word 也会把它们带进成品。排版居中/分页本就该交给导出器（proposalDocx）处理，正文里
 * 不该出现任何 HTML。故在抽取阶段统一清洗，预览与导出同源受益。
 *
 * 规则：
 *   - `<br>` / `<br/>` / `<br />`（不分大小写）→ 换行（它们语义上就是换行）。
 *   - 其余 HTML 标签（`<div …>`、`</div>`、`<span>`、`<center>` 等）整体删除。
 *     正则只匹配「`<` 紧跟字母的标签名」，故 markdown 的自动链接 `<https://…>`、`<a@b.com>`
 *     不会被误删（`<` 后是 `https`/`a` 但紧跟 `:`/`@`，不满足「标签名后接空白或 `>`」）。
 *   - 清洗后把 3+ 连续换行压成 2 个（删标签可能留下成片空行），首尾 trim。
 */
function stripDraftHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 抽取「方案草稿」结构：闭合哨兵块数组（各带 kind）+ 截断残文。main 与 renderer 共享的纯函数。
 *
 * - 每个闭合哨兵块 = 一节，kind 由哨兵类型（封面/目录/正文）决定，抽取后经 stripDraftHtml
 *   剥离裸 HTML。一条消息里可混有多种 kind 的块，按出现先后逐块抽取。
 * - 完全无起始哨兵 → { blocks: [], truncated: null }（纯提问 / 过程对话）。
 * - 有起始哨兵但无【同类】结束哨兵 → truncated 带回残文及其 kind，blocks 为之前已闭合的部分。
 */
export function extractProposalDraftResult(text: string): ProposalDraftExtraction {
  const blocks: ProposalDraftBlock[] = []
  let truncated: ProposalDraftBlock | null = null
  if (!text) return { blocks, truncated }
  let from = 0
  for (;;) {
    // 在三种 kind 的起始哨兵里取「位置最靠前」的那个——块的 kind 由它自己的哨兵决定，
    // 不再依赖外部 phase（根因修复，见文件头 PROPOSAL_DRAFT_BEGIN 注释）。
    let kind: ProposalKind | null = null
    let begin = -1
    for (const k of KIND_SCAN_ORDER) {
      const i = text.indexOf(PROPOSAL_DRAFT_BEGIN[k], from)
      if (i >= 0 && (begin < 0 || i < begin)) {
        begin = i
        kind = k
      }
    }
    if (kind === null) break
    const contentStart = begin + PROPOSAL_DRAFT_BEGIN[kind].length
    const e = text.indexOf(PROPOSAL_DRAFT_END[kind], contentStart)
    if (e < 0) {
      // 未闭合 = 截断。残文连同 kind 交调用侧降级，而非丢弃（B2 核心修复）。
      const tail = stripDraftHtml(text.slice(contentStart))
      if (tail) truncated = { markdown: tail, kind }
      break
    }
    const section = stripDraftHtml(text.slice(contentStart, e))
    if (section) blocks.push({ markdown: section, kind })
    from = e + PROPOSAL_DRAFT_END[kind].length
  }
  return { blocks, truncated }
}

/**
 * 把分节草稿拼成单串 markdown，供「导出 Word」与「真预览」同源消费（两处原先各自
 * `sections.map(s=>s.markdown).join('\n\n')`，现统一到此，保证预览=导出逐像素一致）。
 *
 * pageBreaks=true 即 docx 模式：每个 kind 区段起始插一行区段标记（PROPOSAL_SECTION_MARK），
 * proposalDocx 据此分节；分页由 Word 分节天然完成，故不再插 PROPOSAL_PAGEBREAK。
 * pageBreaks=false（.md 导出）：纯空行拼接，绝不含任何标记。
 *
 * 截断残文（truncated=true）不参与分节：它是「疑似不完整、待用户复核」的临时内容，
 * 常是某阶段末轮被流截断的尾巴，其 kind 可能与逻辑归属不符。若拿它的 kind 去切区段，
 * 会把同一逻辑段劈到两节。故照常输出内容但既不触发标记、也不更新 prevKind，分节边界只由
 * 正式定稿块决定。
 *
 * 纯函数，main 与 renderer 共享。空数组 → ''。
 */
export function buildProposalMarkdown(
  sections: Array<{ markdown: string; kind: ProposalKind; truncated?: boolean }>,
  opts?: { pageBreaks?: boolean }
): string {
  // pageBreaks=true 即 docx 模式：每个 kind 区段起始插一行区段标记（PROPOSAL_SECTION_MARK），
  // proposalDocx 据此分节；分页由 Word 分节天然完成，故不再插 PROPOSAL_PAGEBREAK。
  // pageBreaks=false（.md 导出）：纯空行拼接，绝不含任何标记。
  const pageBreaks = opts?.pageBreaks ?? false
  const parts: string[] = []
  let prevKind: ProposalKind | null = null
  for (const sec of sections) {
    const md = sec.markdown.trim()
    if (!md) continue
    // 截断残文：输出内容但不参与分节（不插标记、不更新 prevKind），与原分页逻辑一致——
    // 它 kind 可能与逻辑归属不符，拿它切区段会把同一逻辑段劈到两节。
    if (sec.truncated) {
      parts.push(md)
      continue
    }
    if (pageBreaks && sec.kind !== prevKind) {
      parts.push(PROPOSAL_SECTION_MARK(sec.kind))
    }
    parts.push(md)
    prevKind = sec.kind
  }
  return parts.join('\n\n').trim()
}
