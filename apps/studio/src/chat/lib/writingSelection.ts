/**
 * 选区 → 改写作用域的纯逻辑。
 *
 * 从组件里抽出来单独一份，是因为「跨节怎么吸附、序号怎么夹」这类判定一旦错了，
 * 用户看到的是「改了隔壁段落」这种事后无法自证的损坏，而组件目录不在 `bun test`
 * 的执行范围内（只跑 electron/、src/chat/lib、src/chat/composer）——留在组件里
 * 等于留一块测试盲区。DOM 那半截（closest 找块容器）留在组件里，这里零 DOM。
 */

/** 选区某一端落在哪一节的第几块。由组件从 data-section-name / data-block-index 读出。 */
export interface WritingBlockRef {
  sectionName: string
  blockIndex: number
}

/** 一次改写的作用域：某一节里的一段连续块区间（含端点）。 */
export interface WritingSelectionScope {
  sectionName: string
  range: { start: number; end: number }
}

/**
 * 由选区两端的块引用算出作用域。
 *
 * 三条规则：
 *  1. **起点缺失 → null**：选区起点没落在任何块上（选到了纸面留白 / 进度骨架），不成立。
 *  2. **跨节吸附到起点所在节**：跨节改写要同时写两个文件、两把乐观锁（每节一个 mtime），
 *     第一版不支持。退化成「只改起点那一块」而不是「改起点节的后半截」——用户选到别的节，
 *     说明他的意图本就超出我们能满足的范围，此时改得少（可再选一次）远比改得多安全。
 *  3. **序号必须是整数**：`Number(attr)` 对脏属性值会给出 NaN，而 NaN 参与的比较全为 false，
 *     会让下游 buildRevisionMessage 的越界检查静默失效、切出错误区间。这里就地挡掉。
 *
 * 终点缺失（选区尾停在块外，例如拖过了纸面底部）按「同起点单块」处理，理由同规则 2。
 */
export function resolveSelectionScope(
  start: WritingBlockRef | null,
  end: WritingBlockRef | null
): WritingSelectionScope | null {
  if (!start || !Number.isInteger(start.blockIndex) || start.blockIndex < 0) return null
  // 写成一整条 && 链而不是先算 boolean 再取值：TS 的窄化跟不过一个中间布尔变量，
  // 分两步会在 `end.blockIndex` 处误报 possibly-null。
  const other =
    end !== null &&
    end.sectionName === start.sectionName &&
    Number.isInteger(end.blockIndex) &&
    end.blockIndex >= 0
      ? end.blockIndex
      : start.blockIndex
  return {
    sectionName: start.sectionName,
    range: {
      start: Math.min(start.blockIndex, other),
      end: Math.max(start.blockIndex, other)
    }
  }
}
