# 方案封面/目录整页版式 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「写方案」导出/预览的封面竖向居中独占一页、目录有「目录」大标题+层级缩进独占一页，且预览=导出一致。

**Architecture:** 在拼接 markdown 时给每个 kind 区段插一个 HTML 注释区段标记（取代旧的 kind 边界分页标记）；`proposalDocx` 解析后按标记把顶层节点分组，每组构造一个独立 Word Section——封面节走 `verticalAlign:center`+段落强制居中+无页脚，目录节注入「目录」标题+无页脚，正文节维持现有渲染+页码页脚。

**Tech Stack:** TypeScript（composite：node 侧 + web 侧）、`docx@9.7.1`、`unified`/`remark-parse`/`remark-gfm`（mdast）、`docx-preview`（预览渲染）、bun（运行/包管理）。

## Global Constraints

- 包管理器与运行器是 **bun**，不是 npm。
- **唯一自动化质量门是 `bun run typecheck`**（`tsc -p node` + `tsc -p web`）；项目**无单元测试框架、无 ESLint**。本计划的「测试」用 bun 一次性脚本（放 scratchpad，不入库）+ typecheck + docx-preview 手动比对。
- **不变量「预览=导出逐像素一致」**：预览（`renderProposal` IPC → `markdownToDocxBuffer`）与导出（`exportProposal` → 同一函数）必须走同一引擎、同一份 markdown。改动不得让两者分叉。
- **不加 IPC**：靠 markdown 内的注释标记承载 kind，不改 `exportProposal`/`renderProposal` 的 payload 形状。
- **`.md` 导出（`pageBreaks:false`）绝不含任何注释标记**（注释外漏到纯文本成品是历史禁令）。
- 注释密度高、专门解释「为什么这样而不那样」——沿用此风格，改不变量时把理由写进注释。
- 进程边界：`proposalDocx.ts` 是 **main 进程专用**（依赖 Node + docx）。`shared/proposal.ts` 被 main 与 renderer 共享，必须保持纯函数、无 Node 依赖。
- scratchpad 绝对路径（放临时脚本/产物）：
  `/private/tmp/claude-501/-Users-kika-Desktop-project-Electron-claude-desktop/ca131ef4-d07b-4104-848c-97aface31835/scratchpad`
- 项目根：`/Users/kika/Desktop/project/Electron/claude-desktop`
- 当前分支：`Install-Plan`（直接在此分支提交，勿切 main）。
- 提交信息结尾加：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

- `apps/desktop/src/shared/proposal.ts` — **修改**。新增区段标记常量/正则 `PROPOSAL_SECTION_MARK` / `PROPOSAL_SECTION_RE`；改 `buildProposalMarkdown` 在 docx 模式插区段标记、不再插 `PROPOSAL_PAGEBREAK`。
- `apps/desktop/src/main/core/proposalDocx.ts` — **修改**。新增 `groupBySectionMarks`、`pageNumberFooter`、`buildSectionChildren`、`stripLeadingTocHeading`；`BlockContext` 加 `forceAlign`；`blockToDocx` 三处套用 `forceAlign`；`markdownToDocxBuffer` 从单 section 改多 section。
- `apps/desktop/src/main/core/proposalPrompt.ts` — **修改**。封面/目录两阶段各补一句版式约束。

---

## Task 1: 区段标记 + buildProposalMarkdown（shared/proposal.ts）

**Files:**
- Modify: `apps/desktop/src/shared/proposal.ts`（`PROPOSAL_PAGEBREAK` 定义附近加常量；改 `buildProposalMarkdown`，约 145-167 行）
- Test（throwaway）: `<scratchpad>/verify-marker.ts`

**Interfaces:**
- Consumes: 现有 `ProposalKind`、`PROPOSAL_PAGEBREAK`。
- Produces:
  - `PROPOSAL_SECTION_MARK(kind: ProposalKind): string` → 形如 `<!--proposal-section:cover-->`
  - `PROPOSAL_SECTION_RE: RegExp` → `/^<!--proposal-section:(cover|toc|content)-->$/`
  - `buildProposalMarkdown` 行为变更：`pageBreaks:true` 时在每个 kind 区段起始插 `PROPOSAL_SECTION_MARK(kind)`、不再插 `PROPOSAL_PAGEBREAK`；`pageBreaks:false` 不变。

