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

// ── 阶段确认（聊天内 AskUserQuestion 驱动）─────────────────────────────
// 旧设计靠右侧面板按钮调 advancePhase 推进阶段；现改为 AI 在聊天里用 AskUserQuestion
// 发起确认，用户点选放行项时由渲染层推进。两个 header 是「确认问题」的身份标记：
// 提示词用它们填 AskUserQuestion 的 header，渲染层用它们识别「这是阶段确认、且选了放行项」。
// 值必须前后端一字不差，故集中定义在 shared。
export const PROPOSAL_COVER_CONFIRM_HEADER = '封面确认'
export const PROPOSAL_TOC_CONFIRM_HEADER = '目录确认'

// 决策结果：advance-content=推进到正文阶段（toc 确认放行）；clear-only=仅清跳阶提示
// （cover 确认放行）；none=不是阶段确认放行项，什么都不做。
export type ProposalStageConfirm = 'advance-content' | 'clear-only' | 'none'

/**
 * 纯函数：给定 AskUserQuestion 的原始 input 与用户答案 map（questionText→selectedLabel），
 * 判断是否命中「阶段确认放行」。判定 = header 命中两个确认常量之一 且 用户选中的 label
 * 恰等于该问题 options[0].label（放行项约定排首位）。toc 确认优先（命中即返回 advance-content）。
 *
 * 故意不硬编码放行项文案：放行项 label 取自同一份 input 的 options[0]，无论 AI 措辞如何，
 * 只要用户点的是首选项即匹配——唯一硬编码的是 header 常量（提示词据此填值，可靠）。
 */
export function decideProposalStageConfirm(
  input: unknown,
  answers: Record<string, string>
): ProposalStageConfirm {
  if (!input || typeof input !== 'object') return 'none'
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return 'none'
  let result: ProposalStageConfirm = 'none'
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const rq = q as Record<string, unknown>
    const header = typeof rq.header === 'string' ? rq.header : null
    const question = typeof rq.question === 'string' ? rq.question : null
    if (!header || !question) continue
    if (header !== PROPOSAL_COVER_CONFIRM_HEADER && header !== PROPOSAL_TOC_CONFIRM_HEADER)
      continue
    const opts = rq.options
    if (!Array.isArray(opts) || opts.length === 0) continue
    const first = opts[0]
    const proceedLabel =
      first && typeof first === 'object' && typeof (first as Record<string, unknown>).label === 'string'
        ? ((first as Record<string, unknown>).label as string)
        : null
    if (!proceedLabel) continue
    if (answers[question] !== proceedLabel) continue
    // 选了该确认问题的首选项（放行项）
    if (header === PROPOSAL_TOC_CONFIRM_HEADER) return 'advance-content'
    result = 'clear-only'
  }
  return result
}

/**
 * 纯函数：判断一张 AskUserQuestion 卡是不是【方案阶段确认卡】，是则返回是哪一阶段。
 * 与 decideProposalStageConfirm 的区别：那个判「用户点完放行项后该往哪走」（需要 answers），
 * 本函数只认「这是封面/目录确认卡」——用户还没作答就能识别，供确认卡渲染时钉说明行用。
 * 只硬编码 header 常量（提示词据此填值，可靠）；放行项文案一概不管。toc 优先于 cover。
 */
export function identifyProposalStageConfirm(input: unknown): 'cover' | 'toc' | null {
  if (!input || typeof input !== 'object') return null
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return null
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const header = (q as Record<string, unknown>).header
    if (header === PROPOSAL_TOC_CONFIRM_HEADER) return 'toc'
    if (header === PROPOSAL_COVER_CONFIRM_HEADER) return 'cover'
  }
  return null
}

// 抽取时按此顺序找「位置最靠前」的起始哨兵（顺序本身不影响正确性，只是遍历用）。
const KIND_SCAN_ORDER: ProposalKind[] = ['cover', 'toc', 'content']

/**
 * 哨兵是否【至少一侧贴到行边界】：从它所在行的行首到 start 全是空白（前侧到行首），【或】
 * 从 start+len 到行尾全是空白（后侧到行尾）。满足任一即算真分隔符。
 *
 * 为什么要「至少一侧」而非「前后都独占整行」（本次根因修复）：
 *  - 排除内联引用（防幻影块，历史根因）：上下文压缩生成的「对话总结」会把哨兵当格式说明复述，
 *      正文须包在哨兵 `===方案正文开始===`/`===方案正文结束===` 内
 *    这类内联引用里，哨兵【两侧都被反引号/行文包住】——前侧不到行首、后侧不到行尾，两条都不成立，
 *    故仍被精准排除（旧「前后都独占」也能排它，本次放宽不削弱这道防线）。
 *  - 但旧「前后都独占」过严，误伤了【真哨兵紧贴一侧文字】的正常情形：AI 偶尔少打一个换行，写成
 *    `===方案封面结束===进入阶段二：目录…`（结束哨兵前是行首、后紧贴过渡语）或
 *    `…【目录大纲】===方案目录开始===`（起始哨兵前紧贴文字、后是换行）。旧判定认不出这两个真哨兵，
 *    把封面判成截断、把过渡语+后续目录哨兵原文+目录全吞进封面块 → 整篇塌成一节正文、预览里封面
 *    丢了整页布局、裸哨兵当正文显示（用户报的 bug）。真哨兵至少有一侧贴到行边界（前是行首或后是
 *    行尾），故「至少一侧」既救回这类真哨兵、又不放过两侧都被包住的内联引用。
 */
function isStandaloneSentinel(text: string, start: number, len: number): boolean {
  // 前侧到行首全空白？
  let leadingClear = true
  for (let p = start - 1; p >= 0 && text[p] !== '\n'; p--) {
    const ch = text[p]
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      leadingClear = false
      break
    }
  }
  if (leadingClear) return true
  // 后侧到行尾全空白？
  for (let q = start + len; q < text.length && text[q] !== '\n'; q++) {
    const ch = text[q]
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false
  }
  return true
}

