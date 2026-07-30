/**
 * 选区 → 改写作用域的纯逻辑。
 *
 * 从组件里抽出来单独一份，是因为「跨节怎么吸附、序号怎么夹」这类判定一旦错了，
 * 用户看到的是「改了隔壁段落」这种事后无法自证的损坏，而组件目录不在 `bun test`
 * 的执行范围内（只跑 electron/、src/chat/lib、src/chat/composer）——留在组件里
 * 等于留一块测试盲区。DOM 那半截（closest 找块容器）留在组件里，这里零 DOM。
 */

/**
 * 「这几块看起来还是用户当初选中的那几块吗」的最低门槛。
 *
 * 只在**重定位失败后走兜底 range** 那条路上用（见 handleWritingTurnEnd）。为什么不能直接
 * 用 `locateBlockRangeByTextWithHint` 那套 indexOf 包含判定：那正是刚刚失败的那一个——
 * 选中文字来自**渲染后的 DOM**（没有 `**`、`` ` ``、`[]()`），块源码里有，去空白后
 * indexOf 必然落空。**用包含判定当兜底校验，等于把「格式化选区」这个最常见的良性情况
 * 一并拒掉**，而兜底存在的意义恰恰就是接住它。
 *
 * 故改判**字符覆盖率**：选中文字的每个字符（去空白后）能否在块源码里找到对应的一个。
 * 良性情况下覆盖率恒为 1.0——渲染文本的字符全部来自源码，markdown 标记只会给源码
 * **多加**字符、绝不拿走选中文字里的字符。而块换了个段落时，覆盖率会掉到很低
 * （中文里 `的``了` 这种高频字带来的偶然重合远达不到阈值）。
 *
 * 归一方式与 `locateAllBlockRanges` 保持一致（`\s+ → ''`），不另造一套。
 */
const SELECTION_COVERAGE_MIN = 0.8

/**
 * 兜底校验：`sliceMarkdown`（按兜底 range 切出来的块源码）是否大致还是 `selectedText`
 * 当初选中的那段。空切片（越界）与空选区一律 false——宁可让用户重选，也不能拿一张
 * 左边是空白或错内容的对照卡骗他点「应用」。
 */
export function sliceCoversSelection(sliceMarkdown: string, selectedText: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const need = norm(selectedText)
  const have = norm(sliceMarkdown)
  if (!need || !have) return false
  // 多重集合求交：每个字符按出现次数消耗，避免「块里有一个『的』就覆盖选区里十个『的』」。
  const pool = new Map<string, number>()
  for (const ch of have) pool.set(ch, (pool.get(ch) ?? 0) + 1)
  let covered = 0
  let total = 0
  for (const ch of need) {
    total += 1
    const n = pool.get(ch) ?? 0
    if (n > 0) {
      pool.set(ch, n - 1)
      covered += 1
    }
  }
  return covered / total >= SELECTION_COVERAGE_MIN
}

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
