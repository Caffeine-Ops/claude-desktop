// 写作工作区的共享纯逻辑。main 与 renderer 共用此文件，保证两端对「体裁怎么判、节怎么排、
// 改写结果怎么抽」用同一份判定——两边各写一份必然漂移（proposal 的哨兵放 shared 是同一理由）。
// 零 IO、零 electron 依赖：bun test 在无 electron 的进程里跑。

import { PROPOSAL_PAGEBREAK } from './proposal'

/**
 * 文档源。写作有两种形态，下游一律只认这个判别联合，不再各自判断：
 *  - project：主管线 / 优化改写类工作流建的项目目录，正文在 <projectDir>/drafts/*.md
 *  - single ：职场快道 / 去AI化的单文件成稿（<cwd>/写作/<标题>.md）
 */
export type WritingDocSource =
  | { kind: 'project'; projectDir: string }
  | { kind: 'single'; filePath: string }

/**
 * 排版体裁。前三个取自 spec_lock.md 的 genre 字段；`workplace` 是**默认档**，
 * 覆盖两种情况：单文件模式，以及职场快道的长稿项目（它建目录但刻意不建 spec_lock）。
 */
export type WritingGenre = 'wechat' | 'short-story' | 'article' | 'workplace'

/** 轮询回来的节文件元信息（不含正文——每 2s 搬万字正文没必要）。 */
export interface WritingFileMeta {
  name: string
  mtimeMs: number
  size: number
  /**
   * 纳秒精度的 mtime（`statSync(p, { bigint: true }).mtimeNs` 转成 string——BigInt
   * 虽然 Electron 的 structured clone 认得，但不该指望它，且绝不能直接过 JSON）。
   * **轮询判定「文件变没变」专用**：`mtimeMs` 精度不够，若改写后新内容长度恰好与旧内容
   * 相同、且文件系统在同一毫秒内完成两次写入，`name:mtimeMs:size` 拼出的签名会与上一轮
   * 一致，判定「未变化」而跳过拉正文——静默漏刷，界面停在旧内容且不报错。纳秒精度下
   * 「等长改写 + 同一纳秒写入」不可能同时成立，缺口被彻底堵死。**不要用内容哈希替代**：
   * 那需要每轮读全部文件内容，等于把「scan 只回元信息、正文按需拉」的设计意义清空
   * （长篇小说每 2 秒读一遍全文）。只用于签名比对，不做数值运算，故存 string 足够。
   */
  mtimeNs: string
}

/** 带正文的一节。mtimeMs 是读取那一刻的值，写回时当乐观锁的比对基准。 */
export interface WritingSection {
  name: string
  markdown: string
  mtimeMs: number
}

const GENRES: readonly WritingGenre[] = ['wechat', 'short-story', 'article', 'workplace']

// `- genre: short-story` / `-  genre ： wechat`。全角冒号要认：契约模板是中文文档，
// 用户手改时打出全角冒号是常态，认不出就整篇掉进默认档、排版突然变样且无任何报错。
const GENRE_LINE = /^\s*-\s*genre\s*[:：]\s*(\S+)\s*$/m

/**
 * spec_lock.md 正文 → 体裁。读不到文件（null）、没有该字段、值不在白名单内，
 * 一律退回 `workplace` 默认档。**不信任任意字符串**：genre 直接决定排版分支，
 * 放一个野值进去会让下游 switch 落进 default 之外的空隙。
 */
export function parseWritingGenre(specLockText: string | null): WritingGenre {
  if (!specLockText) return 'workplace'
  const m = GENRE_LINE.exec(specLockText)
  const v = m?.[1]
  return v && (GENRES as readonly string[]).includes(v) ? (v as WritingGenre) : 'workplace'
}