/**
 * 从 from 起找下一个【独占整行】的 token 出现位置；跳过被行内其他字符（如反引号引用）包裹的。
 * 无独占行出现 → -1。供 extractProposalDraftResult 找真起始/结束哨兵共用。
 */
function indexOfStandaloneSentinel(text: string, token: string, from: number): number {
  let i = text.indexOf(token, from)
  while (i >= 0) {
    if (isStandaloneSentinel(text, i, token.length)) return i
    i = text.indexOf(token, i + token.length)
  }
  return -1
}

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
 *   - 其余【已知排版 HTML 标签】（白名单 HTML_TAG_NAMES：div/span/center/table/font/h1-6…）
 *     整体删除、只留可见文本。【刻意按白名单删，不删任意 `<字母…>`】：否则正文里的泛型
 *     `List<String>`、比较式 `当 A<B 且 C>D 时` 会被静默吞成 `List`、`当 A D 时`（评审发现）。
 *     白名单天然放过 markdown 自动链接 `<https://…>`（https 非标签名）。【单字母标签
 *     b/i/u/p/a/s/q 不列入】——它们与单字母变量名/泛型参数（`A<B…>`、`Map<K,V>`）无法靠形式
 *     区分，且 AI 几乎只用 markdown 语法（`**粗体**`）而非 `<b>`；宁可漏删一个可见标签，
 *     也绝不错删不可见的正文。
 *   - 清洗后把 3+ 连续换行压成 2 个（删标签可能留下成片空行），首尾 trim。
 */
// 已知排版 HTML 标签白名单（≥2 字母，故不与单字母变量/泛型参数冲突）。模块级一次编译，
// stripDraftHtml 高频调用复用；`.replace` 全局正则每次自重置 lastIndex，共享安全。
const HTML_TAG_NAMES = [
  'div', 'span', 'center', 'br', 'strong', 'em', 'ins', 'del', 'mark', 'small', 'big',
  'sub', 'sup', 'font', 'strike', 'hr', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table',
  'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup', 'img',
  'figure', 'figcaption', 'blockquote', 'pre', 'code', 'kbd', 'samp', 'var', 'abbr',
  'cite', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'details',
  'summary', 'wbr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
].join('|')
const HTML_TAG_RE = new RegExp(`</?(?:${HTML_TAG_NAMES})(?:\\s[^>]*)?/?>`, 'gi')

function stripDraftHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(HTML_TAG_RE, '')
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
    // 不再依赖外部 phase（根因修复，见文件头 PROPOSAL_DRAFT_BEGIN 注释）。只认【独占整行】
    // 的哨兵（indexOfStandaloneSentinel），排除被反引号内联引用的文档说明（幻影块根因，见
    // isStandaloneSentinel 注释）。
    let kind: ProposalKind | null = null
    let begin = -1
    for (const k of KIND_SCAN_ORDER) {
      const i = indexOfStandaloneSentinel(text, PROPOSAL_DRAFT_BEGIN[k], from)
      if (i >= 0 && (begin < 0 || i < begin)) {
        begin = i
        kind = k
      }
    }
    if (kind === null) break
    const contentStart = begin + PROPOSAL_DRAFT_BEGIN[kind].length
    // 结束哨兵同样必须独占整行：否则正文里内联引用一句 `===方案正文结束===` 会提前误闭合本块。
    const e = indexOfStandaloneSentinel(text, PROPOSAL_DRAFT_END[kind], contentStart)
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
 * 聊天气泡展示层的一段：`text`=普通对话文本（原样走 markdown），`draft`=一段被哨兵圈住、
 * 要写进右侧文档的草稿（渲成折叠卡片）。complete=false 表示流式进行中（只见起始哨兵、
 * 结束哨兵未到）。content 已 trim。
 */
export type ProposalChatSegment =
  | { type: 'text'; value: string }
  | { type: 'draft'; kind: ProposalKind; content: string; complete: boolean }

/**
 * 把一条 assistant 消息文本切成有序的 text / draft 段，供聊天气泡把哨兵块渲成「草稿写入」
 * 卡片（AssistantMarkdown）。纯展示，故【刻意宽松】：
 *
 * - 用裸 indexOf 找哨兵，【不要求独占整行】——这样哨兵与内容挤在同一行/同一列表项
 *   （`===方案正文开始=== 客户单位：… ===方案正文结束===`，用户截图里的真实形态）也能被
 *   识别成卡片。这与入库用的 extractProposalDraftResult【故意不同】：那个必须独占整行来精准
 *   排除被反引号内联引用的哨兵（幻影块根因），因为它决定落库内容、错判有数据后果；这里只
 *   决定怎么把文字画成卡片，多切一个卡片最多是显示噪声、无数据后果，宽松换来对真实输出的兼容。
 * - 只见起始哨兵、无同类结束哨兵 = 流式进行中：起始哨兵之后到结尾全部当卡片内容，complete:false。
 *
 * 空串 → []；完全无哨兵 → 单个 text 段（原文），调用侧据此走「零改动」的原渲染路径。
 * 纯空白的 text 段与空内容的闭合块被丢弃（不产出空 markdown / 空卡片）。
 */
export function splitProposalDraftSegments(text: string): ProposalChatSegment[] {
  const segments: ProposalChatSegment[] = []
  if (!text) return segments
  const pushText = (value: string): void => {
    if (value.trim()) segments.push({ type: 'text', value })
  }
  let from = 0
  for (;;) {
    // 位置最靠前的起始哨兵（任意 kind）——kind 由哨兵自身决定，与 extractProposalDraftResult 同源。
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
    pushText(text.slice(from, begin))
    const contentStart = begin + PROPOSAL_DRAFT_BEGIN[kind].length
    const e = text.indexOf(PROPOSAL_DRAFT_END[kind], contentStart)
    if (e < 0) {
      // 流式进行中：即便内容暂为空也产出卡片，用户即时看到「正在写入」。
      segments.push({ type: 'draft', kind, content: text.slice(contentStart).trim(), complete: false })
      return segments
    }
    const body = text.slice(contentStart, e).trim()
    if (body) segments.push({ type: 'draft', kind, content: body, complete: true })
    from = e + PROPOSAL_DRAFT_END[kind].length
  }
  pushText(text.slice(from))
  return segments
}

