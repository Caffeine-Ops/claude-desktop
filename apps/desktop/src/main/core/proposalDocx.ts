import {
  Document,
  Packer,
  Paragraph,
  PageBreak,
  TextRun,
  HeadingLevel,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  LevelFormat,
  LineRuleType,
  AlignmentType,
  VerticalAlignTable,
  HeightRule,
  BorderStyle,
  Footer,
  PageNumber
} from 'docx'
import { readFileSync } from 'node:fs'
import imageSize from 'image-size'
import type { IStylesOptions, INumberingOptions, ISectionOptions } from 'docx'
import { PROPOSAL_PAGEBREAK, PROPOSAL_SECTION_RE, isEmbeddableImagePath } from '../../shared/proposal'
import type { ProposalKind } from '../../shared/proposal'
import {
  CN_SIZE_PT,
  FONT_DOCX,
  MARGIN_TWIPS,
  defaultProposalStyle,
  type ProposalStyleConfig,
  type ProposalLevelStyle
} from '../../shared/proposalStyle'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type {
  Root,
  RootContent,
  PhrasingContent,
  ListItem,
  TableCell as MdTableCell
} from 'mdast'

/**
 * 把方案 markdown 转成真正的 .docx（方案 B：逐 mdast 节点构造，而非 html 中转）。
 *
 * 为什么走 mdast 而不是 html→docx：对标题层级、有序/无序列表、表格、加粗/斜体有
 * 完全控制，最接近最终 Word 成品。未知节点降级为纯文本段，绝不抛错中断导出。
 *
 * 样式模板（style 参数）：所有字体/字号/对齐/缩进/行距/页边距/列表符号都由传入的
 * ProposalStyleConfig 决定，编译进 Document 的 styles + numbering + section.page。
 * 预览（renderProposal IPC）与导出（exportProposal）传同一份 style，故「预览=导出
 * 逐像素一致」这条不变量在加了模板后依然成立。style 省略时回退默认模板（经典正式），
 * 让任何旧调用点（不传 style）也立刻拿到好看的默认排版，而非 Word 裸默认。
 *
 * 主进程专用（依赖 Node）。renderer 永远只传 markdown 字符串 + 纯数据 style 过来。
 */
const HEADING_BY_DEPTH = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
] as const

// 列表最大嵌套层级（0-indexed）。Word 的有序/无序列表上限是 9 级，故 0..8。
// numbering config 注册到这一级；listItemParagraphs 对超深嵌套 clamp 到此，
// 绝不引用未注册的 level（否则 Word/LibreOffice 报 numbering reference not found）。
const MAX_LIST_LEVEL = 8

// 有序 / 无序列表的 numbering 实例引用名。两者都走 numbering（而非 docx 内置 bullet），
// 这样项目符号字形（●/○/■）与编号格式（1./a./i.）都能由模板配置控制。
const ORDERED_REF = 'proposal-ordered'
const UNORDERED_REF = 'proposal-unordered'

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  justify: AlignmentType.JUSTIFIED
} as const

const OL_FORMAT = {
  decimal: LevelFormat.DECIMAL,
  lowerLetter: LevelFormat.LOWER_LETTER,
  lowerRoman: LevelFormat.LOWER_ROMAN
} as const

const UL_GLYPH = { disc: '●', circle: '○', square: '■' } as const

// A4 页宽（twips，210mm）。嵌图最大宽 = 版心宽（页宽 − 左右页边距），换算成 px（96dpi）。
const A4_PAGE_WIDTH_TWIPS = 11906
// 扩展名 → docx ImageRun 的 type。SVG 不在内（v1 不嵌 SVG，降级文字）。
const IMG_TYPE: Record<string, 'png' | 'jpg' | 'gif'> = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif'
}

// 西文/中文双字体：eastAsia 给中文字形，ascii/hAnsi 给西文与数字，观感协调。
function runFont(name: ProposalLevelStyle['font']): { ascii: string; eastAsia: string; hAnsi: string } {
  const f = FONT_DOCX[name]
  return { ascii: f.ascii, eastAsia: f.eastAsia, hAnsi: f.ascii }
}

// 内联样式累积：递归下传 bold/italics/code 标志，叶子 text 据此产出 TextRun。
interface InlineStyle {
  bold?: boolean
  italics?: boolean
  code?: boolean
}

