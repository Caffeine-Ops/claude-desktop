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

/** 定长栈追加：超出 `max` 时丢最老的一条。不改动入参（zustand 要求 immutable 更新）。 */
export function pushBounded<T>(stack: T[], item: T, max: number): T[] {
  const next = [...stack, item]
  return next.length > max ? next.slice(next.length - max) : next
}
