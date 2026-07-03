# 写方案·配图密度增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「写方案」生成的文档配图密度对标参考方案（库图积极复用 + Mermaid 每章一图 + 关键章节 AI 彩图自动发起走审阅卡）。

**Architecture:** 四块：① 提示词把知识库配图从「拿不准就不插」反转为「有相关图就应插」；② Mermaid 提示词升密度要求 + 渲染主题从素色 neutral 换 base 彩色；③ 新增 `genimage` 围栏指令块——AI 在正文里留指令，renderer 在落节时机自动调已有的 `PROPOSAL_IMAGE_GENERATE` IPC 生成彩图、走现有 `imageReviews` 审阅卡，应用=原地替换指令块；④ 未处理指令块在 docx/PDF/md 导出全部剥除。**零新 IPC**。

**Tech Stack:** Electron（main/preload/renderer 三进程）、React 19、zustand、bun test、remark/mdast + docx（导出）、mermaid（懒加载）。

**Spec:** `docs/superpowers/specs/2026-07-03-proposal-image-density-design.md`

## Global Constraints

- 包管理器是 **bun**，不是 npm；测试命令 `bun test src/`，质量门 `bun run typecheck`（均在 `apps/desktop/` 下执行）。仓库**没有 ESLint、没有其它 CI 检查**，typecheck + bun test 是全部自动化防线。
- 所有路径以 `apps/desktop/` 为根（monorepo；下文省略该前缀）。
- **零新 IPC**：生图复用 `PROPOSAL_IMAGE_GENERATE` 通道（`src/shared/ipc-channels.ts:508` → `src/main/ipc/register.ts:1286`），renderer 经 `window.chatApi.proposalImageGenerate({ sessionId, prompt })` 调用。不改 preload、不改 ipc-channels。
- mermaid 初始化里 `htmlLabels: false`（含 `flowchart.htmlLabels: false`）、`securityLevel: 'strict'`、`suppressErrorRendering: true` 是**导出不变量，逐字保留**（`src/renderer/src/lib/mermaidRender.ts` 文件头注释解释了为什么）。
- **草稿重建路径（restoreFromTranscript / restoreFromDisk / reopen）绝不自动发起生图**——只有生成会话进行中的落节时机（FusionRuntimeProvider 的 end/syncSections 路径）才自动发起，防止每次重开会话烧生图费。
- 提示词约束 AI 全文最多 **3** 个 genimage 指令块；renderer 侧另设**每会话最多 5 次**自动发起的防御上限（提示词失灵时的兜底）。
- 注释风格：解释「为什么这样而不是那样」，不写「做了什么」；UI 文案全中文。
- 每个 Task 结束提交一次 git commit，消息格式 `feat(proposal): …`（中文）。

---

### Task 1: shared 模块 `proposalGenImage.ts` —— 指令块解析 / 剥除 / 落位手术

**Files:**
- Create: `src/shared/proposalGenImage.ts`
- Test: `src/shared/proposalGenImage.test.ts`

**Interfaces:**
- Consumes: `splitBlocks(markdown: string): string[]`（`src/shared/proposalBlocks.ts:27`）
- Produces（后续 Task 4/6/7 依赖，签名必须一致）:
  - `const GENIMAGE_LANG = 'genimage'`
  - `isGenImageDirectiveBlock(blockText: string): boolean`
  - `interface GenImageDirectiveContent { caption: string; prompt: string }`
  - `parseGenImageBlock(blockText: string): GenImageDirectiveContent | null`
  - `interface GenImageDirective extends GenImageDirectiveContent { blockIndex: number; occurrence: number; raw: string }`
  - `parseGenImageDirectives(markdown: string): GenImageDirective[]`
  - `stripGenImageDirectives(markdown: string): string`
  - `genImageDirectiveKey(sectionId: string, raw: string, occurrence: number): string`
  - `replaceGenImageDirectiveBlock(blocks: string[], raw: string, occurrence: number, replacement: string): { blocks: string[]; changed: boolean }`
  - `removeGenImageDirectiveBlock(blocks: string[], raw: string, occurrence: number): { blocks: string[]; changed: boolean }`

- [ ] **Step 1: 写失败测试**

创建 `src/shared/proposalGenImage.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'

import {
  isGenImageDirectiveBlock,
  parseGenImageBlock,
  parseGenImageDirectives,
  stripGenImageDirectives,
  genImageDirectiveKey,
  replaceGenImageDirectiveBlock,
  removeGenImageDirectiveBlock
} from './proposalGenImage'

const DIRECTIVE = ['```genimage', '图说: 系统总体架构图', '分层架构：应用层、AI 能力层、数据层。', '```'].join('\n')

describe('isGenImageDirectiveBlock / parseGenImageBlock', () => {
  it('识别完整指令块并解析图说与构图描述', () => {
    expect(isGenImageDirectiveBlock(DIRECTIVE)).toBe(true)
    expect(parseGenImageBlock(DIRECTIVE)).toEqual({
      caption: '系统总体架构图',
      prompt: '分层架构：应用层、AI 能力层、数据层。'
    })
  })
  it('全角冒号的图说行同样解析', () => {
    const d = ['```genimage', '图说：业务闭环架构', '闭环描述。', '```'].join('\n')
    expect(parseGenImageBlock(d)).toEqual({ caption: '业务闭环架构', prompt: '闭环描述。' })
  })
  it('缺图说行退化：caption 用默认「配图」，全文当构图描述', () => {
    const d = ['```genimage', '只有构图描述一行。', '```'].join('\n')
    expect(parseGenImageBlock(d)).toEqual({ caption: '配图', prompt: '只有构图描述一行。' })
  })
  it('普通 mermaid / 代码块不误报', () => {
    expect(isGenImageDirectiveBlock('```mermaid\nflowchart LR\n```')).toBe(false)
    expect(isGenImageDirectiveBlock('普通段落')).toBe(false)
    expect(parseGenImageBlock('```ts\nconst a = 1\n```')).toBeNull()
  })
  it('内容为空的指令块视为无效（不产出空 prompt 的生图任务）', () => {
    expect(parseGenImageBlock('```genimage\n```')).toBeNull()
  })
})

describe('parseGenImageDirectives', () => {
  it('抽出全部指令块并带 blockIndex 与同内容 occurrence', () => {
    const md = ['正文一段。', '', DIRECTIVE, '', '又一段。', '', DIRECTIVE].join('\n')
    const out = parseGenImageDirectives(md)
    expect(out.length).toBe(2)
    expect(out[0].blockIndex).toBe(1)
    expect(out[0].occurrence).toBe(0)
    expect(out[1].blockIndex).toBe(3)
    expect(out[1].occurrence).toBe(1)
    expect(out[0].caption).toBe('系统总体架构图')
    expect(out[0].raw).toBe(DIRECTIVE)
  })
  it('反引号内联引用的伪指令不误报（幻影哨兵教训：必须独立成块）', () => {
    const md = '正文里内联提到 `\\`\\`\\`genimage` 字样不算指令。'
    expect(parseGenImageDirectives(md)).toEqual([])
  })
  it('空文档 → []', () => {
    expect(parseGenImageDirectives('')).toEqual([])
  })
})