// 块级上下文：blockquote 把「左缩进 + 斜体基样式」下传给递归出来的子块，
// 从构造时就带上——而不是事后拿 Paragraph 改（docx 的 Paragraph 构造后不可变，
// 也正是 A1 数据损坏的根因：旧实现丢弃 blockToDocx(child) 的结果重建段落，
// 把嵌套 list 压平/重复、把 table 打成乱段）。
interface BlockContext {
  indent?: { left: number }
  baseStyle?: InlineStyle
  // 强制段落水平对齐（封面节用 CENTER 覆盖模板自带 align，使标题/落款都居中）。
  forceAlign?: (typeof AlignmentType)[keyof typeof AlignmentType]
}

// 遍历级环境：跨整篇文档共享的状态 + 由 style 预算出的常量。
//  - walk.titleConsumed：「文档里第一个一级标题」用封面标题样式（ProposalTitle），
//    其余一级标题用 Heading1。真实方案的封面大标题就是首个 `#`，故以此规则把它单独
//    放大居中，无需在 markdown 里另加标记。
//  - bodyFirstLine：正文首行缩进 twips，只施加在正文段落上（不进 Normal 样式，
//    以免列表项/标题继承到首行缩进）。
interface WalkEnv {
  walk: { titleConsumed: boolean }
  bodyFirstLine: number
  // 当前模板的页边距（twips），嵌图算版心宽用。
  imgMarginTwips: number
  // 未接地图的绝对路径全集（接地闸门）：命中的图不嵌入、降级为带标注的文字占位。
  // 由 collectUngroundedImagePaths（main）算好传入；缺省（裸调用 / 无索引）→ 不挡任何图。
  ungroundedImagePaths?: ReadonlySet<string>
}

function inlineRuns(nodes: PhrasingContent[], style: InlineStyle = {}): TextRun[] {
  const runs: TextRun[] = []
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        runs.push(
          new TextRun({
            text: n.value,
            bold: style.bold,
            italics: style.italics,
            font: style.code ? 'Consolas' : undefined
          })
        )
        break
      case 'strong':
        runs.push(...inlineRuns(n.children, { ...style, bold: true }))
        break
      case 'emphasis':
        runs.push(...inlineRuns(n.children, { ...style, italics: true }))
        break
      case 'inlineCode':
        runs.push(new TextRun({ text: n.value, font: 'Consolas', bold: style.bold }))
        break
      case 'link':
        // 链接降级为其可见文本（方案文档极少需要可点击超链接；保内容不保交互）。
        runs.push(...inlineRuns(n.children, style))
        break
      case 'break':
        runs.push(new TextRun({ break: 1 }))
        break
      default:
        // 其它内联节点（image 等）：取其 children 文本兜底，无 children 则忽略。
        if ('children' in n && Array.isArray(n.children)) {
          runs.push(...inlineRuns(n.children as PhrasingContent[], style))
        }
    }
  }
  return runs.length ? runs : [new TextRun('')]
}

// 列表项 → 段落数组。ordered / unordered 都引用各自的 numbering 实例（编号格式与项目
// 符号字形由模板的 ol/ul 决定）；嵌套靠 level。baseStyle 用于引用块内的列表（斜体）。
// 缩进交给 numbering 各级的 indent，不另加 indent.left，避免覆盖编号自带缩进。
function listItemParagraphs(
  item: ListItem,
  ordered: boolean,
  level: number,
  baseStyle?: InlineStyle
): Paragraph[] {
  const out: Paragraph[] = []
  // 超过 Word 上限的深层嵌套 clamp 到 MAX_LIST_LEVEL：宁可让最深几级共用同一编号级别，
  // 也绝不引用未注册的 level（那会让 Word 打开时报 numbering reference not found）。
  const safeLevel = Math.min(level, MAX_LIST_LEVEL)
  for (const child of item.children) {
    if (child.type === 'paragraph') {
      out.push(
        new Paragraph({
          children: inlineRuns(child.children, baseStyle),
          numbering: { reference: ordered ? ORDERED_REF : UNORDERED_REF, level: safeLevel }
        })
      )
    } else if (child.type === 'list') {
      // 嵌套列表：递归，level+1。
      for (const sub of child.children) {
        out.push(...listItemParagraphs(sub, Boolean(child.ordered), level + 1, baseStyle))
      }
    }
  }
  return out
}

function tableCellContent(cell: MdTableCell): Paragraph[] {
  return [new Paragraph({ children: inlineRuns(cell.children) })]
}

