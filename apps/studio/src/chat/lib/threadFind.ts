/**
 * 对话内查找（⌘F）的检索逻辑——消息数组 + 搜索词进，命中列表出。
 *
 * 为什么搜内存数据而不是屏幕上的 DOM
 * ----------------------------------
 * 长对话默认只挂载最近 30 条（stores/chat.ts 的 HISTORY_WINDOW_INITIAL，
 * 更早的要点「显示更早的消息」才进 DOM）。拿 Chromium 自带的整页查找
 * （webContents.findInPage）看着免费，但它只能搜到已经画出来的那一屏——
 * 用户搜不到早期内容时不会想到「是没加载」，只会判定「这句话不存在」。
 * 所以检索走数据层，命中后由调用方负责把历史窗口揭开再滚过去。
 *
 * 零依赖纯模块（同 exportTranscript 的纪律）：不碰 store / React / i18n，
 * 消息类型直接复用导出那边立好的结构性契约。
 */

import type { TranscriptMessage, TranscriptPart } from './exportTranscript'
import { stripMessageMarker } from './messageMarkers'

/** 一条命中。**按消息去重**，不是逐个出现各算一项。
 *
 *  为什么：定位只到消息级（不做字符级高亮，理由见 plainify 的注释），
 *  同一条消息里的第 2、3 次出现跳过去画面不会动，用户会以为「下一个」
 *  卡住了。计数因此按消息走——查找栏显示「第 3 条 / 共 12 条」，每次
 *  跳转都真的换一条。`count` 留着给需要时展示「本条内 3 处」。 */
export type FindHit = {
  /** 在**完整**消息数组里的下标。跳转要靠它判断该不该先揭开历史窗口。 */
  readonly messageIndex: number
  readonly role: 'user' | 'assistant'
  /** 这条消息里出现了几次（不重叠计数）。 */
  readonly count: number
}

/**
 * 把一段 markdown 原文压成「用户眼睛看到的样子」。
 *
 * 这是本功能最隐蔽的坑：AI 回复存的原文是 `**部署**脚本`，屏幕上渲染出来
 * 是「部署脚本」。不剥标记就命中不了，表现成「明明屏幕上有这四个字却搜
 * 不到」——用户只会判定功能坏了。
 *
 * 搜索词**同样**要过这一层：剥了正文却不剥词，`foo_bar` 这类两边都带标记
 * 字符的输入反而会从能匹配变成不能匹配，等于拿一个 bug 换另一个。
 *
 * 剥完之后字符位置必然与渲染结果对不上（代码块、表格里更乱）——这正是
 * 不做字符级高亮、只定位到消息的另一个理由：错位完全不可见。
 *
 * 刻意**不剥 `_`**：中文环境里用下划线做斜体极罕见，而它在代码标识符里
 * 到处都是，剥了会让 `foo_bar` 和 `foobar` 互相误命中。
 */
function plainify(s: string): string {
  return (
    s
      // `[显示文字](url)` → `显示文字`。必须先做：url 里常有 `~` `*`，
      // 留到后面会被下一条规则拆得认不出。用户看不见 url，它不该可搜。
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // 行内强调 / 行内代码 / 删除线的标记字符。
      .replace(/[*`~]/g, '')
  )
}

/** 一条消息里用户**看得见**的文本。看不见的一律不进来（2026-10-09 用户
 *  拍板的检索范围）：思考过程默认折叠、工具调用的完整输出一次 grep 就能
 *  几千行——把它们算进去，计数会被撑到「1/400」，上下跳转直接废掉。 */
function visibleText(m: TranscriptMessage): string {
  if (typeof m.content === 'string') return m.content
  const parts = m.content as readonly TranscriptPart[]
  const texts: string[] = []
  for (const p of parts) {
    if (p.type !== 'text') continue
    const t = (p as { text?: unknown }).text
    if (typeof t === 'string') texts.push(t)
  }
  return texts.join('\n')
}

/** 不重叠地数 `needle` 在 `hay` 里出现几次。两者都已小写化。 */
function countOccurrences(hay: string, needle: string): number {
  let n = 0
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at === -1) break
    n++
    from = at + needle.length
  }
  return n
}

/**
 * 在一轮对话里找词。返回按消息下标升序排列的命中列表（⌘F 的「下一个」
 * 是往下走，不是按相关度）。
 *
 * 空词 / 纯空白词返回零命中，**而且这个早退是必需的**，不只是为了结果好看：
 * JS 的 `'abc'.indexOf('', 10)` 返回 3（字符串长度）而不是 -1，空串会让
 * 上面那个计数循环永远退不出去（实现过程中撞了两次死循环）。
 */
export function findInMessages(
  messages: readonly TranscriptMessage[],
  query: string
): FindHit[] {
  const q = plainify(query.trim()).toLowerCase()
  if (q.length === 0) return []

  const hits: FindHit[] = []
  messages.forEach((m, i) => {
    if (m.role !== 'user' && m.role !== 'assistant') return
    // stripMessageMarker 先行：表格框选 / 图片标记编辑这两种消息在屏幕上
    // 渲染成卡片，原文首行是协议 JSON。跟着屏幕走——卡片上那句问题要能
    // 搜到，JSON 字段名不该能搜到。
    const hay = plainify(stripMessageMarker(visibleText(m))).toLowerCase()
    const count = countOccurrences(hay, q)
    if (count > 0) hits.push({ messageIndex: i, role: m.role, count })
  })
  return hits
}

/**
 * 「上一个 / 下一个」走到哪一条。`current` 为 -1 表示还没选中任何命中。
 *
 * 环绕是 ⌘F 的既定语义（走到底再按回到第一条），用户不会去数还剩几条。
 * 零命中时返回 -1 而不是 0——0 是个合法下标，调用方拿去索引会读到
 * 不存在的命中。
 */
export function stepHit(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1
  // 还没选中时，往下走从头开始、往上走从尾开始（想看最近的命中）。
  if (current < 0) return dir === 1 ? 0 : total - 1
  // +total 是为了让 -1 这种情况也落在正数域里再取模。
  return (current + dir + total) % total
}

/**
 * 跳到第 `messageIndex` 条之前，要调几次 `revealEarlierMessages()`。
 *
 * `windowStart` = stores/chat.ts 的 `historyWindowStart`：它之前的消息还
 * 没挂进 DOM。`step` = 一次揭开多少条（HISTORY_WINDOW_REVEAL_STEP）。
 * 目标已经挂载时返回 0——查找命中的多数是近期消息，不该为它们白跑一趟
 * 揭开 + 滚动补偿。
 */
export function revealStepsNeeded(
  windowStart: number,
  messageIndex: number,
  step: number
): number {
  if (messageIndex >= windowStart) return 0
  return Math.ceil((windowStart - messageIndex) / step)
}
