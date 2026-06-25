import {
  Document,
  Packer,
  Paragraph,
  PageBreak,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  LevelFormat,
  AlignmentType,
  Footer,
  PageNumber
} from 'docx'
import { PROPOSAL_PAGEBREAK } from '../../shared/proposal'
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
 * 主进程专用（依赖 Node）。renderer 永远只传 markdown 字符串过来。
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

// 列表项 → 段落数组。ordered 用编号引用，unordered 用项目符号；嵌套靠 level。
// baseStyle 用于引用块内的列表（斜体）；缩进交给 numbering/bullet 的 level，不另加
// indent.left，避免覆盖编号自带的缩进。
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
          ...(ordered
            ? { numbering: { reference: 'proposal-ordered', level: safeLevel } }
            : { bullet: { level: safeLevel } })
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

// 顶层块节点 → docx 元素（Paragraph | Table）。
// ctx 由 blockquote 下传（左缩进 + 斜体基样式），其余调用走默认 undefined。
function blockToDocx(node: RootContent, ctx?: BlockContext): Array<Paragraph | Table> {
  switch (node.type) {
    case 'heading':
      return [
        new Paragraph({
          // 上界 clamp 到 6、下界 clamp 到 0：remark 标准不产 depth0，但万一上游传入
          // depth0 会让 `-1` 索引出 undefined → 标题静默降级普通段、丢目录条目（C3）。
          heading: HEADING_BY_DEPTH[Math.max(0, Math.min(node.depth, 6) - 1)],
          children: inlineRuns(node.children, ctx?.baseStyle),
          indent: ctx?.indent
        })
      ]
    case 'paragraph':
      return [new Paragraph({ children: inlineRuns(node.children, ctx?.baseStyle), indent: ctx?.indent })]
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
        out.push(...blockToDocx(child, quoteCtx))
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
      const rows = node.children.map(
        (row) =>
          new TableRow({
            children: row.children.map(
              (cell) =>
                new TableCell({
                  children: tableCellContent(cell),
                  width: { size: 0, type: WidthType.AUTO }
                })
            )
          })
      )
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

// markdown 解析器（remark + GFM）提为模块级单例：processor 链与插件注册一次即可，
// 不必每次导出都重建。.parse() 只跑分词（含 remarkGfm 注册的 micromark 扩展，覆盖
// 表格/删除线等 GFM 语法），与原先 unified().use().use().parse() 行为一致。
const mdProcessor = unified().use(remarkParse).use(remarkGfm)

export async function markdownToDocxBuffer(markdown: string): Promise<Buffer> {
  const tree = mdProcessor.parse(markdown) as Root
  const children: Array<Paragraph | Table> = []
  for (const node of tree.children) {
    children.push(...blockToDocx(node))
  }
  const doc = new Document({
    // 有序列表编号实例：1. 2. 3. …，多级递进。
    numbering: {
      config: [
        {
          reference: 'proposal-ordered',
          // 注册 0..MAX_LIST_LEVEL 全部级别，覆盖 Word 支持的最深有序嵌套。
          levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, lvl) => ({
            level: lvl,
            format: LevelFormat.DECIMAL,
            text: `%${lvl + 1}.`,
            alignment: AlignmentType.START
          }))
        }
      ]
    },
    sections: [
      {
        // 页脚：每页底部居中「— 当前页码 —」。size 18 = 9pt（half-points），
        // 灰色 9a9a9e 与正文区分。页码字段由 Word/LibreOffice/ docx-preview 在
        // 渲染/翻页时各自计算，故导出成品与预览的页码完全一致。
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: ['— ', PageNumber.CURRENT, ' —'],
                    size: 18,
                    color: '9a9a9e'
                  })
                ]
              })
            ]
          })
        },
        children: children.length
          ? children
          : [new Paragraph({ children: [new TextRun('')] })]
      }
    ]
  })
  return Packer.toBuffer(doc)
}