// 一个 image mdast 节点 → docx 段落数组：成功则 [居中 ImageRun 段, 居中图说段]；
// 不可嵌（svg/未知扩展/读盘失败/尺寸读不出）则降级为 [「[图：alt]」文字段]，绝不抛错。
// maxWidthPx 为版心宽（px），图按原始像素等比缩放到不超过它。
function imageParagraphs(
  alt: string,
  path: string,
  maxWidthPx: number,
  ungrounded = false
): Paragraph[] {
  const caption = (alt || path.slice(path.lastIndexOf('/') + 1)).trim()
  const degrade = (): Paragraph[] => [
    new Paragraph({ children: [new TextRun({ text: `[图：${caption}]`, color: '9a9a9e' })] })
  ]
  // 接地闸门：未接地图（不属本节所引文件 assets，疑似挪用 / 无关装饰）即便文件在盘上也【不嵌入】，
  // 降级为带标注的文字占位——让「图与文同源」这条接地底线成为导出的强制闸门，而非仅 UI 红条
  // （评审：接地是安全底线，却没建在导出必经收口上，ungrounded 图照样进交付 Word）。
  if (ungrounded) {
    return [
      new Paragraph({
        children: [
          new TextRun({ text: `[图（未接地·疑似挪用，已据接地校验略去）：${caption}]`, color: '9a9a9e' })
        ]
      })
    ]
  }
  // 「能否进 Word」由 shared 的 isEmbeddableImagePath 统一判定（与预览侧 AssistantMarkdown 的
  // KB 图 <img> 同源），保证「预览=导出一致」：webp/svg/无扩展名两侧都降级文字，绝不出现
  // 「预览有图、成品 Word 没图」的静默丢失（评审发现）。命中后再取 docx ImageRun 的 type。
  if (!isEmbeddableImagePath(path)) return degrade()
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  const type = IMG_TYPE[ext]
  if (!type) return degrade() // 双保险：isEmbeddableImagePath 为真即 ext∈IMG_TYPE，仍留守卫做类型收窄
  let data: Buffer
  try {
    data = readFileSync(path)
  } catch {
    return degrade() // 读不到 → 降级
  }
  let w: number, h: number
  try {
    const dim = imageSize(data)
    if (!dim.width || !dim.height) return degrade()
    w = dim.width
    h = dim.height
  } catch {
    return degrade() // 尺寸读不出 → 降级
  }
  // 等比缩放：宽超版心则按比例缩小，否则原尺寸。
  const scale = w > maxWidthPx ? maxWidthPx / w : 1
  const width = Math.round(w * scale)
  const height = Math.round(h * scale)
  const out: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({ type, data, transformation: { width, height } })]
    })
  ]
  if (caption) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: caption, size: 18, color: '9a9a9e' })]
      })
    )
  }
  return out
}

