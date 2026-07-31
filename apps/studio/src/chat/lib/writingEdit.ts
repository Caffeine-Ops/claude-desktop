import { splitBlocks, spliceBlocks } from '@desktop-shared/proposalBlocks'

/**
 * 手动编辑用的块级操作。与 `writingRevision.ts`（AI 改写）分开成两个模块：那边的重头戏是
 * 「AI 回来的文本怎么在漂过的正文里重新定位」，这边不需要——手动编辑期间 AI 被锁住不写盘
 * （见 useWritingInProgress 那道闸），块序号在编辑窗口内是稳定的，直接按序号操作即可。
 * 两边共用底层的 splitBlocks / spliceBlocks，不共用定位逻辑。
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
