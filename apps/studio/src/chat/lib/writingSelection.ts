/**
 * 选区 → 改写作用域的纯逻辑。
 *
 * 从组件里抽出来单独一份，是因为「跨节怎么吸附、序号怎么夹」这类判定一旦错了，
 * 用户看到的是「改了隔壁段落」这种事后无法自证的损坏，而组件目录不在 `bun test`
 * 的执行范围内（只跑 electron/、src/chat/lib、src/chat/composer）——留在组件里
 * 等于留一块测试盲区。DOM 那半截（closest 找块容器）留在组件里，这里零 DOM。
 */

/**
 * 兜底校验的最小选区长度（归一后的字符数），**中文档**。
 *
 * 短选区在任何「字符层面」的判据下都会失真——4 个常用汉字在随便一段中文里几乎必然凑得齐，
 * 判据恒真、等于没判。这条门槛把它们直接判否：**代价不对称**——判错方向（假阴性）只是让
 * 用户重选重发一次，判错另一头（假阳性）是相邻段落被整块覆盖、无备份无撤销。
 */
const SELECTION_MIN_CHARS = 12

/**
 * 同上，**拉丁/数字档**。为什么要分档、为什么差这么多倍：
 *
 * 子序列判据的强度 ≈ Σ 1/p（每个字符在切片里的出现频率）。中文常用字 p≈0.1%~1%，一个 12 字
 * 的选区期望要上千字的切片才凑得齐；拉丁字母 p≈5%~12%、阿拉伯数字统共只有 10 个符号，
 * `1/p` 只有 8~20，12 个字母的选区期望 200 字符就凑齐了。**这是字符集大小决定的，调参救不了。**
 *
 * 蒙特卡洛实测（真实语料）的假阳性率：
 * ```
 *   选区归一长度        切片 300   切片 600   切片 1200
 *   中文 12 字           —         0.17%      0.39%
 *   英文 12 字母         38.0%     66.4%      81.0%
 *   英文 20 字母         5.8%      37.7%      68.1%
 *   英文 60 字母         —         —          3.7%
 * ```
 * 60 是由实测表倒推的下限，这里取更保守的 **80**：兜底本就是 relocate 失败后的最后一道闸，
 * 代价不对称；而纯英文/数据类的短选区本来 relocate 成功率就高（英文稿标记密度低），
 * 提高门槛的误拒代价小。
 *
 * 数字密集的中文同样落在这一档——实测「2026年Q3营收增长12%」「12%毛利率38%客户91%」这类
 * 14 字选区会被无关的经营数据段放行，而 `workplace-writing` 快道（周报/述职）正是这类文本。
 * 故分档看的是「CJK 占比」而非「有没有中文」。
 */
const SELECTION_MIN_CHARS_LATIN = 80

// CJK 统一表意文字基本区。只用来分档，不追求覆盖全部扩展区——扩展区字符同样是低频字，
// 落进拉丁档只会更严，方向是安全的。
const CJK_CHAR = /[一-鿿]/

/**
 * 这段选中文字**够不够长**到可以拿去做兜底校验。按字符集自适应（理由见两个常量的注释）。
 *
 * 单独导出而不是藏在 {@link sliceCoversSelection} 里：调用方要据此分出**对因的提示文案**——
 * 「选区太短」时正文可能一个字都没变，若统一提示「内容变化太大」，用户会去找一个不存在的变化。
 */
export function isSelectionLongEnoughForFallback(selectedText: string): boolean {
  const need = [...selectedText.replace(/\s+/g, '')]
  if (need.length === 0) return false
  const cjk = need.filter((c) => CJK_CHAR.test(c)).length
  const min = cjk / need.length >= 0.5 ? SELECTION_MIN_CHARS : SELECTION_MIN_CHARS_LATIN
  return need.length >= min
}