describe('stripGenImageDirectives', () => {
  it('剥除指令块，其余正文原样保留', () => {
    const md = ['## 第一章', '', '正文。（据《白皮书》）', '', DIRECTIVE, '', '尾段。'].join('\n')
    const out = stripGenImageDirectives(md)
    expect(out).not.toContain('genimage')
    expect(out).not.toContain('图说')
    expect(out).toContain('## 第一章')
    expect(out).toContain('正文。（据《白皮书》）')
    expect(out).toContain('尾段。')
  })
  it('指令块在文档末尾（无尾随换行）也剥得掉', () => {
    const md = '正文。\n\n' + DIRECTIVE
    expect(stripGenImageDirectives(md)).not.toContain('genimage')
  })
  it('无指令块时原样返回（引用相等，零成本快路径）', () => {
    const md = '## 章\n\n正文。'
    expect(stripGenImageDirectives(md)).toBe(md)
  })
  it('不吞普通 mermaid 块', () => {
    const md = '```mermaid\nflowchart LR\nA-->B\n```'
    expect(stripGenImageDirectives(md)).toBe(md)
  })
})

describe('genImageDirectiveKey', () => {
  it('同节同内容同序 → 键稳定；不同 occurrence / 不同内容 → 键不同', () => {
    const k1 = genImageDirectiveKey('sec-1', DIRECTIVE, 0)
    expect(genImageDirectiveKey('sec-1', DIRECTIVE, 0)).toBe(k1)
    expect(genImageDirectiveKey('sec-1', DIRECTIVE, 1)).not.toBe(k1)
    expect(genImageDirectiveKey('sec-1', '```genimage\n别的\n```', 0)).not.toBe(k1)
    expect(genImageDirectiveKey('sec-2', DIRECTIVE, 0)).not.toBe(k1)
  })
})

