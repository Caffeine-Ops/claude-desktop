# 写作实时预览工作区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `skills/writing` 配一个右栏工作区——AI 逐节写、右栏逐节亮，选中段落交 AI 改写并写回磁盘，成稿导出 Word / PDF / 公众号 HTML。

**Architecture:** 磁盘文件是唯一真相源。渲染层每 2 秒轮询 `drafts/*.md` 的文件名与 mtime，变了才拉正文（同 `LivePreviewEditor` 轮询 `svg_output/*.svg` 的既有模式）。纸面只读、逐块渲染；选区改写发消息给 AI，AI 用哨兵回改后文本，用户点「应用」后由渲染层拼回整节、经乐观锁写回文件。导出复用 proposal 已有的 `markdownToDocxBuffer` / `renderProposalPdfHtml` 引擎，**不改 proposal 一行代码**。

**Tech Stack:** Electron + React 19 + zustand + Tailwind v4 / shadcn；`bun test`；共享纯函数放 `electron/shared/`。

设计依据：`docs/superpowers/specs/2026-07-29-writing-live-preview-design.md`

## Global Constraints

- **包管理器是 `bun`，不是 npm。** 所有命令用 `bun`。
- **测试只在三个目录下会被执行**：`bun test electron/ src/chat/lib src/chat/composer`（见 `apps/studio/package.json` 的 `test` 脚本）。**纯逻辑一律放这三个目录之一**，放 `src/chat/stores/` 下的测试不会被跑。
- **加一条 IPC 要同时改四处**，漏一处 typecheck 报错：`electron/shared/ipc-channels.ts`（通道常量 + payload/result 类型）→ `electron/preload/index.ts`（暴露方法）→ `electron/preload/index.d.ts`（类型）→ main handler（`electron/main/ipc/register.ts`）。
- **不改 proposal 任何现有文件**。只 import 它的纯函数：`electron/shared/proposalBlocks.ts` 的 `splitBlocks` / `joinBlocks` / `spliceBlocks` / `locateBlockRangeByTextWithHint`；`electron/main/core/proposalDocx.ts` 的 `markdownToDocxBuffer`；`src/chat/lib/renderProposalPdfHtml.ts` 的 `renderProposalPdfHtml`；`electron/shared/proposalStyle.ts` 的 `cloneProposalStyle`。
- **CSS 铁律**（`CLAUDE.md`「样式分层」）：新组件一律用 shadcn 原语 + Tailwind utility，**禁止裸 `<button>`/`<input>`**（canvas 的裸元素 reset 会把它们填成描边卡片）。任何 `createPortal(…, document.body)` 的子树脱离 `.chat-app` 豁免，portal 内的交互元素**必须带 `data-slot` 属性**逃逸 canvas reset。
- **窗口拖拽**：新组件顶栏**禁止**声明 `app-region: drag`。顶部 46px 带内的交互元素要加 `[-webkit-app-region:no-drag]`。
- **注释密度**：这个仓库的注释解释「为什么这样而不是那样」。新增不变量时把理由写进注释。
- **验收命令**：`bun test`（在 `apps/studio/` 下跑）、`bun run typecheck`（仓库根，全 workspace）。
- **工作目录**：除非特别注明，所有相对路径均相对 `apps/studio/`。

---

### Task 1: 共享纯逻辑层 `writing.ts`

整个功能的地基：类型、体裁解析、节文件排序拼接、改写哨兵。全是纯函数、零 IO，前后端共用。

**Files:**
- Create: `apps/studio/electron/shared/writing.ts`
- Test: `apps/studio/electron/shared/writing.test.ts`

**Interfaces:**
- Consumes: `electron/shared/proposalBlocks.ts` 的 `splitBlocks`（本任务不用，后续任务用）
- Produces:
  - `type WritingDocSource = { kind: 'project'; projectDir: string } | { kind: 'single'; filePath: string }`
  - `type WritingGenre = 'wechat' | 'short-story' | 'article' | 'workplace'`
  - `interface WritingFileMeta { name: string; mtimeMs: number; size: number }`
  - `interface WritingSection { name: string; markdown: string; mtimeMs: number }`
  - `parseWritingGenre(specLockText: string | null): WritingGenre`
  - `parseOutlineTotal(designSpecText: string | null): number | null`
  - `sortSectionNames(names: string[]): string[]`
  - `joinWritingSections(sections: WritingSection[], opts: { pageBreaks: boolean }): string`
  - `shouldPageBreak(genre: WritingGenre): boolean`
  - `WRITING_REVISION_BEGIN` / `WRITING_REVISION_END` 常量
  - `extractRevisionResult(text: string): string | null`

- [ ] **Step 1: 写失败的测试**

创建 `apps/studio/electron/shared/writing.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import {
  parseWritingGenre,
  parseOutlineTotal,
  sortSectionNames,
  joinWritingSections,
  shouldPageBreak,
  extractRevisionResult,
  WRITING_REVISION_BEGIN,
  WRITING_REVISION_END
} from './writing'

describe('parseWritingGenre', () => {
  it('读出 spec_lock 的 genre', () => {
    const text = '# 写作契约\n\n## 体裁\n- genre: short-story\n- sub: 悬疑推理\n'
    expect(parseWritingGenre(text)).toBe('short-story')
  })

  it('文件不存在（null）退回 workplace 默认档', () => {
    expect(parseWritingGenre(null)).toBe('workplace')
  })

  it('有文件但没有 genre 字段，退回 workplace', () => {
    expect(parseWritingGenre('# 写作契约\n\n## 目标\n- audience: 通勤读者\n')).toBe('workplace')
  })

  it('genre 值不在白名单内，退回 workplace（不信任任意字符串）', () => {
    expect(parseWritingGenre('- genre: 随便写的\n')).toBe('workplace')
  })

  it('容忍全角冒号与多余空白', () => {
    expect(parseWritingGenre('-  genre ：  wechat  \n')).toBe('wechat')
  })
})

describe('parseOutlineTotal', () => {
  it('数出大纲里的节数', () => {
    const text = '# 写作方案\n\n## 大纲\n\n### 第1节 开场\n铺垫\n\n### 第2节 转折\n推进\n\n### 第3节 收束\n落点\n'
    expect(parseOutlineTotal(text)).toBe(3)
  })

  it('没有大纲段落时返回 null——不猜数字', () => {
    expect(parseOutlineTotal('# 写作方案\n\n## 目标\n写清楚\n')).toBeNull()
  })

  it('入参为 null 时返回 null', () => {
    expect(parseOutlineTotal(null)).toBeNull()
  })
})

describe('sortSectionNames', () => {
  it('数字前缀按自然序，不是字典序（10 排在 2 之后）', () => {
    const input = ['10-收束.md', '2-转折.md', '1-开场.md']
    expect(sortSectionNames(input)).toEqual(['1-开场.md', '2-转折.md', '10-收束.md'])
  })

  it('零填充前缀同样按数值排', () => {
    expect(sortSectionNames(['03-c.md', '01-a.md', '02-b.md'])).toEqual([
      '01-a.md',
      '02-b.md',
      '03-c.md'
    ])
  })

  it('无数字前缀的退回字典序', () => {
    expect(sortSectionNames(['b.md', 'a.md', 'c.md'])).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('混合时数字前缀的整体排在无前缀的前面（保证正文顺序稳定）', () => {
    expect(sortSectionNames(['附录.md', '2-b.md', '1-a.md'])).toEqual([
      '1-a.md',
      '2-b.md',
      '附录.md'
    ])
  })
})

describe('joinWritingSections', () => {
  const secs = [
    { name: '1-a.md', markdown: '# 第一章\n\n正文一', mtimeMs: 1, size: 0 } as never,
    { name: '2-b.md', markdown: '# 第二章\n\n正文二', mtimeMs: 2, size: 0 } as never
  ]

  it('不分页时用空行连接', () => {
    expect(joinWritingSections(secs, { pageBreaks: false })).toBe(
      '# 第一章\n\n正文一\n\n# 第二章\n\n正文二'
    )
  })

  it('分页时在节之间插入分页标记，首节前不插', () => {
    const out = joinWritingSections(secs, { pageBreaks: true })
    expect(out.startsWith('# 第一章')).toBe(true)
    expect(out).toContain('\n\n<!-- pagebreak -->\n\n# 第二章')
  })

  it('空数组返回空串', () => {
    expect(joinWritingSections([], { pageBreaks: true })).toBe('')
  })
})

describe('shouldPageBreak', () => {
  it('小说每节起新页（节=章节）', () => {
    expect(shouldPageBreak('short-story')).toBe(true)
  })

  it('文章与职场文档连续排版（节只是小标题段落）', () => {
    expect(shouldPageBreak('article')).toBe(false)
    expect(shouldPageBreak('workplace')).toBe(false)
  })

  it('微信不涉及分页', () => {
    expect(shouldPageBreak('wechat')).toBe(false)
  })
})

describe('extractRevisionResult', () => {
  it('抽出哨兵之间的正文并去掉首尾空白', () => {
    const text = `好的，我改了：\n${WRITING_REVISION_BEGIN}\n改后的段落。\n${WRITING_REVISION_END}\n还有什么要调整的吗？`
    expect(extractRevisionResult(text)).toBe('改后的段落。')
  })

  it('没有哨兵时返回 null——不把整段回复当成正文写进文件', () => {
    expect(extractRevisionResult('我觉得这段挺好的，需要我改哪里？')).toBeNull()
  })

  it('只有开始哨兵（被截断）时返回 null', () => {
    expect(extractRevisionResult(`${WRITING_REVISION_BEGIN}\n写到一半`)).toBeNull()
  })

  it('哨兵之间为空时返回 null——不拿空内容覆盖原文', () => {
    expect(extractRevisionResult(`${WRITING_REVISION_BEGIN}\n\n${WRITING_REVISION_END}`)).toBeNull()
  })

  it('取第一对哨兵（AI 多写了一对时不拼接）', () => {
    const text = `${WRITING_REVISION_BEGIN}\nA\n${WRITING_REVISION_END}\n${WRITING_REVISION_BEGIN}\nB\n${WRITING_REVISION_END}`
    expect(extractRevisionResult(text)).toBe('A')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test electron/shared/writing.test.ts
```

Expected: FAIL — `Cannot find module './writing'`

- [ ] **Step 3: 实现 `electron/shared/writing.ts`**

```ts
// 写作工作区的共享纯逻辑。main 与 renderer 共用此文件，保证两端对「体裁怎么判、节怎么排、
// 改写结果怎么抽」用同一份判定——两边各写一份必然漂移（proposal 的哨兵放 shared 是同一理由）。
// 零 IO、零 electron 依赖：bun test 在无 electron 的进程里跑。

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

// 大纲节：design_spec.md 里「## 大纲」之下的三级标题。只数这一段之内的，
// 免得把文档别处的 ### 也算进去。
const OUTLINE_HEADING = /^##\s+大纲\s*$/m
const SECTION_HEADING = /^###\s+\S/gm

/**
 * design_spec.md 正文 → 大纲节数（用于纸面末尾的「正在写第 N 节 · 共 M 节」）。
 * **解析不到返回 null，不猜数字**：显示一个错的总数比不显示更糟——用户会以为还差两节，
 * 其实已经写完了。null 时 UI 降级成「正在写下一节…」。
 */
export function parseOutlineTotal(designSpecText: string | null): number | null {
  if (!designSpecText) return null
  const start = OUTLINE_HEADING.exec(designSpecText)
  if (!start) return null
  const rest = designSpecText.slice(start.index + start[0].length)
  // 大纲段落到下一个二级标题为止
  const nextH2 = /^##\s+/m.exec(rest)
  const segment = nextH2 ? rest.slice(0, nextH2.index) : rest
  const matches = segment.match(SECTION_HEADING)
  return matches && matches.length > 0 ? matches.length : null
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
 * 分页标记。与 proposal 的导出链共用同一种 HTML 注释形态——`markdownToDocxBuffer`
 * 的 markdown 解析器把它当 html 节点，docx 生成时翻成分页符。
 */
const PAGE_BREAK = '<!-- pagebreak -->'

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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/studio && bun test electron/shared/writing.test.ts
```

Expected: PASS，24 个用例全绿

- [ ] **Step 5: 类型检查**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```

Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add apps/studio/electron/shared/writing.ts apps/studio/electron/shared/writing.test.ts
git commit -m "feat(writing): 写作工作区共享纯逻辑层（体裁解析/节排序/改写哨兵）"
```

---

### Task 2: 主进程文件读写层 + 三条 IPC

扫项目、读节、带乐观锁写回。核心函数可独立测试（用临时目录），IPC 布线在同一任务里完成——只有布通了下游才能用。

**Files:**
- Create: `apps/studio/electron/main/core/writingProject.ts`
- Create: `apps/studio/electron/main/core/writingProject.test.ts`
- Modify: `apps/studio/electron/shared/ipc-channels.ts`（追加通道常量 + payload/result 类型）
- Modify: `apps/studio/electron/preload/index.ts`（暴露三个方法）
- Modify: `apps/studio/electron/preload/index.d.ts`（类型）
- Modify: `apps/studio/electron/main/ipc/register.ts`（三个 handler）

**Interfaces:**
- Consumes: Task 1 的 `WritingDocSource` / `WritingGenre` / `WritingFileMeta` / `WritingSection` / `parseWritingGenre` / `parseOutlineTotal` / `sortSectionNames`
- Produces:
  - `scanWritingDoc(source: WritingDocSource): WritingScanResult`
  - `readWritingSections(source: WritingDocSource, names: string[]): WritingReadResult`
  - `writeWritingSection(source: WritingDocSource, name: string, markdown: string, expectedMtimeMs: number): WritingWriteResult`
  - `window.chatApi.writingScan` / `writingReadSections` / `writingWriteSection`

- [ ] **Step 1: 写失败的测试**

