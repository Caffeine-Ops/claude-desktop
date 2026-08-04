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