// 阶段有序权重：cover < toc < content。只此一处定义，门护栏与 store 推进同源。
const PROPOSAL_PHASE_ORDER: Record<ProposalKind, number> = { cover: 0, toc: 1, content: 2 }

/**
 * 阶段门谓词：判断某 kind 的草稿块在当前 phase 下是否「越过了用户确认门」。
 *
 * 三阶段里唯一【必须用户点按钮（confirmToc）】才能跨的门是 toc→content：正文必须基于
 * 用户确认过的目录来写。cover→toc 不是门——允许 AI 哨兵自动推进（用户在聊天里确认封面、
 * 让 AI 出目录是设计内的「聊天驱动阶段」，见 PROPOSAL_DRAFT_BEGIN 注释）。
 *
 * 故规则极简：content 块仅当 phase 已是 content（confirmToc 已显式推进过）才合法；
 * 在 cover/toc 阶段收到 content 块 = AI 自行跳过了目录门（本次根因：用户点「生成目录」后
 * AI 直接冒正文，appendSections 取 max 把 phase 一把顶到 content，目录确认按钮与目录回灌
 * 全被绕过）。cover/toc 块在任何阶段都不越界（封面可反复改、目录可回头改）。
 */
export function isDraftBlockAheadOfPhase(phase: ProposalKind, kind: ProposalKind): boolean {
  return kind === 'content' && phase !== 'content'
}

/**
 * 流式硬门探测（①·根因「目录阶段一直在思考」）：in-flight 文本里是否已出现【独占整行】的
 * 正文【起始】哨兵，且当前 phase 还没确认目录（cover/toc）。供渲染端在 chunk 流里逐段调用——
 * 一旦命中即 abort 本轮，趁 AI 刚要写正文就掐断，避免它在「跳过目录确认」后跑飞整篇正文
 * （那正是用户看到的长时间「在思考」）。
 *
 * 为什么只看【起始】哨兵而非等闭合：目的是【尽早】打断，等 content 块闭合就晚了（整章正文已生成）。
 * 为什么必须独占整行：复用 isStandaloneSentinel——排除 AI 在说明/引用里内联提到哨兵字样的误判
 * （与 extractProposalDraftResult 同源，见 isStandaloneSentinel 注释）。
 * 为什么 content 阶段恒返回 false：用户点「确认目录」时 applyProposalStageConfirm 已同步把 phase
 * 推到 content（早于 AI 吐正文），故此后正文哨兵是合法产出，绝不能误伤——这也让本探测在最昂贵的
 * 正文阶段直接短路、不扫长文本。
 */
export function detectContentSentinelAheadOfPhase(text: string, phase: ProposalKind): boolean {
  if (phase === 'content' || !text) return false
  return indexOfStandaloneSentinel(text, PROPOSAL_DRAFT_BEGIN.content, 0) >= 0
}

/** 取两阶段里更靠后的（cover<toc<content）。阶段「绝不回退」语义的单一实现。 */
export function laterPhase(a: ProposalKind, b: ProposalKind): ProposalKind {
  return PROPOSAL_PHASE_ORDER[b] > PROPOSAL_PHASE_ORDER[a] ? b : a
}

/**
 * 稳定按阶段序（cover<toc<content）排序节，维持「同 kind 连续、每 kind 至多一组」不变量。
 *
 * appendSections 是纯追加，而块的 kind 取自哨兵、不保证连续：用户在【正文阶段】让 AI「重写
 * 封面」时，AI 发的 cover 块不被阶段门拦（封面可反复改），追加后 sections 变成
 * [cover, toc, content…, cover]——kind 非连续。下游全都假设它连续：buildProposalMarkdown 会
 * 在尾部 cover 再插一个区段标记 → 两个封面 Word 分节；ProposalPaper 渲两个「封面」组头；
 * moveSection 的「同 kind 相邻交换」也失效（评审发现）。故 append/restore 后统一过此函数把
 * 散落的 kind 归并回各自区段。
 *
 * 用稳定排序（Array.prototype.sort 在现代引擎稳定）：同 kind 内的既有相对顺序——包括用户经
 * moveSection 做的调整、以及逐章正文的先后——一律保持不变，只把跨区的「迟到块」移回其区段。
 * 返回新数组，不原地改入参。main 与 renderer 共享纯函数。
 */
export function sortSectionsByKind<T extends { kind: ProposalKind }>(sections: T[]): T[] {
  return [...sections].sort((a, b) => PROPOSAL_PHASE_ORDER[a.kind] - PROPOSAL_PHASE_ORDER[b.kind])
}

/**
 * 折叠单例 kind（封面/目录）的重复节：每个单例 kind 只保留【最后一份】，丢弃更早的；正文（多节）
 * 全保留、相对顺序不变。返回新数组，不原地改入参。main 与 renderer 共享纯函数。
 *
 * 为什么需要（本次根因修复的第二层）：appendDraftBlocks 的单例替换只管【实时 append/sync】路径。
 * 但「重开历史方案会话」是另一条路——它从会话 transcript（或盘上草稿）重建 sections，绕过
 * appendDraftBlocks 把每条 assistant 消息抽出的每个块直接堆进数组。用户曾在「调整封面」对话里让
 * AI 重发过修订版封面，transcript 于是同时留着原版+修订版两个封面块 → 重建出两份封面（实时路径
 * 已修、重建路径会复发）。故 restore 路径统一过本函数，把历史重复折叠成「最后一份胜出」（transcript
 * 按时间顺序，最后一个封面/目录即用户最终敲定的修订版）。也顺带清掉旧版本遗留的脏草稿。
 */