// 顶层块节点 → docx 元素（Paragraph | Table）。
// env 跨整篇共享（首个 h1 当封面标题 + 正文首行缩进）；ctx 由 blockquote 下传。
function blockToDocx(node: RootContent, env: WalkEnv, ctx?: BlockContext): Array<Paragraph | Table> {
  switch (node.type) {
    case 'heading': {
      // 文档里第一个一级标题 → 封面标题样式（居中放大）。其余标题按层级套 HeadingN。
      // 守卫改为 !ctx?.baseStyle && !ctx?.indent（而非旧的 !ctx）：封面节传入仅含 forceAlign
      // 的 ctx（truthy），旧的 !ctx 会把封面首个 h1 挡在 Title 分支外；新守卫放行只带
      // forceAlign 的 ctx，仍排除 blockquote 那种带 baseStyle/indent 的 ctx。
      if (node.depth === 1 && !env.walk.titleConsumed && !ctx?.baseStyle && !ctx?.indent) {
        env.walk.titleConsumed = true
        return [
          new Paragraph({
            style: 'Title', // 内置 Title 样式，由 styles.default.title 覆盖（见 buildDocStyles）
            children: inlineRuns(node.children),
            ...(ctx?.forceAlign ? { alignment: ctx.forceAlign } : {})
          })
        ]
      }
      return [
        new Paragraph({
          // 上界 clamp 到 6、下界 clamp 到 0：remark 标准不产 depth0，但万一上游传入
          // depth0 会让 `-1` 索引出 undefined → 标题静默降级普通段、丢目录条目（C3）。
          heading: HEADING_BY_DEPTH[Math.max(0, Math.min(node.depth, 6) - 1)],
          children: inlineRuns(node.children, ctx?.baseStyle),
          indent: ctx?.indent,
          ...(ctx?.forceAlign ? { alignment: ctx.forceAlign } : {})
        })
      ]
    }
    case 'paragraph': {
      // 独占一行的图（children 仅 image，忽略纯空白 text）→ 居中嵌图 + 图说。
      // 混排（图夹在文字中）不在 v1 范围，退回下面的普通段落渲染；其中 image 节点被 inlineRuns
      // 静默忽略（image mdast 无 children、alt 在 .alt 上，default 分支取不到）——v1 不支持混排嵌图。
      const imgs = node.children.filter((c) => c.type === 'image')
      const nonEmpty = node.children.filter(
        (c) => !(c.type === 'text' && c.value.trim() === '')
      )
      if (imgs.length > 0 && nonEmpty.every((c) => c.type === 'image')) {
        // env.imgMarginTwips 已是 twips 值（= MARGIN_TWIPS[style.margin]），直接用、勿再 index。
        const maxWidthPx = Math.round(
          ((A4_PAGE_WIDTH_TWIPS - 2 * env.imgMarginTwips) / 1440) * 96
        )
        const out: Paragraph[] = []
        for (const img of imgs) {
          if (img.type === 'image') {
            // 接地闸门：本图路径在未接地全集里 → imageParagraphs 降级为占位（详见其注释）。
            const isUngrounded = env.ungroundedImagePaths?.has(img.url) ?? false
            out.push(...imageParagraphs(img.alt ?? '', img.url, maxWidthPx, isUngrounded))
          }
        }
        return out
      }
      return [
        new Paragraph({
          children: inlineRuns(node.children, ctx?.baseStyle),
          // 引用块左缩进优先；居中段落（封面）不施加首行缩进；其余正文段落施加模板首行缩进。
          indent:
            ctx?.indent ??
            (ctx?.forceAlign
              ? undefined
              : env.bodyFirstLine
                ? { firstLine: env.bodyFirstLine }
                : undefined),
          ...(ctx?.forceAlign ? { alignment: ctx.forceAlign } : {})
        })
      ]
    }
    case 'list': {
      const out: Paragraph[] = []
      for (const item of node.children) {
        out.push(...listItemParagraphs(item, Boolean(node.ordered), 0, ctx?.baseStyle))
      }
      return out
    }
    case 'blockquote': {
      // 引用：缩进 + 斜体。直接复用 blockToDocx(child) 的递归结果（保留嵌套 list 的
      // 编号/项目符号结构、table 的行列），只把引用上下文下传，绝不拿强转的
      // child.children 重建段落——那正是 A1 丢内容/重复/损坏的根因。
      const quoteCtx: BlockContext = {
        indent: { left: 480 },
        baseStyle: { ...ctx?.baseStyle, italics: true }
      }
      const out: Array<Paragraph | Table> = []
      for (const child of node.children) {
        out.push(...blockToDocx(child, env, quoteCtx))
      }
      return out.length ? out : [new Paragraph({ children: [new TextRun('')] })]
    }
    case 'code':
      // 代码块：逐行等宽段落。
      return node.value
        .split('\n')
        .map(
          (line) =>
            new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] })
        )
    case 'table': {
      const rows: TableRow[] = []
      for (const row of node.children) {
        const cells = row.children.map(
          (cell) =>
            new TableCell({
              children: tableCellContent(cell),
              width: { size: 0, type: WidthType.AUTO }
            })
        )
        // 无单元格的行（畸形/空 GFM 行）会让 docx 在 Packer 阶段抛错、整篇导出与预览
        // 全文失败。补一个空单元格降级，与本文件其它分支「绝不抛错中断导出」的契约一致
        // （评审发现 5）：宁可多一个空格，也不让一张坏表打掉整篇文档。
        if (cells.length === 0) {
          cells.push(
            new TableCell({
              children: [new Paragraph({ children: [new TextRun('')] })],
              width: { size: 0, type: WidthType.AUTO }
            })
          )
        }
        rows.push(new TableRow({ children: cells }))
      }
      // 整张表没有任何行（同样会让 Packer 抛错）→ 直接忽略，不产出空 Table。
      if (rows.length === 0) return []
      return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })]
    }
    case 'html':
      // 块级 html 节点：唯一我们关心的是分页标记（renderer 拼接时插在 kind 边界）。
      // 命中 → 产一个只含 PageBreak 的段落，得到真分页；其它 html（用户极少在方案里写）
      // 降级为可见文本，不静默吞。
      if (node.value.trim() === PROPOSAL_PAGEBREAK) {
        return [new Paragraph({ children: [new PageBreak()] })]
      }
      return [new Paragraph({ children: [new TextRun(node.value)] })]
    case 'thematicBreak':
      return [new Paragraph({ children: [new TextRun('———')], alignment: AlignmentType.CENTER })]
    default:
      // 未知块：取文本兜底，绝不抛错。
      if ('children' in node && Array.isArray(node.children)) {
        return [new Paragraph({ children: inlineRuns(node.children as PhrasingContent[]) })]
      }
      if ('value' in node && typeof node.value === 'string') {
        return [new Paragraph({ children: [new TextRun(node.value)] })]
      }
      return []
  }
}