// 大纲段落标题。真实模板（skills/writing/templates/design_spec_reference.md）里写的是
// 「## V. 内容大纲（分节表）」——带罗马数字编号和括号后缀，精确匹配 `## 大纲` 必然落空。
// 这里放宽成「二级标题里含‘大纲’二字」，只圈段落范围，不管标题剩余部分长什么样。
const OUTLINE_HEADING = /^##\s+.*大纲/m
// 只数「## 大纲」到下一个二级标题之间这一段之内的，免得把文档别处的标题/表格也算进去。
const SECTION_HEADING = /^###\s+\S/gm
// 大纲表格行：真实模板里节次不是三级标题，而是 markdown 表格的一行——
// `| 第1节 | 600 | 抛谜面… | 好奇被吊起… |`。行首为 `|`，紧跟「第N节」单元格
// （容忍「第」与数字、数字与「节」之间有空格——用户手填表格时的常见写法）才算一条真实节次；
// 表头行 `| 节次 | 字数 | … |` 和分隔行 `|---|---|…` 的首格都不是「第N节」，天然不会被计入，
// 不需要额外排除逻辑。
const TABLE_SECTION_ROW = /^\|\s*第\s*\d+\s*节\s*\|/gm

/**
 * design_spec.md 正文 → 大纲节数（用于纸面末尾的「正在写第 N 节 · 共 M 节」）。
 * **解析不到返回 null，不猜数字**：显示一个错的总数比不显示更糟——用户会以为还差两节，
 * 其实已经写完了。null 时 UI 降级成「正在写下一节…」。
 *
 * 两种节次形态都认，取**较大值而非相加**：
 *  - 表格行（`| 第1节 | … |`）——真实模板（design_spec_reference.md）的主路径。
 *  - `### 第N节` 三级标题——真实模板不这么写，但用户手改 design_spec 时可能这么写，留作兼容。
 * 两者若同时出现，只可能是同一份大纲被写成了两种形式的重复表达（例如正文用表格、
 * 附带了一份三级标题目录），相加会让节数直接翻倍；取较大值总是落在「更完整地数了一遍」那个。
 */
export function parseOutlineTotal(designSpecText: string | null): number | null {
  if (!designSpecText) return null
  const start = OUTLINE_HEADING.exec(designSpecText)
  if (!start) return null
  const rest = designSpecText.slice(start.index + start[0].length)
  // 大纲段落到下一个二级标题为止
  const nextH2 = /^##\s+/m.exec(rest)
  const segment = nextH2 ? rest.slice(0, nextH2.index) : rest
  const headingMatches = segment.match(SECTION_HEADING)
  const tableMatches = segment.match(TABLE_SECTION_ROW)
  const total = Math.max(headingMatches?.length ?? 0, tableMatches?.length ?? 0)
  return total > 0 ? total : null
}

// 「## 配图」段（spec_lock_reference.md：段名固定，逐字对齐，见该模板顶注）。
const IMAGE_SECTION_HEADING = /^##\s*配图\s*$/m
// `- image_style: 极简线条插画，低饱和暖色` / 全角冒号同 GENRE_LINE 一样要认。
// **刻意不剥尾部注释**（2026-08 审查 M-1 修复前的版本曾试图剥 `\s+#.*`，被审查者
// 实测证伪）：真实模板（spec_lock_reference.md）里带尾注释对齐的只有 `image_plan`
// 和 `image_count` 两行，`image_style` 这一行从来不带。`image_style` 是自由文本
// 创作性字段，画风描述本身完全可能含 `#`（配色 hex 码、话题标签），一旦尝试用
// `#` 切注释，`- image_style: 低饱和暖色，主色 #E8A33D` 会被腰斩成「低饱和暖色，
// 主色」——颜色信息丢失且零报错，全篇配图颜色跑偏。宁可将来某人手滑在这行后面加一句
// `# 备注`被整段当成风格描述的一部分（无害，最多让提示词多几个字），也不能砍错。
const IMAGE_STYLE_LINE = /^\s*-\s*image_style\s*[:：]\s*(.+)$/m