export function collapseSingletonSections<T extends { kind: ProposalKind }>(sections: T[]): T[] {
  // 单例 kind 的「最后一份」下标：正向遍历不断覆盖，遍历完即指向各 kind 最后一次出现。
  const lastIndexOfKind = new Map<ProposalKind, number>()
  sections.forEach((sec, i) => {
    if (SINGLETON_KINDS.has(sec.kind)) lastIndexOfKind.set(sec.kind, i)
  })
  // 保留：非单例（content 全留）+ 单例里恰是「最后一份」的那个。其余单例旧版本剔除。
  return sections.filter(
    (sec, i) => !SINGLETON_KINDS.has(sec.kind) || lastIndexOfKind.get(sec.kind) === i
  )
}

/** gateDraftBlocksByPhase 的结果：放行的块、被拦的越界块、过门后应推进到的 phase。 */
export interface ProposalGateResult {
  /** 允许入区的块（保持原顺序）。 */
  accepted: ProposalDraftBlock[]
  /** 越过未确认目录门被拦下的 content 块——不入文档，交调用侧提示用户先生成确认目录。 */
  skippedAhead: ProposalDraftBlock[]
  /**
   * 接受块后 phase 应推进到的目标：在 accepted 块的 kind 上取 max，绝不回退，也绝不自动
   * 跨 toc→content（越界 content 块已被剔出 accepted，故不会把 phase 顶过门）。
   * 注意以【入参 phase】（用户当前确认到的阶段）判越界，而非边遍历边推进——否则同一条
   * 消息里 toc 块先把游标推到 toc、其后的 content 块就会被误放行（混排攻击面）。
   */
  nextPhase: ProposalKind
}

/**
 * 阶段门护栏：按当前 phase 过滤 AI 一轮产出的草稿块，剔除越过「目录确认门」的正文块，
 * 并算出绝不跨门的 nextPhase。main 与 renderer 共享的纯函数（store.appendSections 调用）。
 */
export function gateDraftBlocksByPhase(
  phase: ProposalKind,
  blocks: ProposalDraftBlock[]
): ProposalGateResult {
  const accepted: ProposalDraftBlock[] = []
  const skippedAhead: ProposalDraftBlock[] = []
  let nextPhase = phase
  for (const b of blocks) {
    if (isDraftBlockAheadOfPhase(phase, b.kind)) {
      skippedAhead.push(b)
      continue
    }
    accepted.push(b)
    if (PROPOSAL_PHASE_ORDER[b.kind] > PROPOSAL_PHASE_ORDER[nextPhase]) nextPhase = b.kind
  }
  return { accepted, skippedAhead, nextPhase }
}

/** appendDraftBlocks 的状态切片：草稿入库只依赖这三个字段（其余 store 字段与本逻辑无关）。 */
export interface DraftAppendState<T extends ProposalDraftBlock> {
  sections: T[]
  phase: ProposalKind
  stageSkip: { count: number } | null
}

/**
 * 单例 kind：全篇至多一节。封面、目录天然唯一（一份方案只有一个封面、一个目录）；正文是多节
 * （逐章追加）。这个区分是「封面/目录修订要替换、正文要追加」的单一真相源（appendDraftBlocks 用）。
 *
 * 为什么需要它（本次根因修复）：用户在「确认封面/目录吗？要调整吗？」对话里点「调整」后，AI 会
 * 重发一份【修订版】封面/目录哨兵块。它与旧块内容不同 → 躲过 appendDraftBlocks 的逐字内容级去重
 * → 旧逻辑把它当【新节追加】，于是右侧草稿出现两份封面/目录（用户报「复制一整块、原处不变」的
 * bug，见截图）。把封面/目录标为单例后，新块【整节替换】同 kind 旧节，修订就地生效、不再堆叠。
 */
export const SINGLETON_KINDS: ReadonlySet<ProposalKind> = new Set<ProposalKind>(['cover', 'toc'])

/**
 * 纯函数：把一批闭合草稿块（blocks）+ 可选截断残块（truncated）追加进当前草稿，返回新的
 * sections/phase/stageSkip。store 的两个入口共用它，差别只在 messageId 记账：
 *   - appendSections（轮末 'end' 触发）：额外按 messageId 去重 + 记账。
 *   - syncSections（轮内 AskUserQuestion 暂停时触发）：增量同步，不碰 messageId。
 *
 * 为什么轮内也要同步：AI 在一个 SDK 轮里生成封面/目录后用 AskUserQuestion 暂停确认，而
 * AskUserQuestion 经 canUseTool 内联应答、【不结束 SDK 轮】，该轮的 'end' 要等模型彻底停下
 * 才到——期间右侧草稿一直空（「对话说生成封面了、右侧还是空的」的根因）。故在每次
 * AskUserQuestion 暂停时调本逻辑即时入库。
 *
 * 去重靠「同 kind 且 markdown 逐字相同」（dupKey）：messageId 去重只在单次运行内有效，且
 * 轮内同步会对同一 messageId 多次调用——内容级去重才是真正的幂等防线（方案正文两节逐字
 * 一致几乎不可能是有意产出，可安全当作重放/重复同步丢弃）。NUL 连接 kind 与 markdown，
 * 正文不含 NUL，绝不会把不同内容误判同一。
 *
 * 截断残块只在轮末传入（轮内同步传 null）：半截内容会在后续流里闭合、轮末再正式入库；
 * 若轮内就把半截当节加进去，闭合后的完整块 markdown 不同、内容级去重拦不住，会重复成两节。
 *
 * makeSection 由调用方注入（生成 id、设 baselineMarkdown）——shared 不依赖 crypto.randomUUID：
 * 渲染层注入 crypto.randomUUID，单测注入确定性计数器。main 与 renderer 共享纯函数。
 */