// 一个层级配置 → docx 段落样式的 run + paragraph 属性。
// spacingBeforePt 给标题留段前距（正文传 0）；onlyRun/skipIndent 用不到时省略。
function levelStyle(
  l: ProposalLevelStyle,
  style: ProposalStyleConfig,
  spacingBeforePt: number,
  applyIndent: boolean
): { run: Record<string, unknown>; paragraph: Record<string, unknown> } {
  const sizePt = CN_SIZE_PT[l.size]
  const firstLine = applyIndent && l.indentChars ? Math.round(l.indentChars * sizePt * 20) : 0
  return {
    run: {
      font: runFont(l.font),
      size: Math.round(sizePt * 2), // half-points
      bold: l.bold,
      ...(l.color ? { color: l.color } : {})
    },
    paragraph: {
      alignment: ALIGN[l.align],
      spacing: {
        line: Math.round(style.lineMultiple * 240),
        lineRule: LineRuleType.AUTO,
        before: Math.round(spacingBeforePt * 20),
        after: Math.round(style.spaceAfterPt * 20)
      },
      ...(firstLine ? { indent: { firstLine } } : {})
    }
  }
}

// 模板配置 → Document.styles。
//
// 关键坑（实测）：内置 Heading1-6 / Title 这些样式【无法】用同名 id 放进 paragraphStyles
// 覆盖——docx 仍会注入它自己的默认（如 Heading1 的蓝色 2E74B5、sz32），把我们的字体/
// 加粗全部丢掉。这些内置样式必须走 styles.default.heading1/2/3/title。而 Normal 走
// paragraphStyles 覆盖是生效的（实测字体/字号/对齐都正确），故混合：Normal 留
// paragraphStyles，标题与封面标题走 default。
//
// 正文首行缩进【不】写进 Normal（改为逐正文段落施加），以免列表项/标题继承首行缩进。
function buildDocStyles(style: ProposalStyleConfig): IStylesOptions {
  const normal = levelStyle(style.body, style, 0, false)
  const titleBase = levelStyle(style.title, style, 0, true)
  return {
    default: {
      // 封面标题：套用内置 'Title' 样式（blockToDocx 首个 h1 用 style:'Title'）。
      title: {
        run: titleBase.run,
        paragraph: {
          ...titleBase.paragraph,
          // 额外给充裕段前/段后距，和正文拉开。
          spacing: {
            line: Math.round(style.lineMultiple * 240),
            lineRule: LineRuleType.AUTO,
            before: Math.round(6 * 20),
            after: Math.round(18 * 20)
          }
        }
      },
      heading1: levelStyle(style.h1, style, 12, true),
      heading2: levelStyle(style.h2, style, 10, true),
      heading3: levelStyle(style.h3, style, 8, true)
    },
    paragraphStyles: [
      { id: 'Normal', name: 'Normal', run: normal.run, paragraph: normal.paragraph }
    ]
  }
}