创建 `apps/studio/electron/main/core/writingProject.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanWritingDoc, readWritingSections, writeWritingSection } from './writingProject'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'writing-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeProject(opts: { specLock?: string; designSpec?: string; drafts?: Record<string, string> }): string {
  const dir = join(root, 'proj_2026-07-29')
  mkdirSync(join(dir, 'drafts'), { recursive: true })
  if (opts.specLock !== undefined) writeFileSync(join(dir, 'spec_lock.md'), opts.specLock)
  if (opts.designSpec !== undefined) writeFileSync(join(dir, 'design_spec.md'), opts.designSpec)
  for (const [name, body] of Object.entries(opts.drafts ?? {})) {
    writeFileSync(join(dir, 'drafts', name), body)
  }
  return dir
}

describe('scanWritingDoc · project 模式', () => {
  it('回体裁、大纲总数与节文件元信息（按自然序）', () => {
    const dir = makeProject({
      specLock: '## 体裁\n- genre: short-story\n',
      designSpec: '## 大纲\n\n### 第1节 开场\n\n### 第2节 收束\n',
      drafts: { '10-j.md': 'j', '2-b.md': 'b', '1-a.md': 'a' }
    })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.genre).toBe('short-story')
    expect(r.outlineTotal).toBe(2)
    expect(r.files.map((f) => f.name)).toEqual(['1-a.md', '2-b.md', '10-j.md'])
    expect(r.files[0].size).toBeGreaterThan(0)
  })

  it('没有 spec_lock 时退回 workplace 默认档', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.genre).toBe('workplace')
  })

  it('drafts 目录还没建（AI 刚 init 完）时回空列表，不是错误', () => {
    const dir = join(root, 'empty_proj')
    mkdirSync(dir)
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.files).toEqual([])
  })

  it('只认 .md，忽略其他文件（编辑器临时文件不该进正文）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a', '.DS_Store': 'x', 'notes.txt': 'y' } })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.files.map((f) => f.name)).toEqual(['1-a.md'])
  })

  it('项目目录不存在时回 dirMissing，供 UI 退回空态', () => {
    const r = scanWritingDoc({ kind: 'project', projectDir: join(root, 'nope') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.dirMissing).toBe(true)
  })

  it('相对路径一律拒绝（IPC 边界的路径守卫）', () => {
    const r = scanWritingDoc({ kind: 'project', projectDir: 'relative/path' })
    expect(r.ok).toBe(false)
  })
})

describe('scanWritingDoc · single 模式', () => {
  it('单文件当作只有一节的文档，体裁恒为默认档', () => {
    const f = join(root, '周报.md')
    writeFileSync(f, '# 本周周报\n\n做了三件事')
    const r = scanWritingDoc({ kind: 'single', filePath: f })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.genre).toBe('workplace')
    expect(r.outlineTotal).toBeNull()
    expect(r.files.map((f2) => f2.name)).toEqual(['周报.md'])
  })

  it('文件不存在时回 dirMissing', () => {
    const r = scanWritingDoc({ kind: 'single', filePath: join(root, 'nope.md') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.dirMissing).toBe(true)
  })
})

describe('readWritingSections', () => {
  it('按给定名字读正文，返回顺序与 names 无关、恒为自然序', () => {
    const dir = makeProject({ drafts: { '1-a.md': '正文一', '2-b.md': '正文二' } })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, ['2-b.md', '1-a.md'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sections.map((s) => s.name)).toEqual(['1-a.md', '2-b.md'])
    expect(r.sections[0].markdown).toBe('正文一')
    expect(r.sections[0].mtimeMs).toBeGreaterThan(0)
  })

  it('names 为空数组 = 读全部', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a', '2-b.md': 'b' } })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, [])
    expect(r.ok && r.sections.length).toBe(2)
  })

  it('跳过读不到的文件而不是整批失败（AI 可能正好在改名）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, ['1-a.md', '9-gone.md'])
    expect(r.ok && r.sections.map((s) => s.name)).toEqual(['1-a.md'])
  })

  it('拒绝带路径分隔符的名字（防目录穿越）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, ['../../etc/passwd'])
    expect(r.ok && r.sections).toEqual([])
  })
})

describe('writeWritingSection · 乐观锁', () => {
  it('mtime 相符时写入成功并回新 mtime', () => {
    const dir = makeProject({ drafts: { '1-a.md': '旧正文' } })
    const before = statSync(join(dir, 'drafts', '1-a.md')).mtimeMs
    const r = writeWritingSection({ kind: 'project', projectDir: dir }, '1-a.md', '新正文', before)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mtimeMs).toBeGreaterThanOrEqual(before)
  })

  it('mtime 不符时拒写，回冲突与盘上最新内容', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'AI 刚改过的内容' } })
    const r = writeWritingSection({ kind: 'project', projectDir: dir }, '1-a.md', '我的改动', 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflict).toBe(true)
    expect(r.current?.markdown).toBe('AI 刚改过的内容')
  })

  it('冲突时磁盘内容原封不动', () => {
    const dir = makeProject({ drafts: { '1-a.md': '原内容' } })
    writeWritingSection({ kind: 'project', projectDir: dir }, '1-a.md', '我的改动', 1)
    const r = readWritingSections({ kind: 'project', projectDir: dir }, ['1-a.md'])
    expect(r.ok && r.sections[0].markdown).toBe('原内容')
  })

  it('拒绝带路径分隔符的名字（防目录穿越）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = writeWritingSection({ kind: 'project', projectDir: dir }, '../evil.md', 'x', 0)
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test electron/main/core/writingProject.test.ts
```

Expected: FAIL — `Cannot find module './writingProject'`

- [ ] **Step 3: 实现 `electron/main/core/writingProject.ts`**

```ts
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import {
  parseOutlineTotal,
  parseWritingGenre,
  sortSectionNames,
  type WritingDocSource,
  type WritingFileMeta,
  type WritingGenre,
  type WritingSection
} from '../../shared/writing'

/**
 * 写作文档的磁盘访问层。三个动作：扫（轮询用，只回元信息）、读（拉正文）、
 * 写（带乐观锁）。**同步 fs 是刻意的**：三个操作都在几个小文件上，异步化换来的
 * 并发收益抵不过让 handler 变成 async 之后的错误路径复杂度（proposalDraftStore
 * 同理）。
 */

export type WritingScanResult =
  | { ok: true; genre: WritingGenre; outlineTotal: number | null; files: WritingFileMeta[] }
  | { ok: false; dirMissing?: true; error: string }

export type WritingReadResult =
  | { ok: true; sections: WritingSection[] }
  | { ok: false; error: string }

export type WritingWriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; conflict: true; current: { markdown: string; mtimeMs: number } | null }
  | { ok: false; conflict?: false; error: string }

/** 读文本，任何失败（不存在/不是文件/无权限）一律回 null——调用方据此走默认分支。 */
function readTextOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 节文件所在目录。project 模式是 <projectDir>/drafts，single 模式是那个文件的父目录。
 * 统一到一个函数，下游三个动作就不用各自分叉。
 */
function sectionDir(source: WritingDocSource): string {
  return source.kind === 'project' ? join(source.projectDir, 'drafts') : dirname(source.filePath)
}

/**
 * 名字白名单：必须是纯文件名的 .md。**拒绝任何带路径分隔符的名字**——name 来自 IPC，
 * 直接 join 会被 `../../` 穿越出项目目录写到任意位置。
 */
function isSafeSectionName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name === basename(name) &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name.toLowerCase().endsWith('.md')
  )
}

/** IPC 入口的路径守卫：只收绝对路径（相对路径的基准目录在 main 侧毫无意义）。 */
function sourceAbsPath(source: WritingDocSource): string | null {
  const p = source.kind === 'project' ? source.projectDir : source.filePath
  return typeof p === 'string' && p.length > 0 && isAbsolute(p) ? p : null
}

export function scanWritingDoc(source: WritingDocSource): WritingScanResult {
  const abs = sourceAbsPath(source)
  if (!abs) return { ok: false, error: 'Invalid path (expected absolute).' }

  if (source.kind === 'single') {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      return { ok: false, dirMissing: true, error: 'Document not found.' }
    }
    if (!st.isFile()) return { ok: false, dirMissing: true, error: 'Not a file.' }
    return {
      ok: true,
      // 单文件模式没有契约可读，恒走默认档——职场快道 / 去AI化本来就不建 spec_lock。
      genre: 'workplace',
      outlineTotal: null,
      files: [{ name: basename(abs), mtimeMs: st.mtimeMs, size: st.size }]
    }
  }

  try {
    if (!statSync(abs).isDirectory()) {
      return { ok: false, dirMissing: true, error: 'Not a directory.' }
    }
  } catch {
    return { ok: false, dirMissing: true, error: 'Project directory not found.' }
  }

  const genre = parseWritingGenre(readTextOrNull(join(abs, 'spec_lock.md')))
  const outlineTotal = parseOutlineTotal(readTextOrNull(join(abs, 'design_spec.md')))

  // drafts/ 还没建（AI 刚 init 完、还没开写）不是错误，回空列表让 UI 显示「等待 AI 开写」。
  let names: string[]
  try {
    names = readdirSync(sectionDir(source))
  } catch {
    return { ok: true, genre, outlineTotal, files: [] }
  }

  const files: WritingFileMeta[] = []
  for (const name of sortSectionNames(names.filter(isSafeSectionName))) {
    try {
      const st = statSync(join(sectionDir(source), name))
      if (st.isFile()) files.push({ name, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // 扫描与 stat 之间文件消失（AI 正在改名）——跳过，下一轮轮询自会补上。
    }
  }
  return { ok: true, genre, outlineTotal, files }
}

export function readWritingSections(
  source: WritingDocSource,
  names: string[]
): WritingReadResult {
  const abs = sourceAbsPath(source)
  if (!abs) return { ok: false, error: 'Invalid path (expected absolute).' }

  // names 为空 = 读全部。先扫一次拿到当前文件清单，避免调用方还得先 scan 再 read。
  let wanted = names.filter(isSafeSectionName)
  if (names.length === 0) {
    const scan = scanWritingDoc(source)
    if (!scan.ok) return { ok: false, error: scan.error }
    wanted = scan.files.map((f) => f.name)
  }

  const dir = sectionDir(source)
  const sections: WritingSection[] = []
  for (const name of sortSectionNames(wanted)) {
    try {
      const p = join(dir, name)
      const st = statSync(p)
      if (!st.isFile()) continue
      sections.push({ name, markdown: readFileSync(p, 'utf-8'), mtimeMs: st.mtimeMs })
    } catch {
      // 单个文件读不到就跳过，不让整批失败——AI 可能正好在改名或删重建。
    }
  }
  return { ok: true, sections }
}

export function writeWritingSection(
  source: WritingDocSource,
  name: string,
  markdown: string,
  expectedMtimeMs: number
): WritingWriteResult {
  const abs = sourceAbsPath(source)
  if (!abs) return { ok: false, error: 'Invalid path (expected absolute).' }
  if (!isSafeSectionName(name)) return { ok: false, error: 'Invalid section name.' }
  if (typeof markdown !== 'string') return { ok: false, error: 'Invalid markdown.' }

  const p = join(sectionDir(source), name)
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(p)
  } catch {
    return { ok: false, conflict: true, current: null }
  }

  // 乐观锁：读这一节时记下的 mtime 与盘上不符 = 期间被 AI 改过。拒写并回传最新内容，
  // 由 UI 提示用户重来。宁可让用户重做一次，也不静默覆盖 AI 的产出（反之亦然）。
  // 用不等号而非「大于」：文件被删后重建，mtime 理论上可能变小。
  if (st.mtimeMs !== expectedMtimeMs) {
    let current: { markdown: string; mtimeMs: number } | null = null
    try {
      current = { markdown: readFileSync(p, 'utf-8'), mtimeMs: st.mtimeMs }
    } catch {
      current = null
    }
    return { ok: false, conflict: true, current }
  }

  try {
    writeFileSync(p, markdown, 'utf-8')
    return { ok: true, mtimeMs: statSync(p).mtimeMs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/studio && bun test electron/main/core/writingProject.test.ts
```

Expected: PASS，全部用例绿

- [ ] **Step 5: 加 IPC 通道常量与类型**

在 `apps/studio/electron/shared/ipc-channels.ts` 的 `IPC_CHANNELS` 对象里，紧挨 `PROPOSAL_*` 那组之后追加：

```ts
  /**
   * Renderer → main. 写作工作区轮询入口：回体裁、大纲总节数、节文件元信息。
   * 【只回元信息不回正文】——每 2s 搬一遍万字正文毫无必要，正文走 WRITING_READ_SECTIONS
   * 按需拉。同款分工见 PPT_PREVIEW_LIST_SLIDES。
   */
  WRITING_SCAN: 'writing:scan',
  /** Renderer → main. 按名字批量拉节正文；names 为空数组 = 拉全部。 */
  WRITING_READ_SECTIONS: 'writing:read-sections',
  /**
   * Renderer → main. 带乐观锁写回一节。expectedMtimeMs 与盘上不符即拒写、回传盘上最新内容
   * （AI 可能在润色阶段回头重写该节）。绝不静默覆盖。
   */
  WRITING_WRITE_SECTION: 'writing:write-section',
```

在同文件末尾的类型区（`ProposalExportFormat` 那一带）追加：

```ts
import type { WritingDocSource, WritingFileMeta, WritingGenre, WritingSection } from './writing'

/** Payload for WRITING_SCAN. */
export interface WritingScanPayload {
  source: WritingDocSource
}
/** Result of WRITING_SCAN. `dirMissing` 供 UI 区分「目录没了」与「读失败」。 */
export type WritingScanResultIpc =
  | { ok: true; genre: WritingGenre; outlineTotal: number | null; files: WritingFileMeta[] }
  | { ok: false; dirMissing?: true; error: string }

/** Payload for WRITING_READ_SECTIONS. `names` 为空数组表示读全部。 */
export interface WritingReadSectionsPayload {
  source: WritingDocSource
  names: string[]
}
/** Result of WRITING_READ_SECTIONS. */
export type WritingReadSectionsResultIpc =
  | { ok: true; sections: WritingSection[] }
  | { ok: false; error: string }

/** Payload for WRITING_WRITE_SECTION. */
export interface WritingWriteSectionPayload {
  source: WritingDocSource
  name: string
  markdown: string
  expectedMtimeMs: number
}
/** Result of WRITING_WRITE_SECTION. `conflict` = 乐观锁拦下，`current` 是盘上最新内容。 */
export type WritingWriteSectionResultIpc =
  | { ok: true; mtimeMs: number }
  | { ok: false; conflict: true; current: { markdown: string; mtimeMs: number } | null }
  | { ok: false; conflict?: false; error: string }
```

- [ ] **Step 6: 在 preload 暴露三个方法**

