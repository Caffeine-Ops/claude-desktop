/**
 * 出图 / 改图的审阅卡与任务态类型。原本住在 stores/proposal.ts，2026-08-03 搬到
 * 这里——写作工作区要复用同一套卡片组件，让它 import 提案的 store 模块只为拿两个
 * 类型，会把两个 feature 的依赖方向拧成环（写作 store → 提案 store）。
 *
 * 只有类型，没有运行时代码：两边各自的 store 持有各自的实例，互不共享状态。
 */

// 点图工具栏（Task 9）发起改图/生成后的「待审阅」项，挂在数组里（非 blockReviews 那种以助手
// 消息 id 为 key——图片操作不经 SDK 轮，没有 messageId 可挂）。Task 11 在此之上渲染「原图 vs
// 新图」对照卡 + 应用/放弃。id 由 addImageReview 生成（crypto.randomUUID()），供 Task 11 增删。
// 瞬时 UI 信号，不持久化（同 blockReviews：未决的图片改写不该跨会话留存）。
export interface ImageReview {
  id: string
  sectionId: string
  blockIndex: number
  sourcePath?: string // mode='generate'/'directive' 时没有源图，故可空
  resultPath: string
  // 'directive' = genimage 指令块自动生图（配图密度③）：应用=原地替换指令块，丢弃=删指令块，
  // 与 'generate'（追加插入到 blockIndex 之后）落位语义不同，必须分流。
  mode: 'edit' | 'generate' | 'directive'
  // mode='edit' 时，源图在该块内【同路径出现序列】里的下标（0 起，来自 ProposalPaper
  // handlePaperClick 从 DOM 数出的 imgSel.occurrence）——应用时喂给 replaceImageOccurrence
  // 精确定位换哪一张（同一块贴了两张同路径图时不误换）。mode='generate' 没有源图、无意义，
  // 缺省即可（Task 11 应用逻辑按 mode 分流，不读 generate 项的这个字段）。
  occurrence?: number
  // mode='directive'：指令块原文（trim）+ 同内容出现序——落位手术按内容键定位（块序漂移免疫，
  // 见 shared/proposalGenImage.ts 顶注），blockIndex 只用于审阅卡渲染锚定。
  directiveRaw?: string
  directiveOccurrence?: number
  // mode='directive'：图说，落位时作 `![图说](路径)` 的 alt 文字。
  caption?: string
  /**
   * 写作侧专属（2026-08 复审 C-1 补）：`WRITING_IMAGE_GENERATE` 回的 `../images/<文件名>`
   * 相对路径——**落位写进正文时必须用这个，不能用 `resultPath`**。`resultPath` 是绝对路径，
   * 只给审阅卡预览 `<img>` 用（经 `writingasset://` 协议转换显示）；把绝对路径直接写进
   * markdown 会让「项目文件夹整体搬走/发给别人」后引用全断（`writingImageWriter.ts` 里
   * `relPath` 存在的唯一理由就是保这份可移植性），路径含空格时更糟——mdast 会把整行
   * `![图](/Users/k/我的 项目/images/x.png)` 解析成纯文本而非图片节点，图永远出不来、
   * 源码字面量永久卡在草稿里，且不含空格时预览照样正常（因为 `isWritingAssetSrc` 认
   * 绝对路径），走查根本抓不到。提案侧没有这个字段——提案的产出图落在会话内存草稿里，
   * 从不需要相对路径可移植性；这是写作独有的磁盘落位需求。可选（不是全部生产者都填得出，
   * 理论上兜底缺省时应用会直接失败，同 `directiveRaw` 缺失一视同仁）。
   */
  relPath?: string
}

// genimage 指令块的生图任务态（配图密度③）。键 = genImageDirectiveKey(sectionId, raw, occurrence)。
// 三重职责：① 幂等 seen 集合——键存在（无论何态）即不再自动发起，防重复烧钱；② 驱动指令块卡片
// 的多态渲染（pending 转圈 / failed 错误+重试 / done 提示看审阅卡 / manual 手动生成）；③ restore
// 重建路径把既存指令块预登记成 manual 哨兵 → 卡片渲染成手动态、autoFire 永不自动补发（终审 I-1）。
// 瞬时 UI 信号，不持久化（与 imageReviews 同重置点清空）。
export interface GenImageJob {
  // manual = restore 重建时预登记的「旧指令块」哨兵（见 seedManualGenImageJobs）：autoFire 视为
  // 已见永不自动发起，卡片渲染成手动生成态；用户点按钮时被 fireGenImageDirective 覆写回 pending。
  status: 'pending' | 'failed' | 'done' | 'manual'
  error?: string
}