// 模板配置 → numbering：有序（格式由 ol 定）+ 无序（项目符号字形由 ul 定）。
// 每级带 left/hanging 缩进，保证编号悬挂对齐、逐级递进。
function buildNumbering(style: ProposalStyleConfig): INumberingOptions {
  const indentFor = (lvl: number): { left: number; hanging: number } => ({
    left: 540 + lvl * 360,
    hanging: 360
  })
  return {
    config: [
      {
        reference: ORDERED_REF,
        levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, lvl) => ({
          level: lvl,
          format: OL_FORMAT[style.ol],
          text: `%${lvl + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: indentFor(lvl) } }
        }))
      },
      {
        reference: UNORDERED_REF,
        levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, lvl) => ({
          level: lvl,
          format: LevelFormat.BULLET,
          text: UL_GLYPH[style.ul],
          alignment: AlignmentType.START,
          style: { paragraph: { indent: indentFor(lvl) } }
        }))
      }
    ]
  }
}

// markdown 解析器（remark + GFM）提为模块级单例：processor 链与插件注册一次即可，
// 不必每次导出都重建。.parse() 只跑分词（含 remarkGfm 注册的 micromark 扩展，覆盖
// 表格/删除线等 GFM 语法），与原先 unified().use().use().parse() 行为一致。
const mdProcessor = unified().use(remarkParse).use(remarkGfm)

// 一个区段分组：kind（来自区段标记）+ 它包含的顶层 mdast 节点。
interface SectionGroup {
  kind: ProposalKind
  nodes: RootContent[]
}

// 按 PROPOSAL_SECTION_MARK 标记把顶层节点切成有序分组。标记节点本身剔除（不渲染）。
// 无任何标记（旧调用 / 裸 markdown）→ 单组 content，向后兼容。
function groupBySectionMarks(nodes: RootContent[]): SectionGroup[] {
  const groups: SectionGroup[] = []
  let current: SectionGroup | null = null
  for (const node of nodes) {
    if (node.type === 'html') {
      const m = node.value.trim().match(PROPOSAL_SECTION_RE)
      if (m) {
        current = { kind: m[1] as ProposalKind, nodes: [] }
        groups.push(current)
        continue // 标记本身不进内容
      }
    }
    if (!current) {
      // 第一个标记之前的游离节点（裸 markdown / 异常输入）→ content 兜底组。
      current = { kind: 'content', nodes: [] }
      groups.push(current)
    }
    current.nodes.push(node)
  }
  return groups.length ? groups : [{ kind: 'content', nodes: [] }]
}

// 正文页脚：每页底部居中「— 当前页码 —」（封面/目录节不挂此页脚，故无页码）。
function pageNumberFooter(): { default: Footer } {
  return {
    default: new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ children: ['— ', PageNumber.CURRENT, ' —'], size: 18, color: '9a9a9e' })
          ]
        })
      ]
    })
  }
}

// 剥掉 AI 在目录大纲里自带的「目录」标题（导出器会统一注入，避免重复）。
// 仅当首个节点是 heading 且其纯文本（去空白）等于「目录」时剥除首节点；否则原样返回。
// 注意 mdast heading 的 children 是 PhrasingContent[]，取 text 值要安全处理（c.value 只在
// text / inlineCode 节点上存在，其余节点无 value，故用 'value' in c 守卫）。
function stripLeadingTocHeading(nodes: RootContent[]): RootContent[] {
  const first = nodes[0]
  if (first && first.type === 'heading') {
    const text = (first.children as PhrasingContent[])
      .map((c) => ('value' in c && typeof c.value === 'string' ? c.value : ''))
      .join('')
      .replace(/\s/g, '')
    if (text === '目录') return nodes.slice(1)
  }
  return nodes
}

// A4 页高（twips）= docx 默认页面高度（210×297mm 的 297mm；docx 不设 page.size 时即此值）。
// 封面整页布局据此算「版心高度」= 页高 − 上下页边距。
const A4_PAGE_HEIGHT_TWIPS = 16838

// 识别封面「落款」行（编制单位 / 日期等）。当 AI 没给显式 `---` 分隔时，用它把尾部连续的
// 落款行归到页面底部块。匹配从宽：覆盖编制/拟制/起草/供应商/承建/投标/乙方等单位类，
// 以及含「年/月」或四位年份的日期类。
const COVER_FOOTER_RE = /编制|拟制|起草|供应商|承建|投标|乙方|日期|\d{4}\s*年|\d{1,2}\s*月/

// 把封面节点切成「上块（标题/客户）+ 下块（落款）」。优先按显式 thematicBreak（`---`）切；
// 无分隔线时退而把【尾部连续的落款行】归为下块；都不命中则下块为空（调用方退化为整体居中）。
function splitCoverNodes(nodes: RootContent[]): { top: RootContent[]; bottom: RootContent[] } {
  const hr = nodes.findIndex((n) => n.type === 'thematicBreak')
  if (hr >= 0) return { top: nodes.slice(0, hr), bottom: nodes.slice(hr + 1) }
  let i = nodes.length
  while (i > 0) {
    const n = nodes[i - 1]
    if (n.type !== 'paragraph') break
    const text = (n.children as PhrasingContent[])
      .map((c) => ('value' in c && typeof c.value === 'string' ? c.value : ''))
      .join('')
    if (!COVER_FOOTER_RE.test(text)) break
    i--
  }
  // 全部行都像落款（无标题，极端）或没有任何落款行 → 不切，全归上块、下块空。
  if (i <= 0 || i >= nodes.length) return { top: nodes, bottom: [] }
  return { top: nodes.slice(0, i), bottom: nodes.slice(i) }
}

// 封面行 → 纯文本（递归取 inline 文本）。封面按角色强排字号、不走 blockToDocx 的节点样式，
// 也不依赖 AI 是否用 `#` 写标题，故只需取出文字本身。
function inlineText(nodes: PhrasingContent[]): string {
  let s = ''
  for (const n of nodes) {
    if ('value' in n && typeof n.value === 'string') s += n.value
    else if ('children' in n && Array.isArray(n.children)) s += inlineText(n.children as PhrasingContent[])
  }
  return s
}
function nodeText(node: RootContent): string {
  if ('children' in node && Array.isArray(node.children)) return inlineText(node.children as PhrasingContent[])
  if ('value' in node && typeof node.value === 'string') return node.value
  return ''
}

// 一行封面文字 → 居中段落，按给定层级（title/h1/h3）【显式上字号】，从而排出「标题 > 抬头 >
// 落款」的字号层次——而非全用正文字号（用户反馈：旧版封面各行字号一样、无层次）。keepColor
// 仅标题保留模板点缀色（如商务靛蓝）；抬头/落款去色更干净。
function coverLine(
  text: string,
  level: ProposalLevelStyle,
  style: ProposalStyleConfig,
  opts: { keepColor: boolean; bold: boolean; spacingAfterPt: number }
): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: {
      line: Math.round(style.lineMultiple * 240),
      lineRule: LineRuleType.AUTO,
      after: Math.round(opts.spacingAfterPt * 20)
    },
    children: [
      new TextRun({
        text,
        font: runFont(level.font),
        size: Math.round(CN_SIZE_PT[level.size] * 2), // half-points
        bold: opts.bold,
        ...(opts.keepColor && level.color ? { color: level.color } : {})
      })
    ]
  })
}

// 封面整页布局：占满版心、无边框的表格做竖向分布。【不】依赖 Section.verticalAlign——
// docx-preview 不渲染节级竖向居中，会把内容顶到页首、下方留一大片空白（实测）；而表格单元格
// 竖向对齐两端渲染器都支持，故预览与导出 Word 一致。字号层次由 coverLine 按角色强排
// （标题 title 级 > 抬头 h1 级 > 落款 h3 级），不依赖 AI 是否用 `#` 写标题。
//   - 有落款（下块非空）：两行——上行占 ~58% 版心、单元格竖向居中（标题块落上中部），
//     下行占其余、单元格底对齐（落款贴页面底部），整页铺满。
//   - 无落款：单行占满版心、竖向居中（整体居中庄重，作为 AI 未给落款时的优雅退化）。
function buildCoverChildren(
  group: SectionGroup,
  style: ProposalStyleConfig
): Array<Paragraph | Table> {
  const contentHeight = A4_PAGE_HEIGHT_TWIPS - 2 * MARGIN_TWIPS[style.margin]
  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'auto' }
  const cellMargins = { top: 0, bottom: 0, left: 0, right: 0 }
  const mkCell = (
    children: Paragraph[],
    valign: (typeof VerticalAlignTable)[keyof typeof VerticalAlignTable]
  ): TableCell =>
    new TableCell({
      children: children.length ? children : [new Paragraph({ children: [new TextRun('')] })],
      verticalAlign: valign,
      margins: cellMargins,
      width: { size: 100, type: WidthType.PERCENTAGE }
    })

  const { top, bottom } = splitCoverNodes(group.nodes)

  // 上块：首个非空行 = 方案标题（title 级：放大加粗、保留点缀色），其下一条细分隔线强化层次；
  // 其余行 = 抬头/客户信息（h1 级：中等字号、去色不加粗）。
  const topChildren: Paragraph[] = []
  let titleDone = false
  for (const node of top) {
    const text = nodeText(node).trim()
    if (!text) continue
    if (!titleDone) {
      titleDone = true
      topChildren.push(coverLine(text, style.title, style, { keepColor: true, bold: true, spacingAfterPt: 6 }))
      topChildren.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: Math.round(12 * 20) },
          children: [new TextRun({ text: '————————', color: '9a9a9e' })]
        })
      )
    } else {
      topChildren.push(coverLine(text, style.h1, style, { keepColor: false, bold: false, spacingAfterPt: 4 }))
    }
  }

  // 下块：落款（h3 级：较小字号、去色不加粗）。
  const bottomChildren: Paragraph[] = []
  for (const node of bottom) {
    const text = nodeText(node).trim()
    if (!text) continue
    bottomChildren.push(coverLine(text, style.h3, style, { keepColor: false, bold: false, spacingAfterPt: 4 }))
  }

  const rows: TableRow[] = []
  if (bottomChildren.length) {
    const topH = Math.round(contentHeight * 0.58)
    rows.push(
      new TableRow({
        children: [mkCell(topChildren, VerticalAlignTable.CENTER)],
        height: { value: topH, rule: HeightRule.EXACT }
      })
    )
    rows.push(
      new TableRow({
        children: [mkCell(bottomChildren, VerticalAlignTable.BOTTOM)],
        height: { value: contentHeight - topH, rule: HeightRule.EXACT }
      })
    )
  } else {
    rows.push(
      new TableRow({
        children: [mkCell(topChildren, VerticalAlignTable.CENTER)],
        height: { value: contentHeight, rule: HeightRule.EXACT }
      })
    )
  }

  return [
    new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: noBorder,
        bottom: noBorder,
        left: noBorder,
        right: noBorder,
        insideHorizontal: noBorder,
        insideVertical: noBorder
      }
    })
  ]
}