describe('replace / removeGenImageDirectiveBlock', () => {
  const blocks = ['正文一段。', DIRECTIVE, '又一段。', DIRECTIVE]
  it('按 occurrence 原地替换第二个同内容指令块', () => {
    const { blocks: next, changed } = replaceGenImageDirectiveBlock(blocks, DIRECTIVE, 1, '![系统总体架构图](/a/b.png)')
    expect(changed).toBe(true)
    expect(next[1]).toBe(DIRECTIVE) // 第一个不动
    expect(next[3]).toBe('![系统总体架构图](/a/b.png)')
    expect(blocks[3]).toBe(DIRECTIVE) // 纯函数：入参不被就地修改
  })
  it('删除：块被摘掉、数组变短', () => {
    const { blocks: next, changed } = removeGenImageDirectiveBlock(blocks, DIRECTIVE, 0)
    expect(changed).toBe(true)
    expect(next.length).toBe(3)
    expect(next.filter((b) => b === DIRECTIVE).length).toBe(1)
  })
  it('内容漂移（用户手改过指令文本）→ no-op，changed=false', () => {
    const { changed } = replaceGenImageDirectiveBlock(blocks, '```genimage\n改过了\n```', 0, '![x](/y.png)')
    expect(changed).toBe(false)
  })
  it('occurrence 越界 → no-op', () => {
    const { changed } = removeGenImageDirectiveBlock(blocks, DIRECTIVE, 5)
    expect(changed).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/shared/proposalGenImage.test.ts`
Expected: FAIL（模块不存在 / Cannot find module './proposalGenImage'）

- [ ] **Step 3: 写实现**

创建 `src/shared/proposalGenImage.ts`：

```ts
// genimage 指令块（配图密度增强 ③）：AI 在正文里输出的「请应用调生图模型出一张彩图」占位指令。
// 形如：
//   ```genimage
//   图说: 系统总体架构图
//   <构图描述，组件/分层必须来自知识库事实>
//   ```
// AI 只负责留指令；真正的生图由 renderer 在落节时机自动调 PROPOSAL_IMAGE_GENERATE IPC，产出
// 走图片审阅卡（imageReviews），用户点「应用」才用 `![图说](路径)` 原地替换指令块。
//
// 为什么用围栏代码块而不是自造行内语法：① splitBlocks 对围栏有现成的整块消费逻辑（内部空行
// 不切、天然独立成块）；② react-markdown 解析围栏为 code 节点，渲染侧按 lang 精确拦截；③ 吸取
// 「幻影哨兵」教训——反引号内联引用的伪指令不会被当成真指令（识别以【块】为单位，不裸扫全文）。
//
// 手术函数按【指令块原文 trim 相等】匹配而非 blockIndex：审阅悬而未决期间该节可能被并发编辑、
// 块序漂移，内容键比下标键稳（同 applyImageReplacementWithDrift 的取舍，但这里内容自带唯一性，
// 无需歧义守卫——同内容多块由 occurrence 区分）。

import { splitBlocks } from './proposalBlocks'

export const GENIMAGE_LANG = 'genimage'

// 块级识别：整块必须以 ```genimage 围栏开头、以 ``` 收尾（splitBlocks 产出的块已 trim 首尾空行）。
const GENIMAGE_BLOCK_RE = /^```genimage[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

export function isGenImageDirectiveBlock(blockText: string): boolean {
  return GENIMAGE_BLOCK_RE.test(blockText.trim())
}

export interface GenImageDirectiveContent {
  /** 图说：落位后作 `![图说](路径)` 的 alt 文字，也是卡片上显示的图名。 */
  caption: string
  /** 构图描述：交给生图模型的正文（不含图说行）。 */
  prompt: string
}

/** 解析单个指令块。非指令块或内容为空（没法生图）→ null。 */
export function parseGenImageBlock(blockText: string): GenImageDirectiveContent | null {
  const m = GENIMAGE_BLOCK_RE.exec(blockText.trim())
  if (!m) return null
  const inner = m[1].trim()
  if (!inner) return null
  const lines = inner.split('\n')
  // 图说行：首行「图说: xxx」（冒号全半角都认——AI 中文语境常打全角）。缺省 caption 用「配图」。
  const cap = /^图说[:：]\s*(.+)$/.exec(lines[0].trim())
  if (cap) {
    const prompt = lines.slice(1).join('\n').trim()
    return { caption: cap[1].trim(), prompt: prompt || cap[1].trim() }
  }
  return { caption: '配图', prompt: inner }
}

export interface GenImageDirective extends GenImageDirectiveContent {
  /** splitBlocks 下标（发起时刻的快照，仅用于审阅卡锚定渲染位置）。 */
  blockIndex: number
  /** 同内容指令块的出现序（0 起）——手术定位用的稳定键之二。 */
  occurrence: number
  /** 指令块原文（trim 后整块）——手术定位用的稳定键之一。 */
  raw: string
}

/** 抽取一节 markdown 里的全部指令块（按块扫描，绝不裸扫全文）。 */
export function parseGenImageDirectives(markdown: string): GenImageDirective[] {
  if (!markdown || !markdown.includes('```genimage')) return []
  const blocks = splitBlocks(markdown)
  const out: GenImageDirective[] = []
  const seen = new Map<string, number>()
  blocks.forEach((blk, i) => {
    const content = parseGenImageBlock(blk)
    if (!content) return
    const raw = blk.trim()
    const occurrence = seen.get(raw) ?? 0
    seen.set(raw, occurrence + 1)
    out.push({ ...content, blockIndex: i, occurrence, raw })
  })
  return out
}

// 导出剥除用：行首锚定的围栏正则（与 mermaidRender 的 MERMAID_FENCE_RE 同风格，但必须锚行首
// ——内联反引号里的伪指令不能被吞）。用正则而非 splitBlocks+joinBlocks 重拼：strip 跑在导出
// 全文（含分页注释/节标记）上，重拼会规整化块间距、破坏「预览=导出」的字节稳定预期。
const GENIMAGE_FENCE_MD_RE =
  /(^|\r?\n)[ \t]{0,3}```genimage[ \t]*\r?\n[\s\S]*?\r?\n[ \t]{0,3}```[ \t]*(?=\r?\n|$)/g

/** 剥掉全文的 genimage 指令块（未生成/未审阅的指令绝不进交付物）。无指令时原样返回。 */
export function stripGenImageDirectives(markdown: string): string {
  if (!markdown.includes('```genimage')) return markdown
  return markdown.replace(GENIMAGE_FENCE_MD_RE, '$1').replace(/\n{3,}/g, '\n\n')
}

// djb2 短哈希：key 只做幂等去重（Map 键），不做安全用途；Date.now/Math.random 被禁（可重放性），
// 内容哈希天然稳定。
function hashText(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 生图任务的幂等键：节 + 指令内容 + 同内容序。genImageJobs / seen 集合共用。 */
export function genImageDirectiveKey(sectionId: string, raw: string, occurrence: number): string {
  return `${sectionId}#${occurrence}#${hashText(raw.trim())}`
}

function directiveIndices(blocks: readonly string[], raw: string): number[] {
  const key = raw.trim()
  const out: number[] = []
  blocks.forEach((b, i) => {
    if (b.trim() === key) out.push(i)
  })
  return out
}

/**
 * 用 replacement（一般是 `![图说](路径)`）原地替换第 occurrence 个内容等于 raw 的块。
 * replacement 为空串 = 删除该块。找不到（内容漂移/越界）→ changed:false、入参原样返回。
 * 纯函数：不就地修改入参。
 */
export function replaceGenImageDirectiveBlock(
  blocks: string[],
  raw: string,
  occurrence: number,
  replacement: string
): { blocks: string[]; changed: boolean } {
  const idx = directiveIndices(blocks, raw)[occurrence]
  if (idx === undefined) return { blocks, changed: false }
  const next = blocks.slice()
  if (replacement) next[idx] = replacement
  else next.splice(idx, 1)
  return { blocks: next, changed: true }
}

/** 摘除第 occurrence 个内容等于 raw 的块（审阅「丢弃」用）。 */
export function removeGenImageDirectiveBlock(
  blocks: string[],
  raw: string,
  occurrence: number
): { blocks: string[]; changed: boolean } {
  return replaceGenImageDirectiveBlock(blocks, raw, occurrence, '')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/shared/proposalGenImage.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/proposalGenImage.ts apps/desktop/src/shared/proposalGenImage.test.ts
git commit -m "feat(proposal): genimage 指令块 shared 基建——块级解析/导出剥除/落位手术（配图密度③）"
```

---

### Task 2: 提示词三条——库图积极化、Mermaid 密度、genimage 指令

**Files:**
- Modify: `src/main/core/proposalPrompt.ts:95-102`（两条改写 + 一条新增）
- Test: `src/main/core/proposalPrompt.test.ts`（追加断言）

**Interfaces:**
- Consumes: 无（纯文本改动）
- Produces: `buildProposalAppend()` 输出里包含新纪律文案；Task 6/7 的运行时行为依赖 AI 按此输出 ` ```genimage ` 块

**注意**：`proposalPrompt.ts` 里这些条目是单行长字符串数组元素，Edit 时 old_string 必须整条精确匹配（含前后单引号与结尾逗号之间的内容）。既有测试断言 `'![图说]'`、`'绝不挪用别处的图'` 必须继续存在于新文案中（下面的新文案已包含）。

- [ ] **Step 1: 先加失败断言**

在 `src/main/core/proposalPrompt.test.ts` 末尾追加：

```ts
describe('buildProposalAppend 配图密度增强', () => {
  const out = buildProposalAppend('/mirror', [])

  it('库图纪律为积极式：有对应图就应当插入、一节一图', () => {
    expect(out).toContain('就应当插入')
    expect(out).toContain('一节一图')
  })

  it('同一张图全文只插一次', () => {
    expect(out).toContain('只插一次')
  })

  it('mermaid 升级为密度要求：每个一级章应至少配一张结构图', () => {
    expect(out).toContain('应至少配一张')
  })

  it('genimage 指令块纪律：存在、限 3 个、接地', () => {
    expect(out).toContain('genimage')
    expect(out).toContain('图说:')
    expect(out).toContain('最多 3 个')
    expect(out).toContain('绝不为画面丰满编造')
  })

  it('既有库图硬约束不回归：同源约束与尖括号包裹仍在', () => {
    expect(out).toContain('![图说]')
    expect(out).toContain('绝不挪用别处的图')
    expect(out).toContain('尖括号')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/proposalPrompt.test.ts`
Expected: FAIL（新 describe 里 4 条失败：`就应当插入`、`应至少配一张`、`最多 3 个` 等不在输出里）

- [ ] **Step 3: 改写库图条目（原 L97）**

用 Edit 把这条数组元素整体替换（old_string 为当前 L97 那条完整字符串）。新文案：

```ts
    // 嵌图（配图密度增强 ①）：措辞从「拿不准就不插」反转为「有相关图就应插」+ 明确密度目标——
    // 对标客户方案的「每个功能小节配一张产品截图」排布。同源约束（只能用本节已引用文件名下的
    // 图）原样保留，这是接地底线：防止往客户方案塞 logo/无关装饰图。封面/目录不插图。
    '【正文·积极嵌入知识库配图】写每一节正文时都主动检查：本节已 （据《…》） 引用过的文件名下是否列有配图（上面文件清单里该文件名下的「图：」路径）。【只要某张图与本节内容对应（界面截图、功能示意、统计图表等），就应当插入，不要吝啬】——图文并茂是这份方案的硬性质量要求：叶子级功能小节（最深层标题下的正文）凡所引文件配有对应界面截图的应配一张，一节一图为宜；统计/分析类小节凡有图表截图的同样应配。插法：从【该文件的图清单】里挑最相关的图，按 `![图说](<图的绝对路径>)` 单独成行嵌入（路径【务必用尖括号 `<>` 包裹】——图路径几乎必然含空格如「Application Support」，不包尖括号会导致整条图片语法解析失败、只显示成一行纯文字），图说一句话说明图意。硬性约束：① 只能用你在本节已 （据《…》） 引用过文件名下列出的图，绝不挪用别处的图、绝不编造图路径；② 同一张图整份方案【只插一次】，绝不重复插入；③ 仅在确无相关图时才不插，不要为「插不插图」打断提问；④ 封面、目录一律不插图。',
```

- [ ] **Step 4: 改写 Mermaid 条目（原 L102）**

同样整条替换。新文案（五条硬纪律逐字保留，只把开头的条件式改成密度要求）：

```ts
    // Mermaid 结构图（配图密度增强 ②）：从条件式「当某节要表达…时」升级为密度要求——每个一级章
    // 有事实可依就应至少一张。知识库配图是「引用既有位图」，这条是「按方案设计画结构图」，互补。
    // 底线仍是溯源：图里的组件/步骤/环节必须来自原文事实，绝不为「画得好看」编造不存在的模块。
    // mermaid 是 code 块、不走 ![]() 接地校验，故纪律全靠这条提示词约束。
    '【正文·用 Mermaid 画结构图】结构图是这份方案的硬性质量要求：【每个一级章（## 级）凡涉及系统架构、业务流程、部署拓扑、组织结构或实施时间计划、且知识库原文事实足以支撑时，应至少配一张】用 ```mermaid 代码块绘制的结构图（流程图 flowchart、时序图 sequenceDiagram、甘特图 gantt 等）——结构图比大段文字更能让客户看懂方案设计；事实不足以画图的章节不硬画、绝不为凑图编造。硬性纪律：① 图里的组件 / 节点 / 步骤 / 环节 / 时间【必须来自知识库原文的事实】，绝不为美观或完整而编造不存在的模块、接口或环节；② 图所依据的事实仍按第 3 条在【图所在的那一段】标注（据《文件名》）来源；③ 只画纯结构，节点文字用【简短中文短语】，不要把整段正文塞进图、不要在节点标签里写 HTML（如 <br>）；④ 【防语法错】节点标签含中文标点或特殊符号（（）《》：、，；等）时，必须用英文双引号把标签文本整体包住，例如 `A["预问诊：生成报告"]`、`B["对话情景（NLP）"]`，否则 mermaid 解析报错、图画不出；⑤ 封面、目录一律不画图。mermaid 代码块与正文同样要包在【正文哨兵】里、作为该章正文的一部分。',
```

- [ ] **Step 5: 新增 genimage 条目**

紧接 Mermaid 条目之后插入新数组元素：

```ts
    // AI 彩图指令（配图密度增强 ③）：mermaid 管日常结构图；门面级架构图（总体架构/业务闭环/
    // 能力全景）用生图模型出彩图，观感对标专业美工。AI 只负责在正文里留一个 genimage 指令块，
    // 真正的生图由应用在落节时自动调出图 API、走「先审后落地」的图片审阅卡——AI 自己不调工具、
    // 不知道也不需要知道生图何时完成。数量硬限 3 个防费用失控（renderer 另有每会话 5 次兜底）。
    '【正文·门面架构图用 genimage 指令块】对【门面级结构图】——系统总体架构图、业务闭环架构、能力全景图这类需要专业彩图质感、通常放在「总体架构/总体设计」章的图——请【不要用 mermaid】，改为在正文相应位置输出一个 genimage 围栏代码块，应用会自动调用生图模型出彩图并交用户审阅。格式（首行图说、其余行构图描述）：\n```genimage\n图说: 系统总体架构图\n分层架构，自下而上为基础设施层（…）、数据层（…）、AI 能力层（…）、应用层（…），各层组件与连线关系…\n```\n硬性纪律：① 整份方案 genimage 指令块【最多 3 个】，只用于最重要的门面图，普通流程/时序/计划仍用 mermaid；② 构图描述里的分层、组件、连线【必须来自知识库原文的事实】，绝不为画面丰满编造不存在的模块或接口；描述所依据的事实按第 3 条在指令块所在段落标注（据《文件名》）来源；③ 构图描述要求图中文字【少而精、全用简短中文标签】（生图模型渲染中文长句易出错）；④ 指令块要独立成块（前后空行）、包在【正文哨兵】里、作为该章正文的一部分；⑤ 封面、目录一律禁止。',
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/main/core/proposalPrompt.test.ts`
Expected: PASS（新增 5 条 + 既有全部绿）

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/core/proposalPrompt.ts apps/desktop/src/main/core/proposalPrompt.test.ts
git commit -m "feat(proposal): 提示词配图密度增强——库图积极化+Mermaid每章一图+genimage门面彩图指令"
```

---

### Task 3: Mermaid 主题美化（base + 品牌蓝 themeVariables）

**Files:**
- Modify: `src/renderer/src/lib/mermaidRender.ts:26-39`（仅 `mermaid.initialize` 调用）

**Interfaces:**
- Consumes / Produces: 无签名变化。导出栅格化（`rasterizeSvg`）与 docx/PDF 嵌图走同一 `renderMermaid`，主题变化自然全链路跟随，无需改导出器。

- [ ] **Step 1: 改 initialize 配置**

把 `theme: 'neutral',` 一行替换为：

```ts
        // base + themeVariables（配图密度增强 ②）：素色 neutral 与客户方案里的专业彩图观感差距
        // 太大；base 是 mermaid 唯一官方支持 themeVariables 全量定制的主题。品牌蓝系浅底深框、
        // 白色画布（rasterizeSvg 导出时也刷白底，两端一致）。只调颜色/字号，不碰布局与标签渲染
        // 方式——htmlLabels:false 等导出不变量在下方逐字保留。
        theme: 'base',
        themeVariables: {
          primaryColor: '#eaf1fd', // 节点底：浅品牌蓝
          primaryTextColor: '#1e3a5f', // 节点文字：深蓝灰
          primaryBorderColor: '#3b74d9', // 节点框：品牌蓝
          lineColor: '#5b8def', // 连线
          secondaryColor: '#f4f8ff',
          tertiaryColor: '#fafcff',
          fontSize: '14px'
        },
```

其余配置（`startOnLoad`、`securityLevel`、`htmlLabels`、`flowchart`、`suppressErrorRendering`）逐字不动。

- [ ] **Step 2: typecheck 验证**

Run: `cd apps/desktop && bun run typecheck:web`
Expected: 通过（`themeVariables` 是 mermaid `MermaidConfig` 的合法字段；若类型报错，检查 mermaid 版本的类型定义字段名，不要用 `as any` 硬压）

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/mermaidRender.ts
git commit -m "feat(proposal): mermaid 主题 neutral→base 品牌蓝彩化，导出不变量逐字保留"
```

---

### Task 4: 导出全路径剥除 genimage 指令块

**Files:**
- Modify: `src/main/core/proposalDocx.ts`（`markdownToDocxBuffer` 入口 strip + `case 'code'` 防御性跳过）
- Modify: `src/main/core/proposalExport.ts`（.md 直接写盘路径 strip）
- Test: `src/main/core/proposalDocx.test.ts`（zip 解包断言 document.xml 无指令残留）

**Interfaces:**
- Consumes: `stripGenImageDirectives`、`GENIMAGE_LANG`（Task 1）
- Produces: 导出物（docx / 预览 / PDF / md）不含任何 genimage 文本。注意 `markdownToDocxBuffer` 同时服务「导出 docx」（proposalExport.ts:87）、「预览」与「PDF 渲染」（register.ts:1135 的 RENDER_PROPOSAL）——一处收口，三路全覆盖。

- [ ] **Step 1: 写失败测试**

在 `src/main/core/proposalDocx.test.ts` 末尾追加（含零依赖 zip 解包 helper——仓库无 zip 库，用 node:zlib 手解中央目录；不用局部头尺寸字段：流式写 zip 常设 bit3、局部头尺寸为 0）：

```ts
import { inflateRawSync } from 'node:zlib'

// 从 docx（zip）buffer 里解出 word/document.xml 文本：尾部找 EOCD → 中央目录拿偏移与压缩尺寸
// → inflateRawSync。仅测试用，不求通用健壮。
function readDocxDocumentXml(buf: Buffer): string {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('EOCD not found')
  let off = buf.readUInt32LE(eocd + 16)
  const count = buf.readUInt16LE(eocd + 10)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory header')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    if (name === 'word/document.xml') {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const data = buf.subarray(dataStart, dataStart + compSize)
      return method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8')
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('document.xml not found in docx')
}

describe('markdownToDocxBuffer 剥除 genimage 指令块', () => {
  it('未处理的指令块绝不进交付 Word（document.xml 无残留）', async () => {
    const md = [
      '<!--proposal-section:content-->',
      '',
      '## 总体架构',
      '',
      '正文。（据《白皮书》）',
      '',
      '```genimage',
      '图说: 系统总体架构图',
      '分层构图描述。',
      '```',
      '',
      '尾段。（据《白皮书》）'
    ].join('\n')
    const buf = await markdownToDocxBuffer(md)
    const xml = readDocxDocumentXml(Buffer.from(buf))
    expect(xml).not.toContain('genimage')
    expect(xml).not.toContain('图说')
    expect(xml).not.toContain('分层构图描述')
    expect(xml).toContain('尾段') // 剥除不误伤相邻正文
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/proposalDocx.test.ts`
Expected: 新用例 FAIL——`xml` 里含 `genimage`/`图说`（当前 code 块按等宽段落原样进 docx）

- [ ] **Step 3: 实现 docx 剥除**

`src/main/core/proposalDocx.ts` 两处：

① `markdownToDocxBuffer`（L1123）——在既有 strip 链最外层加一环：

```ts
// 现状：
//   const tree = mdProcessor.parse(normalizeImageMarkdown(stripCitations(markdown))) as Root
// 改为（genimage 指令是给应用看的占位、不是内容，与来源标注同点剥除）：
const tree = mdProcessor.parse(
  normalizeImageMarkdown(stripCitations(stripGenImageDirectives(markdown)))
) as Root
```

import 处追加：`import { stripGenImageDirectives, GENIMAGE_LANG } from '../../shared/proposalGenImage'`（与既有 `../../shared/proposal` import 并排）。

② `case 'code'`（L502-507 附近）——mermaid 分支之前加防御性跳过（strip 已在入口收口，这里兜「嵌套在 blockquote 等结构里、行首锚定正则漏网」的残余，直接吞掉、绝不当普通代码渲染）：

```ts
    case 'code': {
      // genimage 指令块：应用侧占位指令，绝不属于交付内容。入口 stripGenImageDirectives 已剥
      // 一遍，这里对漏网块（嵌套结构里的）再兜一道——静默吞掉，不输出任何占位文字（编辑态卡片
      // 已保证用户看得见未处理的指令，导出物里不需要提醒）。
      if (node.lang === GENIMAGE_LANG) return []
      // mermaid 围栏块 → 嵌入预渲位图（方案一二期）。……（下方既有逻辑不动）
```

- [ ] **Step 4: 实现 .md 写盘剥除**

`src/main/core/proposalExport.ts:80`：

```ts
// 现状：
//   writeFileSync(r.filePath, normalizeImageMarkdown(stripCitations(markdown)), 'utf8')
// 改为：
writeFileSync(
  r.filePath,
  normalizeImageMarkdown(stripCitations(stripGenImageDirectives(markdown))),
  'utf8'
)
```

import 处追加：`import { stripGenImageDirectives } from '../../shared/proposalGenImage'`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/main/core/proposalDocx.test.ts`
Expected: PASS（含既有全部用例——strip 不得破坏任何既有导出用例）

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/core/proposalDocx.ts apps/desktop/src/main/core/proposalExport.ts apps/desktop/src/main/core/proposalDocx.test.ts
git commit -m "feat(proposal): 导出全路径剥除 genimage 指令块（docx/预览/PDF/md 一处收口+防御兜底）"
```

---

### Task 5: store 扩展——ImageReview 'directive' 模式 + genImageJobs 任务态

**Files:**
- Modify: `src/renderer/src/stores/proposal.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 6/7 依赖）:
  - `ImageReview.mode: 'edit' | 'generate' | 'directive'`；新可选字段 `directiveRaw?: string`、`directiveOccurrence?: number`、`caption?: string`
  - `interface GenImageJob { status: 'pending' | 'failed' | 'done'; error?: string }`
  - state `genImageJobs: Record<string, GenImageJob>`（键 = `genImageDirectiveKey` 产物）
  - action `setGenImageJob: (key: string, job: GenImageJob) => void`

- [ ] **Step 1: 扩 ImageReview**

`src/renderer/src/stores/proposal.ts:52-64` 的 `ImageReview`：

```ts
export interface ImageReview {
  id: string
  sectionId: string
  blockIndex: number
  sourcePath?: string // mode='generate'/'directive' 时没有源图，故可空
  resultPath: string
  // 'directive' = genimage 指令块自动生图（配图密度③）：应用=原地替换指令块，丢弃=删指令块，
  // 与 'generate'（追加插入到 blockIndex 之后）落位语义不同，必须分流。
  mode: 'edit' | 'generate' | 'directive'
  // mode='edit'：源图同路径出现序（既有语义不变，见原注释）。
  occurrence?: number
  // mode='directive'：指令块原文（trim）+ 同内容出现序——落位手术按内容键定位（块序漂移免疫，
  // 见 shared/proposalGenImage.ts 顶注），blockIndex 只用于审阅卡渲染锚定。
  directiveRaw?: string
  directiveOccurrence?: number
  // mode='directive'：图说，落位时作 `![图说](路径)` 的 alt 文字。
  caption?: string
}
```

- [ ] **Step 2: 加 GenImageJob 状态与 action**

在 `BlockRevisionReview`/`ImageReview` 定义之后追加：

```ts
// genimage 指令块的生图任务态（配图密度③）。键 = genImageDirectiveKey(sectionId, raw, occurrence)。
// 三重职责：① 幂等 seen 集合——键存在（无论何态）即不再自动发起，防重复烧钱；② 驱动指令块卡片
// 的三态渲染（pending 转圈 / failed 错误+重试 / done 提示看审阅卡）；③ restore 重建路径不写入
// 任何键 → 卡片渲染成「点此生成」手动态。瞬时 UI 信号，不持久化（与 imageReviews 同重置点清空）。
export interface GenImageJob {
  status: 'pending' | 'failed' | 'done'
  error?: string
}
```

`ProposalState` 接口里、`imageReviews` 之后加：

```ts
  genImageJobs: Record<string, GenImageJob>
```

action 声明（`removeImageReview` 之后）：

```ts
  // genimage 任务态登记/更新（配图密度③）。整表清空走各 reset 点，不单独提供删除。
  setGenImageJob: (key: string, job: GenImageJob) => void
```

实现（`removeImageReview` 实现之后）：

```ts
  setGenImageJob: (key, job) =>
    set((s) => ({ genImageJobs: { ...s.genImageJobs, [key]: job } })),
```

- [ ] **Step 3: 全部重置点加 `genImageJobs: {}`**

以下 **7 处** set 对象里、`imageReviews` 字段旁各加一行 `genImageJobs: {}`：初始 state（L224 附近）、`start`、`reopen`、`leaveMode`、`restoreFromTranscript`、`restoreFromDisk`、`reset`。

`removeSection`（L326-330）连带清理挂在被删节上的任务键（键以 `${sectionId}#` 开头，与 imageReviews 孤儿清理同理由）：

```ts
  removeSection: (id) =>
    set((s) => {
      const jobs: Record<string, GenImageJob> = {}
      for (const [k, v] of Object.entries(s.genImageJobs)) {
        if (!k.startsWith(`${id}#`)) jobs[k] = v
      }
      return {
        sections: s.sections.filter((sec) => sec.id !== id),
        imageReviews: s.imageReviews.filter((r) => r.sectionId !== id),
        genImageJobs: jobs
      }
    }),
```

- [ ] **Step 4: typecheck**

Run: `cd apps/desktop && bun run typecheck:web`
Expected: 通过（store 无消费者变化；`mode: 'directive'` 是纯扩展，既有 `'edit'|'generate'` 分支不受影响——`ProposalImageReview.tsx` 的 `review.mode === 'edit' ? '改图预览' : '生成预览'` 对 directive 落到「生成预览」，语义正确，无需改）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts
git commit -m "feat(proposal): store 扩展 directive 审阅模式与 genImageJobs 任务态（配图密度③）"
```

---

### Task 6: 自动发起管线——错误文案抽取、发起 lib、FusionRuntimeProvider 接线

**Files:**
- Create: `src/renderer/src/lib/imageErrorText.ts`
- Create: `src/renderer/src/lib/proposalGenImageFire.ts`
- Modify: `src/renderer/src/components/workspace/ProposalPaper.tsx:424-429`（删本地 `friendlyImageError`，改 import）
- Modify: `src/renderer/src/runtime/FusionRuntimeProvider.tsx`（两处接线）

**Interfaces:**
- Consumes: `parseGenImageDirectives` / `genImageDirectiveKey` / `GenImageDirective`（Task 1）；`setGenImageJob` / `addImageReview`（Task 5）；`window.chatApi.proposalImageGenerate({ sessionId, prompt })`（既有）
- Produces（Task 7 依赖）:
  - `friendlyImageError(err: unknown, mode: 'edit' | 'generate'): string`（imageErrorText.ts）
  - `fireGenImageDirective(sessionId: string, sectionId: string, d: GenImageDirective): Promise<void>`
  - `autoFireProposalGenImages(sessionId: string): void`

- [ ] **Step 1: 抽取 friendlyImageError**

创建 `src/renderer/src/lib/imageErrorText.ts`（正文从 `ProposalPaper.tsx:424-429` 原样搬移——评审惯例：同一段 includes 映射绝不复制三处）：

```ts
// 出图/改图失败的统一错误分流（原在 ProposalPaper 内，genimage 自动发起管线也要用，抽到 lib
// 单一事实源）。可操作的错误按语义引导（缺配置 → 去设置；认证失败/格式不可嵌 → 透传 main 的
// 中文原文，它们本身就写给用户看）；其余归到按 mode 的泛化提示。
export function friendlyImageError(err: unknown, mode: 'edit' | 'generate'): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('未配置')) return '尚未配置出图 API，请到设置里填写 key 与地址后再试。'
  if (message.includes('认证失败') || message.includes('无法嵌入 Word')) return message
  return mode === 'edit' ? '改图失败，请稍后重试。' : '生成失败，请稍后重试。'
}
```

`ProposalPaper.tsx`：删除本地 `friendlyImageError` 函数（L421-429 连注释），顶部加 `import { friendlyImageError } from '../../lib/imageErrorText'`。

- [ ] **Step 2: 写发起 lib**

创建 `src/renderer/src/lib/proposalGenImageFire.ts`：

```ts
// genimage 指令块的生图发起器（配图密度③）。两个入口：
//   - autoFireProposalGenImages：FusionRuntimeProvider 在【落节时机】（end 入库 / AskUserQuestion
//     暂停时的轮内 syncSections）调用，扫全部正文节里的新指令块并自动发起。只有这两个实时路径
//     会调它——restore/reopen 重建草稿绝不自动发起（防重开会话重复烧生图费），重建出的指令块
//     渲染成「点此生成」手动卡（见 GenImageDirectiveCard）。
//   - fireGenImageDirective：单条发起（手动卡按钮 / 自动路径共用）。
// 幂等：genImageJobs 键存在即跳过（无论 pending/failed/done——failed 的重试是用户显式点按钮，
// 不归自动路径管）。防御上限 MAX_AUTO_FIRE_PER_SESSION 兜提示词失灵（AI 输出几十个指令块）的
// 极端场景：超限的指令块留成手动卡，用户看得见、点一下也能生成，不静默丢。
import {
  parseGenImageDirectives,
  genImageDirectiveKey,
  type GenImageDirective
} from '@shared/proposalGenImage'
import { useProposalStore } from '../stores/proposal'
import { friendlyImageError } from './imageErrorText'

const MAX_AUTO_FIRE_PER_SESSION = 5
// 会话内已自动发起计数。模块级 Map 而非 store：它是防御性配额、不是 UI 状态，不需要驱动渲染。
const autoFired = new Map<string, number>()

/** 给生图模型的最终提示词：构图描述 + 统一风格约束（中文短标签、扁平商务、白底、无水印）。 */
export function buildGenImagePrompt(d: { caption: string; prompt: string }): string {
  return (
    `为售前建设方案绘制「${d.caption}」：${d.prompt}\n` +
    '风格要求：现代扁平商务信息图/架构示意图，蓝色系配色、白色背景、圆角矩形分层分区排布；' +
    '图中文字全部使用简体中文、少而大、清晰可读；不要出现水印、乱码或与内容无关的装饰元素。'
  )
}

/** 发起一条指令块的生图：登记 pending → IPC → 成功登记审阅卡+done / 失败记 error。 */
export async function fireGenImageDirective(
  sessionId: string,
  sectionId: string,
  d: GenImageDirective
): Promise<void> {
  const key = genImageDirectiveKey(sectionId, d.raw, d.occurrence)
  useProposalStore.getState().setGenImageJob(key, { status: 'pending' })
  try {
    const { path } = await window.chatApi.proposalImageGenerate({
      sessionId,
      prompt: buildGenImagePrompt(d)
    })
    const pstore = useProposalStore.getState()
    // 秒级网络往返期间节可能被删：生成已完成但无处挂审阅卡，静默丢弃（与 handleImageGenerate
    // 的既有立场一致）。job 不清——removeSection 已按 sectionId 前缀连带清理。
    if (!pstore.sections.some((s) => s.id === sectionId)) return
    pstore.addImageReview({
      sectionId,
      blockIndex: d.blockIndex,
      resultPath: path,
      mode: 'directive',
      directiveRaw: d.raw,
      directiveOccurrence: d.occurrence,
      caption: d.caption
    })
    pstore.setGenImageJob(key, { status: 'done' })
  } catch (err) {
    useProposalStore
      .getState()
      .setGenImageJob(key, { status: 'failed', error: friendlyImageError(err, 'generate') })
  }
}

/** 落节时机的自动发起：扫全部正文节，对没登记过任务的指令块逐条 fire（不 await，互不阻塞）。 */
export function autoFireProposalGenImages(sessionId: string): void {
  const s = useProposalStore.getState()
  if (!s.active || s.sessionId !== sessionId) return
  for (const sec of s.sections) {
    if (sec.kind !== 'content') continue
    for (const d of parseGenImageDirectives(sec.markdown)) {
      const key = genImageDirectiveKey(sec.id, d.raw, d.occurrence)
      if (s.genImageJobs[key]) continue
      const fired = autoFired.get(sessionId) ?? 0
      if (fired >= MAX_AUTO_FIRE_PER_SESSION) {
        console.warn('[proposal-genimage] 自动生图达每会话上限，其余指令块留手动生成', {
          sessionId,
          cap: MAX_AUTO_FIRE_PER_SESSION
        })
        return
      }
      autoFired.set(sessionId, fired + 1)
      void fireGenImageDirective(sessionId, sec.id, d)
    }
  }
}
```

- [ ] **Step 3: FusionRuntimeProvider 接线（两处）**

顶部 import：`import { autoFireProposalGenImages } from '../lib/proposalGenImageFire'`

① `case 'end'` 的方案草稿处理块内（`FusionRuntimeProvider.tsx:1293` 附近）——`if (msg && msg.role === 'assistant') { … }` 的整个 pending/append 分流 if-else 链**结束之后、闭合大括号之前**加：

```ts
              // genimage 自动发起（配图密度③）：本轮入库/替换的节里可能带新指令块。放在分流
              // 之后统一扫——append 与 reviseSection 两条路径都可能引入指令块，扫描自身按
              // genImageJobs 幂等，重复调用零成本。
              autoFireProposalGenImages(sid)
```

② `syncProposalDraftFromInflight`（L1364-1380）末尾、`triggerProposalCitationVerification()` 之后加：

```ts
  // AskUserQuestion 暂停时的轮内同步同样可能带入新指令块（AI 生成正文中途暂停确认）：
  // 与 end 路径同一入口，幂等由 genImageJobs 保证。
  autoFireProposalGenImages(sid)
```

- [ ] **Step 4: typecheck**

Run: `cd apps/desktop && bun run typecheck:web`
Expected: 通过。特别确认 `ProposalPaper.tsx` 删除本地函数后所有 `friendlyImageError` 调用点走新 import。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/imageErrorText.ts apps/desktop/src/renderer/src/lib/proposalGenImageFire.ts apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(proposal): genimage 落节自动发起管线——幂等任务态+每会话防御上限+restore不自燃"
```

---

### Task 7: 编辑态渲染与审阅落位——GenImageDirectiveCard + ProposalPaper 分流 + 聊天侧降级

**Files:**
- Create: `src/renderer/src/components/workspace/GenImageDirectiveCard.tsx`
- Modify: `src/renderer/src/components/workspace/ProposalPaper.tsx`（块渲染分流、apply/discard/retry 的 directive 分支）
- Modify: `src/renderer/src/components/chat/AssistantMarkdown.tsx`（聊天侧 genimage 围栏降级为提示条）

**Interfaces:**
- Consumes: Task 1 全部解析/手术函数；Task 5 的 `GenImageJob`/`genImageJobs`/新 ImageReview 字段；Task 6 的 `fireGenImageDirective`
- Produces: 用户可见行为——指令块渲染成卡片（生成中/失败重试/待手动生成/已生成待审阅四态）；审阅卡「应用」原地替换指令块为图、「丢弃」删指令块

- [ ] **Step 1: 写 GenImageDirectiveCard**

创建 `src/renderer/src/components/workspace/GenImageDirectiveCard.tsx`：

```tsx
import type { GenImageJob } from '../../stores/proposal'
import { SpinnerIcon, AlertTriangleIcon, ImageIcon } from './proposalIcons'

// genimage 指令块的编辑态卡片（配图密度③）：指令块本身留在草稿 markdown 里当锚点，编辑态
// 不渲染成代码块而渲染成此卡。四态：
//   pending → 转圈「正在生成」；failed → 错误 + 重试（+缺配置时「去设置」）；
//   done   → 一行提示看下方审阅卡（审阅卡与本卡同 blockIndex，紧挨着渲染）；
//   无 job → 「点此生成」手动态（restore 重建路径不自动发起的落点，或超防御上限的溢出指令）。
// 纯展示 + 回调，不碰 store/IPC（与 ProposalImageReview 同纪律）。
export interface GenImageDirectiveCardProps {
  caption: string
  job: GenImageJob | undefined
  /** AI 流式生成中：手动「生成」按钮禁用（与其它编辑操作的 generating 冻结纪律一致）。 */
  generating: boolean
  onGenerate: () => void
  onOpenSettings: () => void
}

export function GenImageDirectiveCard({
  caption,
  job,
  generating,
  onGenerate,
  onOpenSettings
}: GenImageDirectiveCardProps): React.JSX.Element {
  const needsSettings = job?.status === 'failed' && (job.error ?? '').includes('未配置')
  return (
    <div className="my-2 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2.5 text-[12.5px]">
      <div className="flex items-center gap-2 text-neutral-600">
        <ImageIcon />
        <span className="font-medium">方案配图：{caption}</span>
      </div>
      {job?.status === 'pending' && (
        <div className="mt-1.5 flex items-center gap-1.5 text-neutral-500">
          <SpinnerIcon />
          <span>正在调用生图模型绘制，完成后会出现审阅卡供你确认…</span>
        </div>
      )}
      {job?.status === 'failed' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-rose-600">
          <AlertTriangleIcon />
          <span>{job.error ?? '生成失败，请稍后重试。'}</span>
          <button
            type="button"
            className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-700 hover:border-accent hover:text-accent disabled:opacity-40"
            disabled={generating}
            onClick={onGenerate}
          >
            重试
          </button>
          {needsSettings && (
            <button
              type="button"
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-700 hover:border-accent hover:text-accent"
              onClick={onOpenSettings}
            >
              去设置
            </button>
          )}
        </div>
      )}
      {job?.status === 'done' && (
        <div className="mt-1.5 text-neutral-500">已生成，请在下方审阅卡里确认「应用」或「丢弃」。</div>
      )}
      {!job && (
        <div className="mt-1.5 flex items-center gap-2 text-neutral-500">
          <span>尚未生成（重开会话不会自动扣费出图）。</span>
          <button
            type="button"
            className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-700 hover:border-accent hover:text-accent disabled:opacity-40"
            disabled={generating}
            onClick={onGenerate}
          >
            生成这张图
          </button>
        </div>
      )}
    </div>
  )
}
```

**图标注意**：`proposalIcons.tsx` 是内联 SVG 集（无图标库，项目约定）。若 `ImageIcon` 不存在，按既有图标的风格补一个 16px 内联 SVG（山形+圆点的常规 image 图标），命名 `ImageIcon` 并从 `proposalIcons.tsx` 导出——不要引入任何图标库。`SpinnerIcon`/`AlertTriangleIcon` 已存在（`ProposalImageReview.tsx:5` 在用）。

- [ ] **Step 2: ProposalPaper 块渲染分流**

`ProposalPaper.tsx` 顶部 import 追加：

```ts
import {
  isGenImageDirectiveBlock,
  parseGenImageBlock,
  parseGenImageDirectives,
  genImageDirectiveKey,
  replaceGenImageDirectiveBlock,
  removeGenImageDirectiveBlock
} from '@shared/proposalGenImage'
import { fireGenImageDirective } from '../../lib/proposalGenImageFire'
import { GenImageDirectiveCard } from './GenImageDirectiveCard'
```

store 订阅（`imageReviews` 订阅旁，L166 附近）：

```ts
  // genimage 任务态：驱动指令块卡片的三态渲染（配图密度③）。
  const genImageJobs = useProposalStore((s) => s.genImageJobs)
```

块渲染循环（L871 `getBlocks(sec.markdown).map((blk, bi) => (`）里，在「编辑中 textarea / 普通块」的三元判断中插入 directive 分支——把现有：

```tsx
          {editingBlock && ... ? (
            <textarea ... />
          ) : (
            <div data-section-id={sec.id} data-block-index={bi} ...>
              <AssistantMarkdown text={blk} highlightCitations />
            </div>
          )}
```

改为（directive 卡不给 data-block-index——它不参与文字选区与点图交互；双击编辑对指令块无意义，走整节源码逃生舱即可）：

```tsx
          {editingBlock && editingBlock.sectionId === sec.id && editingBlock.blockIndex === bi ? (
            <textarea ... />
          ) : isGenImageDirectiveBlock(blk) ? (
            (() => {
              // occurrence：同内容指令块按块序数第几个（与 parseGenImageDirectives 的口径一致）。
              const secBlocks = getBlocks(sec.markdown)
              let occ = 0
              for (let k = 0; k < bi; k++) {
                if (secBlocks[k].trim() === blk.trim()) occ++
              }
              const content = parseGenImageBlock(blk)
              const key = genImageDirectiveKey(sec.id, blk.trim(), occ)
              return (
                <GenImageDirectiveCard
                  caption={content?.caption ?? '配图'}
                  job={genImageJobs[key]}
                  generating={generating}
                  onGenerate={() => {
                    if (!proposalSid || !content) return
                    void fireGenImageDirective(proposalSid, sec.id, {
                      ...content,
                      blockIndex: bi,
                      occurrence: occ,
                      raw: blk.trim()
                    })
                  }}
                  onOpenSettings={openImageApiSettings}
                />
              )
            })()
          ) : (
            <div data-section-id={sec.id} data-block-index={bi} ...（原样）>
              <AssistantMarkdown text={blk} highlightCitations />
            </div>
          )}
```

- [ ] **Step 3: applyImageReview 加 directive 分支**

`applyImageReview`（L355）在 `if (review.mode === 'generate') { … }` 之前插入：

```ts
    if (review.mode === 'directive') {
      // 应用 = 用生成图原地替换指令块。按内容键（directiveRaw+occurrence）定位而非 blockIndex
      // ——审阅悬而未决期间块序可能漂移（见 shared/proposalGenImage.ts 顶注）。找不到（用户手改
      // 了指令文本/已删）→ 与改图漂移同一立场：console.warn 留痕、摘卡不落地。
      if (!review.directiveRaw) {
        pstore.removeImageReview(review.id)
        return
      }
      const blocks = splitBlocks(sec.markdown)
      const { blocks: next, changed } = replaceGenImageDirectiveBlock(
        blocks,
        review.directiveRaw,
        review.directiveOccurrence ?? 0,
        `![${review.caption ?? '配图'}](${review.resultPath})`
      )
      if (changed) {
        pstore.updateSection(sec.id, joinBlocks(next))
      } else {
        console.warn('[proposal] 应用配图失败：指令块已不在本节（被手改或删除），已放弃', {
          reviewId: review.id,
          sectionId: review.sectionId
        })
      }
      pstore.removeImageReview(review.id)
      return
    }
```

- [ ] **Step 4: 丢弃分支——directive 连带删指令块**

现有 `discardImageReview(id: string)`（L410-412）改为接收整个 review：

```ts
  // 放弃：摘审阅项；directive 模式额外把指令块从草稿里删掉（spec：丢弃 = 删除整个指令块——
  // 指令已被用户明确否决，留着会反复渲染「已生成」卡造成状态错乱）。产出图文件留在磁盘（随
  // 草稿区一并清理，不即时删盘——既定策略，见原注释）。
  function discardImageReview(review: ImageReview): void {
    const pstore = useProposalStore.getState()
    if (review.mode === 'directive' && review.directiveRaw) {
      const sec = pstore.sections.find((s) => s.id === review.sectionId)
      if (sec) {
        const { blocks: next, changed } = removeGenImageDirectiveBlock(
          splitBlocks(sec.markdown),
          review.directiveRaw,
          review.directiveOccurrence ?? 0
        )
        if (changed) pstore.updateSection(sec.id, joinBlocks(next))
      }
    }
    pstore.removeImageReview(review.id)
  }
```

调用点同步：`renderReviewCard` 里 `onDiscard={() => discardImageReview(review.id)}` → `onDiscard={() => discardImageReview(review)}`。

- [ ] **Step 5: retryImageReview 保留 directive 字段**

`retryImageReview`（L434-470）：非 edit 模式已走 `proposalImageGenerate` 分支，无需改 IPC 调用；但重登记时补三个新字段——`pstore.addImageReview({ … occurrence: review.occurrence })` 改为：

```ts
      const id = pstore.addImageReview({
        sectionId: review.sectionId,
        blockIndex: review.blockIndex,
        sourcePath: review.sourcePath,
        resultPath: path,
        mode: review.mode,
        occurrence: review.occurrence,
        directiveRaw: review.directiveRaw,
        directiveOccurrence: review.directiveOccurrence,
        caption: review.caption
      })
```

同函数开头的守卫 `if (review.mode === 'edit' && !review.sourcePath)` 不动（directive 无源图，天然放行）。

- [ ] **Step 6: 聊天侧降级（AssistantMarkdown）**

`AssistantMarkdown.tsx` 的 `pre` override（L266，mermaid 判断之前）加：

```tsx
    // genimage 指令块（配图密度③）：编辑态由 ProposalPaper 拦成卡片，这里只兜聊天流里的显示
    // ——不渲染成代码卡（指令原文对用户是噪声），降级为一行提示。
    if (language === 'genimage') {
      return (
        <div className="my-2 rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
          已插入配图生成指令，将在右侧方案文档中自动生成并供你审阅。
        </div>
      )
    }
```

- [ ] **Step 7: typecheck + 全量测试**

Run: `cd apps/desktop && bun run typecheck && bun test src/`
Expected: 双 tsconfig 通过；全部 bun test 绿。

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/GenImageDirectiveCard.tsx apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx apps/desktop/src/renderer/src/components/workspace/proposalIcons.tsx apps/desktop/src/renderer/src/components/chat/AssistantMarkdown.tsx
git commit -m "feat(proposal): genimage 指令块卡片四态渲染+审阅应用/丢弃原地手术+聊天侧降级提示"
```

---

### Task 8: 收尾——全量验证 + 手工 GUI 走查清单

**Files:**
- 无新改动（验证任务）

- [ ] **Step 1: 全量自动化验证**

Run: `cd apps/desktop && bun run typecheck && bun test src/`
Expected: 全绿。任何红条先修复再继续（修复走各自 Task 的文件，不新开散修 commit）。

- [ ] **Step 2: 冒烟——dev 起应用手工走查**

Run: `cd apps/desktop && bun run dev`

走查清单（记录结果，逐条核对；生图需已在设置里配置出图 API）：

1. 新建方案会话生成正文：观察 AI 是否按新提示词多插库图（叶子小节配截图）、每个一级章至少一张 mermaid、总体架构章输出 genimage 指令块。
2. genimage 指令块出现后：卡片先转圈（正在生成），完成后下方出现审阅卡；点「应用」→ 指令块原地变成图片；点「丢弃」→ 指令块消失。
3. mermaid 图配色为品牌蓝彩色（编辑态 + 预览 + docx 导出三处一致）。
4. 未配置出图 API 时：指令块卡片显示错误 +「去设置」按钮，不阻塞正文生成。
5. 留一个未处理的指令块，分别导出 docx / PDF / md：三者均无 genimage 残留文本；预览里也不可见。
6. 「返回」→ 重开方案（reopen）与重启 app 后打开历史会话（restore）：指令块渲染成「生成这张图」手动卡，**不自动发起**；点按钮可手动生成。
7. 双击含指令块的节的其它块、选区即改：既有交互无回归（指令卡不参与选区）。

- [ ] **Step 3: 按全局规范归档**

把本次实现中踩的坑（如有）写进 Obsidian vault 的 errors/ 与 sessions/ 并互加双链；更新项目 memory（`proposal-tables-images-enhancement` 相关记忆补一条配图密度增强的交付状态）。

- [ ] **Step 4: 最终提交（若走查产生修复）**

```bash
git add -A && git commit -m "fix(proposal): 配图密度增强 GUI 走查修复"
```

---

## Self-Review 记录

- **Spec 覆盖**：①库图积极化 → Task 2；②Mermaid 密度+美化 → Task 2 + Task 3；③genimage 管线（语法/提示词/落节自动发起/幂等/restore 不自燃/卡片渲染/审阅应用丢弃/防御上限）→ Task 1/2/5/6/7；④导出剥除+校验兼容+测试 → Task 1/4（校验兼容：directive 落位后的 `![图说](路径)` 与既有 generate 落位同构，P 图功能已交付同路径，无新工作，走查项 5 覆盖）。
- **类型一致性**：`GenImageDirective{caption,prompt,blockIndex,occurrence,raw}`、`genImageDirectiveKey(sectionId, raw, occurrence)`、`GenImageJob{status,error}`、`ImageReview.mode='directive'+directiveRaw/directiveOccurrence/caption` 在 Task 1/5/6/7 间已逐一核对。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