`apps/studio/electron/preload/index.ts`，在 `chatApi` 对象里追加（照抄同文件里 `renderProposalPdf` 那几行的写法）：

```ts
  writingScan: (payload: WritingScanPayload): Promise<WritingScanResultIpc> =>
    ipcRenderer.invoke(IPC_CHANNELS.WRITING_SCAN, payload),
  writingReadSections: (
    payload: WritingReadSectionsPayload
  ): Promise<WritingReadSectionsResultIpc> =>
    ipcRenderer.invoke(IPC_CHANNELS.WRITING_READ_SECTIONS, payload),
  writingWriteSection: (
    payload: WritingWriteSectionPayload
  ): Promise<WritingWriteSectionResultIpc> =>
    ipcRenderer.invoke(IPC_CHANNELS.WRITING_WRITE_SECTION, payload),
```

`apps/studio/electron/preload/index.d.ts` 的 `ChatApi` 接口里加对应三行签名（类型与上面一致）。

- [ ] **Step 7: 在 main 注册三个 handler**

`apps/studio/electron/main/ipc/register.ts`，在 proposal 那组 handler 之后追加：

```ts
  // 写作工作区：扫 / 读 / 写。业务逻辑全在 writingProject.ts（可单测），
  // 这里只做「拿到 payload → 转调 → 原样回传」的薄壳。
  ipcMain.handle(
    IPC_CHANNELS.WRITING_SCAN,
    async (_event, payload: WritingScanPayload): Promise<WritingScanResultIpc> =>
      scanWritingDoc(payload.source)
  )

  ipcMain.handle(
    IPC_CHANNELS.WRITING_READ_SECTIONS,
    async (
      _event,
      payload: WritingReadSectionsPayload
    ): Promise<WritingReadSectionsResultIpc> =>
      readWritingSections(payload.source, Array.isArray(payload.names) ? payload.names : [])
  )

  ipcMain.handle(
    IPC_CHANNELS.WRITING_WRITE_SECTION,
    async (
      _event,
      payload: WritingWriteSectionPayload
    ): Promise<WritingWriteSectionResultIpc> =>
      writeWritingSection(
        payload.source,
        payload.name,
        payload.markdown,
        payload.expectedMtimeMs
      )
  )
```

文件顶部加 import：

```ts
import {
  scanWritingDoc,
  readWritingSections,
  writeWritingSection
} from '../core/writingProject'
```

- [ ] **Step 8: 类型检查**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```

Expected: 无错误。若报「Property 'writingScan' does not exist」，说明 `preload/index.d.ts` 漏改——四处必须齐。

- [ ] **Step 9: 提交**

```bash
git add apps/studio/electron/main/core/writingProject.ts apps/studio/electron/main/core/writingProject.test.ts apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/index.ts apps/studio/electron/preload/index.d.ts apps/studio/electron/main/ipc/register.ts
git commit -m "feat(writing): 主进程节文件读写层 + 三条 IPC（扫描/读节/乐观锁写回）"
```

---

### Task 3: 接管判定纯函数

从消息里的工具调用判断「当前会话是不是在写作、文档源是什么」。独立成纯函数放 `src/chat/lib/`（该目录在 `bun test` 覆盖范围内）。

**Files:**
- Create: `apps/studio/src/chat/lib/writingDocSource.ts`
- Test: `apps/studio/src/chat/lib/writingDocSource.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WritingDocSource`
- Produces:
  - `WRITING_PROJECT_MARKER = 'WRITING_PROJECT='`
  - `WRITING_SINGLE_DIR = '写作'`
  - `detectWritingSource(parts: WritingToolPart[]): WritingDocSource | null`
  - `interface WritingToolPart { toolName: string; commandText: string; resultText: string; filePath: string | null }`

- [ ] **Step 1: 写失败的测试**

创建 `apps/studio/src/chat/lib/writingDocSource.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { detectWritingSource, type WritingToolPart } from './writingDocSource'

function bash(resultText: string, commandText = ''): WritingToolPart {
  return { toolName: 'Bash', commandText, resultText, filePath: null }
}
function write(filePath: string): WritingToolPart {
  return { toolName: 'Write', commandText: '', resultText: '', filePath }
}

describe('detectWritingSource · 项目模式', () => {
  it('从脚本输出的 WRITING_PROJECT= 行抓项目目录', () => {
    const parts = [bash('已创建项目\nWRITING_PROJECT=/Users/k/写作/小说_2026-07-29\n')]
    expect(detectWritingSource(parts)).toEqual({
      kind: 'project',
      projectDir: '/Users/k/写作/小说_2026-07-29'
    })
  })

  it('多次 init 时取最后一个（用户开了第二个项目）', () => {
    const parts = [
      bash('WRITING_PROJECT=/a/proj1\n'),
      bash('WRITING_PROJECT=/a/proj2\n')
    ]
    expect(detectWritingSource(parts)).toEqual({ kind: 'project', projectDir: '/a/proj2' })
  })

  it('相对路径不接管——main 侧只收绝对路径，早点挡住避免无谓 IPC', () => {
    expect(detectWritingSource([bash('WRITING_PROJECT=relative/proj\n')])).toBeNull()
  })

  it('标记后面为空时不接管', () => {
    expect(detectWritingSource([bash('WRITING_PROJECT=\n')])).toBeNull()
  })
})

describe('detectWritingSource · 单文件模式', () => {
  it('认 Write 到「写作」目录下的 .md', () => {
    expect(detectWritingSource([write('/Users/k/proj/写作/本周周报.md')])).toEqual({
      kind: 'single',
      filePath: '/Users/k/proj/写作/本周周报.md'
    })
  })

  it('不在「写作」目录下的 md 不接管（AI 写别的文档不该弹工作区）', () => {
    expect(detectWritingSource([write('/Users/k/proj/docs/readme.md')])).toBeNull()
  })

  it('「写作」目录下的非 md 不接管', () => {
    expect(detectWritingSource([write('/Users/k/proj/写作/data.json')])).toBeNull()
  })

  it('多次写入取最后一个', () => {
    const parts = [write('/a/写作/一.md'), write('/a/写作/二.md')]
    expect(detectWritingSource(parts)).toEqual({ kind: 'single', filePath: '/a/写作/二.md' })
  })
})

describe('detectWritingSource · 优先级与兜底', () => {
  it('项目模式优先于单文件模式，与出现顺序无关', () => {
    const parts = [write('/a/写作/周报.md'), bash('WRITING_PROJECT=/a/proj\n')]
    expect(detectWritingSource(parts)).toEqual({ kind: 'project', projectDir: '/a/proj' })
    const reversed = [bash('WRITING_PROJECT=/a/proj\n'), write('/a/写作/周报.md')]
    expect(detectWritingSource(reversed)).toEqual({ kind: 'project', projectDir: '/a/proj' })
  })

  it('没有任何写作痕迹时返回 null（普通会话保持单栏）', () => {
    expect(detectWritingSource([bash('ls -la'), write('/a/src/index.ts')])).toBeNull()
  })

  it('空数组返回 null', () => {
    expect(detectWritingSource([])).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test src/chat/lib/writingDocSource.test.ts
```

Expected: FAIL — `Cannot find module './writingDocSource'`

- [ ] **Step 3: 实现 `src/chat/lib/writingDocSource.ts`**

```ts
import type { WritingDocSource } from '@desktop-shared/writing'

/**
 * 「当前会话是不是在写作、正文在哪」的判定。**纯函数**：入参是从消息里摘出来的工具调用
 * 摘要，不碰 store、不碰 window——放在 src/chat/lib/ 才进得了 bun test 的覆盖范围
 * （package.json 的 test 脚本只跑 electron/、src/chat/lib、src/chat/composer）。
 *
 * 判定思路照搬 chat.ts 的 usePreviewServer：遍历消息里的 tool-call，从命令文本 / 命令输出 /
 * 工具参数里找路径。**不猜路径**——项目目录名是 <slug>_<日期>，slug 规则在 Python 里
 * （中文保留、其余压下划线），前端复刻一份必然漂移，所以让脚本自己报数。
 */

/** `project_manager.py init` 在 stdout 末行打印的标记。同款手法见 bin/ensure-python.cmd 的 `WRITING_PY=`。 */
export const WRITING_PROJECT_MARKER = 'WRITING_PROJECT='

/** 单文件模式的约定落点目录名（职场快道 / 去AI化的成稿写进 <cwd>/写作/）。 */
export const WRITING_SINGLE_DIR = '写作'

/** 从一条 tool-call 里摘出的判定素材。由调用方（store）从消息树上取，本模块不关心怎么取。 */
export interface WritingToolPart {
  toolName: string
  /** Bash 的命令文本；非 Bash 为空串。 */
  commandText: string
  /** Bash 的命令输出；没有结果时为空串。 */
  resultText: string
  /** Write/Edit 的目标绝对路径；非文件工具为 null。 */
  filePath: string | null
}

// 标记行：取到行尾，两侧 trim。用 [^\r\n]+ 而非 \S+ 是因为路径可能含空格。
const PROJECT_LINE = new RegExp(`${WRITING_PROJECT_MARKER}([^\\r\\n]+)`, 'g')

/** 只认绝对路径：main 侧的路径守卫会拒相对路径，这里先挡住省一次无谓 IPC。 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

/** 路径是否落在「写作」目录下且是 .md。用分隔符包夹匹配，防止 `我的写作笔记/` 这类误命中。 */
function isSingleDocPath(p: string): boolean {
  if (!p.toLowerCase().endsWith('.md')) return false
  const norm = p.replace(/\\/g, '/')
  return norm.includes(`/${WRITING_SINGLE_DIR}/`)
}

/**
 * 遍历工具调用，判定文档源。**项目模式优先于单文件模式**：主管线会先 init 项目再写文件，
 * 若按出现顺序取最后一个，写第一节时就会被 Write 的路径判定顶掉。两种模式各自取「最后一次」
 * （用户可能在同一会话里开第二个项目 / 写第二篇周报）。都没有则返回 null，会话保持单栏。
 */
export function detectWritingSource(parts: WritingToolPart[]): WritingDocSource | null {
  let projectDir: string | null = null
  let singleFile: string | null = null

  for (const p of parts) {
    if (p.toolName === 'Bash') {
      // 标记可能出现在命令输出里（正常路径），也可能在命令文本里（用户手敲 echo 调试）。
      // 两处都扫，取最后一次命中。
      for (const hay of [p.commandText, p.resultText]) {
        if (!hay) continue
        PROJECT_LINE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = PROJECT_LINE.exec(hay)) !== null) {
          const dir = m[1].trim()
          if (dir && isAbsolutePath(dir)) projectDir = dir
        }
      }
      continue
    }
    if (p.filePath && isAbsolutePath(p.filePath) && isSingleDocPath(p.filePath)) {
      singleFile = p.filePath
    }
  }

  if (projectDir) return { kind: 'project', projectDir }
  if (singleFile) return { kind: 'single', filePath: singleFile }
  return null
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/studio && bun test src/chat/lib/writingDocSource.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/lib/writingDocSource.ts apps/studio/src/chat/lib/writingDocSource.test.ts
git commit -m "feat(writing): 写作工作区接管判定（项目标记 / 单文件落点）"
```

---

### Task 4: 前端 store + 轮询

把接管判定、轮询、节内容管起来。这一步做完还看不见东西，但下一步的 UI 全靠它。

**Files:**
- Create: `apps/studio/src/chat/stores/writing.ts`

**Interfaces:**
- Consumes: Task 1 类型、Task 2 的 `window.chatApi.writingScan` / `writingReadSections`、Task 3 的 `detectWritingSource`
- Produces:
  - `useWritingStore`（zustand）：`{ source, genre, outlineTotal, sections, status, setSource, applyScan, setSections, replaceSectionMarkdown }`
  - `useWritingWorkspace(): boolean` —— 右栏门控
  - `useWritingSource(): WritingDocSource | null` —— 从当前会话消息推导文档源
  - `useWritingPoll(active: boolean): void` —— 轮询副作用 hook

- [ ] **Step 1: 实现 store**

创建 `apps/studio/src/chat/stores/writing.ts`：

```ts
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import type { WritingDocSource, WritingGenre, WritingSection } from '@desktop-shared/writing'
import { detectWritingSource, type WritingToolPart } from '../lib/writingDocSource'
import { useChatStore } from './chat'

/** 轮询间隔。2s 是「AI 写完一节到你看见」的上限，对人眼足够；再密只是空转 IPC。 */
const POLL_MS = 2000

type WritingStatus = 'idle' | 'ready' | 'missing' | 'error'

interface WritingState {
  source: WritingDocSource | null
  genre: WritingGenre
  outlineTotal: number | null
  sections: WritingSection[]
  status: WritingStatus
  errMsg: string
  /** 切换文档源：清空旧内容，避免上一篇的正文闪现在新文档里。 */
  setSource: (source: WritingDocSource | null) => void
  applyScan: (v: { genre: WritingGenre; outlineTotal: number | null }) => void
  setSections: (sections: WritingSection[]) => void
  setStatus: (status: WritingStatus, errMsg?: string) => void
  /** 应用改写后就地替换一节的正文与 mtime（写盘成功后调用，避免等下一轮轮询才刷新）。 */
  replaceSectionMarkdown: (name: string, markdown: string, mtimeMs: number) => void
}

export const useWritingStore = create<WritingState>((set) => ({
  source: null,
  genre: 'workplace',
  outlineTotal: null,
  sections: [],
  status: 'idle',
  errMsg: '',
  setSource: (source) =>
    set({ source, sections: [], outlineTotal: null, status: 'idle', errMsg: '' }),
  applyScan: ({ genre, outlineTotal }) => set({ genre, outlineTotal }),
  setSections: (sections) => set({ sections }),
  setStatus: (status, errMsg = '') => set({ status, errMsg }),
  replaceSectionMarkdown: (name, markdown, mtimeMs) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.name === name ? { ...sec, markdown, mtimeMs } : sec))
    }))
}))

/**
 * 从当前会话的消息树推导文档源。订阅 messages 会随流式每 delta 重算，故用 useShallow +
 * 把重活关在纯函数里（detectWritingSource 只扫 tool-call、不碰正文文本）。
 */