// 一个区段分组 → 该 Section 的子节点。封面节走整页表格布局（buildCoverChildren）；
// 目录节注入「目录」标题；正文节默认渲染。封面/目录的 titleConsumed 已在各自路径处理。
function buildSectionChildren(
  group: SectionGroup,
  style: ProposalStyleConfig,
  bodyFirstLine: number,
  ungroundedImagePaths?: ReadonlySet<string>
): Array<Paragraph | Table> {
  const env: WalkEnv = {
    walk: { titleConsumed: group.kind !== 'cover' },
    bodyFirstLine,
    imgMarginTwips: MARGIN_TWIPS[style.margin],
    ungroundedImagePaths
  }
  const out: Array<Paragraph | Table> = []

  if (group.kind === 'cover') {
    // 封面整页布局（标题上中、落款贴底、铺满、按角色排字号层次），见 buildCoverChildren 注释。
    return buildCoverChildren(group, style)
  }

  if (group.kind === 'toc') {
    // 目录节首部注入居中「目录」大标题（复用 Title 量级样式），紧跟一条浅色分隔线。
    // 导出器统一注入，避免 AI 大纲里自带的「目录」标题造成重复——故先用
    // stripLeadingTocHeading 剥掉首节点（若其纯文本等于「目录」）再遍历剩余大纲。
    out.push(
      new Paragraph({
        style: 'Title', // 复用内置 Title 样式（buildDocStyles 已按模板覆盖字体/字号/对齐）
        alignment: AlignmentType.CENTER,
        children: [new TextRun('目录')]
      })
    )
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({ text: '————————', color: '9a9a9e' })]
      })
    )
    // 大纲列表/标题沿用默认 blockToDocx 渲染（list→numbering 自带层级缩进）；
    // stripLeadingTocHeading 只剥「目录」标题，其余节点原样渲染。
    for (const node of stripLeadingTocHeading(group.nodes)) {
      out.push(...blockToDocx(node, env))
    }
    return out
  }

  for (const node of group.nodes) {
    out.push(...blockToDocx(node, env))
  }
  return out.length ? out : [new Paragraph({ children: [new TextRun('')] })]
}

