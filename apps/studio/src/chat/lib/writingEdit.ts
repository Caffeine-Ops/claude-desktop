import { splitBlocks, spliceBlocks } from '@desktop-shared/proposalBlocks'

/**
 * 手动编辑用的块级操作。与 `writingRevision.ts`（AI 改写）分开成两个模块：那边的重头戏是
 * 「AI 回来的文本怎么在漂过的正文里**重新定位**」，这边刻意不做定位——按块序号直接操作。
 * 两边共用底层的 splitBlocks / spliceBlocks，不共用定位逻辑。
 *
 * 【为什么这边不需要 `applyReview` 那套逐字节自检 —— 2026-07-31 复审 I-4 改正】
 * 这段注释原先写的理由是「手动编辑期间 AI 被锁住不写盘，块序号在编辑窗口内是稳定的」。
 * **两句都不成立，别再照着它推理**：
 *  - `useWritingInProgress()` 那道闸只拦「**进入**编辑」，设计明文规定**已经在编辑中的块
 *    不踢出**（强行退出会直接丢掉用户正敲的字）——所以编辑窗口内 AI 随时可能开写。
 *  - 块序号也不稳定：同一节里先改 A 再改 B 时，A 那次编辑若改变了块数（清空 = 删掉一块、
 *    敲个空行 = 拆成两块），B 手里的序号立刻整体顶漂。
 *
 * 真正兜住「不会把字写进没选中的那一块」的，是下面这三件事**合起来**，缺一不可：
 *  1. **mtime 乐观锁**：基准取「进入编辑那一刻」的快照（不是写盘那一刻现读的），
 *     编辑窗口内文件被任何人改过，提交都会被主进程拒掉；
 *  2. **`replaceBlockAt` 越界回 null**（刻意不像 `spliceBlocks` 那样夹紧）：序号已经指不到
 *     东西时拒写，而不是退而求其次写进最后一块；
 *  3. **刷新基准前先核对索引**：`WritingPaper.commitEdit` 里 A→B 那次受控的基准刷新，会先
 *     用 `blockSourceAt(新正文, B 的序号) === B 的 base` 确认「B 当初快照的那份源码现在还
 *     待在同一个下标上」，对不上就保留过期基准、让乐观锁照旧把 B 拒掉（一次安全的失败）。
 * 改这三处任何一处之前，先回到这段：它们是同一套论证的三条腿。
 */

/** 取出第 `blockIndex` 块的 markdown 源码。序号非法回 null —— 调用方据此拒绝进入编辑态。 */
export function blockSourceAt(sectionMarkdown: string, blockIndex: number): string | null {
  if (!Number.isInteger(blockIndex) || blockIndex < 0) return null
  const blocks = splitBlocks(sectionMarkdown)
  if (blockIndex >= blocks.length) return null
  return blocks[blockIndex]
}

/**
 * 把第 `blockIndex` 块换成 `nextBlockMarkdown`，返回整节的新源码。
 *
 * `nextBlockMarkdown` 为空 = 删除这一块（spliceBlocks 里 splitBlocks('') 得空数组，
 * 前后两段直接接上）。这是「把输入框清空 = 删掉这一段」这条产品约定的实现点，
 * 有撤销栈兜底，故不在这里拦。
 *
 * 【为什么越界必须回 null 而不是交给 spliceBlocks 夹紧】spliceBlocks 会把越界端点
 * clamp 到最后一块（它是为「AI 改写的 stale range」设计的容错）。手动编辑里越界只可能
 * 来自「用户编辑期间这一节被换掉了」，此时夹紧等于把用户的字写进他没选的那一段——
 * 静默改错内容，比拒绝写入糟糕得多。
 */
export function replaceBlockAt(
  sectionMarkdown: string,
  blockIndex: number,
  nextBlockMarkdown: string
): string | null {
  if (!Number.isInteger(blockIndex) || blockIndex < 0) return null
  const blocks = splitBlocks(sectionMarkdown)
  if (blockIndex >= blocks.length) return null
  return spliceBlocks(sectionMarkdown, { start: blockIndex, end: blockIndex }, nextBlockMarkdown)
}

/**
 * 用户在输入框里改出来的内容，和进入编辑时那一块，落到磁盘上会不会是同一个东西。
 *
 * 比的是**规范形态**（都过一遍 splitBlocks 再 join）而不是裸字符串：用户在末尾多敲一个
 * 回车，splitBlocks 会把它吃掉、写进磁盘的字节完全相同——此时写盘是纯空转，还会白占一格
 * 撤销额度（用户点开看一眼再点走，就少一次真正的后悔机会）。
 *
 * 注意清空必须判为「变了」：那是「删除这一段」这个真实意图，不是空转。
 */
export function isBlockUnchanged(originalBlock: string, candidate: string): boolean {
  return splitBlocks(originalBlock).join('\n\n') === splitBlocks(candidate).join('\n\n')
}

/**
 * 「用户瞄准的那一块，现在在第几号」——按**内容**在最新正文里把它找回来。
 *
 * 【为什么需要它，2026-08-03 实测】双击换块时，两次点击之间会发生一件事：第一次
 * mousedown 让上一块失焦 → 那一块存盘 → 编辑框收起（还可能整块被删掉，「清空 = 删除
 * 这一段」是明文约定）→ **下方内容整体上移**。等第二次点击和 dblclick 到达时，鼠标底下
 * 已经换了一块，`event.target` 指向的不再是用户瞄准的那一段（实测：瞄准「那么，做那个
 * 机器人的人」，打开的却是下面那个标题）。
 *
 * 光记住「用户按下时那一块是第几号」也不够：如果那次存盘删掉了一块，这个序号在**新**
 * 正文里指向的仍然是错的段落。所以记的是那一刻的**源码内容**，用它来重新定位——内容
 * 不会因为别处的增删而漂。
 *
 * - 序号还指着同一份内容 → 原样返回（绝大多数情况，零成本）。
 * - 内容挪了位置 → 返回它现在的新序号。
 * - 内容**不见了**（那一块被删或被改写）→ 返回 `null`。调用方应当**拒绝进入编辑**：
 *   此刻打开任何一块都不是用户想要的那一块，宁可让他重新双击一次。
 * - 多处逐字节相同（重复段落、连续的 `---` 分隔线）→ 挑离原序号最近的一处。这是没有
 *   更好办法的裁决：内容本身给不出区分度，而「离手指按下的位置最近」是唯一可用的线索。
 */
export function locateBlockBySource(
  sectionMarkdown: string,
  originalIndex: number,
  source: string
): number | null {
  if (!source.trim()) return null
  const blocks = splitBlocks(sectionMarkdown)
  if (
    Number.isInteger(originalIndex) &&
    originalIndex >= 0 &&
    originalIndex < blocks.length &&
    blocks[originalIndex] === source
  ) {
    return originalIndex
  }
  let best: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] !== source) continue
    const d = Math.abs(i - originalIndex)
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  }
  return best
}

/** 定长栈追加：超出 `max` 时丢最老的一条。不改动入参（zustand 要求 immutable 更新）。 */
export function pushBounded<T>(stack: T[], item: T, max: number): T[] {
  const next = [...stack, item]
  return next.length > max ? next.slice(next.length - max) : next
}