export function appendDraftBlocks<T extends ProposalDraftBlock>(
  state: DraftAppendState<T>,
  blocks: ProposalDraftBlock[],
  truncated: ProposalDraftBlock | null,
  makeSection: (block: ProposalDraftBlock, opts: { truncated?: boolean }) => T
): DraftAppendState<T> {
  // 阶段门护栏：剔除越过「目录确认门」（唯一被 gate 的转换 toc→content）的正文块。
  const gate = gateDraftBlocksByPhase(state.phase, blocks)
  let skipped = gate.skippedAhead.length
  const dupKey = (kind: ProposalKind, markdown: string): string => `${kind}\u0000${markdown}`
  const existingKeys = new Set(state.sections.map((sec) => dupKey(sec.kind, sec.markdown)))

  // 收集本轮要真正入库的块（已闭合块 + 轮末截断残块），统一过「内容级去重 + 阶段门」。
  // truncated 标记透传给 makeSection 以打「疑似截断」徽标。
  const incoming: Array<{ block: ProposalDraftBlock; truncated: boolean }> = []
  for (const b of gate.accepted) {
    if (!existingKeys.has(dupKey(b.kind, b.markdown))) incoming.push({ block: b, truncated: false })
  }
  // phase 取 gate 算出的「绝不跨门」目标；再叠上被接受的截断残块（laterPhase 不回退）。
  let phase = gate.nextPhase
  if (truncated && !existingKeys.has(dupKey(truncated.kind, truncated.markdown))) {
    if (isDraftBlockAheadOfPhase(state.phase, truncated.kind)) {
      // 截断的越界正文（AI 在目录阶段写了未闭合的正文哨兵）同样被门拦下、记入 skipped。
      skipped += 1
    } else {
      incoming.push({ block: truncated, truncated: true })
      phase = laterPhase(phase, truncated.kind)
    }
  }

  // 单例 kind（封面/目录）替换：本批确有「内容不同」的新封面/目录块时，移除同 kind 旧节、由新块
  // 取代——修订就地生效，不再把修订版当新节追加（重复封面/目录的根因，见 SINGLETON_KINDS 注释）。
  // 仅当 incoming 里确有该 kind 的新块才替换：完全相同的块已被上面的逐字去重过滤掉、不进 incoming，
  // 故纯重复同步绝不会误删既有节（幂等不变量保持）。同批若混入多个同 kind 单例块（理论少见，如 AI
  // 一轮里改了两版封面），只保留最后一个，避免又生成两节。
  const replacedKinds = new Set<ProposalKind>()
  for (const it of incoming) if (SINGLETON_KINDS.has(it.block.kind)) replacedKinds.add(it.block.kind)
  const deduped: Array<{ block: ProposalDraftBlock; truncated: boolean }> = []
  for (const it of incoming) {
    if (SINGLETON_KINDS.has(it.block.kind)) {
      const prev = deduped.findIndex((x) => x.block.kind === it.block.kind)
      if (prev >= 0) deduped.splice(prev, 1)
    }
    deduped.push(it)
  }

  const added: T[] = deduped.map((it) =>
    makeSection(it.block, it.truncated ? { truncated: true } : {})
  )
  // 被替换 kind 的旧节先剔出；其余旧节保留。content 永不在 replacedKinds 里 → 多节正文原样保留。
  const kept = state.sections.filter((sec) => !replacedKinds.has(sec.kind))
  return {
    // sortSectionsByKind：把（替换后的）新块按阶段序归并回各自区段，维持「同 kind 连续」不变量。
    sections: sortSectionsByKind([...kept, ...added]),
    phase,
    // 本轮有越界块被拦才更新提示；否则保留既有 stageSkip（不被无关轮次悄悄清掉）。
    stageSkip: skipped > 0 ? { count: skipped } : state.stageSkip
  }
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

// ───────────────────────── 引用落地校验（#1） ─────────────────────────
//
// 正文每段末尾按提示词规则 3 标 `（据《文件名》）`，但这标注是 AI 写完才贴的、无人验真。
// 客户级方案里一处编造即灾难。下面这套把「段落正文」与它所引「镜像原文」做 trigram 重叠
// 核对：忠实搬运 → 高重叠（supported）；编造/过度改写 → 低重叠（unsupported）。
// 纯函数（parseCitations / trigramOverlap）放 shared 供 main 核对与单测共用；真正读镜像
// 文件的 verifyCitations 在 main（proposalVerify.ts），renderer 经 IPC 取结果。

/**
 * 保留来源名（P3-2 阶段二·补料）：用户为「资料缺失」缺口补充的外部资料，AI 据它写的内容
 * 标 `（据《用户补充资料》）`。校验侧（verifyCitationsCore）识别这个保留名，给出独立的
 * `user-supplied` 判定——既不当编造红灯（它是用户授权注入的真实资料），也不静默绕过校验
 * （仍计入引用、在 UI 中明示「非知识库、请自行确认」），溯源透明。与真实 KB 文件 title 撞名
 * 的概率可忽略且无害。main 与 renderer 同源，写进补料指令与校验分支。
 */
export const USER_SUPPLIED_SOURCE = '用户补充资料'

/**
 * 一条引用的核对结论。`file` 是《》里的文件 title（= KB 索引的 title）。
 * - `supported`：段落正文与所引文件原文的字符 trigram 重叠率 ≥ 阈值。
 * - `unsupported`：重叠率低于阈值（疑似编造或过度改写）。
 * - `file-not-found`：该 title 不在 KB 索引（ok 文件）里，或镜像文件读不到。
 * - `user-supplied`：引用的是 {@link USER_SUPPLIED_SOURCE}（用户补料）——非 KB、无从 trigram
 *   核对，但属用户授权的真实资料；UI 标中性提示，不计编造/引错。
 */
export interface CitationVerdict {
  file: string
  status: 'supported' | 'unsupported' | 'file-not-found' | 'user-supplied'
  /** trigram 重叠率，supported/unsupported 时有；file-not-found / user-supplied 时无。 */
  overlap?: number
}

/**
 * 一张图的接地核对结论。`path` 是 markdown `![alt](path)` 里的图路径。
 * - `grounded`：该图属于本节已 `（据《X》）` 引用过文件的 assets（图与文同源）。
 * - `ungrounded`：不属任何本节所引文件的 assets（疑似挪用/编造，UI 标红但保留）。
 */
export interface ImageVerdict {
  path: string
  status: 'grounded' | 'ungrounded'
}

/**
 * 一节正文的引用核对汇总。`degraded=true` 表示校验整体失败（索引缺失 / 异常降级），
 * UI 应显示「未校验」灰标而非红/绿结论——绝不能把降级误判成「无编造」。
 */
export interface SectionVerification {
  verdicts: CitationVerdict[]
  /** 段内去重后引用的文件数（覆盖度）；content 段为 0 = 未引用任何来源。 */
  citedFileCount: number
  degraded?: boolean
  /** 本节图片接地核对结论（无图时省略）。grounded=图属本节所引文件的 assets；ungrounded=不属。 */
  imageVerdicts?: ImageVerdict[]
}

/** 一段正文 + 它末尾引用的文件名集合（解析自 `（据《X》《Y》）`）。 */
export interface ParsedCitationParagraph {
  paragraph: string
  files: string[]
}

// 引用组：中文括号「（据…）」，组内可含多个《》。组前面紧邻的正文是被它支持的段落。
// 用 indexOf 不够（要捕获组内文件名），用正则；`（` `）` `《` `》` 非正则元字符，安全。
const CITATION_GROUP_RE = /（据([^）]*)）/g
const CITATION_FILE_RE = /《([^》]+)》/g

/**
 * 解析正文里的引用：以每个「（据…）」引用组为锚，引用归属于它前面紧邻的正文片段
 * （到上一个引用组结束或文本开头）。返回每段正文及其引用的文件名集合（去重、保序）。
 * 引用组内无《》或正文为空仍计入（files 可空时跳过该组）。无引用组 → []。
 * main 与 renderer 共享的纯函数。
 */
export function parseCitations(markdown: string): ParsedCitationParagraph[] {
  if (!markdown) return []
  const out: ParsedCitationParagraph[] = []
  let lastEnd = 0
  CITATION_GROUP_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CITATION_GROUP_RE.exec(markdown)) !== null) {
    const paragraph = markdown.slice(lastEnd, m.index).trim()
    const files: string[] = []
    CITATION_FILE_RE.lastIndex = 0
    let fm: RegExpExecArray | null
    while ((fm = CITATION_FILE_RE.exec(m[1])) !== null) {
      const name = fm[1].trim()
      if (name && !files.includes(name)) files.push(name)
    }
    if (files.length) out.push({ paragraph, files })
    lastEnd = m.index + m[0].length
  }
  return out
}