export function useWritingSource(): WritingDocSource | null {
  return useChatStore(
    useShallow((s): WritingDocSource | null => {
      const parts: WritingToolPart[] = []
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const p of m.content as unknown as {
          type: string
          toolName?: string
          args?: Record<string, unknown>
          result?: unknown
        }[]) {
          if (p.type !== 'tool-call' || !p.toolName) continue
          const args = p.args ?? {}
          parts.push({
            toolName: p.toolName,
            commandText: typeof args.command === 'string' ? args.command : '',
            resultText: typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? ''),
            filePath: typeof args.file_path === 'string' ? args.file_path : null
          })
        }
      }
      return detectWritingSource(parts)
    })
  )
}

/** 右栏门控：有文档源即接管。与 proposal / slides 的互斥在 ThreadView 里裁决。 */
export function useWritingWorkspace(): boolean {
  return useWritingStore((s) => s.source !== null)
}

/**
 * 轮询副作用。只在 `active`（面板挂载且当前会话是写作会话）时跑。
 *
 * 两个必须守住的点：
 *  1) **只在元信息变了才拉正文**。scan 回的是文件名+mtime+size，与上一轮签名一致就什么都不做——
 *     否则每 2s 把万字正文搬一遍，长篇会明显卡。
 *  2) **cancelled 闸门**。一轮里有两次 await，期间可能切会话/换文档源；晚到的响应必须丢弃，
 *     不能覆盖新文档的内容（proposal 预览的 objectURL 竞态是同一类问题）。
 */
export function useWritingPoll(active: boolean): void {
  const source = useWritingStore((s) => s.source)
  const lastSignature = useRef<string | null>(null)

  useEffect(() => {
    if (!active || !source) return
    lastSignature.current = null
    let cancelled = false

    async function tick(): Promise<void> {
      if (!source) return
      const scan = await window.chatApi.writingScan({ source })
      if (cancelled) return
      const st = useWritingStore.getState()
      if (!scan.ok) {
        st.setStatus(scan.dirMissing ? 'missing' : 'error', scan.error)
        return
      }
      st.applyScan({ genre: scan.genre, outlineTotal: scan.outlineTotal })
      const signature = scan.files.map((f) => `${f.name}:${f.mtimeMs}:${f.size}`).join('|')
      if (signature === lastSignature.current) {
        st.setStatus('ready')
        return
      }
      const read = await window.chatApi.writingReadSections({ source, names: [] })
      if (cancelled) return
      if (!read.ok) {
        useWritingStore.getState().setStatus('error', read.error)
        return
      }
      lastSignature.current = signature
      useWritingStore.getState().setSections(read.sections)
      useWritingStore.getState().setStatus('ready')
    }

    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, source])
}
```

- [ ] **Step 2: 类型检查**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```

Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add apps/studio/src/chat/stores/writing.ts
git commit -m "feat(writing): 写作工作区前端 store + 2s 目录轮询"
```

---

### Task 5: 纸面渲染 + 右栏接管（第一个能看见的里程碑）

做完这一步，跑 `bun run dev` 让 AI 写文章，右栏就会逐节亮起来。

**Files:**
- Create: `apps/studio/src/chat/components/workspace/WritingPaper.tsx`
- Create: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`
- Create: `apps/studio/src/chat/lib/writingGenreStyle.ts`
- Test: `apps/studio/src/chat/lib/writingGenreStyle.test.ts`
- Modify: `apps/studio/src/chat/components/chat/ThreadView/ThreadView.tsx`（约 499-510 行加门控；836-862 行加右栏分支）

**Interfaces:**
- Consumes: Task 4 的 `useWritingStore` / `useWritingSource` / `useWritingWorkspace` / `useWritingPoll`；`splitBlocks`（`@desktop-shared/proposalBlocks`）
- Produces:
  - `writingStyleFor(genre: WritingGenre): ProposalStyleConfig`
  - `paperSkinClass(genre: WritingGenre): string`
  - `<WritingPaper />`、`<WritingDocPanel />`

- [ ] **Step 1: 写体裁样式的失败测试**

创建 `apps/studio/src/chat/lib/writingGenreStyle.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { writingStyleFor, paperSkinClass } from './writingGenreStyle'

describe('writingStyleFor', () => {
  it('一律关掉品牌横幅——写作交付的是用户自己的稿子，不该印 Fusion Ai logo', () => {
    for (const g of ['wechat', 'short-story', 'article', 'workplace'] as const) {
      expect(writingStyleFor(g).brand).toBe(false)
    }
  })

  it('小说正文首行缩进两字符、段后不留白（靠缩进分段）', () => {
    const s = writingStyleFor('short-story')
    expect(s.body.indentChars).toBe(2)
    expect(s.spaceAfterPt).toBe(0)
  })

  it('文章不缩进、段后留白', () => {
    const s = writingStyleFor('article')
    expect(s.body.indentChars).toBe(0)
    expect(s.spaceAfterPt).toBeGreaterThan(0)
  })

  it('职场文档标题用黑体、正文仿宋（公文观感）', () => {
    const s = writingStyleFor('workplace')
    expect(s.h1.font).toBe('黑体')
    expect(s.body.font).toBe('仿宋')
    expect(s.body.indentChars).toBe(0)
  })

  it('每次调用返回独立对象，改一个不影响另一个', () => {
    const a = writingStyleFor('article')
    const b = writingStyleFor('article')
    a.body.indentChars = 9
    expect(b.body.indentChars).toBe(0)
  })
})

describe('paperSkinClass', () => {
  it('四种体裁给出各不相同的皮肤类名', () => {
    const classes = (['wechat', 'short-story', 'article', 'workplace'] as const).map(paperSkinClass)
    expect(new Set(classes).size).toBe(4)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test src/chat/lib/writingGenreStyle.test.ts
```

Expected: FAIL — `Cannot find module './writingGenreStyle'`

- [ ] **Step 3: 实现 `src/chat/lib/writingGenreStyle.ts`**

```ts
import type { WritingGenre } from '@desktop-shared/writing'
import type { ProposalStyleConfig } from '@desktop-shared/proposalStyle'
import { cloneProposalStyle } from '@desktop-shared/proposalStyle'

/**
 * 体裁 → 导出/打印样式。基于 proposal 的 classic 模板改几个字段——**不新造一套样式体系**：
 * docx 生成器（markdownToDocxBuffer）只认 ProposalStyleConfig，另起炉灶等于把整条导出链重写。
 *
 * 一律 `brand: false`：品牌横幅是方案交付物的身份标识，用户自己的小说/周报印上去是错的。
 * 第一版不做样式弹窗（见 spec「明确不做」），四个预设即全部可选项。
 */
export function writingStyleFor(genre: WritingGenre): ProposalStyleConfig {
  const s = cloneProposalStyle('classic')
  s.brand = false
  switch (genre) {
    case 'short-story':
      s.name = '小说'
      s.body.font = '宋体'
      s.body.indentChars = 2
      s.lineMultiple = 1.5
      // 段后 0：中文小说靠首行缩进分段，再加段后距会松散成散文集。
      s.spaceAfterPt = 0
      break
    case 'article':
      s.name = '文章'
      s.body.font = '宋体'
      s.body.indentChars = 0
      s.lineMultiple = 1.6
      s.spaceAfterPt = 8
      break
    case 'workplace':
      s.name = '职场文档'
      s.body.font = '仿宋'
      s.body.indentChars = 0
      s.h1.font = '黑体'
      s.h2.font = '黑体'
      s.h3.font = '黑体'
      s.lineMultiple = 1.5
      s.spaceAfterPt = 6
      break
    case 'wechat':
      // 微信文案的正常出口是公众号 HTML，不是 Word。这套预设仅在用户仍点了「导出 Word」时兜底。
      s.name = '微信文案'
      s.body.font = '微软雅黑'
      s.body.indentChars = 0
      s.lineMultiple = 1.75
      s.spaceAfterPt = 10
      break
  }
  return s
}

/**
 * 体裁 → 纸面皮肤的 Tailwind 类串。屏显的观感与导出预设对齐（缩进、行距、字体家族），
 * 但不追求逐像素一致——那是「打印预览」tab 的职责，它渲染的是真 PDF。
 */
export function paperSkinClass(genre: WritingGenre): string {
  switch (genre) {
    case 'wechat':
      // 375px 手机宽 + 微信读感的行距
      return 'mx-auto w-[375px] px-4 py-6 text-[15px] leading-[1.75] font-sans'
    case 'short-story':
      return 'mx-auto w-[min(46rem,100%)] px-10 py-12 text-[15px] leading-[1.8] font-serif [&_p]:indent-[2em] [&_p]:my-0'
    case 'article':
      return 'mx-auto w-[min(46rem,100%)] px-10 py-12 text-[15px] leading-[1.7] font-serif [&_p]:my-3'
    case 'workplace':
      return 'mx-auto w-[min(46rem,100%)] px-10 py-12 text-[15px] leading-[1.6] [&_h1]:font-bold [&_h2]:font-bold [&_p]:my-2'
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/studio && bun test src/chat/lib/writingGenreStyle.test.ts
```

Expected: PASS

- [ ] **Step 5: 实现 `WritingPaper.tsx`**

创建 `apps/studio/src/chat/components/workspace/WritingPaper.tsx`：

```tsx
import { useMemo } from 'react'

import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { cn } from '@/src/lib/utils'
import { useWritingStore } from '../../stores/writing'
import { paperSkinClass } from '../../lib/writingGenreStyle'
import { AssistantMarkdown } from '../chat/ThreadView/AssistantMessage'

/**
 * 文稿态纸面。**只读**——第一版不做手动改字（见 spec「明确不做」），一切修改经 AI 改写通道。
 *
 * 逐块渲染（块 = 一个标题/段落/列表/表格/围栏代码，切法见 proposalBlocks.ts）而不是把整节
 * 丢给一个 markdown 组件：块的 DOM 边界就是选区改写的定位锚点——`data-section-name` +
 * `data-block-index` 让选区两端能向上 closest() 找到「选中了哪一节的哪几块」。整节渲染时
 * 这个映射无从建立。
 */
export function WritingPaper({
  streaming,
  onSelectionChange
}: {
  streaming: boolean
  onSelectionChange?: () => void
}): React.JSX.Element {
  const sections = useWritingStore((s) => s.sections)
  const genre = useWritingStore((s) => s.genre)
  const outlineTotal = useWritingStore((s) => s.outlineTotal)
  const status = useWritingStore((s) => s.status)

  // 每节切块。sections 变才重算——流式期间 2s 一次，代价可忽略。
  const blocks = useMemo(
    () => sections.map((s) => ({ name: s.name, items: splitBlocks(s.markdown) })),
    [sections]
  )

  if (status === 'missing') {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          写作项目目录已不存在
          <br />
          可能被移动或删除了
        </div>
      </div>
    )
  }

  if (sections.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          还没有正文
          <br />
          AI 写完第一节后会自动出现在这里
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex-1 overflow-y-auto"
      onMouseUp={onSelectionChange}
      onKeyUp={onSelectionChange}
    >
      <div className={cn('writing-paper', paperSkinClass(genre))}>
        {blocks.map((sec) =>
          sec.items.map((block, i) => (
            <div
              key={`${sec.name}:${i}`}
              data-section-name={sec.name}
              data-block-index={i}
              className="writing-block"
            >
              <AssistantMarkdown text={block} />
            </div>
          ))
        )}

        {/* 进度骨架：节级实时的代价是写一节的几十秒里页面不动，用它告诉用户「在写、还剩几节」。
            总数解析不到时只说「正在写下一节」——显示错的总数比不显示更糟。 */}
        {streaming && (
          <div className="mt-6 flex items-center gap-2 text-[12px] text-muted-foreground">
            <div className="size-3 animate-spin rounded-full border-[2px] border-border border-t-accent" />
            {outlineTotal
              ? `正在写第 ${sections.length + 1} 节 · 共 ${outlineTotal} 节`
              : '正在写下一节…'}
          </div>
        )}
      </div>
    </div>
  )
}
```

> **实现提示**：`AssistantMarkdown` 的实际导出名与路径以 `src/chat/components/chat/ThreadView/AssistantMessage.tsx` 为准。若它不是具名导出，改为该文件里渲染 markdown 的那个组件；不要新引一个 markdown 库——聊天树已有一套，再引第二套会带来两份 CSS。

- [ ] **Step 6: 实现 `WritingDocPanel.tsx`（壳 + tab）**

创建 `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`：

```tsx
import { useState } from 'react'

import { Button } from '@/src/components/ui/button'
import { cn } from '@/src/lib/utils'
import { useChatStore } from '../../stores/chat'
import { useWritingPoll, useWritingSource, useWritingStore } from '../../stores/writing'
import { WritingPaper } from './WritingPaper'

/**
 * 写作工作区右栏。两个 tab：文稿（可选区改写的排版纸面）与打印预览（真 PDF / 微信手机宽）。
 *
 * 顶栏**不标 app-region:drag**：根 layout 的 .window-drag-strip 是全应用唯一的拖拽面，
 * 组件顶栏再标会复发「整窗拖不动 + 双击不缩放」（CLAUDE.md 记了 7 条同族事故）。
 */
export function WritingDocPanel(): React.JSX.Element | null {
  const source = useWritingSource()
  const setSource = useWritingStore((s) => s.setSource)
  const storeSource = useWritingStore((s) => s.source)
  const [tab, setTab] = useState<'doc' | 'preview'>('doc')
  const sessionId = useChatStore((s) => s.sessionId)
  const streaming = useChatStore((s) =>
    sessionId ? (s.perSession[sessionId]?.streaming ?? false) : false
  )

  // 会话消息推导出的源与 store 里的不一致时同步（切会话 / 开了新项目）。
  const sameSource = JSON.stringify(source) === JSON.stringify(storeSource)
  if (!sameSource) setSource(source)

  useWritingPoll(storeSource !== null)

  if (!storeSource) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col border-l border-border bg-background">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <Button
          variant={tab === 'doc' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setTab('doc')}
        >
          文稿
        </Button>
        <Button
          variant={tab === 'preview' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setTab('preview')}
        >
          打印预览
        </Button>
      </div>

      <div className={cn('flex min-h-0 flex-1 flex-col', tab === 'doc' ? '' : 'hidden')}>
        <WritingPaper streaming={streaming} />
      </div>
      {/* 打印预览在 Task 8 接入；此处先占位，避免切过去是一片空白无解释。 */}
      <div className={cn('grid flex-1 place-items-center', tab === 'preview' ? '' : 'hidden')}>
        <div className="text-[12.5px] text-muted-foreground">打印预览即将接入</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: 接进 ThreadView**

`apps/studio/src/chat/components/chat/ThreadView/ThreadView.tsx`：

1. 顶部 import 区加：

```ts
import { useWritingWorkspace } from '../../../stores/writing'
import { WritingDocPanel } from '../../workspace/WritingDocPanel'
```

2. 在 `const isProposalMode = useProposalWorkspace()`（约 505 行）之后加：

```ts
  // 写作两栏：与 proposal 同为「实时接管」语义（有写作文档源即接管、没有即还原），
  // 不按会话启动模式标记。三者互斥，优先级 proposal > slides > writing——proposal 由
  // slash 显式激活、意图最强；writing 是从工具调用推导出来的，最弱。
  const isWritingMode = useWritingWorkspace() && !isProposalMode && !isSlidesMode
