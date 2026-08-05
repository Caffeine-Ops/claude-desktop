/**
 * 写作纸面「应用/丢弃」genimage 指令块的手术函数（配图密度③ · P1b task 5）。
 *
 * 纯字符串手术，不碰 store/IPC——WritingPaper 算出新 markdown 后走既有的
 * commitSection（`WRITING_WRITE_SECTION` 的 `expectedMtimeMs` 乐观锁 + 20 步撤销
 * 栈），这里只管「新 markdown 长什么样」，不许新开写盘入口。
 *
 * 定位与拼接全部复用 `shared/proposalGenImage.ts` 的 `replaceGenImageDirectiveBlock`
 * / `removeGenImageDirectiveBlock`（按【指令块原文 trim 相等 + 出现序】定位，与
 * `splitBlocks` 完全同语义）——提案侧「点图审阅卡应用/丢弃」走的就是这两个纯函数，
 * 写作侧没有理由另起一份手术逻辑（同源同风险，复制一份只会让两边的定位语义慢慢漂）。
 * 本文件只是把「blocks 数组 → 整节 markdown」这一层 splitBlocks/joinBlocks 包装成
 * WritingPaper 想要的「字符串进、字符串出」签名。
 *
 * 定位不到（内容已被并发编辑漂移/越界）两个函数都回 null，由调用方提示用户
 * 「原文已变化，请重新生成」——绝不允许猜位置乱替换，这是与提案侧同源的硬约束。
 */
import { splitBlocks, joinBlocks } from '@desktop-shared/proposalBlocks'
import {
  replaceGenImageDirectiveBlock,
  removeGenImageDirectiveBlock
} from '@desktop-shared/proposalGenImage'

/**
 * 用 `![图说](相对路径)` 原地替换第 `occurrence` 个内容等于 `directiveRaw` 的指令块，
 * 其余正文原样保留。定位不到回 null。
 */
export function applyGenImageToSection(
  markdown: string,
  directiveRaw: string,
  occurrence: number,
  caption: string,
  relPath: string
): string | null {
  const { blocks, changed } = replaceGenImageDirectiveBlock(
    splitBlocks(markdown),
    directiveRaw,
    occurrence,
    `![${caption}](${relPath})`
  )
  return changed ? joinBlocks(blocks) : null
}

/**
 * 删掉第 `occurrence` 个内容等于 `directiveRaw` 的指令块。`joinBlocks` 只保留非空块
 * 再用单个空行拼接，删块本身不会在正文里留下连续空行。定位不到回 null。
 */
export function discardGenImageFromSection(
  markdown: string,
  directiveRaw: string,
  occurrence: number
): string | null {
  const { blocks, changed } = removeGenImageDirectiveBlock(
    splitBlocks(markdown),
    directiveRaw,
    occurrence
  )
  return changed ? joinBlocks(blocks) : null
}

/**
 * 应用/丢弃第 `removedOccurrence` 个 `(sectionId, directiveRaw)` 指令块成功后，把
 * 同一 `(sectionId, directiveRaw)` 下 occurrence 更大的兄弟审阅项就地减一
 * （2026-08 复审 M-1）。
 *
 * 【为什么这是确定性位移，不是位置猜测】`replaceGenImageDirectiveBlock`/
 * `removeGenImageDirectiveBlock` 对指令块数组做的是精确的按下标 splice：删除/替换
 * 第 k 个同内容块后，原本排在它后面的第 j 个（j>k）在新数组里天然变成第 j-1 个，
 * 这是数组下标算术本身决定的，不依赖任何内容启发式。若不同步调整，同一节里有三个
 * （或更多）字面完全相同的指令块时，兄弟审阅卡挂着的旧 occurrence 会在下一次应用/
 * 丢弃时命中错误的、实际属于另一个原始块的新位置——两块时 `applyGenImageToSection`/
 * `discardGenImageFromSection` 会因下标越界安全失败（回 null），但三块起会命中一个
 * 「凑巧还存在」的下标、静默把图落错地方（复审 M-1 实测复现）。
 *
 * 只影响 `sectionId`/`directiveRaw` 都相同的项（不同节或不同指令内容的审阅卡无关，
 * 原样返回）；`occurrence <= removedOccurrence` 的项也原样返回（更早的兄弟不受影响，
 * 被处理的这一项本身应由调用方另行摘除，不归本函数管）。纯函数，不就地修改入参。
 */
export function renumberSiblingGenImageReviews<
  T extends { sectionId: string; directiveRaw?: string; directiveOccurrence?: number }
>(reviews: readonly T[], sectionId: string, directiveRaw: string, removedOccurrence: number): T[] {
  return reviews.map((r) => {
    if (r.sectionId !== sectionId || r.directiveRaw !== directiveRaw) return r
    const occ = r.directiveOccurrence ?? 0
    return occ > removedOccurrence ? { ...r, directiveOccurrence: occ - 1 } : r
  })
}