// 来源标注剥除：把段末的「（据《X》）」引用组整段删掉（含多个《》、连续多组）。
// 设计取舍：来源是给作者「逐句溯源」的工作态标注，编辑态保留并上色（见 AssistantMarkdown
// 的 highlightCitations），但导出的交付文件（docx/PDF/md）与真预览都不应出现——客户看到的
// 是干净成品。故清洗只发生在导出/预览的 markdown 上，编辑态那份 sec.markdown 不动。
// - 用独立正则字面量（非共享的 CITATION_GROUP_RE），避免和 parseCitations 的 lastIndex 状态耦合。
// - 顺带吃掉引用组前的 ASCII 空格/制表（`正文 （据…）` → `正文`），中文正文一般无此空格，安全兜底。
// main 与 renderer 共享的纯函数。
export function stripCitations(markdown: string): string {
  if (!markdown) return markdown
  return markdown.replace(/[ \t]*（据[^）]*）/g, '')
}

// markdown 图片：`![alt](path)`。path 取到首个 `)` 前——KB 图为 img-N.png 类路径、不含 `)`。
// 要求前置 `!`，故普通链接 `[text](url)` 不会被误抽（无 `!`）。alt 可空。
// 目标可能被尖括号包裹（`![alt](<path>)`，见 normalizeImageMarkdown）：捕获后由 stripAngle 剥掉，
// 让接地比对（proposalVerify 的 allowed.has(path)）拿到的仍是干净绝对路径，无论 <> 来自 AI 还是兜底。
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

// markdown 图片的可选 title：url 后【空白分隔】的 `"..."` / `'...'`（`![alt](url "title")`）。解析
// path 时剥掉它，否则 path 夹带 ` "title"`、与 KB asset 绝对路径精确比较必不等，合法配图被误判
// ungrounded（评审发现）。要求 title 前有空白，故路径【自身含空格但无 title】（userData 路径可能
// 含空格）不会被误剥——其结尾不是引号、不匹配。
const IMAGE_TITLE_SUFFIX_RE = /\s+(?:"[^"]*"|'[^']*')\s*$/

/**
 * 抽取正文里的所有图片：返回 {alt, path} 数组（保序）。无图 → []。
 * 与 parseCitations 解析的 `（据…）` 引用组互不干扰（语法不同）。main 与 renderer 共享纯函数。
 */
export function parseImages(markdown: string): { alt: string; path: string }[] {
  if (!markdown) return []
  const out: { alt: string; path: string }[] = []
  IMAGE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMAGE_RE.exec(markdown)) !== null) {
    const path = stripAngleWrap(m[2].trim().replace(IMAGE_TITLE_SUFFIX_RE, '').trim())
    out.push({ alt: m[1].trim(), path })
  }
  return out
}

// `<path>` → `path`。仅在首尾成对时剥；含空格的 userData 绝对路径被 <> 包裹后，接地比对与 img.url
// 需拿到不带尖括号的原始路径（remark 解析 <目标> 同样会剥括号，故两侧一致）。
function stripAngleWrap(s: string): string {
  return s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1).trim() : s
}

/**
 * 归一化图片语法：把「目标含空格、且未用尖括号包裹」的 `![alt](路径)` 补成 `![alt](<路径>)`。
 *
 * 为什么必须有：CommonMark 规定裸目标（无 `<>`）【不许含空格】，否则整条 `![]()` 不被解析成图片、
 * 退化成纯文本——既不显示、也进不了 docx 的 image 节点（预览与导出一起丢图）。KB 镜像图是 userData
 * 绝对路径，macOS 上必然含「Application Support」空格 → 必然触发。提示词已要求 AI 直接写 `<>`，这里
 * 是【兜底】：历史草稿 / transcript 里的裸路径、以及 AI 偶发不听话，都在走 mdast 解析的各消费端入口
 * （预览 AssistantMarkdown、导出 docx、写 .md）统一补 `<>`。
 *
 * 与 stripCitations 同为 presentation-time 纯转换：只作用于「送去解析 / 交付」的那份，绝不改编辑态
 * 存储的 sec.markdown 真相。幂等——已 `<>` 包裹（正则首字符排除 `<`）、或目标不含空格的原样不动。
 * remark 解析 `<目标>` 时会剥掉尖括号，故 img.url / `<img src>` 拿到的仍是干净路径，kbasset:// 与
 * docx fs 读盘均不受影响。main 与 renderer 共享纯函数。
 */