- [ ] **Step 1: 写验证脚本**

创建 `<scratchpad>/verify-marker.ts`：

```ts
import {
  buildProposalMarkdown,
  PROPOSAL_SECTION_MARK,
  PROPOSAL_PAGEBREAK
} from '/Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop/src/shared/proposal'

const sections = [
  { markdown: '# 智慧水务方案\n\n客户单位：××公司', kind: 'cover' as const },
  { markdown: '1. 项目背景\n2. 需求分析', kind: 'toc' as const },
  { markdown: '## 一、项目背景\n\n正文段落。', kind: 'content' as const },
  { markdown: '## 二、需求分析\n\n正文段落。', kind: 'content' as const }
]

const docx = buildProposalMarkdown(sections, { pageBreaks: true })
const md = buildProposalMarkdown(sections, { pageBreaks: false })

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('ok:', msg)
}

assert(docx.includes(PROPOSAL_SECTION_MARK('cover')), 'docx 含封面区段标记')
assert(docx.includes(PROPOSAL_SECTION_MARK('toc')), 'docx 含目录区段标记')
assert(docx.includes(PROPOSAL_SECTION_MARK('content')), 'docx 含正文区段标记')
assert(
  docx.split(PROPOSAL_SECTION_MARK('content')).length - 1 === 1,
  '连续两节 content 只在区段起始插一次标记'
)
assert(!docx.includes(PROPOSAL_PAGEBREAK), 'docx 不再插旧分页标记')
assert(docx.indexOf(PROPOSAL_SECTION_MARK('cover')) === 0, '封面标记在最前')
assert(!md.includes('proposal-section'), '.md 模式无任何区段标记')
assert(!md.includes('proposal-pagebreak'), '.md 模式无分页标记')
console.log('ALL PASS')
```

- [ ] **Step 2: 跑脚本确认它失败**

Run: `bun run "<scratchpad>/verify-marker.ts"`
Expected: 失败——`PROPOSAL_SECTION_MARK` 尚未导出（import 报错 / undefined）。

- [ ] **Step 3: 加常量**

在 `apps/desktop/src/shared/proposal.ts` 的 `PROPOSAL_PAGEBREAK` 定义之后追加：

```ts
/**
 * 区段起始标记（begin-only）：docx 导出/预览时插在每个 kind 区段的最前，让
 * proposalDocx 在丢失 kind 的扁平 markdown 里重新识别「这段是封面/目录/正文」，
 * 据此为每段构造独立 Word Section（封面竖向居中、目录注标题、正文带页码）。
 *
 * 与 PROPOSAL_PAGEBREAK 同款：单独成行的 HTML 注释 → remark 解析为块级 html 节点，
 * 在聊天/.md 里不可见。取代了旧的「kind 边界插 PROPOSAL_PAGEBREAK」——分页改由 Word
 * 分节天然完成（每个 section 默认起新页），不必再单独插分页标记。
 */
export const PROPOSAL_SECTION_MARK = (kind: ProposalKind): string =>
  `<!--proposal-section:${kind}-->`

/** 反解析区段标记（proposalDocx 侧 trim 后整行匹配）。 */
export const PROPOSAL_SECTION_RE = /^<!--proposal-section:(cover|toc|content)-->$/
```

- [ ] **Step 4: 改 buildProposalMarkdown**

把 `buildProposalMarkdown` 的循环体改为「kind 变化处插区段标记」，替换原先插 `PROPOSAL_PAGEBREAK` 的逻辑。将函数体（145 行起）改为：

```ts
export function buildProposalMarkdown(
  sections: Array<{ markdown: string; kind: ProposalKind; truncated?: boolean }>,
  opts?: { pageBreaks?: boolean }
): string {
  // pageBreaks=true 即 docx 模式：每个 kind 区段起始插一行区段标记（PROPOSAL_SECTION_MARK），
  // proposalDocx 据此分节；分页由 Word 分节天然完成，故不再插 PROPOSAL_PAGEBREAK。
  // pageBreaks=false（.md 导出）：纯空行拼接，绝不含任何标记。
  const pageBreaks = opts?.pageBreaks ?? false
  const parts: string[] = []
  let prevKind: ProposalKind | null = null
  for (const sec of sections) {
    const md = sec.markdown.trim()
    if (!md) continue
    // 截断残文：输出内容但不参与分节（不插标记、不更新 prevKind），与原分页逻辑一致——
    // 它 kind 可能与逻辑归属不符，拿它切区段会把同一逻辑段劈到两节。
    if (sec.truncated) {
      parts.push(md)
      continue
    }
    if (pageBreaks && sec.kind !== prevKind) {
      parts.push(PROPOSAL_SECTION_MARK(sec.kind))
    }
    parts.push(md)
    prevKind = sec.kind
  }
  return parts.join('\n\n').trim()
}
```