export async function markdownToDocxBuffer(
  markdown: string,
  style: ProposalStyleConfig = defaultProposalStyle(),
  // 接地闸门：未接地图的绝对路径全集（collectUngroundedImagePaths 算出）。命中的图降级为占位、
  // 不嵌入。缺省 → 不挡任何图（裸调用 / 索引不可用时退化为旧行为，导出绝不被校验阻塞）。
  ungroundedImagePaths?: ReadonlySet<string>
): Promise<Buffer> {
  const tree = mdProcessor.parse(markdown) as Root
  const bodyFirstLine = style.body.indentChars
    ? Math.round(style.body.indentChars * CN_SIZE_PT[style.body.size] * 20)
    : 0

  const margin = MARGIN_TWIPS[style.margin]
  const pageMargin = { top: margin, right: margin, bottom: margin, left: margin }

  // 按区段标记分组 → 每组一个 Word Section（默认 NEXT_PAGE，天然各自起新页）。
  // 封面/目录节不挂页码页脚；正文节挂「— N —」页脚。
  const groups = groupBySectionMarks(tree.children)
  const sections: ISectionOptions[] = groups.map((group) => {
    const children = buildSectionChildren(group, style, bodyFirstLine, ungroundedImagePaths)
    const safeChildren = children.length
      ? children
      : [new Paragraph({ children: [new TextRun('')] })]
    // 所有节同样的页边距。封面的竖向分布由 buildCoverChildren 的整页表格承担，【不】用
    // Section.verticalAlign（docx-preview 不渲染节级竖向居中，会把封面顶到页首、下方留白）。
    const properties = { page: { margin: pageMargin } }
    return {
      properties,
      ...(group.kind === 'content' ? { footers: pageNumberFooter() } : {}),
      children: safeChildren
    }
  })

  const doc = new Document({
    styles: buildDocStyles(style),
    numbering: buildNumbering(style),
    sections: sections.length
      ? sections
      : [
          {
            properties: { page: { margin: pageMargin } },
            children: [new Paragraph({ children: [new TextRun('')] })]
          }
        ]
  })
  return Packer.toBuffer(doc)
}