const IMAGE_UNWRAPPED_RE = /(!\[[^\]]*\]\()([^<)][^)]*)(\))/g

export function normalizeImageMarkdown(markdown: string): string {
  if (!markdown) return markdown
  return markdown.replace(IMAGE_UNWRAPPED_RE, (whole, head: string, inner: string, tail: string) => {
    // inner = 目标 + 可选 title（url 后空白分隔的 "..."/'...'）。拆出 title，只包 url 部分。
    const titleMatch = inner.match(IMAGE_TITLE_SUFFIX_RE)
    const title = titleMatch ? titleMatch[0] : ''
    const dest = title ? inner.slice(0, inner.length - title.length) : inner
    // 目标不含空格 → CommonMark 能解析，不必包裹（最小改动、不动无辜图）。
    if (!/\s/.test(dest)) return whole
    return `${head}<${dest}>${title}${tail}`
  })
}

// ───────────────────────── 资料缺失标记（P3-2） ─────────────────────────
//
// 「只用知识库、绝不臆造」（proposalPrompt 规则 2）的产物：AI 写正文时遇到知识库查不到的
// 内容，不编造、也不跳过，而是在【缺料的那一行】单独成行写 `⚠️ 资料缺失：<缺什么>`。
//
// 关键变化（相对旧版）：这条标记【就留在正文哨兵块内】，不再像旧版那样甩在对话里飘走——
// 这样它① 天然锚定到所在章节（含它的那一节 section），② 随草稿持久化/重建，③ 在预览与
// 导出里原样可见，提醒「这里有个洞、待补」。renderer 据此把全篇缺口聚合成一张清单
// （P3-2 阶段一·让缺失可见），后续「补料 → 定点续写」（阶段二）也以这条标记为锚定位。
//
// 解析容忍 AI 的措辞抖动：⚠ 警告符后可带/不带变体选择符 ️、可有/无空格，「资料缺失」
// 后全角「：」或半角「:」皆可，描述取冒号后到行尾。要求 ⚠ 前缀是安全阀——绝不让正文里
// 讨论「资料缺失」的普通行（如目录里某章叫「资料缺失分析」）被误当成缺口标记。
// 行首容忍前导空白与常见列表/引用符（AI 偶尔把它写成 `- ⚠️…` 或 `> ⚠️…`）。

/** 资料缺失标记的可见前缀（写进提示词，main 与 renderer 同源，避免两端措辞漂移）。 */
export const PROPOSAL_GAP_PREFIX = '⚠️ 资料缺失：'

// 整行匹配：行首可选列表/引用符 + 警告符（变体选择符可选）+ 「资料缺失」 + 冒号 + 描述。
const GAP_RE = /^[ \t]*(?:[-*>]\s*)?⚠️?\s*资料缺失\s*[:：]\s*(.+?)\s*$/gm

/**
 * 抽取一段正文里的所有「资料缺失」缺口描述（冒号后的文本，保序）。无缺口 → []。
 * 与 parseCitations / parseImages 互不干扰（语法各异）。main 与 renderer 共享纯函数。
 * 同一节内重复的缺口不去重——AI 可能在一章里标多处缺料，每处都该单独列出供用户补。
 */
export function parseGaps(markdown: string): string[] {
  if (!markdown) return []
  const out: string[] = []
  GAP_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = GAP_RE.exec(markdown)) !== null) {
    const desc = m[1].trim()
    if (desc) out.push(desc)
  }
  return out
}

/**
 * 可原生嵌入 docx 的位图扩展名。docx 的 `ImageRun.type` 仅支持 jpg/png/gif/bmp；webp/svg
 * 无法原生嵌入（svg 需另走 fallback API，本版不做）。bmp 虽被 docx 支持，但 proposalDocx 的
 * IMG_TYPE 暂不映射它，故这里也【不】收 bmp——保持「可嵌集合 ⊆ IMG_TYPE 可映射集合」，绝不
 * 让预览放行一张导出仍会降级的图。
 */
export const EMBEDDABLE_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif'] as const

/**
 * 这张图能否进 Word（决定预览与导出是否真正显示它）。导出侧（proposalDocx.imageParagraphs）
 * 与预览侧（AssistantMarkdown 的 KB 图 `<img>`）共用此谓词：不可嵌的图两侧都降级为文字占位，
 * 杜绝「预览有图、成品 Word 没图」的静默丢失——这是「预览=导出一致」不变量在图片上的落点。
 * 无扩展名（lastIndexOf('.') 为 -1）→ false，顺带堵掉无后缀名的越界路径。main 与 renderer 共享。
 */
export function isEmbeddableImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return (EMBEDDABLE_IMAGE_EXTS as readonly string[]).includes(path.slice(dot).toLowerCase())
}

/**
 * a 的字符 trigram 集合被 b 覆盖的比例（|A∩B| / |A|）。中文按字符 3-gram，忽略空白。
 * a 规整后不足 3 字时退化为「a 是否为 b 的子串」（1 或 0）。任一空串 → 0。
 *
 * 用于「这段正文是否真出自所引原文」：忠实搬运 → 高重叠；编造 → 低重叠。方向性是有意的
 * （只问 a 的 gram 有多少在 b 里，不对称）：原文 b 通常远长于段落 a，用 |A| 作分母才不会
 * 被 b 的长度稀释。
 */
export function trigramOverlap(a: string, b: string): number {
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return 0
  if (na.length < 3) return nb.includes(na) ? 1 : 0
  const gramsOf = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3))
    return set
  }
  const A = gramsOf(na)
  const B = gramsOf(nb)
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / A.size
}