> 注：原实现是 `prevKind !== null && sec.kind !== prevKind` 才插分页（首节不插）。新实现去掉
> `prevKind !== null`，让**首个区段（封面）也插标记**——proposalDocx 需要知道第一组的 kind。
> `sec.kind !== prevKind` 在首节时为 `'cover' !== null` 成立，正确。

- [ ] **Step 5: 跑脚本确认通过**

Run: `bun run "<scratchpad>/verify-marker.ts"`
Expected: 末行 `ALL PASS`，全部 `ok:`。

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: 通过（无报错）。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/src/shared/proposal.ts
git commit -m "feat(proposal): 区段标记取代 kind 边界分页标记

buildProposalMarkdown docx 模式改为每个 kind 区段起始插
PROPOSAL_SECTION_MARK，供 proposalDocx 分节；.md 模式不变（无标记）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 多 Section 分组骨架（proposalDocx.ts）

把 `markdownToDocxBuffer` 从「单 section」改为「按区段标记分组 → 每组一个 Section」。本任务只搭结构 + 页脚规则（封面/目录无页码、正文有页码），封面/目录的专属版式留给 Task 3/4——本任务里它们暂用默认 `blockToDocx` 渲染。

**Files:**
- Modify: `apps/desktop/src/main/core/proposalDocx.ts`
- Test（throwaway）: `<scratchpad>/gen-docx.ts` + `unzip` 检查

**Interfaces:**
- Consumes: Task 1 的 `PROPOSAL_SECTION_RE`；现有 `blockToDocx`、`buildDocStyles`、`buildNumbering`、`WalkEnv`、`MARGIN_TWIPS`、`CN_SIZE_PT`。
- Produces:
  - `interface SectionGroup { kind: ProposalKind; nodes: RootContent[] }`
  - `function groupBySectionMarks(nodes: RootContent[]): SectionGroup[]`
  - `function pageNumberFooter(): { default: Footer }`
  - `function buildSectionChildren(group: SectionGroup, style: ProposalStyleConfig, bodyFirstLine: number): Array<Paragraph | Table>`
  - `markdownToDocxBuffer` 产出多个 `ISectionOptions`（cover/toc 无 footer，content 有 footer）。

- [ ] **Step 1: 写 docx 生成脚本**

创建 `<scratchpad>/gen-docx.ts`：

```ts
import { markdownToDocxBuffer } from '/Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop/src/main/core/proposalDocx'
import { buildProposalMarkdown } from '/Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop/src/shared/proposal'

const sections = [
  { markdown: '# 智慧水务整体解决方案\n\n客户单位：××水务集团\n\n编制单位：○○科技\n\n日期：2026 年 6 月', kind: 'cover' as const },
  { markdown: '1. 项目背景\n2. 需求分析\n3. 总体方案设计\n   1. 架构\n   2. 功能', kind: 'toc' as const },
  { markdown: '## 一、项目背景\n\n正文段落（据《资料》）。', kind: 'content' as const },
  { markdown: '## 二、需求分析\n\n正文段落（据《资料》）。', kind: 'content' as const }
]

const md = buildProposalMarkdown(sections, { pageBreaks: true })
const buf = await markdownToDocxBuffer(md)
const out = '/private/tmp/claude-501/-Users-kika-Desktop-project-Electron-claude-desktop/ca131ef4-d07b-4104-848c-97aface31835/scratchpad/out.docx'
await Bun.write(out, buf)
console.log('wrote', out, buf.length, 'bytes')
```

- [ ] **Step 2: 跑脚本生成 + 解压看当前 section 数**

```bash
bun run "<scratchpad>/gen-docx.ts"
unzip -p "<scratchpad>/out.docx" word/document.xml > "<scratchpad>/out.xml"
grep -c "w:sectPr" "<scratchpad>/out.xml"
```
Expected（改造前）：`1`（当前是单 section）。这是基线，确认脚本可跑。