/**
 * spec_lock.md 正文 → 配图段的 image_style 字段（生图提示词里的画风约束，见
 * buildWritingGenImagePrompt）。文件不存在、没有「## 配图」段、段内没有该字段——三种都
 * 回 null，且三种都是正常态：职场快道刻意不建 spec_lock；`image_plan: none` 时按模板
 * 约定（spec_lock_reference.md）这两行本就留空。**不猜画风**：拼错的风格句会让生图
 * 结果偏离契约约定，宁可让提示词退化成"没有额外风格要求"（buildWritingGenImagePrompt
 * 对空串的处理），也不要塞一个编造的默认风格进去。
 */
export function parseImageStyle(specLockText: string | null): string | null {
  if (!specLockText) return null
  const start = IMAGE_SECTION_HEADING.exec(specLockText)
  if (!start) return null
  const rest = specLockText.slice(start.index + start[0].length)
  // 配图段落到下一个二级标题为止，同 parseOutlineTotal 的段落收口写法。
  const nextH2 = /^##\s+/m.exec(rest)
  const segment = nextH2 ? rest.slice(0, nextH2.index) : rest
  const m = IMAGE_STYLE_LINE.exec(segment)
  const v = m?.[1]?.trim()
  return v ? v : null
}

// `- image_count: 3`。只捕获紧跟在冒号后的数字前缀——不像 image_style 需要纠结尾部
// 注释怎么切，数字本身不可能含 `#`，`(\d+)` 天然只取数字部分，后面不管跟不跟注释
// 都不影响。
const IMAGE_COUNT_LINE = /^\s*-\s*image_count\s*[:：]\s*(\d+)/m
// `- image_plan: none` / `cover-only` / `inline`。三选一，这里只关心 none 和
// cover-only 两个会覆写上限的取值——是其中之一就直接决定 cap，不管 image_count
// 那行写了什么。
const IMAGE_PLAN_LINE = /^\s*-\s*image_plan\s*[:：]\s*(\S+)/m

/**
 * spec_lock.md 正文 → 配图段的 image_count 字段（本篇配图张数上限，见
 * spec_lock_reference.md「配图」段说明：「生图是要花钱的，这是第一道闸（第二道在
 * 桌面端的自动触发上限）」）。文件不存在 / 没有「## 配图」段 / 字段缺失或不是合法数字
 * ——都回 null，由调用方（autoFireWritingGenImages）退回桌面端自己的默认上限
 * MAX_AUTO_FIRE_PER_WRITING_PROJECT。
 *
 * **三条 2026-08 审查修复（m-1 / m-4），都是"契约只能收紧、不能放宽"这条承诺本身
 * 要求的**：
 * ① `image_count: 0` 是合法值（"这篇一张都不要"），不再退化成 null→回退默认 5——
 *    0 与正整数一样是"契约给出的明确上限"，只有负数/非数字才算野值、才回 null。
 * ② `image_plan: none` 时无条件把上限压成 0，不看 image_count 字段写了什么。按模板
 *    约定 `image_plan: none` 时 image_count/image_style 两行本就该留空，但写手偶尔
 *    会残留陈旧数值（例如策划中途从"配图"改成"不配图"、忘记删掉这两行）；若照抄那个
 *    残留数字当上限，"这篇根本不配图"这个最常见、最该被闸住的场景反而完全不受契约
 *    约束——不信任任何可能过期的字段组合，`none` 这个显式声明优先级最高。
 * ③ `image_plan: cover-only` 时无条件把上限压成 1——模板定义"只配封面"就是恰好
 *    一张（`image_count` 含封面一起算，也就是 cover-only 下 image_count 本该等于
 *    1）。与 ② 同一逻辑：不信任 image_count 可能残留的陈旧数值，`cover-only` 这个
 *    显式声明本身就该决定上限，不用去读那个数字对不对。
 */
