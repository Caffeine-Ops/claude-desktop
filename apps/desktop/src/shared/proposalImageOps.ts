// 点图工具栏「删除」用的纯字符串手术：在一块 markdown 文本里找到路径等于 targetPath 的第
// occurrence 个（0 起）`![alt](path)` 图片语法并摘掉它，其余内容原样保留（同块共存的说明文字
// 等不受影响）。找不到匹配项（路径不存在，或 occurrence 超出该路径出现次数）则原样返回——
// 调用方据「返回值是否等于入参」判断是否真的删了。
//
// 抽成独立无依赖的 shared 模块（而非留在 ProposalPaper.tsx 里）纯粹是为了让 bun test 能直接
// 跑：renderer 侧 .tsx 不在 web tsconfig 的可测路径外没问题，但把纯逻辑单独拆出来测试意图更
// 直白，也顺带避免 ProposalPaper 那个大文件继续膨胀。
//
// path 归一化逻辑刻意与 shared/proposal.ts 的 parseImages 保持一致（剥 `"title"`/`'title'`
// 后缀、剥 `<>` 包裹）——targetPath 来自 AssistantMarkdown 的 data-raw-src，那是 react-markdown
// 解析后的干净路径（等价于 parseImages 抽出的 path），两边用同一套剥离规则比较才不会因为
// markdown 原文里到底带没带 `<>`/title 而误判「找不到」。parseImages 本身不导出内部正则，
// 这里的块级删除又需要拿到匹配的原始子串位置（parseImages 只返回值，不返回位置），故在此
// 自成一份小实现，而非 import 复用——两处判据一致即可，不必共享同一个正则对象。
//
// occurrence 参数解同路径重复图（Finding 2）：一块里可能有两张路径完全相同的图（同一张图贴了
// 两次），此前的实现总摘第一个匹配，即便用户点的是第二张。调用方（ProposalPaper 的
// handlePaperClick）负责数清楚「点中的这张 img 前面还有几个 data-raw-src 相同的 img 节点」
// 得到 occurrence，这里只负责按下标摘对应那一个，不掺入任何 DOM 相关逻辑（保持纯函数、可测）。
const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g

function normalizeImagePath(raw: string): string {
  let p = raw.trim()
  p = p.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim() // 剥 title 后缀
  if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1).trim() // 剥 <> 包裹
  return p
}

export function removeImageOccurrence(blockText: string, path: string, occurrence: number): string {
  IMAGE_RE.lastIndex = 0
  let matchStart = -1
  let matchLen = 0
  let seen = 0
  let m: RegExpExecArray | null
  while ((m = IMAGE_RE.exec(blockText)) !== null) {
    if (normalizeImagePath(m[1]) !== path) continue
    if (seen === occurrence) {
      matchStart = m.index
      matchLen = m[0].length
      break
    }
    seen++
  }
  if (matchStart < 0) return blockText

  // 只摘掉图片语法本身紧邻的空格/制表符（不动换行——多行结构原样保留，joinBlocks 上游已经
  // 靠「trim 后为空的块整块过滤掉」处理独占一整块的图片，这里不必费力抹平内部空行，见文件顶部
  // 原实现同款注释）。
  const before = blockText.slice(0, matchStart).replace(/[ \t]+$/, '')
  const after = blockText.slice(matchStart + matchLen).replace(/^[ \t]+/, '')

  const beforeNonEmpty = before.trim() !== ''
  const afterNonEmpty = after.trim() !== ''
  // Finding 1：inline 图片摘掉后，前后文字直接拼接会把两个非空白字符粘在一起（"See image:" +
  // "shown above" → "See image:shown above"）。前后剥离只吃掉了紧邻图片的空格/制表符，原本
  // 「文字 空格 图片 空格 文字」里那个分隔用的空格就这样被两头各吃一半、全部丢失。当两侧都非空
  // 且交界处会碰上两个非空白字符时，补回恰好一个空格；只有一侧非空（图片在行首/行尾）或交界处
  // 本就是换行等空白字符（图片单独占一行、前后靠换行天然分隔）时不补，避免画蛇添足。
  let joined: string
  if (beforeNonEmpty && afterNonEmpty) {
    const lastCh = before[before.length - 1]
    const firstCh = after[0]
    const needsSpace = !/\s/.test(lastCh) && !/\s/.test(firstCh)
    joined = needsSpace ? `${before} ${after}` : before + after
  } else {
    joined = before + after
  }
  return joined.trim()
}