- [ ] **Step 3: 加导入**

在 `proposalDocx.ts` 顶部 docx 导入块加 `VerticalAlignSection`，并从 shared 导入区段正则与类型：

```ts
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
  LineRuleType,
  AlignmentType,
  VerticalAlignSection,
  Footer,
  PageNumber
} from 'docx'
```

并把现有
```ts
import { PROPOSAL_PAGEBREAK } from '../../shared/proposal'
```
改为
```ts
import { PROPOSAL_PAGEBREAK, PROPOSAL_SECTION_RE } from '../../shared/proposal'
import type { ProposalKind } from '../../shared/proposal'
```

- [ ] **Step 4: 加分组函数 + 页脚助手 + 区段子节点构造**

在 `markdownToDocxBuffer` 定义之前（`mdProcessor` 单例之后）插入：

```ts
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

// 一个区段分组 → 该 Section 的子节点。本任务 cover/toc 暂用默认渲染（Task 3/4 加专属版式）。
// 封面节让首个 h1 走 Title 放大样式（titleConsumed=false）；目录/正文节的 h1 → HeadingN。
function buildSectionChildren(
  group: SectionGroup,
  style: ProposalStyleConfig,
  bodyFirstLine: number
): Array<Paragraph | Table> {
  const env: WalkEnv = {
    walk: { titleConsumed: group.kind !== 'cover' },
    bodyFirstLine
  }
  const out: Array<Paragraph | Table> = []
  for (const node of group.nodes) {
    out.push(...blockToDocx(node, env))
  }
  return out.length ? out : [new Paragraph({ children: [new TextRun('')] })]
}
```

- [ ] **Step 5: 改 markdownToDocxBuffer 为多 section**

把 `markdownToDocxBuffer`（414 行起）函数体替换为：

```ts
export async function markdownToDocxBuffer(
  markdown: string,
  style: ProposalStyleConfig = defaultProposalStyle()
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
    const children = buildSectionChildren(group, style, bodyFirstLine)
    const safeChildren = children.length
      ? children
      : [new Paragraph({ children: [new TextRun('')] })]
    // 封面节竖向居中（verticalAlign）——封面段落水平居中在 Task 3 加。
    const properties =
      group.kind === 'cover'
        ? { page: { margin: pageMargin }, verticalAlign: VerticalAlignSection.CENTER }
        : { page: { margin: pageMargin } }
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
```

> `ISectionOptions` 已在文件顶部 `import type` 中。`Footer`/`PageNumber` 已导入。

- [ ] **Step 6: 重新生成 + 验 section 数与页脚规则**

```bash
bun run "<scratchpad>/gen-docx.ts"
unzip -p "<scratchpad>/out.docx" word/document.xml > "<scratchpad>/out.xml"
grep -c "w:sectPr" "<scratchpad>/out.xml"
unzip -l "<scratchpad>/out.docx" | grep -c "footer[0-9]*.xml"
unzip -p "<scratchpad>/out.docx" word/document.xml | grep -o "w:vAlign w:val=\"center\"" | head
```
Expected:
- `grep -c "w:sectPr"` → `3`（封面/目录/正文三节）。
- footer 文件数 → `1`（只正文节一个页码页脚；封面/目录无）。
- `w:vAlign ... center` → 输出一行（封面节竖向居中已生效）。

- [ ] **Step 7: typecheck**

Run: `bun run typecheck`
Expected: 通过。

- [ ] **Step 8: 提交**