export function parseImageCount(specLockText: string | null): number | null {
  if (!specLockText) return null
  const start = IMAGE_SECTION_HEADING.exec(specLockText)
  if (!start) return null
  const rest = specLockText.slice(start.index + start[0].length)
  const nextH2 = /^##\s+/m.exec(rest)
  const segment = nextH2 ? rest.slice(0, nextH2.index) : rest
  const plan = IMAGE_PLAN_LINE.exec(segment)?.[1]
  if (plan === 'none') return 0
  if (plan === 'cover-only') return 1
  const m = IMAGE_COUNT_LINE.exec(segment)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// 文件名前导数字。写手按 SKILL.md「一节一文件，按序命名」产出，实际形态有
// `1-开场.md`、`01-开场.md` 两种，都得按数值排。
const LEADING_NUM = /^(\d+)/

/**
 * 节文件名排序。**按数值而非字典序**：字典序会把 `10-x.md` 排到 `2-x.md` 前面，
 * 正文顺序当场错乱且毫无报错。无数字前缀的（如 `附录.md`）统一排在带前缀的之后、
 * 内部按字典序——它们不属于主线节次，钉在尾部比穿插进正文安全。
 */
export function sortSectionNames(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const na = LEADING_NUM.exec(a)
    const nb = LEADING_NUM.exec(b)
    if (na && nb) {
      const d = Number(na[1]) - Number(nb[1])
      return d !== 0 ? d : a.localeCompare(b)
    }
    if (na) return -1
    if (nb) return 1
    return a.localeCompare(b)
  })
}

/**
 * 分页标记。**直接复用 proposal 的 `PROPOSAL_PAGEBREAK` 本体**（而非另定义一个字符串常量）：
 * `markdownToDocxBuffer`（proposalDocx.ts `case 'html'`）用 `node.value.trim() === PROPOSAL_PAGEBREAK`
 * 做逐字节比对来插入 Word 分页符，两边若各写一份、哪怕只差一个空格（曾经的真实 bug：这里写的是
 * `'<!-- pagebreak -->'`，proposal 那边是 `'<!--proposal-pagebreak-->'`），比对就永远不命中——
 * 分页标记会原样降级成一行可见文本「<!-- pagebreak -->」躺进导出的 Word 里，小说体裁的每章分页
 * 静默失效，且没有任何报错。
 */
const PAGE_BREAK = PROPOSAL_PAGEBREAK

/** 各节拼成完整 markdown。`pageBreaks` 时在**节之间**插分页标记（首节前不插，否则多一张空白首页）。 */
export function joinWritingSections(
  sections: WritingSection[],
  opts: { pageBreaks: boolean }
): string {
  const parts = sections.map((s) => s.markdown.trim()).filter((s) => s.length > 0)
  if (parts.length === 0) return ''
  const sep = opts.pageBreaks ? `\n\n${PAGE_BREAK}\n\n` : '\n\n'
  return parts.join(sep)
}

/**
 * 该体裁导出时是否每节起新页。小说的「节」是章节，理应翻页；文章与职场文档的「节」
 * 只是小标题段落，强行分页会把一份两页的周报撑成六页。
 */
export function shouldPageBreak(genre: WritingGenre): boolean {
  return genre === 'short-story'
}

// 选区改写的哨兵。形态与 proposal 的 `===方案正文开始===` 同源：在聊天里显示为普通文本
// （react-markdown 无 rehype-raw，整行含 CJK 不会被当 setext 下划线），不含正则元字符，
// indexOf 扫描即可。
export const WRITING_REVISION_BEGIN = '===改写结果开始==='
export const WRITING_REVISION_END = '===改写结果结束==='

/**
 * 助手回复文本 → 改写后的干净正文。**没有哨兵就返回 null**，绝不把整段回复当正文写进
 * 文件——AI 可能在反问「你想改成什么风格」，那句话落盘就毁了这一节。同理，哨兵之间为空
 * 也返回 null（不拿空内容覆盖原文）。多对哨兵时只取第一对。
 */
export function extractRevisionResult(text: string): string | null {
  const b = text.indexOf(WRITING_REVISION_BEGIN)
  if (b === -1) return null
  const from = b + WRITING_REVISION_BEGIN.length
  const e = text.indexOf(WRITING_REVISION_END, from)
  if (e === -1) return null
  const body = text.slice(from, e).trim()
  return body.length > 0 ? body : null
}