```

3. 把 `isSplitMode` 改为：

```ts
  const isSplitMode = isProposalMode || isSlidesMode || isWritingMode
```

4. 在右栏渲染区（约 857-862 行 `{isProposalMode ? (…) : null}` 那段）之后，追加同构的一段：

```tsx
      {isWritingMode ? (
        <div className="flex min-h-0 flex-1">
          <WritingDocPanel />
        </div>
      ) : null}
```

> 照抄 `isProposalMode` 那段的容器结构与类名，保持三种分栏的布局一致。

- [ ] **Step 8: 类型检查 + 全量测试**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck && cd apps/studio && bun test
```

Expected: 全绿

- [ ] **Step 9: 手动验证第一个里程碑**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run dev
```

在聊天里说「用 writing 技能帮我写一篇 800 字的行业观察短文」。确认：

1. AI 跑完 `project_manager.py init` 后（Task 9 会加打印标记；此时可先手动在项目目录下建 `drafts/1-x.md` 并在聊天里 `echo "WRITING_PROJECT=<绝对路径>"` 触发接管来验证 UI）右栏出现
2. 纸面逐节冒出内容
3. 流式期间末尾显示进度骨架

- [ ] **Step 10: 提交**

```bash
git add apps/studio/src/chat/lib/writingGenreStyle.ts apps/studio/src/chat/lib/writingGenreStyle.test.ts apps/studio/src/chat/components/workspace/WritingPaper.tsx apps/studio/src/chat/components/workspace/WritingDocPanel.tsx apps/studio/src/chat/components/chat/ThreadView/ThreadView.tsx
git commit -m "feat(writing): 右栏文稿工作区（逐块纸面 + 体裁皮肤 + 进度骨架）"
```

---

### Task 6: 选区改写 —— 定位与消息组装

改写链路的前半段：从 DOM 选区算出「改哪一节的哪几块」，组装发给 AI 的消息。纯逻辑先行、可单测。

**Files:**
- Create: `apps/studio/src/chat/lib/writingRevision.ts`
- Test: `apps/studio/src/chat/lib/writingRevision.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WRITING_REVISION_BEGIN` / `WRITING_REVISION_END`；`splitBlocks` / `spliceBlocks` / `locateBlockRangeByTextWithHint`（`@desktop-shared/proposalBlocks`）
- Produces:
  - `interface WritingRevisionTarget { sectionName: string; range: { start: number; end: number }; selectedText: string }`
  - `buildRevisionMessage(input: { sectionMarkdown: string; target: WritingRevisionTarget; instruction: string }): string | null`
  - `applyRevision(sectionMarkdown: string, range: { start: number; end: number }, replacement: string): string`
  - `relocateTarget(sectionMarkdown: string, target: WritingRevisionTarget): { start: number; end: number } | null`

- [ ] **Step 1: 写失败的测试**

创建 `apps/studio/src/chat/lib/writingRevision.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import {
  WRITING_REVISION_BEGIN,
  WRITING_REVISION_END
} from '@desktop-shared/writing'
import { buildRevisionMessage, applyRevision, relocateTarget } from './writingRevision'

const SECTION = '# 小标题\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。'

describe('buildRevisionMessage', () => {
  const target = {
    sectionName: '1-a.md',
    range: { start: 1, end: 1 },
    selectedText: '第一段正文。'
  }

  it('消息里带上选中原文、用户指令和哨兵格式要求', () => {
    const msg = buildRevisionMessage({
      sectionMarkdown: SECTION,
      target,
      instruction: '改口语一点'
    })
    expect(msg).not.toBeNull()
    expect(msg).toContain('第一段正文。')
    expect(msg).toContain('改口语一点')
    expect(msg).toContain(WRITING_REVISION_BEGIN)
    expect(msg).toContain(WRITING_REVISION_END)
  })

  it('明确要求 AI 不要自己改文件——落地由用户点应用后前端执行', () => {
    const msg = buildRevisionMessage({ sectionMarkdown: SECTION, target, instruction: 'x' })
    expect(msg).toContain('不要修改任何文件')
  })

  it('空指令返回 null（不发一轮没有诉求的请求）', () => {
    expect(
      buildRevisionMessage({ sectionMarkdown: SECTION, target, instruction: '   ' })
    ).toBeNull()
  })

  it('区间越界（该节已被改短）返回 null', () => {
    const bad = { ...target, range: { start: 99, end: 99 } }
    expect(
      buildRevisionMessage({ sectionMarkdown: SECTION, target: bad, instruction: 'x' })
    ).toBeNull()
  })
})

describe('applyRevision', () => {
  it('用改后文本替换指定块区间，其余块原样保留', () => {
    const out = applyRevision(SECTION, { start: 1, end: 1 }, '改写后的第一段。')
    expect(out).toContain('改写后的第一段。')
    expect(out).not.toContain('第一段正文。')
    expect(out).toContain('第二段正文。')
    expect(out).toContain('# 小标题')
  })

  it('跨块区间整体替换成一块', () => {
    const out = applyRevision(SECTION, { start: 1, end: 2 }, '合并后的一段。')
    expect(out).toContain('合并后的一段。')
    expect(out).not.toContain('第一段正文。')
    expect(out).not.toContain('第二段正文。')
    expect(out).toContain('第三段正文。')
  })
})