```bash
git add apps/desktop/src/main/core/proposalDocx.ts
git commit -m "feat(proposal): docx 按区段标记分多 Word Section

groupBySectionMarks 把顶层节点按 kind 切组，每组一个 Section（默认起新页）；
封面节 verticalAlign 居中，封面/目录无页码页脚、正文保留页码页脚。
封面/目录专属版式见后续提交。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 封面段落水平居中 + 竖向居中实测（proposalDocx.ts）

封面节所有段落强制水平居中（与已就位的竖向居中合成「居中庄重式」），并去掉居中文本上的首行缩进。然后**手动在 docx-preview 实测竖向居中**；若 docx-preview 不认 `verticalAlign`，套用兜底（整页高单元格表格竖向居中）。

**Files:**
- Modify: `apps/desktop/src/main/core/proposalDocx.ts`（`BlockContext`、`blockToDocx`、`buildSectionChildren`）

**Interfaces:**
- Consumes: Task 2 的 `buildSectionChildren`、`SectionGroup`。
- Produces: `BlockContext.forceAlign?`；封面节段落带 `<w:jc w:val="center"/>`。

- [ ] **Step 1: 给 BlockContext 加 forceAlign**

把 `BlockContext` 接口（约 103 行）改为：

```ts
interface BlockContext {
  indent?: { left: number }
  baseStyle?: InlineStyle
  // 强制段落水平对齐（封面节用 CENTER 覆盖模板自带 align，使标题/落款都居中）。
  forceAlign?: (typeof AlignmentType)[keyof typeof AlignmentType]
}
```

- [ ] **Step 2: blockToDocx 三处套用 forceAlign**

在 `blockToDocx` 的 heading-Title 分支、heading-普通分支、paragraph 分支分别加 `alignment`。

heading-Title 分支（约 204-209 行）改为：

```ts
        return [
          new Paragraph({
            style: 'Title', // 内置 Title 样式，由 styles.default.title 覆盖（见 buildDocStyles）
            children: inlineRuns(node.children),
            ...(ctx?.forceAlign ? { alignment: ctx.forceAlign } : {})
          })
        ]
```

heading-普通分支（约 211-219 行）改为：

```ts
      return [
        new Paragraph({
          heading: HEADING_BY_DEPTH[Math.max(0, Math.min(node.depth, 6) - 1)],
          children: inlineRuns(node.children, ctx?.baseStyle),
          indent: ctx?.indent,
          ...(ctx?.forceAlign ? { alignment: ctx.forceAlign } : {})
        })
      ]
```

paragraph 分支（约 221-229 行）改为——注意：居中时去掉首行缩进（居中文本带首行缩进会偏右）：

```ts
    case 'paragraph':
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
```

- [ ] **Step 3: buildSectionChildren 封面分支传 forceAlign**

把 `buildSectionChildren`（Task 2 加的）改为按 kind 分支，封面节下传居中上下文：

```ts
function buildSectionChildren(
  group: SectionGroup,
  style: ProposalStyleConfig,
  bodyFirstLine: number
): Array<Paragraph | Table> {
  const env: WalkEnv = {
    walk: { titleConsumed: group.kind !== 'cover' },
    bodyFirstLine
  }
  const out: Array<Paragraph | Table> = []

  if (group.kind === 'cover') {
    // 封面：所有段落水平居中（forceAlign）；竖向居中靠 Section.verticalAlign。
    for (const node of group.nodes) {
      out.push(...blockToDocx(node, env, { forceAlign: AlignmentType.CENTER }))
    }
    return out.length ? out : [new Paragraph({ children: [new TextRun('')] })]
  }

  for (const node of group.nodes) {
    out.push(...blockToDocx(node, env))
  }
  return out.length ? out : [new Paragraph({ children: [new TextRun('')] })]
}
```

- [ ] **Step 4: 生成 + 验封面段落居中**

```bash
bun run "<scratchpad>/gen-docx.ts"
unzip -p "<scratchpad>/out.docx" word/document.xml > "<scratchpad>/out.xml"
grep -o "w:jc w:val=\"center\"" "<scratchpad>/out.xml" | wc -l
```
Expected: ≥ 4（封面标题 + 3 行落款都居中；目录/正文不受影响）。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: 通过。

- [ ] **Step 6: docx-preview 竖向居中手动实测（关键 parity 检查）**

```bash
bun run dev
```
在应用里：进入写方案 → 有封面草稿 → 打开「导出 Word · 样式模板」弹窗看左侧真预览（或预览态）。
确认封面：① 标题+落款整体在页面**竖向居中**（不是贴页顶）；② 全部**水平居中**；③ 封面**独占一页**、**无页脚页码**。
再点导出 Word，用 Word/Pages 打开，确认与预览一致。

- **若竖向居中在 docx-preview 不生效（贴顶）**：套用兜底——把封面内容包进占满版心高度的单行单列表格、单元格竖向居中（两端渲染器对表格单元格竖向居中支持更稳）。在 `buildSectionChildren` 的 cover 分支改为：

```ts
  if (group.kind === 'cover') {
    const inner: Paragraph[] = []
    for (const node of group.nodes) {
      // 封面内容只会是标题/落款段落，blockToDocx 在此只产 Paragraph；强转安全。
      inner.push(...(blockToDocx(node, env, { forceAlign: AlignmentType.CENTER }) as Paragraph[]))
    }
    // 版心高度 = A4 高(15840 twips) - 上下页边距；表格高度撑满、单元格竖向居中。
    const pageH = 15840 - 2 * MARGIN_TWIPS[style.margin]
    const cell = new TableCell({
      children: inner.length ? inner : [new Paragraph({ children: [new TextRun('')] })],
      verticalAlign: VerticalAlignTable.CENTER,
      width: { size: 100, type: WidthType.PERCENTAGE },
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })
    const row = new TableRow({ children: [cell], height: { value: pageH, rule: HeightRule.EXACT } })
    // 无边框表格：用 NONE 边框，封面看不出表格框线。
    const noBorder = { style: BorderStyle.NONE, size: 0, color: 'auto' }
    return [
      new Table({
        rows: [row],
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder }
      })
    ]
  }
