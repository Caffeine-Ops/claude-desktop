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

/**
 * 代码跨度遮罩：把围栏 ```…``` 与行内 `…`（含 ``…`` 双反引号形态）的内容替换成等长空格。
 * 遮罩后长度与非代码区字符完全不变，IMAGE_RE 在遮罩文本上扫描、命中区间直接回原文落子。
 *
 * 为什么必须遮罩（评审 CONFIRMED）：occurrence 由调用方按【真实渲染的 <img> DOM 顺序】数出，
 * 而反引号里的 `![…](…)` 字面量 react-markdown 渲染成 <code> 不渲染 <img>——正则若连代码
 * 跨度里的示例一起数，两套计数错位，手术会切碎代码跨度、留下真图且照样落盘（与项目记档的
 * 「幻影哨兵」同根：raw 扫描 vs 渲染结构）。
 */
function maskCodeSpans(text: string): string {
  return text.replace(/```[\s\S]*?```|``[^`]*``|`[^`\n]*`/g, (m) => ' '.repeat(m.length))
}

/**
 * remove/replace 共用的 occurrence 定位（评审发现：此前两函数各自复制这段扫描循环，匹配规则
 * 修一处漏一处会造成「删得掉却换不了」的不对称）。返回第 occurrence 个（0 起）路径归一后等于
 * path 的图片语法在【原文】中的区间；找不到返回 null。
 */
function findImageOccurrence(
  blockText: string,
  path: string,
  occurrence: number
): { start: number; len: number } | null {
  const masked = maskCodeSpans(blockText)
  IMAGE_RE.lastIndex = 0
  let seen = 0
  let m: RegExpExecArray | null
  while ((m = IMAGE_RE.exec(masked)) !== null) {
    if (normalizeImagePath(m[1]) !== path) continue
    if (seen === occurrence) return { start: m.index, len: m[0].length }
    seen++
  }
  return null
}

export function removeImageOccurrence(blockText: string, path: string, occurrence: number): string {
  const hit = findImageOccurrence(blockText, path, occurrence)
  if (!hit) return blockText
  const matchStart = hit.start
  const matchLen = hit.len

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

// 换图（Task 10）用的字符串手术：在一块 markdown 文本里找到路径等于 path 的第 occurrence 个
// （0 起）`![alt](path)` 图片语法，把括号里的路径换成 newPath，其余内容（含 alt 文本）原样
// 保留。找不到匹配项（同 removeImageOccurrence：路径不存在，或 occurrence 超出该路径出现
// 次数）则原样返回——调用方据「返回值是否等于入参」判断是否真的换了。
//
// 与 removeImageOccurrence 共用同一个 findImageOccurrence（含代码跨度遮罩与 normalizeImagePath
// 归一化：title 后缀 / <> 包裹按同一标准剥离后比较），只是命中后的落子动作从「摘除」换成「替换
// 括号内容」。替换后原有的 title 后缀 / <> 包裹一并丢弃（新路径不含它们，同 removeImageOccurrence
// 对这些修饰符的处理立场一致：不保留跟旧路径绑定的修饰符）。
export function replaceImageOccurrence(
  blockText: string,
  path: string,
  occurrence: number,
  newPath: string
): string {
  const hit = findImageOccurrence(blockText, path, occurrence)
  if (!hit) return blockText
  const matchStart = hit.start
  const matchLen = hit.len

  // 从匹配到的完整 `![alt](...)` 子串里单独抠出 alt 文本（IMAGE_RE 本身只捕获路径部分），
  // 拼一个只换了路径、alt 原样保留的新语法。
  const matched = blockText.slice(matchStart, matchStart + matchLen)
  const altMatch = /^!\[([^\]]*)\]/.exec(matched)
  const alt = altMatch ? altMatch[1] : ''
  const replacement = `![${alt}](${newPath})`
  return blockText.slice(0, matchStart) + replacement + blockText.slice(matchStart + matchLen)
}

// 应用改图审阅项（Task 11）时用的「带漂移容错 + 歧义守卫」落点逻辑：把 review 记的新图路径
// 换回目标块。preferredIndex（多半是发起改图那一刻的 blockIndex，越界会被夹到合法范围）优先
// 尝试；审阅悬而未决期间该节完全可能被并发编辑（AI 修订/手改/块序变化）致块布局漂移，若仅按
// 旧下标硬替换，一旦目标块已不含 sourcePath，replaceImageOccurrence 会原样返回、静默不生效
// ——用户点了「应用」却什么也没发生。
//
// 于是在优先下标未命中时退化为扫描该节其余块，但不再是「见第一个匹配就换」：先数清楚除
// preferredIndex 外还有几个块的 path+occurrence 会命中 replaceImageOccurrence（即真的会改变
// 内容），只有【恰好一个】候选时才落地——0 个候选说明图确实不在这节了（原样返回），≥2 个候选
// 说明同一张图（同 path+occurrence）在本节被复用了不止一处，此时无法分辨用户当初点的到底是
// 哪一块，贸然改第一个匹配到的等于可能重写一块用户从未审阅过的内容（Finding 1），故同样按
// no-op 处理，把判断权交回用户（review 卡片仍会被上层摘除，但内容不动）。
//
// 纯函数：不就地修改入参 blocks，返回新数组（changed=false 时返回值与入参内容相等，但调用方
// 不应依赖引用相等）。
export function applyImageReplacementWithDrift(
  blocks: string[],
  preferredIndex: number,
  path: string,
  occurrence: number,
  newPath: string
): { blocks: string[]; changed: boolean } {
  if (blocks.length === 0) return { blocks, changed: false }

  const clampedPreferred = Math.min(Math.max(preferredIndex, 0), blocks.length - 1)
  const replacedAt = (idx: number): string => replaceImageOccurrence(blocks[idx], path, occurrence, newPath)

  const preferredReplaced = replacedAt(clampedPreferred)
  if (preferredReplaced !== blocks[clampedPreferred]) {
    const next = blocks.slice()
    next[clampedPreferred] = preferredReplaced
    return { blocks: next, changed: true }
  }

  const candidates: number[] = []
  for (let i = 0; i < blocks.length; i++) {
    if (i === clampedPreferred) continue
    if (replacedAt(i) !== blocks[i]) candidates.push(i)
  }
  if (candidates.length !== 1) return { blocks, changed: false }

  const idx = candidates[0]
  const next = blocks.slice()
  next[idx] = replacedAt(idx)
  return { blocks: next, changed: true }
}