/**
 * 兜底校验：`sliceMarkdown`（按兜底 range 切出来的块源码）是否**确实还是** `selectedText`
 * 当初选中的那段。只在**重定位失败后走兜底 range** 那条路上用（见 handleWritingTurnEnd）。
 *
 * 判据 = 归一后「选中文字是块源码的**子序列**」+ 选区够长（{@link isSelectionLongEnoughForFallback}）。
 * 归一方式与 `locateAllBlockRanges` 一致（`\s+ → ''`），不另造一套。
 *
 * **为什么不能用 `indexOf` 包含判定**：那正是刚刚失败的那一个——选中文字来自**渲染后的 DOM**
 * （没有 `**`、`` ` ``、`[]()`），块源码里有，去空白后连续匹配必然落空。用它当兜底校验，
 * 等于把「格式化选区 + 正文其实没变」这个最常见的良性情况一并拒掉，而兜底存在的意义恰恰
 * 是接住它。子序列正是包含判定的**最小必要放宽**：只允许源码在选中文字的字符之间**插入**
 * 标记字符，不允许换顺序、不允许缺字。
 *
 * **良性侧「绝大多数情况成立」，不是恒成立——别把它当不变量用。** 真实 Chrome + 本仓渲染链
 * 实测出四类良性误拒（都 fail-closed，用户重选一次即可，可接受）：
 *  1. HTML 实体解码：源码 `&lt;` 渲染成 `<`，选中的 `<` 在源码里找不到；
 *  2. **CSS `text-transform`**：本仓真有两处——表头 `th` 的 uppercase 让英文表头选出来是
 *     `STAGE`（源码里是 `Stage`）、语言 chip 的 lowercase；DOM 选区拿的是**渲染后**的形态；
 *  3. 渲染器注入的界面文字：无语言围栏的 `text` chip、markdown 围栏注入的「小结」等，
 *     这些字压根不在源码里；
 *  4. 选区太短（被上面的长度门槛挡下）。
 *
 * **为什么不是「字符覆盖率 ≥ 某个比例」**（本判据的上一版，实测被打穿、已废弃）：
 * 多重集合覆盖率既不看顺序、也只按选区长度归一而不看切片长度，而兜底切片通常远长于用户
 * 选区——正是假阳性最容易发生的方向。实测反例：职场周报里句式平行的相邻段（「把交付周期
 * 从四周压缩到两周」vs「…把交付周期从两周压缩到一周…」）覆盖率 0.923；4 字短选区对无关
 * 中文段 1.000；英文短选区对无关英文长段 0.882。子序列判据把这三条全部挡下（顺序对不上 /
 * 长度不达标）。
 *
 * **已知盲区（Task 11 之前不修）**：选区一旦超过拉丁档门槛，子序列对拉丁/数字密集文本仍然
 * 偏弱（见 {@link SELECTION_MIN_CHARS_LATIN} 的实测表——字符集小就是会这样）。长度门槛把
 * 高危区间切掉了，但没有把判据变强。**本文件的整套兜底校验都是 Task 11（在 pendingRevision
 * 里存下提交那刻的块源码切片、改成源码级精确匹配）到位之前的临时闸**，那之后应连同
 * `sliceCoversSelection` 一起删除，不要把它当长期设计沉淀下来。
 *
 * **为什么不用「双向覆盖率」或「切片长度 ≤ 选区长度 × K」这两种长度守卫**：两者都会误伤
 * 良性情况。双向覆盖率要求切片的字符也都在选区里，而源码必然多出标记字符，格式化选区一律
 * 被拒；长度比值守卫则忽略了「作用域是整块、用户常常只选块里的一句话」——长段落里选一句，
 * 切片本就比选区长好几倍，属正常。子序列是**顺序**守卫，能挡住长切片白送，又不误伤这两类。
 *
 * 空切片（越界）与过短/空选区一律 false——宁可让用户重选，也不能拿一张左边是空白或错内容的
 * 对照卡骗他点「应用」。
 */
export function sliceCoversSelection(sliceMarkdown: string, selectedText: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, '')
  // 展开成码点数组（`[...s]` 而非 s[i]）：中文、emoji 不能按 UTF-16 码元切。
  const need = [...norm(selectedText)]
  const have = [...norm(sliceMarkdown)]
  if (have.length === 0 || !isSelectionLongEnoughForFallback(selectedText)) return false
  // 贪心子序列匹配：对「是否为子序列」这个判定，最早匹配是最优且完备的（不会漏判）。
  let i = 0
  for (const ch of have) {
    if (ch === need[i]) {
      i += 1
      if (i === need.length) return true
    }
  }
  return false
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