describe('relocateTarget', () => {
  it('内容没变时定位回原区间', () => {
    const t = { sectionName: '1-a.md', range: { start: 2, end: 2 }, selectedText: '第二段正文。' }
    expect(relocateTarget(SECTION, t)).toEqual({ start: 2, end: 2 })
  })

  it('前面插了一块导致序号后移时，按原文重新定位', () => {
    const shifted = '# 小标题\n\n新插入的一段。\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。'
    const t = { sectionName: '1-a.md', range: { start: 2, end: 2 }, selectedText: '第二段正文。' }
    expect(relocateTarget(shifted, t)).toEqual({ start: 3, end: 3 })
  })

  it('原文已不存在（那段被 AI 重写了）时返回 null', () => {
    const t = { sectionName: '1-a.md', range: { start: 1, end: 1 }, selectedText: '早就没有的句子' }
    expect(relocateTarget(SECTION, t)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test src/chat/lib/writingRevision.test.ts
```

Expected: FAIL — `Cannot find module './writingRevision'`

- [ ] **Step 3: 实现 `src/chat/lib/writingRevision.ts`**

```ts
import {
  splitBlocks,
  spliceBlocks,
  locateBlockRangeByTextWithHint
} from '@desktop-shared/proposalBlocks'
import { WRITING_REVISION_BEGIN, WRITING_REVISION_END } from '@desktop-shared/writing'

/** 一次改写的目标。`selectedText` 是排队重定位的依据，见 relocateTarget。 */
export interface WritingRevisionTarget {
  sectionName: string
  range: { start: number; end: number }
  selectedText: string
}

/**
 * 组装发给 AI 的改写请求。
 *
 * 三个要素缺一不可：**本节全文**（AI 要看上下文才知道语气与前后衔接）、**选中块原文**
 * （明确改哪一段）、**哨兵格式要求**（前端据此抽取结果）。外加一句「不要修改任何文件」——
 * AI 手上有 Edit 工具，不明确禁止它会直接改盘，那样就绕过了「先对照再应用」这一步，
 * 用户点「放弃」也已经晚了。
 *
 * 返回 null = 不发这一轮（空指令 / 区间越界）。
 */
export function buildRevisionMessage(input: {
  sectionMarkdown: string
  target: WritingRevisionTarget
  instruction: string
}): string | null {
  const instruction = input.instruction.trim()
  if (!instruction) return null

  const blocks = splitBlocks(input.sectionMarkdown)
  const { start, end } = input.target.range
  if (start < 0 || start >= blocks.length || end < start || end >= blocks.length) return null
  const selected = blocks.slice(start, end + 1).join('\n\n')
  if (!selected.trim()) return null

  return [
    '请按我的要求改写下面这段文字。',
    '',
    '【本节全文（供你把握上下文与前后衔接，不要改动选中范围之外的内容）】',
    input.sectionMarkdown,
    '',
    '【要改的那一段】',
    selected,
    '',
    '【我的要求】',
    instruction,
    '',
    '【输出格式（必须严格遵守）】',
    `把改写后的文字包在下面这对标记之间，标记各占一行，中间只放正文，不要解释、不要加标题：`,
    WRITING_REVISION_BEGIN,
    '（改写后的正文）',
    WRITING_REVISION_END,
    '',
    '【重要】不要修改任何文件。改写结果由我确认后再落地。'
  ].join('\n')
}

/** 把改后文本替换进指定块区间，返回重拼后的整节 markdown。 */
export function applyRevision(
  sectionMarkdown: string,
  range: { start: number; end: number },
  replacement: string
): string {
  return spliceBlocks(sectionMarkdown, range, replacement)
}

/**
 * 用「当初选中的原文」在最新内容里重新定位块区间。
 *
 * 为什么需要：改写请求可能在队列里等过一阵（AI 当时在写下一节），期间前面的改写已经落地、
 * 块序号会漂到别处。直接用入队时的序号，改的就是隔壁段落。原文多处命中时，用入队时的
 * 区间当提示选最近的一处（`locateBlockRangeByTextWithHint` 已实现这个裁决）。
 *
 * 返回 null = 那段原文已经不存在（被 AI 重写了），调用方应丢弃这次改写并告知用户。
 */
export function relocateTarget(
  sectionMarkdown: string,
  target: WritingRevisionTarget
): { start: number; end: number } | null {
  return locateBlockRangeByTextWithHint(sectionMarkdown, target.selectedText, target.range)
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/studio && bun test src/chat/lib/writingRevision.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/lib/writingRevision.ts apps/studio/src/chat/lib/writingRevision.test.ts
git commit -m "feat(writing): 选区改写的定位、消息组装与落地纯逻辑"
```

---

### Task 7: 选区改写 —— 交互闭环（气泡 / 队列 / 对照卡 / 写盘）

把 Task 6 的纯逻辑接成完整交互。做完这一步，选中改写能端到端跑通。

**Files:**
- Create: `apps/studio/src/chat/components/workspace/WritingSelectionBubble.tsx`
- Create: `apps/studio/src/chat/components/workspace/WritingRevisionReview.tsx`
- Modify: `apps/studio/src/chat/stores/writing.ts`（加改写状态：pending / queue / review / conflict）
- Modify: `apps/studio/src/chat/components/workspace/WritingPaper.tsx`（挂气泡）
- Modify: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`（挂对照卡与冲突提示）
- Modify: `apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx`（消息 `end` 时抽取哨兵结果）

**Interfaces:**
- Consumes: Task 6 的 `buildRevisionMessage` / `applyRevision` / `relocateTarget`；Task 1 的 `extractRevisionResult`
- Produces:
  - store 追加：`pendingRevision: WritingRevisionTarget | null`、`queue: QueuedWritingRevision[]`、`review: WritingRevisionReview | null`、`conflictMsg: string`
  - `enqueueOrSendRevision(target, instruction): Promise<void>`
  - `applyPendingReview(): Promise<void>`

- [ ] **Step 1: 在 store 里加改写状态**

在 `apps/studio/src/chat/stores/writing.ts` 追加：

```ts
import type { WritingRevisionTarget } from '../lib/writingRevision'

/** 排队软上限。与 proposal 的 MAX_REVISION_QUEUE 对齐——同一个数只写一处，提示文案引用它。 */
export const MAX_WRITING_REVISION_QUEUE = 10

/** 排队中的改写。**不存最终块序号**：排队期间前面的改写可能落地、序号会漂，排空时用
 *  selectedText 重新定位（range 只当多处命中时的裁决提示）。 */
export interface QueuedWritingRevision {
  id: string
  target: WritingRevisionTarget
  instruction: string
}

/** 待用户裁决的改写。渲染成「原文 vs 改后」对照卡。瞬时 UI 信号，不持久化。 */
export interface WritingRevisionReview {
  target: WritingRevisionTarget
  before: string
  after: string
}
```

并在 `WritingState` 接口与 `create` 里加对应字段与 action：

```ts
  pendingRevision: WritingRevisionTarget | null
  queue: QueuedWritingRevision[]
  review: WritingRevisionReview | null
  conflictMsg: string
  setPendingRevision: (t: WritingRevisionTarget | null) => void
  pushQueue: (item: QueuedWritingRevision) => boolean
  shiftQueue: () => QueuedWritingRevision | null
  setReview: (r: WritingRevisionReview | null) => void
  setConflictMsg: (msg: string) => void
```

实现（放进 `create` 的对象里）：

```ts
  pendingRevision: null,
  queue: [],
  review: null,
  conflictMsg: '',
  setPendingRevision: (pendingRevision) => set({ pendingRevision }),
  pushQueue: (item) => {
    let accepted = false
    set((s) => {
      if (s.queue.length >= MAX_WRITING_REVISION_QUEUE) return s
      accepted = true
      return { queue: [...s.queue, item] }
    })
    return accepted
  },
  shiftQueue: () => {
    let head: QueuedWritingRevision | null = null
    set((s) => {
      if (s.queue.length === 0) return s
      head = s.queue[0]
      return { queue: s.queue.slice(1) }
    })
    return head
  },
  setReview: (review) => set({ review }),
  setConflictMsg: (conflictMsg) => set({ conflictMsg }),
```

- [ ] **Step 2: 实现选区气泡**

创建 `apps/studio/src/chat/components/workspace/WritingSelectionBubble.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/src/components/ui/button'
import { Textarea } from '@/src/components/ui/textarea'
import { useWritingStore, MAX_WRITING_REVISION_QUEUE } from '../../stores/writing'
import type { WritingRevisionTarget } from '../../lib/writingRevision'

interface Anchor {
  target: WritingRevisionTarget
  left: number
  top: number
}

/** 从选区端点向上找带 data-block-index 的块容器，读出「哪一节的第几块」。 */
function resolveBlock(node: Node | null): { sectionName: string; blockIndex: number } | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null)
  const blk = el?.closest<HTMLElement>('[data-block-index]')
  if (!blk) return null
  const sectionName = blk.getAttribute('data-section-name')
  const idx = blk.getAttribute('data-block-index')
  if (sectionName == null || idx == null) return null
  return { sectionName, blockIndex: Number(idx) }
}

/**
 * 选区即改浮层。选中纸面上的文字后贴选区尾浮出，收一句指令发给 AI。
 *
 * **作用域是块，不是精确字符区间**：屏幕上选的是渲染后的纯文本，文件里是 markdown 源码
 * （含 `**加粗**`、列表符号），两者字符位置不对应，硬映射极易错位。选半句实际改整段，是刻意的。
 *
 * **跨节选区吸附到起点所在的那一节**：跨节改写要同时写两个文件、两把乐观锁，第一版不支持。
 */
export function WritingSelectionBubble({
  containerRef,
  onSubmit
}: {
  containerRef: React.RefObject<HTMLElement | null>
  onSubmit: (target: WritingRevisionTarget, instruction: string) => void
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [text, setText] = useState('')
  const queueLen = useWritingStore((s) => s.queue.length)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    function recompute(): void {
      const sel = window.getSelection()
      const container = containerRef.current
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) {
        setAnchor(null)
        return
      }
      const range = sel.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) {
        setAnchor(null)
        return
      }
      const a = resolveBlock(range.startContainer)
      const b = resolveBlock(range.endContainer)
      if (!a) {
        setAnchor(null)
        return
      }
      // 跨节：吸附到起点所在节，终点取该节内起点之后的块（b 为空或跨节时退化为单块）。
      const sameSection = b && b.sectionName === a.sectionName
      const start = Math.min(a.blockIndex, sameSection ? b.blockIndex : a.blockIndex)
      const end = Math.max(a.blockIndex, sameSection ? b.blockIndex : a.blockIndex)
      const rect = range.getBoundingClientRect()
      const box = container.getBoundingClientRect()
      setAnchor({
        target: {
          sectionName: a.sectionName,
          range: { start, end },
          selectedText: sel.toString()
        },
        left: rect.left - box.left,
        top: rect.bottom - box.top + container.scrollTop + 6
      })
    }
    document.addEventListener('selectionchange', recompute)
    return () => document.removeEventListener('selectionchange', recompute)
  }, [containerRef])

  if (!anchor) return null

  const full = queueLen >= MAX_WRITING_REVISION_QUEUE

  return (
    <div
      className="absolute z-20 w-[280px] rounded-lg border border-border bg-popover p-2 shadow-lg"
      style={{ left: anchor.left, top: anchor.top }}
    >
      <Textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="想怎么改？例如：改口语一点"
        className="min-h-[60px] text-[13px]"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {full ? `排队已满（${MAX_WRITING_REVISION_QUEUE}）` : queueLen > 0 ? `${queueLen} 条排队中` : ''}
        </span>
        <Button
          size="sm"
          disabled={!text.trim() || full}
          onClick={() => {
            onSubmit(anchor.target, text)
            setText('')
            setAnchor(null)
            window.getSelection()?.removeAllRanges()
          }}
        >
          改写
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 实现对照卡**

创建 `apps/studio/src/chat/components/workspace/WritingRevisionReview.tsx`：

```tsx
import { Button } from '@/src/components/ui/button'
import { useWritingStore } from '../../stores/writing'

/**
 * 「原文 vs 改后」对照卡。**AI 不直接改文件**，改动先停在这里等用户裁决——改得不满意
 * 零代价丢掉，不污染定稿。这是用户明确要的那一步（对齐写方案的选区改写体验）。
 */
export function WritingRevisionReviewCard({
  onApply,
  onDiscard
}: {
  onApply: () => void
  onDiscard: () => void
}): React.JSX.Element | null {
  const review = useWritingStore((s) => s.review)
  if (!review) return null

  return (
    <div className="border-t border-border bg-muted/30 p-3">
      <div className="mb-2 text-[12px] font-medium text-muted-foreground">改写结果待确认</div>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded border border-border bg-background p-2">
          <div className="mb-1 text-[11px] text-muted-foreground">原文</div>
          <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{review.before}</div>
        </div>
        <div className="rounded border border-accent bg-background p-2">
          <div className="mb-1 text-[11px] text-accent">改写后</div>
          <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{review.after}</div>
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={onApply}>
          应用
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          放弃
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 在 FusionRuntimeProvider 里接哨兵抽取**

找到 `apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx` 里处理助手消息 `'end'` 的分支（proposal 在同处抽取自己的哨兵）。追加一段：

```ts
// 写作选区改写：本轮若是改写请求（pendingRevision 非空），从回复里抽哨兵结果。
// 【没有哨兵就什么都不做】——AI 可能在反问「你想改成什么风格」，那句话不是正文，
// 落盘会毁掉这一节。抽不到时清掉 pendingRevision 让气泡复位，用户可以重发。
{
  const ws = useWritingStore.getState()
  if (ws.pendingRevision) {
    const after = extractRevisionResult(fullText)
    const sec = ws.sections.find((s) => s.name === ws.pendingRevision!.sectionName)
    if (after && sec) {
      const range = relocateTarget(sec.markdown, ws.pendingRevision) ?? ws.pendingRevision.range
      const before = splitBlocks(sec.markdown).slice(range.start, range.end + 1).join('\n\n')
      ws.setReview({ target: { ...ws.pendingRevision, range }, before, after })
    }
    ws.setPendingRevision(null)
  }
}
```

（`fullText` 用该分支已有的助手消息全文变量名；`useWritingStore` / `extractRevisionResult` / `relocateTarget` / `splitBlocks` 在文件顶部 import。）

- [ ] **Step 5: 在 WritingDocPanel 里串起派发、排空与写盘**

在 `WritingDocPanel.tsx` 里加：

```tsx
  const streamingNow = streaming
  const queue = useWritingStore((s) => s.queue)

  /** 派发或排队。AI 忙时排队——写作是长流水线，AI 大部分时间在写下一节，
   *  照搬 proposal「streaming 时拒绝改写」的硬闸会让气泡永远点了没反应。 */
  async function submitRevision(
    target: WritingRevisionTarget,
    instruction: string
  ): Promise<void> {
    const st = useWritingStore.getState()
    if (streamingNow || st.pendingRevision) {
      st.pushQueue({ id: crypto.randomUUID(), target, instruction })
      return
    }
    const sec = st.sections.find((s) => s.name === target.sectionName)
    if (!sec) return
    const msg = buildRevisionMessage({
      sectionMarkdown: sec.markdown,
      target,
      instruction
    })
    if (!msg) return
    st.setPendingRevision(target)
    await sendWritingMessage(msg)
  }

  // 排空：AI 空闲且没有在飞的改写时，取队首执行。用 selectedText 重新定位——
  // 排队期间前面的改写可能已落地、块序号漂了。
  useEffect(() => {
    if (streamingNow) return
    const st = useWritingStore.getState()
    if (st.pendingRevision || st.review || st.queue.length === 0) return
    const head = st.shiftQueue()
    if (!head) return
    const sec = st.sections.find((s) => s.name === head.target.sectionName)
    if (!sec) return
    const range = relocateTarget(sec.markdown, head.target)
    if (!range) {
      st.setConflictMsg('有一条排队的改写找不到原文了（那段可能已被 AI 重写），已跳过。')
      return
    }
    void submitRevision({ ...head.target, range }, head.instruction)
  }, [streamingNow, queue.length])

  /** 应用改写：拼回整节 → 乐观锁写盘。冲突时不覆盖，提示用户并刷新到最新。 */
  async function applyReview(): Promise<void> {
    const st = useWritingStore.getState()
    const r = st.review
    if (!r || !storeSource) return
    const sec = st.sections.find((s) => s.name === r.target.sectionName)
    if (!sec) return
    const next = applyRevision(sec.markdown, r.target.range, r.after)
    const res = await window.chatApi.writingWriteSection({
      source: storeSource,
      name: r.target.sectionName,
      markdown: next,
      expectedMtimeMs: sec.mtimeMs
    })
    if (res.ok) {
      useWritingStore.getState().replaceSectionMarkdown(r.target.sectionName, next, res.mtimeMs)
      useWritingStore.getState().setReview(null)
      return
    }
    if (res.conflict) {
      if (res.current) {
        useWritingStore
          .getState()
          .replaceSectionMarkdown(r.target.sectionName, res.current.markdown, res.current.mtimeMs)
      }
      useWritingStore
        .getState()
        .setConflictMsg('这一节刚被 AI 改过，你的改动未生效。已刷新到最新内容，请重新选中修改。')
      useWritingStore.getState().setReview(null)
      return
    }
    useWritingStore.getState().setConflictMsg(`写入失败：${res.error}`)
  }
```

把 `<WritingSelectionBubble>`（包在 `relative` 容器里，传纸面滚动容器的 ref）、`<WritingRevisionReviewCard onApply={applyReview} onDiscard={() => useWritingStore.getState().setReview(null)} />`，以及 `conflictMsg` 的提示条挂进面板。

> **`sendWritingMessage` 的实现**：照抄 `src/chat/lib/sendProposalStageMessage.ts` 的结构（取 composer runtime 发一条用户消息），新建 `src/chat/lib/sendWritingMessage.ts`。不要复用 proposal 那个函数——它会触碰 proposal store。

- [ ] **Step 6: 类型检查 + 全量测试**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck && cd apps/studio && bun test
```

Expected: 全绿

- [ ] **Step 7: 手动验证改写闭环**

`bun run dev`。让 AI 写一篇短文，然后：

1. 选中一段 → 输入「改口语一点」→ 点改写
2. AI 回复后出现对照卡
3. 点「应用」→ 用另一个编辑器打开磁盘上那个 md 文件，**确认内容真的变了**
4. AI 正在写下一节时发起改写 → 确认显示「N 条排队中」，AI 写完后自动执行

- [ ] **Step 8: 提交**

```bash
git add apps/studio/src/chat/components/workspace/WritingSelectionBubble.tsx apps/studio/src/chat/components/workspace/WritingRevisionReview.tsx apps/studio/src/chat/lib/sendWritingMessage.ts apps/studio/src/chat/stores/writing.ts apps/studio/src/chat/components/workspace/WritingPaper.tsx apps/studio/src/chat/components/workspace/WritingDocPanel.tsx apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(writing): 选区改写闭环（气泡/排队/对照卡/乐观锁写盘）"
```

---

### Task 8: 打印预览 tab

A4 类走真 PDF（与导出物同源），微信走手机宽内联 HTML。

**Files:**
- Create: `apps/studio/src/chat/components/workspace/WritingPreview.tsx`
- Create: `apps/studio/electron/main/core/writingWechat.ts`
- Create: `apps/studio/electron/main/core/writingWechat.test.ts`
- Modify: `apps/studio/electron/shared/ipc-channels.ts`（加 `WRITING_WECHAT_HTML`）
- Modify: `apps/studio/electron/preload/index.ts` + `index.d.ts`
- Modify: `apps/studio/electron/main/ipc/register.ts`
- Modify: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`（替换占位）

**Interfaces:**
- Consumes: Task 1 的 `joinWritingSections` / `shouldPageBreak`；Task 5 的 `writingStyleFor`；`renderProposalPdfHtml`（`src/chat/lib/renderProposalPdfHtml.ts`）；`window.chatApi.renderProposalPdf`
- Produces:
  - `markdownToWechatHtml(markdown: string, style: Record<string, string>): string`
  - `window.chatApi.writingWechatHtml({ markdown, styleName }): Promise<{ ok: true; html: string } | { ok: false; error: string }>`

> **对 spec 的一处修正**：spec 原写「渲染层读 `export_styles/*.json` 自己渲染」。改为
> **main 侧生成 HTML、渲染层拿到成品**——`skillsDir` 解析在 main，且这样「预览看到的」与
> 「复制出去的」是同一份 HTML 字符串，天然一致。HTML 由我们从 markdown AST 生成、
> 只输出白名单标签，不透传原始 HTML。

- [ ] **Step 1: 写微信 HTML 生成的失败测试**

创建 `apps/studio/electron/main/core/writingWechat.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { markdownToWechatHtml } from './writingWechat'

const STYLE = {
  h1: 'font-size:20px;font-weight:bold;',
  h2: 'font-size:17px;font-weight:bold;',
  p: 'font-size:15px;line-height:1.75;',
  li: 'font-size:15px;',
  strong: 'font-weight:bold;'
}

describe('markdownToWechatHtml', () => {
  it('样式全部内联进 style 属性——公众号编辑器会剥掉 <style> 和 class', () => {
    const html = markdownToWechatHtml('# 标题\n\n一段正文', STYLE)
    expect(html).toContain('style="font-size:20px;font-weight:bold;"')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('class=')
  })

  it('渲染标题、段落与列表', () => {
    const html = markdownToWechatHtml('# 大标题\n\n## 小标题\n\n正文\n\n- 甲\n- 乙', STYLE)
    expect(html).toContain('大标题')
    expect(html).toContain('小标题')
    expect(html).toContain('正文')
    expect(html).toContain('甲')
    expect(html).toContain('乙')
  })

  it('转义 HTML 特殊字符，不透传原始标签（防注入）', () => {
    const html = markdownToWechatHtml('正文里有 <script>alert(1)</script> 和 & 符号', STYLE)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('加粗渲染成内联 strong', () => {
    const html = markdownToWechatHtml('这是**重点**内容', STYLE)
    expect(html).toContain('<strong')
    expect(html).toContain('重点')
  })

  it('空 markdown 返回空串', () => {
    expect(markdownToWechatHtml('', STYLE)).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test electron/main/core/writingWechat.test.ts
```

Expected: FAIL — `Cannot find module './writingWechat'`

- [ ] **Step 3: 实现 `writingWechat.ts`**

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveBundledSkillsPluginDir } from './skillsDir'

/**
 * markdown → 公众号可粘贴的内联样式 HTML。
 *
 * **样式必须全内联进每个元素的 style 属性**：公众号编辑器会剥掉 `<style>` 标签和 class，
 * 不内联粘进去就是一片黑字（`skills/writing/scripts/export.py` 的注释已写明这条）。
 *
 * **只输出白名单标签、正文一律转义**：内容来自 AI 与本地文件，直接透传原始 HTML 等于
 * 把任意标签带进渲染层的 dangerouslySetInnerHTML。这里从行结构自己生成标签，正文过 escapeHtml。
 *
 * 行扫描而非完整 markdown AST：与 export.py 的 md_to_wechat_html 保持同一套取舍——
 * 公众号文案只用到标题/段落/列表/加粗这几样，上一整套 remark 不划算。
 */
export function markdownToWechatHtml(markdown: string, style: Record<string, string>): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inList = false

  const s = (k: string): string => (style[k] ? ` style="${style[k]}"` : '')

  function closeList(): void {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      closeList()
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      const tag = `h${h[1].length}`
      out.push(`<${tag}${s(tag)}>${inline(h[2], style)}</${tag}>`)
      continue
    }
    const li = /^[-*+]\s+(.*)$/.exec(line)
    if (li) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li${s('li')}>${inline(li[1], style)}</li>`)
      continue
    }
    closeList()
    out.push(`<p${s('p')}>${inline(line, style)}</p>`)
  }
  closeList()
  return out.join('\n')
}

/** 行内格式：先转义，再把 **x** 换成 strong。顺序不能反——先换标签会被转义吃掉。 */
function inline(text: string, style: Record<string, string>): string {
  const strongStyle = style.strong ? ` style="${style.strong}"` : ''
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, `<strong${strongStyle}>$1</strong>`)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 读 skill 里的导出样式 JSON。**不在前端复刻一份**——两处各写一份必然漂移
 * （仓库有过 `--accent` token 被覆盖、静默失效零报错的事故）。读不到时回 null，
 * 调用方降级为内置默认样式并在 UI 角标提示。
 */
export function loadWechatStyle(name: string): Record<string, string> | null {
  const skills = resolveBundledSkillsPluginDir()
  if (!skills) return null
  try {
    const p = join(skills, 'writing', 'templates', 'export_styles', `${name}.json`)
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

/** 内置兜底样式：JSON 读不到时用，保证预览与复制始终可用。 */
export const FALLBACK_WECHAT_STYLE: Record<string, string> = {
  h1: 'font-size:20px;font-weight:bold;margin:24px 0 12px;',
  h2: 'font-size:17px;font-weight:bold;margin:20px 0 10px;',
  h3: 'font-size:15px;font-weight:bold;margin:16px 0 8px;',
  p: 'font-size:15px;line-height:1.75;margin:0 0 16px;',
  li: 'font-size:15px;line-height:1.75;margin:0 0 8px;',
  strong: 'font-weight:bold;'
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/studio && bun test electron/main/core/writingWechat.test.ts
```

Expected: PASS

- [ ] **Step 5: 加 `WRITING_WECHAT_HTML` IPC（四处齐改）**

通道常量（`ipc-channels.ts`）：

```ts
  /**
   * Renderer → main. markdown → 公众号内联样式 HTML。样式 JSON 在 skill 目录里，
   * 只有 main 能用 skillsDir() 定位；且预览与「复制」共用这同一份 HTML，两者天然一致。
   */
  WRITING_WECHAT_HTML: 'writing:wechat-html',
```

类型：

```ts
export interface WritingWechatHtmlPayload {
  markdown: string
  styleName: 'wechat-default' | 'wechat-serif'
}
export type WritingWechatHtmlResult =
  | { ok: true; html: string; styleFallback: boolean }
  | { ok: false; error: string }
```

handler：

```ts
  ipcMain.handle(
    IPC_CHANNELS.WRITING_WECHAT_HTML,
    async (
      _event,
      payload: WritingWechatHtmlPayload
    ): Promise<WritingWechatHtmlResult> => {
      const loaded = loadWechatStyle(payload.styleName)
      const style = loaded ?? FALLBACK_WECHAT_STYLE
      return {
        ok: true,
        html: markdownToWechatHtml(payload.markdown ?? '', style),
        // UI 据此在角标提示「样式未加载」——降级要看得见，不能静默换一套样式。
        styleFallback: loaded === null
      }
    }
  )
```

preload 的 `writingWechatHtml` 方法与 `.d.ts` 类型照 Task 2 的写法补齐。

- [ ] **Step 6: 实现 `WritingPreview.tsx`**

创建 `apps/studio/src/chat/components/workspace/WritingPreview.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'

import { joinWritingSections, shouldPageBreak } from '@desktop-shared/writing'
import { renderProposalPdfHtml } from '../../lib/renderProposalPdfHtml'
import { writingStyleFor } from '../../lib/writingGenreStyle'
import { useWritingStore } from '../../stores/writing'

/** 防抖窗口：节级更新是成簇到来的（一条消息 end 可能同时刷出多节），300ms 足以等一簇落定。 */
const DEBOUNCE_MS = 300

type Status = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

/**
 * 打印预览。两条分支：
 *  - 微信：main 生成内联 HTML，塞进 375px 手机宽容器。**与「复制公众号 HTML」是同一份字符串**，
 *    所见即所得。
 *  - 其余：走与导出 PDF 完全相同的引擎（renderProposalPdfHtml → renderProposalPdf →
 *    隐藏窗口 printToPDF），预览看的就是导出物本身，分页逐字节一致。
 *
 * 两个必守的点，都是 proposal 预览踩出来的：
 *  1) **objectURL 原子替换 + cancelled 闸门**：一次渲染要过多个 await，期间可能被更新的一帧取代。
 *     只有过了最后一道 cancelled 检查才把新 URL 换进 iframe 并 revoke 旧的。
 *  2) **防抖期间保持上一帧**，不提前翻 loading——否则成簇更新时一直闪 spinner。
 */
export function WritingPreview({ active }: { active: boolean }): React.JSX.Element {
  const sections = useWritingStore((s) => s.sections)
  const genre = useWritingStore((s) => s.genre)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [wechatHtml, setWechatHtml] = useState<string>('')
  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')
  const urlRef = useRef<string | null>(null)
  const lastRendered = useRef<string | null>(null)

  function swapPdfUrl(next: string | null): void {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
    setPdfUrl(next)
  }

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const markdown = joinWritingSections(sections, { pageBreaks: shouldPageBreak(genre) })
    if (!markdown) {
      lastRendered.current = null
      swapPdfUrl(null)
      setWechatHtml('')
      setStatus('empty')
      return
    }
    const signature = `${genre} ${markdown}`
    if (signature === lastRendered.current) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setStatus('loading')
        try {
          if (genre === 'wechat') {
            const r = await window.chatApi.writingWechatHtml({
              markdown,
              styleName: 'wechat-default'
            })
            if (cancelled) return
            if (!r.ok) throw new Error(r.error)
            setWechatHtml(r.html)
          } else {
            const html = await renderProposalPdfHtml(markdown, writingStyleFor(genre))
            if (cancelled) return
            const { bytes } = await window.chatApi.renderProposalPdf({ html })
            if (cancelled) return
            const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
            if (cancelled) return
            swapPdfUrl(URL.createObjectURL(blob))
          }
          lastRendered.current = signature
          setStatus('ready')
        } catch (err) {
          if (cancelled) return
          setErrMsg(err instanceof Error ? err.message : String(err))
          setStatus('error')
        }
      })()
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sections, genre, active])

  return (
    <div className="relative flex-1 overflow-hidden">
      {genre === 'wechat' ? (
        <div className="h-full overflow-y-auto bg-neutral-100 py-6 dark:bg-neutral-900">
          <div
            className="mx-auto w-[375px] bg-white p-4 text-black shadow"
            // 内容由 main 从 markdown 生成、只输出白名单标签且正文已转义（见 writingWechat.ts）
            dangerouslySetInnerHTML={{ __html: wechatHtml }}
          />
        </div>
      ) : (
        pdfUrl && <iframe key={pdfUrl} src={pdfUrl} title="文稿预览" className="h-full w-full border-0" />
      )}

      {status === 'loading' && (
        <div className="absolute inset-0 grid place-items-center bg-neutral-200/80 dark:bg-neutral-900/80">
          <div className="flex flex-col items-center gap-3">
            <div className="size-6 animate-spin rounded-full border-[2.5px] border-border border-t-accent" />
            <div className="text-[12px] text-muted-foreground">正在生成预览…</div>
          </div>
        </div>
      )}
      {status === 'empty' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-[12.5px] text-muted-foreground">还没有正文可预览</div>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex max-w-[80%] flex-col items-center gap-2 text-center">
            <div className="text-[13px] text-rose-500">预览生成失败</div>
            <div className="text-[11px] text-muted-foreground">{errMsg}</div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: 在 WritingDocPanel 替换占位**

把「打印预览即将接入」那个 div 换成 `<WritingPreview active={tab === 'preview'} />`。注意保持组件常驻（用 `hidden` 类切换而非条件卸载），以保住 `lastRendered` 缓存。

- [ ] **Step 8: 类型检查 + 全量测试 + 手动验证**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck && cd apps/studio && bun test
```

`bun run dev`，写一篇文章切到「打印预览」看真 PDF；再写一篇微信文案确认手机宽预览。

- [ ] **Step 9: 提交**

```bash
git add apps/studio/electron/main/core/writingWechat.ts apps/studio/electron/main/core/writingWechat.test.ts apps/studio/src/chat/components/workspace/WritingPreview.tsx apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/index.ts apps/studio/electron/preload/index.d.ts apps/studio/electron/main/ipc/register.ts apps/studio/src/chat/components/workspace/WritingDocPanel.tsx
git commit -m "feat(writing): 打印预览 tab（A4 真 PDF / 微信手机宽内联 HTML）"
```

---

### Task 9: 导出 Word / PDF / 公众号 HTML

**Files:**
- Create: `apps/studio/electron/main/core/writingExport.ts`
- Modify: `apps/studio/electron/shared/ipc-channels.ts`（`WRITING_EXPORT_DOCX` / `WRITING_EXPORT_PDF`）
- Modify: `apps/studio/electron/preload/index.ts` + `index.d.ts`
- Modify: `apps/studio/electron/main/ipc/register.ts`
- Modify: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`（导出按钮组）

**Interfaces:**
- Consumes: `markdownToDocxBuffer`（`electron/main/core/proposalDocx.ts`）；Task 5 的 `writingStyleFor`；Task 8 的 `renderProposalPdfHtml` + `window.chatApi.renderProposalPdf`
- Produces:
  - `exportWritingDocx(win, markdown, style, defaultBaseName): Promise<{ path: string | null }>`
  - `saveWritingPdf(win, bytes, defaultBaseName): Promise<{ path: string | null }>`

- [ ] **Step 1: 实现 `writingExport.ts`**

```ts
import { writeFile } from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'

import { markdownToDocxBuffer } from './proposalDocx'
import type { ProposalStyleConfig } from '../../shared/proposalStyle'

/**
 * 写作的导出出口。**不复用 exportProposal**：那个函数的保存对话框默认文件名写死成
 * 「方案草稿.docx」，写作复用会让用户在保存框里看到「方案草稿」，且日志里显示成方案导出、
 * 误导排查。真正的重逻辑（markdownToDocxBuffer）是共用的，这里只是自己管保存框与默认名。
 *
 * 用户取消保存框时回 `{ path: null }`，不是错误——沿用 PROPOSAL_EXPORT 的语义。
 */
export async function exportWritingDocx(
  win: BrowserWindow,
  markdown: string,
  style: ProposalStyleConfig,
  defaultBaseName: string
): Promise<{ path: string | null }> {
  const r = await dialog.showSaveDialog(win, {
    filters: [{ name: 'Word', extensions: ['docx'] }],
    defaultPath: `${sanitizeBaseName(defaultBaseName)}.docx`
  })
  if (r.canceled || !r.filePath) return { path: null }
  const buf = await markdownToDocxBuffer(markdown, style)
  await writeFile(r.filePath, buf)
  return { path: r.filePath }
}

/**
 * PDF：字节由渲染层出（printToPDF 那条链在 renderer 侧起头），main 只管保存框与写盘。
 * 与 docx 分成两条通道是因为生成方不同，硬塞进一个通道会让 payload 出现互斥字段。
 */
export async function saveWritingPdf(
  win: BrowserWindow,
  bytes: Uint8Array,
  defaultBaseName: string
): Promise<{ path: string | null }> {
  const r = await dialog.showSaveDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: `${sanitizeBaseName(defaultBaseName)}.pdf`
  })
  if (r.canceled || !r.filePath) return { path: null }
  await writeFile(r.filePath, bytes)
  return { path: r.filePath }
}

/** 默认文件名净化：去掉路径分隔符与首尾空白，空则回「文稿」。保存框的默认名不该带目录。 */
function sanitizeBaseName(name: string): string {
  const s = (name ?? '').replace(/[/\\]/g, '_').trim()
  return s.length > 0 ? s : '文稿'
}
```

- [ ] **Step 2: 加两条 IPC（四处齐改）**

```ts
  /** Renderer → main. 导出 Word。渲染层拼好 markdown + 体裁样式，main 弹保存框并写盘。 */
  WRITING_EXPORT_DOCX: 'writing:export-docx',
  /** Renderer → main. 保存 PDF 字节（PDF 由渲染层经 printToPDF 生成）。 */
  WRITING_EXPORT_PDF: 'writing:export-pdf',
```

```ts
export interface WritingExportDocxPayload {
  markdown: string
  style: ProposalStyleConfig
  defaultBaseName: string
}
export interface WritingExportPdfPayload {
  bytes: Uint8Array
  defaultBaseName: string
}
/** 两条通道共用：`path: null` = 用户取消保存框，不是错误。 */
export interface WritingExportResult {
  path: string | null
}
```

handler（`register.ts`，取当前窗口的方式照抄同文件里 `PROPOSAL_EXPORT` 那条）：

```ts
  ipcMain.handle(
    IPC_CHANNELS.WRITING_EXPORT_DOCX,
    async (event, payload: WritingExportDocxPayload): Promise<WritingExportResult> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { path: null }
      return exportWritingDocx(win, payload.markdown, payload.style, payload.defaultBaseName)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WRITING_EXPORT_PDF,
    async (event, payload: WritingExportPdfPayload): Promise<WritingExportResult> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { path: null }
      return saveWritingPdf(win, payload.bytes, payload.defaultBaseName)
    }
  )
```

- [ ] **Step 3: 在 WritingDocPanel 加导出按钮组**

顶栏右侧加三个按钮（微信那个仅 `genre === 'wechat'` 时显示）：

```tsx
  const genre = useWritingStore((s) => s.genre)
  const sections = useWritingStore((s) => s.sections)
  const [exportMsg, setExportMsg] = useState('')

  /** 导出用的完整 markdown 与默认文件名。文件名取第一节的一级标题，取不到用「文稿」。 */
  function buildExportInput(): { markdown: string; baseName: string } {
    const markdown = joinWritingSections(sections, { pageBreaks: shouldPageBreak(genre) })
    const h1 = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim()
    return { markdown, baseName: h1 && h1.length > 0 ? h1 : '文稿' }
  }

  async function exportDocx(): Promise<void> {
    const { markdown, baseName } = buildExportInput()
    if (!markdown) return
    const r = await window.chatApi.writingExportDocx({
      markdown,
      style: writingStyleFor(genre),
      defaultBaseName: baseName
    })
    setExportMsg(r.path ? `已导出到 ${r.path}` : '')
  }

  async function exportPdf(): Promise<void> {
    const { markdown, baseName } = buildExportInput()
    if (!markdown) return
    const html = await renderProposalPdfHtml(markdown, writingStyleFor(genre))
    const { bytes } = await window.chatApi.renderProposalPdf({ html })
    const r = await window.chatApi.writingExportPdf({ bytes, defaultBaseName: baseName })
    setExportMsg(r.path ? `已导出到 ${r.path}` : '')
  }

  /** 微信：复制而非存文件——公众号的工作流就是粘贴，存成 .html 还得再打开复制一次。 */
  async function copyWechat(): Promise<void> {
    const { markdown } = buildExportInput()
    if (!markdown) return
    const r = await window.chatApi.writingWechatHtml({ markdown, styleName: 'wechat-default' })
    if (!r.ok) {
      setExportMsg(`生成失败：${r.error}`)
      return
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([r.html], { type: 'text/html' }),
        'text/plain': new Blob([r.html], { type: 'text/plain' })
      })
    ])
    setExportMsg(r.styleFallback ? '已复制（样式文件未找到，用了内置样式）' : '已复制，可粘贴进公众号编辑器')
  }
```

> 用 `ClipboardItem` 同时写 `text/html` 与 `text/plain`：公众号编辑器读 HTML flavor 才能保住样式，纯文本 flavor 是给其他编辑器的兜底。

- [ ] **Step 4: 类型检查 + 全量测试**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck && cd apps/studio && bun test
```

- [ ] **Step 5: 手动验证三种导出**

`bun run dev`：导出 Word 用 Word/Pages 打开检查样式；小说体裁确认章节起新页；导出 PDF 检查分页与「打印预览」一致；微信文案点复制、粘进公众号编辑器确认样式没丢。

- [ ] **Step 6: 提交**

```bash
git add apps/studio/electron/main/core/writingExport.ts apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/index.ts apps/studio/electron/preload/index.d.ts apps/studio/electron/main/ipc/register.ts apps/studio/src/chat/components/workspace/WritingDocPanel.tsx
git commit -m "feat(writing): 导出 Word / PDF / 公众号 HTML"
```

---

### Task 10: skill 侧三处改动

前面九个任务都在应用侧。这一步让 skill 真正把路径报出来、让轻量工作流落盘、告诉 AI 改写要用哨兵。

**Files:**
- Modify: `skills/writing/scripts/project_manager.py`（`init` 末行打印标记）
- Modify: `skills/writing/tests/`（新增 init 打印标记的测试；具体文件名以该目录现有命名为准）
- Modify: `skills/writing/workflows/workplace-writing.md`（Step 1 落盘规则）
- Modify: `skills/writing/workflows/de-ai.md`（Step 5 输出规则）
- Modify: `skills/writing/SKILL.md`（新增「选区改写响应协议」）

**Interfaces:**
- Consumes: Task 3 的 `WRITING_PROJECT_MARKER`（`'WRITING_PROJECT='`）与 `WRITING_SINGLE_DIR`（`'写作'`）
- Produces: 无代码接口，是协议与文档的落实

- [ ] **Step 1: 先看现有测试怎么组织**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/skills/writing && ls tests/ && head -30 tests/*.py | head -40
```

照它的风格加用例，别新造一套测试组织方式。

- [ ] **Step 2: 给 `project_manager.py` 的 init 加打印标记的失败测试**

在 `tests/` 下对应文件里加：

```python
def test_init_prints_project_marker(tmp_path, capsys):
    """init 必须在 stdout 打印 WRITING_PROJECT=<绝对路径>。

    桌面端据此接管右栏工作区——目录名是 <slug>_<日期>，slug 规则在本文件里
    （中文保留、其余压下划线），前端复刻一份必然漂移，所以由脚本自己报数。
    """
    from scripts.project_manager import main

    main(["init", "我的小说", "--dir", str(tmp_path)])
    out = capsys.readouterr().out
    marker_lines = [ln for ln in out.splitlines() if ln.startswith("WRITING_PROJECT=")]
    assert len(marker_lines) == 1
    path = marker_lines[0].split("=", 1)[1]
    assert Path(path).is_absolute()
    assert Path(path).is_dir()
```

（import 路径与 `main` 的调用签名以该目录现有测试为准。）

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/skills/writing && source bin/ensure-python.sh && $WRITING_PY -m pytest tests/ -k project_marker -v
```

Expected: FAIL

- [ ] **Step 4: 在 `project_manager.py` 的 init 分支末尾打印标记**

在 init 子命令打印完人类可读信息之后追加：

```python
    # 桌面端接管标记：Cowork 的写作工作区从这一行抓项目绝对路径。
    # 同款手法见 bin/ensure-python.cmd 的 `WRITING_PY=<path>`——脚本自己报数，
    # 免得调用方复刻 slugify 规则（中文保留、其余压下划线），两边一漂就找不到目录。
    # 必须是最后一行且独占一行，前端按行首 `WRITING_PROJECT=` 匹配。
    print(f"WRITING_PROJECT={project_dir.resolve()}")
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/skills/writing && $WRITING_PY -m pytest tests/ -v
```

Expected: 全部通过（含原有用例）

- [ ] **Step 6: 改 `workflows/workplace-writing.md` 的落盘规则**

把 Step 1「判长短，决定要不要落盘」那段（约 28-34 行）替换为：

```markdown
- **一律落单文件**，让桌面端的写作工作区能接住（右栏排版预览 + 导出 Word）：
  - 落点：`<当前工作目录>/写作/<标题>.md`。目录不存在就先建。
  - **不建项目、不跑 Python 自举、不写 spec_lock** —— 快道还是快道，只是成稿有个存身处。
  - 用 Write 工具直接写，不要为这一步去跑 `project_manager.py`。
  - 写完把完整路径报给用户。

  > 为什么从「短文纯对话直出」改成一律落盘：桌面端的写作工作区认这个落点，落了盘用户才
  > 能在右栏看到排好版的稿子、直接导出 Word 发出去。纯对话直出的稿子用户还得自己复制粘贴
  > 排版，这一步的手工成本比建一个文件高得多。
```

- [ ] **Step 7: 改 `workflows/de-ai.md` 的输出规则**

把 Step 0 的「轻量守则：默认不建项目、不落盘」（约 32 行）替换为：

```markdown
- **落单文件**：改写后的成稿写到 `<当前工作目录>/写作/<标题>-去AI版.md`（目录不存在就先建），
  用 Write 工具直写。**仍然不建项目、不跑 Python 自举**（除非要用文风对齐或打分证据，
  那时才按 SKILL.md 顶部自举）。落盘是为了让桌面端的写作工作区接住这份稿子——
  用户能在右栏看到排版、直接导出。
```

同步更新该文件末尾检查点里「若落盘，报了完整文件路径」一行为「报了完整文件路径」。

- [ ] **Step 8: 在 `SKILL.md` 加「选区改写响应协议」**

在「角色切换协议」一节之后插入：

```markdown
---

## 选区改写响应协议（桌面端工作区触发）

用户在桌面端的写作工作区里选中一段文字发起改写时，你会收到一条**带固定格式要求**的消息：
它包含本节全文、选中的那一段、用户的要求，并要求你把结果包在一对标记之间。

收到这类请求时：

1. **把改写后的文字包在这对标记之间**，标记各占一行，中间只放正文——不要解释、不要加标题、
   不要重复原文：

   ```
   ===改写结果开始===
   （改写后的正文）
   ===改写结果结束===
   ```

2. **不要修改任何文件。** 你手上有 Edit / Write 工具，但这一轮**绝对不能用**。

   > 理由：改写结果要先给用户看「原文 vs 改后」的对照，由他点「应用」才落地。你若直接改盘，
   > 用户点「放弃」时内容已经被覆盖，这一步的保护就形同虚设。落地由应用侧完成。

3. 只改选中的那一段，不要顺手改选区之外的内容——用户只授权了这一段。

4. 改完可以在标记之外用一句话说明改了什么（那句话只进聊天，不会进文档）。
```

- [ ] **Step 9: 跑 skill 的资源库校验**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/skills/writing && $WRITING_PY scripts/validate_library.py
```

Expected: 通过（本次没动 references/，应无变化，但这是改 skill 后的规定动作）

- [ ] **Step 10: 端到端手动验收**

`bun run dev`，按 spec 的验收清单逐条走：

1. 「用 writing 帮我写一篇 800 字行业观察」→ 右栏**自动**接管（这次不用手动 echo 标记了）→ 逐节冒出 → 进度骨架节数正确
2. 选中一段改写 → 对照卡 → 应用 → 磁盘 md 文件确实变了
3. AI 写作途中发起改写 → 「已排队」→ AI 写完自动执行
4. 导出 Word 打开检查；小说体裁确认章节分页
5. 微信文案：手机宽预览 + 复制 HTML 粘进公众号编辑器
6. 「帮我写本周周报」（职场快道）→ 单文件模式接管
7. 删掉项目目录 → 右栏优雅退回空态

- [ ] **Step 11: 提交**

```bash
git add skills/writing/
git commit -m "feat(writing): skill 侧接入桌面工作区（项目标记/轻量工作流落盘/改写协议）"
```

---

## Self-Review

**1. Spec 覆盖检查**

| spec 章节 | 对应任务 |
|---|---|
| 架构 · 新增文件表 | T1（shared）、T2（main core + IPC）、T4（store）、T5（Panel/Paper）、T7（气泡/对照卡）、T8（Preview）、T9（导出） |
| 数据流 ①接管 | T3（判定纯函数）、T4（store 接线）、T10（脚本打印标记） |
| 数据流 ②③轮询渲染 | T4（轮询）、T5（纸面 + 进度骨架） |
| 数据流 ④改写 | T6（纯逻辑）、T7（交互闭环） |
| 数据流 ⑤导出 | T9 |
| IPC 契约 | T2（三条）、T8（微信 HTML）、T9（两条导出）。**scan 的字段名已按 spec 修正为 `files`** |
| 两个 tab / 编辑不放预览 | T5（文稿 tab）、T8（打印预览 tab） |
| 按体裁切排版 | T5（`writingGenreStyle`）、T8（微信分支） |
| 进度骨架 | T5 |
| 与其他右栏互斥 | T5 Step 7 |
| 按块替换 / 排队 / 乐观锁 | T6、T7、T2（锁在 main 侧实现） |
| 导出三格式 + 分页分叉 | T9、T1（`shouldPageBreak`） |
| skill 侧三处改动 | T10 |
| 错误处理六条 | 目录缺失 T2+T5；读半截 T4（下轮补齐）；写冲突 T2+T7；无哨兵 T1+T7；样式读不到 T8（`styleFallback`）；取消保存 T9 |
| 测试与验证 | 每个任务的测试步骤 + T10 Step 10 的端到端清单 |

无遗漏。

**2. 与 spec 的两处偏离（已在计划内注明理由）**

- **微信 HTML 改由 main 生成**（spec 原写渲染层读 JSON 自渲）：`skillsDir` 解析在 main，且预览与复制共用同一份 HTML 字符串更不易漂。见 T8 开头的说明。
- **导出拆成 `WRITING_EXPORT_DOCX` / `WRITING_EXPORT_PDF` 两条通道**（spec 写的是 `WRITING_EXPORT` / `WRITING_EXPORT_PDF`）：docx 由 main 生成、PDF 由渲染层生成，塞进一条通道会让 payload 出现互斥字段。

这两处需要回填进 spec（见下方「收尾」）。

**3. 类型一致性**

- `WritingDocSource` / `WritingGenre` / `WritingFileMeta` / `WritingSection` 在 T1 定义，T2/T3/T4/T8 引用一致
- `WritingRevisionTarget` 在 T6 定义（`{ sectionName, range, selectedText }`），T7 的 store 与气泡引用一致
- `scanWritingDoc` 回 `files`（元信息），`readWritingSections` 回 `sections`（含正文）——两处字段名刻意不同，已在 T2 注释说明
- `writingStyleFor` 返回 `ProposalStyleConfig`，T8/T9 都按此传给 `renderProposalPdfHtml` / `markdownToDocxBuffer`

**4. 遗留的实现期确认点**（不是占位符，是必须现场核对的既有代码细节）

- `AssistantMarkdown` 的确切导出名与路径（T5 Step 5 已注明以实际文件为准，且给了替代方案）
- `FusionRuntimeProvider` 里助手消息 `'end'` 分支的全文变量名（T7 Step 4）
- `skills/writing/tests/` 的 import 风格与 `main` 调用签名（T10 Step 1 要求先看再写）
- `register.ts` 取当前窗口的既有写法（T9 Step 2 要求照抄 `PROPOSAL_EXPORT`）
