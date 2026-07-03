// genimage 指令块（配图密度增强 ③）：AI 在正文里输出的「请应用调生图模型出一张彩图」占位指令。
// 形如：
//   ```genimage
//   图说: 系统总体架构图
//   <构图描述，组件/分层必须来自知识库事实>
//   ```
// AI 只负责留指令；真正的生图由 renderer 在落节时机自动调 PROPOSAL_IMAGE_GENERATE IPC，产出
// 走图片审阅卡（imageReviews），用户点「应用」才用 `![图说](路径)` 原地替换指令块。
//
// 为什么用围栏代码块而不是自造行内语法：① splitBlocks 对围栏有现成的整块消费逻辑（内部空行
// 不切、天然独立成块）；② react-markdown 解析围栏为 code 节点，渲染侧按 lang 精确拦截；③ 吸取
// 「幻影哨兵」教训——反引号内联引用的伪指令不会被当成真指令（识别以【块】为单位，不裸扫全文）。
//
// 手术函数按【指令块原文 trim 相等】匹配而非 blockIndex：审阅悬而未决期间该节可能被并发编辑、
// 块序漂移，内容键比下标键稳（同 applyImageReplacementWithDrift 的取舍，但这里内容自带唯一性，
// 无需歧义守卫——同内容多块由 occurrence 区分）。

import { splitBlocks } from './proposalBlocks'

export const GENIMAGE_LANG = 'genimage'

// 开围栏字面量（```genimage）：includes 快路径与正则都从 GENIMAGE_LANG 拼出来——常量改名时
// 不会留下与正则静默失配的硬编码副本。
const GENIMAGE_FENCE_OPEN = '```' + GENIMAGE_LANG

// 块级识别：整块必须以 ```genimage 围栏开头、以 ``` 收尾（splitBlocks 产出的块已 trim 首尾空行）。
const GENIMAGE_BLOCK_RE = new RegExp(`^${GENIMAGE_FENCE_OPEN}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?\`\`\`$`)

export function isGenImageDirectiveBlock(blockText: string): boolean {
  return GENIMAGE_BLOCK_RE.test(blockText.trim())
}

export interface GenImageDirectiveContent {
  /** 图说：落位后作 `![图说](路径)` 的 alt 文字，也是卡片上显示的图名。 */
  caption: string
  /** 构图描述：交给生图模型的正文（不含图说行）。 */
  prompt: string
}

/** 解析单个指令块。非指令块或内容为空（没法生图）→ null。 */
export function parseGenImageBlock(blockText: string): GenImageDirectiveContent | null {
  const m = GENIMAGE_BLOCK_RE.exec(blockText.trim())
  if (!m) return null
  const inner = m[1].trim()
  if (!inner) return null
  const lines = inner.split('\n')
  // 图说行：首行「图说: xxx」（冒号全半角都认——AI 中文语境常打全角）。缺省 caption 用「配图」。
  const cap = /^图说[:：]\s*(.+)$/.exec(lines[0].trim())
  if (cap) {
    const prompt = lines.slice(1).join('\n').trim()
    return { caption: cap[1].trim(), prompt: prompt || cap[1].trim() }
  }
  return { caption: '配图', prompt: inner }
}

export interface GenImageDirective extends GenImageDirectiveContent {
  /** splitBlocks 下标（发起时刻的快照，仅用于审阅卡锚定渲染位置）。 */
  blockIndex: number
  /** 同内容指令块的出现序（0 起）——手术定位用的稳定键之二。 */
  occurrence: number
  /** 指令块原文（trim 后整块）——手术定位用的稳定键之一。 */
  raw: string
}

/** 抽取一节 markdown 里的全部指令块（按块扫描，绝不裸扫全文）。 */
export function parseGenImageDirectives(markdown: string): GenImageDirective[] {
  if (!markdown || !markdown.includes(GENIMAGE_FENCE_OPEN)) return []
  const blocks = splitBlocks(markdown)
  const out: GenImageDirective[] = []
  const seen = new Map<string, number>()
  blocks.forEach((blk, i) => {
    const content = parseGenImageBlock(blk)
    if (!content) return
    const raw = blk.trim()
    const occurrence = seen.get(raw) ?? 0
    seen.set(raw, occurrence + 1)
    out.push({ ...content, blockIndex: i, occurrence, raw })
  })
  return out
}