// ── M-0 埋点：可交付率代理 + 引用准确度（backlog docs/.../2026-06-26-proposal-optimization-backlog.md）──
//
// 北极星=「方案可直接交付率」。当前优先级是假设驱动的，没有真实数据。M-0 在【每次导出】落
// 一条本地记录（不外传），让后续 backlog 重排有数可依。两个核心数：
//   ① 可交付率代理：从 AI 生成到导出之间，用户对正文净改了多少字（改得越多 → 越不能直接交付）。
//   ② 引用准确度：复用 P0-1 已落地的 verification（supported/unsupported/file-not-found 三态），
//      在导出这一刻把当前各章的引用核对结论快照下来，算编造率（unsupported）/引错率（file-not-found）。
// 纯函数放 shared 供 renderer 打点与单测共用；真正写盘（appendFile 到 jsonl）在 main（proposalMetricsStore）。

/**
 * 埋点要读的最小 section 结构（与 renderer 的 ProposalSection 结构兼容，但不依赖其类型）。
 * - `baselineMarkdown`：该节【AI 生成时的原文】。appendSections/restore 时设，updateSection 不动它，
 *   故它与 `markdown` 的差就是用户编辑量。缺省（理论不该发生）时退化为「无编辑」。
 * - `verification`：P0-1 引用核对结论；undefined=导出时尚未校验完，degraded=校验降级（都不计入准确度分母）。
 */
export interface ProposalMetricSection {
  markdown: string
  baselineMarkdown?: string
  kind: ProposalKind
  verification?: SectionVerification
}

/**
 * 一条导出埋点记录（v1）。append 一行到 userData/proposal-metrics.jsonl。
 * 刻意只存聚合数，不存正文片段——埋点是统计信号，不该把客户方案内容沉到这层。
 */
export interface ProposalMetricRecord {
  version: 1
  /** 落点时间戳（renderer 侧 Date.now()）。 */
  ts: number
  sessionId: string
  /** 触发本记录的导出格式。与 ipc-channels 的 ProposalExportFormat 同源，内联避免 shared 内循环依赖。 */
  format: 'md' | 'docx'
  /** 草稿总节数。 */
  sectionCount: number
  /** 各 kind 段落数（封面/目录/正文）。 */
  kindCounts: Record<ProposalKind, number>
  /**
   * 可交付率代理。net=Σ|len(当前)−len(生成原文)| 跨所有节的字符净长度变化（廉价代理，非编辑距离：
   * 等长替换记 0、来回改回原样记 0——契合「交付前到底改了多少」而非「改了几次」）。
   * 比例 net/generated 越高 → AI 初稿离可直接交付越远。
   */
  deliverability: {
    generatedChars: number
    finalChars: number
    netEditedChars: number
  }
  /**
   * 引用准确度快照（仅统计 content 节）。degraded/未校验节排除出 totals 分母——绝不把「没校验」
   * 误算成「无编造」。编造率=unsupported/totalCitations；引错率=fileNotFound/totalCitations。
   */
  citation: {
    /** 参与统计的 content 节数（有 verification 且非 degraded）。 */
    verifiedSections: number
    /** 校验降级、未计入的 content 节数。 */
    degradedSections: number
    /** 导出时 verification 仍 undefined（校验未跑完）的 content 节数。 */
    unverifiedSections: number
    /** verifiedSections 中 citedFileCount===0（一处来源都没引）的节数——覆盖度红灯。 */
    zeroCitationSections: number
    /** 所有 verdict 条数（同一文件跨段多次引用计多条）。 */
    totalCitations: number
    supported: number
    /** 疑似编造/过度改写（重叠率低于阈值）。 */
    unsupported: number
    /** 引错文件名 / 镜像读不到。 */
    fileNotFound: number
    /** 引用《用户补充资料》（P3-2 补料）的条数——非 KB、不计编造/引错，单列以观察补料用量。 */
    userSupplied: number
  }
}

/**
 * 由当前草稿 sections 组装一条导出埋点记录（纯函数，无 IO）。renderer 在导出成功后调用，
 * 把结果经 IPC 交给 main 写盘。
 */
export function buildProposalMetric(
  sections: ProposalMetricSection[],
  meta: { ts: number; sessionId: string; format: 'md' | 'docx' }
): ProposalMetricRecord {
  const kindCounts: Record<ProposalKind, number> = { cover: 0, toc: 0, content: 0 }
  let generatedChars = 0
  let finalChars = 0
  let netEditedChars = 0
  const citation = {
    verifiedSections: 0,
    degradedSections: 0,
    unverifiedSections: 0,
    zeroCitationSections: 0,
    totalCitations: 0,
    supported: 0,
    unsupported: 0,
    fileNotFound: 0,
    userSupplied: 0
  }

  for (const sec of sections) {
    kindCounts[sec.kind] += 1
    const baseline = sec.baselineMarkdown ?? sec.markdown
    generatedChars += baseline.length
    finalChars += sec.markdown.length
    netEditedChars += Math.abs(sec.markdown.length - baseline.length)

    // 引用准确度只对正文有意义（封面/目录不标来源）。
    if (sec.kind !== 'content') continue
    if (!sec.verification) {
      citation.unverifiedSections += 1
      continue
    }
    if (sec.verification.degraded) {
      citation.degradedSections += 1
      continue
    }
    citation.verifiedSections += 1
    if (sec.verification.citedFileCount === 0) citation.zeroCitationSections += 1
    for (const v of sec.verification.verdicts) {
      citation.totalCitations += 1
      if (v.status === 'supported') citation.supported += 1
      else if (v.status === 'unsupported') citation.unsupported += 1
      else if (v.status === 'user-supplied') citation.userSupplied += 1
      else citation.fileNotFound += 1
    }
  }

  return {
    version: 1,
    ts: meta.ts,
    sessionId: meta.sessionId,
    format: meta.format,
    sectionCount: sections.length,
    kindCounts,
    deliverability: { generatedChars, finalChars, netEditedChars },
    citation
  }
}
