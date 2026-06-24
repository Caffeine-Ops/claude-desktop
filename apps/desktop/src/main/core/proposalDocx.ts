import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  LevelFormat,
  AlignmentType
} from 'docx'
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

// 内联样式累积：递归下传 bold/italics/code 标志，叶子 text 据此产出 TextRun。
interface InlineStyle {
  bold?: boolean
  italics?: boolean
  code?: boolean
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
function listItemParagraphs(
  item: ListItem,
  ordered: boolean,
  level: number
): Paragraph[] {
  const out: Paragraph[] = []
  for (const child of item.children) {
    if (child.type === 'paragraph') {
      out.push(
        new Paragraph({
          children: inlineRuns(child.children),
          ...(ordered
            ? { numbering: { reference: 'proposal-ordered', level } }
            : { bullet: { level } })
        })
      )
    } else if (child.type === 'list') {
      // 嵌套列表：递归，level+1。
      for (const sub of child.children) {
        out.push(...listItemParagraphs(sub, Boolean(child.ordered), level + 1))
      }
    }
  }
  return out
}

function tableCellContent(cell: MdTableCell): Paragraph[] {
  return [new Paragraph({ children: inlineRuns(cell.children) })]
}

// 顶层块节点 → docx 元素（Paragraph | Table）。
function blockToDocx(node: RootContent): Array<Paragraph | Table> {
  switch (node.type) {
    case 'heading':
      return [
        new Paragraph({
          heading: HEADING_BY_DEPTH[Math.min(node.depth, 6) - 1],
          children: inlineRuns(node.children)
        })
      ]
    case 'paragraph':
      return [new Paragraph({ children: inlineRuns(node.children) })]
    case 'list': {
      const out: Paragraph[] = []
      for (const item of node.children) {
        out.push(...listItemParagraphs(item, Boolean(node.ordered), 0))
      }
      return out
    }
    case 'blockquote': {
      // 引用：缩进 + 斜体，逐子段处理。
      const out: Array<Paragraph | Table> = []
      for (const child of node.children) {
        for (const el of blockToDocx(child)) {
          if (el instanceof Paragraph) {
            out.push(
              new Paragraph({
                children: inlineRuns(
                  'children' in child ? (child.children as PhrasingContent[]) : []
                ),
                indent: { left: 480 },
                style: undefined
              })
            )
          } else {
            out.push(el)
          }
        }
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

export async function markdownToDocxBuffer(markdown: string): Promise<Buffer> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root
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
          levels: [0, 1, 2, 3].map((lvl) => ({
            level: lvl,
            format: LevelFormat.DECIMAL,
            text: `%${lvl + 1}.`,
            alignment: AlignmentType.START
          }))
        }
      ]
    },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [new TextRun('')] })] }]
  })
  return Packer.toBuffer(doc)
}