```

兜底需额外导入：在 docx 导入块补 `VerticalAlignTable, HeightRule, BorderStyle`。并把 cover 节的 `properties` 退回 `{ page: { margin: pageMargin } }`（用了表格就不靠 section verticalAlign）。改完重跑 Step 4-6 验证。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/src/main/core/proposalDocx.ts
git commit -m "feat(proposal): 封面段落水平居中（合成居中庄重式封面）

BlockContext 加 forceAlign，封面节所有段落强制居中且去首行缩进，
与 Section.verticalAlign 合成竖向+水平居中的整页封面。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> 若 Step 6 用了兜底表格方案，提交信息改述为「封面整页高单元格表格竖向居中（docx-preview 不认 verticalAlign 的兜底）」。

---

## Task 4: 目录注入「目录」标题 + 剥重复（proposalDocx.ts）

目录节注入居中「目录」大标题 + 一条分隔线，并剥掉 AI 可能自带的「目录」标题避免重复。列表条目沿用现有 list→numbering 渲染（天然层级缩进）。

**Files:**
- Modify: `apps/desktop/src/main/core/proposalDocx.ts`（`buildSectionChildren` 加 toc 分支；新增 `stripLeadingTocHeading`）

**Interfaces:**
- Consumes: Task 2/3 的 `buildSectionChildren`、`SectionGroup`。
- Produces: `function stripLeadingTocHeading(nodes: RootContent[]): RootContent[]`；目录节首个段落是居中「目录」标题。

- [ ] **Step 1: 加 stripLeadingTocHeading**

在 `buildSectionChildren` 之前插入：

```ts
// 剥掉 AI 在目录大纲里自带的「目录」标题（导出器会统一注入，避免重复）。
// 仅当首个节点是 heading 且其纯文本（去空白）等于「目录」时剥除。
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
```

- [ ] **Step 2: buildSectionChildren 加 toc 分支**

在 `buildSectionChildren` 的 cover 分支之后、content 默认循环之前插入：

```ts
  if (group.kind === 'toc') {
    // 注入居中「目录」大标题（复用 Title 量级样式）+ 一条浅色分隔线。
    out.push(
      new Paragraph({
        style: 'Title',
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
    // 大纲列表/标题沿用默认渲染（list→numbering 自带层级缩进）；剥掉 AI 自带的「目录」标题。
    for (const node of stripLeadingTocHeading(group.nodes)) {
      out.push(...blockToDocx(node, env))
    }
    return out
  }
```

- [ ] **Step 3: 生成 + 验目录标题注入**

更新 `<scratchpad>/gen-docx.ts` 的 toc 节，加一个 AI 自带「目录」标题来验剥除（把 toc markdown 改为 `'# 目录\n\n1. 项目背景\n2. 需求分析\n3. 总体方案设计'`），重跑：

```bash
bun run "<scratchpad>/gen-docx.ts"
unzip -p "<scratchpad>/out.docx" word/document.xml | grep -o "目录" | wc -l
```
Expected: `1`（注入的标题在；AI 自带的「目录」标题已被剥除，全文只剩 1 个「目录」）。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 通过。

- [ ] **Step 5: docx-preview 手动确认目录页**

`bun run dev` → 写方案有目录草稿 → 看预览：目录节有居中「目录」大标题 + 分隔线 + 层级缩进的章节、无页码、独占一页。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/main/core/proposalDocx.ts
git commit -m "feat(proposal): 目录节注入「目录」标题+分隔线并剥重复

目录节首注入居中 Title 量级「目录」+浅色分隔线，剥掉 AI 自带的同名标题；
大纲沿用 list→numbering 的层级缩进，整页无页码。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: prompt 版式约束（proposalPrompt.ts）

降低 AI 输出与导出器版式打架：封面只逐行写信息、不加装饰；目录不自写「目录」标题。

**Files:**
- Modify: `apps/desktop/src/main/core/proposalPrompt.ts`（规则 5 的阶段一·封面、阶段二·目录两条）

**Interfaces:**
- Consumes: 无新依赖（纯文案）。
- Produces: prompt 文案变更（不改函数签名）。

- [ ] **Step 1: 改封面阶段文案**

在 `proposalPrompt.ts` 的「【阶段一·封面】」那条规则末尾，紧接「封面通常含：方案标题、客户单位、编制单位、日期。」之后、`把封面正文用第 6 条…` 之前，插入一句：

```
封面只需逐行写这些信息，每项一行，【不要】自己加「封面」字样、不要加任何居中/分页标签或装饰线——整页排布（竖向居中、水平居中、独占一页）由导出器统一处理。
```

- [ ] **Step 2: 改目录阶段文案**

在「【阶段二·目录】」那条规则里，「提出一份【章节目录大纲】（用有序列表逐章列出）」之后补一句：

```
【只输出有序列表形式的章节大纲本身，不要自己写「目录」二字标题】——「目录」大标题由导出器统一注入，你再写会重复。
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过（纯字符串改动）。

- [ ] **Step 4: 确认文案落位**

```bash
grep -n "由导出器统一处理\|由导出器统一注入" apps/desktop/src/main/core/proposalPrompt.ts
```
Expected: 两行各命中一处。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/core/proposalPrompt.ts
git commit -m "feat(proposal): prompt 约束封面只写信息、目录不自写标题

封面阶段明示不加装饰/居中标签（排版交导出器）；目录阶段明示不自写
「目录」标题（导出器注入），避免与新版式打架。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾验证（全计划完成后）

- [ ] `bun run typecheck` 全绿。
- [ ] `bun run dev`，造一份含封面+目录+正文的草稿，预览态 + 导出弹窗预览 + 导出 Word 三处比对：
  - 封面：竖向+水平居中、独占一页、无页码。
  - 目录：「目录」标题+分隔线+层级缩进、无页码、至少独占一页。
  - 正文：从新页开始、保留「— N —」页码页脚。
  - **预览与导出 Word 逐像素一致**（尤其封面竖向居中）。
- [ ] `.md` 导出：打开导出的 .md，确认**不含任何 `proposal-section` / `proposal-pagebreak` 标记**。
- [ ] 删除 scratchpad 临时脚本与 out.docx/out.xml（不入库）。

---

## Self-Review（写计划后自查，已执行）

- **Spec 覆盖**：封面竖向居中→Task 2(section verticalAlign)+Task 3(fallback)；封面水平居中/无首行缩进→Task 3；封面/目录无页码→Task 2；目录「目录」标题+剥重复→Task 4;层级缩进→沿用现有 numbering（Task 4 复用）；区段标记承载 kind/不动 IPC/.md 无标记→Task 1；prompt 轻调→Task 5；parity 风险与兜底→Task 3 Step 6。正文连续页码（不从 1 重起）= 维持现状，无需新任务。✔ 全覆盖。
- **占位符扫描**：无 TBD/TODO；每个代码步给出完整代码与确切命令、预期输出。兜底方案给了完整可套用代码。✔
- **类型一致性**：`PROPOSAL_SECTION_MARK`/`PROPOSAL_SECTION_RE`（Task 1 定义，Task 2 消费）、`SectionGroup`/`groupBySectionMarks`/`buildSectionChildren`/`pageNumberFooter`（Task 2 定义，Task 3/4 扩展同名）、`BlockContext.forceAlign`（Task 3 定义并即用）、`stripLeadingTocHeading`（Task 4 定义即用）命名前后一致。docx 导入名 `VerticalAlignSection`/`VerticalAlignTable`/`HeightRule`/`BorderStyle` 均经 `docx@9.7.1` d.ts 核实存在。✔
