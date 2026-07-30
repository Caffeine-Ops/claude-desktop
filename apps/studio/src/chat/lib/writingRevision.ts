import { splitBlocks, spliceBlocks } from '@desktop-shared/proposalBlocks'
import { WRITING_REVISION_BEGIN, WRITING_REVISION_END } from '@desktop-shared/writing'

/** 一次改写的目标。重定位的依据是 `beforeMarkdown`（源码），**不是** `selectedText`。 */
export interface WritingRevisionTarget {
  sectionName: string
  range: { start: number; end: number }
  /** 用户在纸面上选中的渲染文本。保留它仅用于展示（气泡里回显）与日志，**不再用于定位**。 */
  selectedText: string
  /**
   * 提交那一刻，`range` 覆盖的那几块的 **markdown 源码**（`splitBlocks` 切片 join）。
   *
   * 这是定位机制的地基：定位不再拿渲染文本去源码里猜，而是**拿源码比源码**。
   * 渲染文本里没有 `**`、`- `、`|` 这些标记，跨内联标记/跨列表项/跨表格的选区拿去
   * `indexOf` 必然落空——那是先天矛盾，不是调参能救的。而这段源码切片
   * `buildRevisionMessage` 本来就要算（就是发给 AI 的「要改的那一段」），
   * 此前算完即丢，才逼出了后面一整套模糊兜底。留住它，后面全是精确比对。
   */
  beforeMarkdown: string
}

/**
 * 一次重定位的结果。**「多处命中」必须显式出现在返回值里**，不能藏在函数内部悄悄挑一个：
 * 挑中的那处可能是错的，而对照卡若不告诉用户「这里有歧义」，他就只能凭「这段眼生不眼生」
 * 判断——相似段落根本看不出来。
 */
export interface WritingRelocateResult {
  range: { start: number; end: number }
  /** 同一节里存在多段**完全相同**的源码，本次是按「离原位置最近」挑的——可能挑错。 */
  ambiguous: boolean
}

/**
 * 把一段块源码归一到「splitBlocks 切出来再 join」的规范形态。
 *
 * 存在的意义是让**比较的两边走同一条路径**：`beforeMarkdown` 是切片 join 出来的、当前正文
 * 也要切片 join，两边都过一遍 splitBlocks 就不会被「块首尾空行怎么算」这类切分细节坑到。
 * 这不是「模糊比对」——splitBlocks 只去块首尾空行、绝不动块内文本（含 GFM 行尾双空格）。
 */
function canonicalize(markdown: string): string {
  return splitBlocks(markdown).join('\n\n')
}

/**
 * 组装发给 AI 的改写请求。
 *
 * 三个要素缺一不可：**本节全文**（AI 要看上下文才知道语气与前后衔接）、**选中块原文**
 * （明确改哪一段）、**哨兵格式要求**（前端据此抽取结果）。外加一句「不要修改任何文件」——
 * AI 手上有 Edit 工具，不明确禁止它会直接改盘，那样就绕过了「先对照再应用」这一步，
 * 用户点「放弃」也已经晚了。
 *
 * 返回 null = 不发这一轮（空指令 / 区间越界 / target 已过期）。
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
  // 一致性校验：`beforeMarkdown` 是**提交那一刻**那几块的源码，`selected` 是**现在**同一区间的
  // 源码。两者不等 = 这一版 target 已经过期（正文在这中间被改过、块序号漂了），此时把
  // `selected` 发给 AI 就是让它改一段用户没选的内容，回来的结果还会被当成「那一段的改写」
  // 落回去。宁可这一轮不发、让用户重选，也不能发一轮定位已经错了的请求。
  // 调用方（排空 effect）应先 relocateTarget 拿到新 range 再进来，正常路径不会撞这道闸。
  if (selected !== canonicalize(input.target.beforeMarkdown)) return null

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
 * 用「提交那一刻的块源码切片」（`target.beforeMarkdown`）在最新正文里重新定位块区间。
 *
 * 为什么不再用 `selectedText` 定位（详见 {@link WritingRevisionTarget.beforeMarkdown} 的
 * 注释）：`selectedText` 是渲染后的纯文本，没有 `**`、`- `、`|` 这些标记，拿它去 markdown
 * 源码里找，选区一旦跨了内联标记/多个列表项/表格就必然落空——三轮模糊补丁想弥补的正是这个
 * 先天矛盾，而实际上只要**留住提交那一刻的源码切片**，后面就是两段源码逐字节比较，
 * 不需要任何归一化或模糊判据。`selectedText` 在这里完全不参与匹配，只在多处命中时
 * 当"哪一处离原位置最近"的参照点用。
 *
 * 算法：把最新正文切块，找一段【连续】的块，其 join 结果与 `beforeMarkdown` 的规范形态
 * （见 {@link canonicalize}）完全相等。
 *
 * - 命中 0 处：那几块的源码已经不在了（真的被改写/删除了）→ `null`，调用方应放弃这次改写，
 *   不能拿"按位置推断"的旧区间去赌——那正是三轮补丁都在踩的坑。
 * - 命中 1 处：直接返回，`ambiguous: false`。
 * - 命中多处：同一节里存在完全相同的连续块（例如两段句式雷同的模板化文字），按「离入队时
 *   `target.range.start` 最近」选一处，但 `ambiguous: true`——挑中的那处可能是错的，
 *   调用方必须把这个信号透传给用户（对照卡警示条），不能像旧版那样悄悄选一个当"精确命中"。
 */
export function relocateTarget(
  sectionMarkdown: string,
  target: WritingRevisionTarget
): WritingRelocateResult | null {
  const blocks = splitBlocks(sectionMarkdown)
  const needleBlocks = splitBlocks(target.beforeMarkdown)
  // 空切片必须提前拦：若放行，下面的循环会把每个位置的「空 slice join 成 ''」都判成命中
  // （needle 也是 ''），在整节里制造出一片虚假命中。正常路径下 beforeMarkdown 不可能是
  // 空白（buildRevisionMessage 的越界/空白检查已经挡在提交之前），这里只是防御。
  if (needleBlocks.length === 0) return null
  const needle = needleBlocks.join('\n\n') // 等价于 canonicalize(target.beforeMarkdown)

  const hits: Array<{ start: number; end: number }> = []
  for (let start = 0; start + needleBlocks.length <= blocks.length; start++) {
    const end = start + needleBlocks.length - 1
    if (blocks.slice(start, end + 1).join('\n\n') === needle) hits.push({ start, end })
  }
  if (hits.length === 0) return null
  if (hits.length === 1) return { range: hits[0], ambiguous: false }

  const nearest = hits.reduce((best, cur) =>
    Math.abs(cur.start - target.range.start) < Math.abs(best.start - target.range.start) ? cur : best
  )
  return { range: nearest, ambiguous: true }
}