// 导出剥除：逐行扫描而非全文正则。全文非贪婪正则对畸形输入是破坏性的——未闭合的 genimage
// 围栏（流式截断）会一路匹配到后面无关代码块/mermaid 的收尾 ```，把中间全部真实正文吞掉；
// 且剥除边界与 parseGenImageDirectives 依赖的 splitBlocks 块边界（FENCE=/^```/ 找收尾）不一致，
// 指令块内部出现裸 ``` 行时会泄漏残片。逐行扫描与 splitBlocks 同语义，剥的和 parse 认的是同一段。
// 之所以不直接 splitBlocks+joinBlocks 重拼：strip 跑在导出全文（含分页注释/节标记）上，重拼会
// 规整化块间距、破坏「预览=导出」的字节稳定预期。
const FENCE_LINE_RE = /^```/ // 与 proposalBlocks.ts 的 FENCE 完全同语义
const GENIMAGE_OPEN_LINE_RE = new RegExp(`^${GENIMAGE_FENCE_OPEN}[ \\t]*\\r?$`)
const BARE_CLOSE_LINE_RE = /^```[ \t]*\r?$/

/** 剥掉全文的 genimage 指令块（未生成/未审阅的指令绝不进交付物）。无指令时原样返回。 */
export function stripGenImageDirectives(markdown: string): string {
  if (!markdown.includes(GENIMAGE_FENCE_OPEN)) return markdown
  const lines = markdown.split('\n')
  const kept: string[] = []
  let stripped = false
  let i = 0
  while (i < lines.length) {
    if (GENIMAGE_OPEN_LINE_RE.test(lines[i])) {
      // 找收尾行：splitBlocks 语义（第一个 /^```/ 行收块）。但收尾行若不是裸 ```（比如撞上了
      // 后续 ```mermaid 的开围栏），这段在 GENIMAGE_BLOCK_RE / parseGenImageDirectives 眼里
      // 也不是合法指令块——典型的流式截断现场。与 parse 的「识别不到就不当指令」立场一致：
      // 安全失败，整体原样返回入参，绝不冒险吞正文。
      let j = i + 1
      while (j < lines.length && !FENCE_LINE_RE.test(lines[j])) j++
      if (j >= lines.length || !BARE_CLOSE_LINE_RE.test(lines[j])) return markdown
      i = j + 1 // 丢弃 [开..收] 这段行，继续扫收尾行之后
      stripped = true
      continue
    }
    kept.push(lines[i])
    i++
  }
  if (!stripped) return markdown // 只有内联反引号伪指令等，没剥任何块 → 原引用返回
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

// djb2 短哈希：key 只做幂等去重（Map 键），不做安全用途；Date.now/Math.random 被禁（可重放性），
// 内容哈希天然稳定。
function hashText(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 生图任务的幂等键：节 + 指令内容 + 同内容序。genImageJobs / seen 集合共用。 */
export function genImageDirectiveKey(sectionId: string, raw: string, occurrence: number): string {
  return `${sectionId}#${occurrence}#${hashText(raw.trim())}`
}

function directiveIndices(blocks: readonly string[], raw: string): number[] {
  const key = raw.trim()
  const out: number[] = []
  blocks.forEach((b, i) => {
    if (b.trim() === key) out.push(i)
  })
  return out
}

/**
 * 用 replacement（一般是 `![图说](路径)`）原地替换第 occurrence 个内容等于 raw 的块。
 * replacement 为空串 = 删除该块。找不到（内容漂移/越界）→ changed:false、入参原样返回。
 * 纯函数：不就地修改入参。
 */
export function replaceGenImageDirectiveBlock(
  blocks: string[],
  raw: string,
  occurrence: number,
  replacement: string
): { blocks: string[]; changed: boolean } {
  const idx = directiveIndices(blocks, raw)[occurrence]
  if (idx === undefined) return { blocks, changed: false }
  const next = blocks.slice()
  if (replacement) next[idx] = replacement
  else next.splice(idx, 1)
  return { blocks: next, changed: true }
}

/** 摘除第 occurrence 个内容等于 raw 的块（审阅「丢弃」用）。 */
export function removeGenImageDirectiveBlock(
  blocks: string[],
  raw: string,
  occurrence: number
): { blocks: string[]; changed: boolean } {
  return replaceGenImageDirectiveBlock(blocks, raw, occurrence, '')
}
