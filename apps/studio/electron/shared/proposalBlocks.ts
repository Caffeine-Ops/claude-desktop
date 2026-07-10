// 编辑态「块」= 一节 markdown 的顶层结构单元（标题/段落/列表/表格/围栏代码/图片行）。
// 逐块渲染让 DOM 块索引与本数组下标天然对齐——这是「选中文字/双击能精确定位到哪一块」
// 的地基。块只活在编辑态内存：手改/AI 改后一律 joinBlocks 重拼回整节 markdown（唯一真相源），
// 不落盘。之所以按「块」而非「精确字符选区」替换：选区纯文本 ↔ markdown 源码子串的映射会被
// 内联格式/来源标注/编号打乱，最脆；按块替换鲁棒得多（见 spec 关键取舍）。

const FENCE = /^```/
const TABLE_ROW = /^\s*\|/
const HEADING = /^#{1,6}\s/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const INDENT_CONT = /^\s+\S/ // 列表项的缩进续行

const isBlank = (s: string): boolean => s.trim() === ''

// 只去块首尾的空行，保留块内部结构（含围栏代码里的空行）。
// 【不】去内容行的行尾空白——否则会连 GFM「行尾两个空格 = 硬换行」一起吃掉。本函数现在也跑在
// 只读逐块渲染与「任一块提交 → joinBlocks(splitBlocks(整节))」的整节重拼路径上，一旦在这里裁剪行尾
// 空白，用户纯浏览就丢硬换行、且编辑任一块即把整节所有硬换行永久抹掉并落盘（review V6）。
function trimBlock(lines: string[]): string {
  let a = 0
  let b = lines.length
  while (a < b && lines[a].trim() === '') a++
  while (b > a && lines[b - 1].trim() === '') b--
  return lines.slice(a, b).join('\n')
}

export function splitBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  const n = lines.length
  let i = 0

  while (i < n) {
    if (isBlank(lines[i])) {
      i++ // 跳过块间空行
      continue
    }
    const start = i
    const line = lines[i]

    if (FENCE.test(line)) {
      // 围栏代码/mermaid：消费到配对 ``` （含），内部空行不切。
      i++
      while (i < n && !FENCE.test(lines[i])) i++
      if (i < n) i++ // 吃掉收尾 ```
    } else if (HEADING.test(line)) {
      i++ // 标题单行一块
    } else if (TABLE_ROW.test(line)) {
      while (i < n && TABLE_ROW.test(lines[i])) i++ // 连续 |…| 行
    } else if (LIST_ITEM.test(line)) {
      // 列表段：连续列表项 + 缩进续行 + 项间【单】空行（loose list 不被拆散）。
      i++
      while (i < n) {
        if (isBlank(lines[i])) {
          const j = i + 1
          if (j < n && !isBlank(lines[j]) && (LIST_ITEM.test(lines[j]) || INDENT_CONT.test(lines[j]))) {
            i++ // 项间单空行，并入列表段
            continue
          }
          break
        }
        if (LIST_ITEM.test(lines[i]) || INDENT_CONT.test(lines[i])) {
          i++
          continue
        }
        break
      }
    } else {
      // 段落：消费到下一空行或下一结构起点。
      i++
      while (
        i < n &&
        !isBlank(lines[i]) &&
        !HEADING.test(lines[i]) &&
        !FENCE.test(lines[i]) &&
        !TABLE_ROW.test(lines[i]) &&
        !LIST_ITEM.test(lines[i])
      ) {
        i++
      }
    }
    const blk = trimBlock(lines.slice(start, i))
    if (blk.length > 0) blocks.push(blk)
  }
  return blocks
}

// 块间用一个空行连接。只过滤纯空块——【不】再逐行去行尾空白（那会吃掉 GFM 硬换行，见 trimBlock
// 注释与 review V6）。幂等仍成立：trimBlock 已去块首尾空行，块内容原样，join('\n\n') 后再 split 回同样的块。
export function joinBlocks(blocks: string[]): string {
  return blocks.filter((b) => b.trim().length > 0).join('\n\n')
}

// 把 [range.start, range.end]（含端点）替换为 replacement（AI 产出，可多块），其余块原样保留。
// 越界端点夹紧到合法范围（防 stale range 越界）。
export function spliceBlocks(
  markdown: string,
  range: { start: number; end: number },
  replacement: string
): string {
  const blocks = splitBlocks(markdown)
  if (blocks.length === 0) return replacement.trim()
  const start = Math.max(0, Math.min(range.start, blocks.length - 1))
  const end = Math.max(start, Math.min(range.end, blocks.length - 1))
  const repl = splitBlocks(replacement)
  return joinBlocks([...blocks.slice(0, start), ...repl, ...blocks.slice(end + 1)])
}

// 用"当初选中的文字"在最新 markdown 里重新定位块区间（排队改写排空时用）。
// 为什么按文字重定位而非直接存块序号：排队期间前面的改写可能落地、块数变化，序号会漂到别处、
// 改错段落；文字内容不漂。规范化去掉两侧所有空白后比较——浏览器选区把块间空行折叠成空格/直接
// 相连，与源码 markdown 的空白不一致，不去空白会永远匹配不上。
//
// 算法：切块后把每块规范化文本顺次拼成一条长串，同时记住每块在长串里的字符区间；在长串里
// indexOf(规范化选区文本)，命中区间的首尾字符各落在哪个块，就是 [start,end]。

// 内部：返回 selectedText 在 markdown 里【所有】命中的块区间（规范化去空白后匹配）。空则空数组。
function locateAllBlockRanges(markdown: string, selectedText: string): Array<{ start: number; end: number }> {
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const needle = norm(selectedText)
  if (!needle) return []
  const blocks = splitBlocks(markdown)
  if (blocks.length === 0) return []

  let hay = ''
  const spans: Array<{ start: number; end: number }> = []
  for (const blk of blocks) {
    const nb = norm(blk)
    const begin = hay.length
    hay += nb
    spans.push({ start: begin, end: hay.length })
  }

  const blockOf = (charIdx: number, forEnd: boolean): number => {
    let found = -1
    for (let k = 0; k < spans.length; k++) {
      const sp = spans[k]
      if (sp.start === sp.end) continue // 规范化后空块跳过
      if (charIdx < sp.end) return k
      found = k
    }
    return forEnd ? found : -1
  }

  const out: Array<{ start: number; end: number }> = []
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at < 0) break
    const start = blockOf(at, false)
    const end = blockOf(at + needle.length - 1, true)
    if (start >= 0 && end >= start) out.push({ start, end })
    from = at + 1 // 允许重叠命中的下一处
  }
  return out
}

// 无 hint 版（Task 1 契约不变）：取第一处命中。
export function locateBlockRangeByText(
  markdown: string,
  selectedText: string
): { start: number; end: number } | null {
  const all = locateAllBlockRanges(markdown, selectedText)
  return all[0] ?? null
}

// 带 hint 版（CEO 护栏#3）：多处命中时选 start 离 hint.start 最近的一处（并列取更靠前）。
export function locateBlockRangeByTextWithHint(
  markdown: string,
  selectedText: string,
  hint: { start: number; end: number }
): { start: number; end: number } | null {
  const all = locateAllBlockRanges(markdown, selectedText)
  if (all.length === 0) return null
  if (all.length === 1) return all[0]
  return all.reduce((best, cur) =>
    Math.abs(cur.start - hint.start) < Math.abs(best.start - hint.start) ? cur : best
  )
}
