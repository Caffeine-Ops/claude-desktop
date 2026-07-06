# 方案写作·表格化呈现知识库数据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「写方案」在源料是结构化数据时用 GFM 表格组织正文，并保证表格不被召回切碎、不被引用校验误判、能导出成真 Word 表格。

**Architecture:** 表格管道已端到端支持（`proposalDocx.ts` 的 `case 'table'` 已产真 Word 表，markitdown 镜像里源表格也是 markdown 形态）。本计划只做三件事：① 提示词教 AI 按数据形态用表格；② 给 `chunkText` 加表格保形（大表不窗口硬切）；③ 用测试锁定「表格段引用校验判 supported」「含表格 markdown 走导出器不抛错」。

**Tech Stack:** TypeScript（composite：tsconfig.node + tsconfig.web）、bun（包管理 + `bun test`）、docx、remark/remark-gfm、unified。

## Global Constraints

- 包管理器与测试用 **bun**，不是 npm。测试脚本：`apps/desktop/package.json` 的 `"test": "bun test src/"`，命令在 `apps/desktop/` 下跑。
- 唯一质量门是 `bun run typecheck`（= `tsc -p node` + `tsc -p web`）；**无 ESLint、无既有 docx 单测**。每个 Task 收尾前 typecheck 必须过。
- `src/shared/` 是 main 与 renderer 共享的**纯函数**，不得引 fs/electron。本计划只动 `src/main/core/`（main 专属），不动 shared 的契约。
- `proposalDocx.ts` 的 `case 'table'`（现状已支持表格）**不要改**。
- 注释沿用仓库风格：解释「为什么这样而不是那样」，不只写做了什么。
- 全程中文文案。

---

### Task 1: 提示词——教 AI 按数据形态用表格

**Files:**
- Modify: `apps/desktop/src/main/core/proposalPrompt.ts`（`buildProposalAppend` 返回数组，在规则 3 之后插入新规则）
- Test: `apps/desktop/src/main/core/proposalPrompt.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `buildProposalAppend(mirrorDir: string, products?: ProposalProductScope[]): string`（签名不变）。
- Produces: `buildProposalAppend` 输出新增一条含「结构化数据用表格」纪律的文本；无新导出符号。

- [ ] **Step 1: Write the failing test**

新建 `apps/desktop/src/main/core/proposalPrompt.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test'

import { buildProposalAppend } from './proposalPrompt'

describe('buildProposalAppend 表格纪律', () => {
  it('输出包含「结构化数据用表格」纪律与接地约束', () => {
    const out = buildProposalAppend('/mirror', [])
    expect(out).toContain('结构化数据')
    expect(out).toContain('GFM markdown 表格')
    // 接地：表里只填查到的真值、空缺写「—」、绝不为凑表编造
    expect(out).toContain('绝不为凑满表格而编造数据')
  })

  it('保留既有「全程中文」收尾纪律（无回归）', () => {
    expect(buildProposalAppend('/mirror', [])).toContain('全程中文')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run（在 `apps/desktop/` 下）: `bun test src/main/core/proposalPrompt.test.ts`
Expected: FAIL — 第一个用例断言 `结构化数据` 不在输出中。

- [ ] **Step 3: Add the table rule**

在 `proposalPrompt.ts` 的 `buildProposalAppend` 返回数组里，找到规则 3 这一整段字符串（以 `'3. 【仅阶段三·正文适用】每写完一段正文` 开头、以 `会污染成品的封面页与目录页。'` 结尾），在它**之后**插入一个新数组元素：

```typescript
    // 表格化呈现：源料是结构化数据时用 GFM 表格，而非摊成散文。接地纪律与第 3 条同源——
    // 表里每个值都必须来自镜像原文，空缺写「—」而非编造（客户据此采购，编表与编文等害）。
    // 用表 vs 用段的判断权交给 AI（与「AI 自动、数据支持就用」一致），拿不准走 AskUserQuestion。
    '【正文·结构化数据用表格】当某节要呈现的源料是结构化数据（参数/规格、功能或方案对比、分项清单、实施/时间计划、报价或配置项等），用 GFM markdown 表格组织，不要摊成大段文字——表格更直观，也保留源料原本的结构。表头用源料里的字段名，单元格只填知识库查到的真值，查不到的留空或写「—」，绝不为凑满表格而编造数据。表格紧接的下一行仍按第 3 条标注（据《文件名》）来源。是否该用表格由你按源料形态判断；拿不准时用 AskUserQuestion 问用户（遵守提问纪律），不要默认堆成散文。',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/main/core/proposalPrompt.test.ts`
Expected: PASS（两个用例都过）。

- [ ] **Step 5: Typecheck + Commit**

Run（仓库根）: `bun run typecheck`
Expected: PASS。

```bash
git add apps/desktop/src/main/core/proposalPrompt.ts apps/desktop/src/main/core/proposalPrompt.test.ts
git commit -m "feat(proposal): 提示词教 AI 按数据形态用 GFM 表格（接地·只填真值）"
```

---

### Task 2: 召回保形——大表格不被窗口硬切

**Files:**
- Modify: `apps/desktop/src/main/core/proposalRetrieve.core.ts`（新增 `isTableBlock` 私有函数 + 改 `chunkText` 的超长块分支）
- Test: `apps/desktop/src/main/core/proposalRetrieve.core.test.ts`（在现有 `describe('chunkText', ...)` 里加用例）

**Interfaces:**
- Consumes: 现有 `chunkText(text: string): string[]`、常量 `CHUNK_MAX`（=600）。
- Produces: `chunkText` 行为变化——块 `≥ CHUNK_MAX` 且为 markdown 表格时整块保留（不再按 600 字窗口硬切）；非表格超长块行为不变。`isTableBlock` 为模块内私有、不导出。

- [ ] **Step 1: Write the failing test**

在 `apps/desktop/src/main/core/proposalRetrieve.core.test.ts` 的 `describe('chunkText', () => { ... })` 内追加：

```typescript
  it('大表格不被窗口硬切，整块保留且分隔行完好', () => {
    // markdown 表格行间无空行 → 本是一个 block；其长度远超 CHUNK_MAX，
    // 旧逻辑会按 600 字窗口硬切（劈碎行/单元格），新逻辑应整块保留。
    const header = '| 指标 | 数值 | 说明 |\n| --- | --- | --- |\n'
    const row = '| 某项目某项目 | 一二三四五六 | 这是一行较长的说明文字用于把表格撑过长度上限 |\n'
    const table = header + row.repeat(40) // 约 1800+ 字，远超 CHUNK_MAX
    const chunks = chunkText(table)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('| --- | --- | --- |')
  })

  it('超长非表格段仍按窗口硬切（无回归，分割线 --- 不算表格）', () => {
    // 纯 --- 分隔线无管道符，不应被当作表格；超长纯文本仍按窗口切。
    const long = '甲'.repeat(CHUNK_MAX + 50) + '\n\n---\n\n' + '乙'.repeat(CHUNK_MAX + 50)
    const chunks = chunkText(long)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })
```

> 注：测试文件顶部已 `import { tokenize, chunkText, rankChunks, CHUNK_MAX } from './proposalRetrieve.core'`，`CHUNK_MAX` 已在作用域内，无需改 import。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/main/core/proposalRetrieve.core.test.ts`
Expected: FAIL — 「大表格不被窗口硬切」用例得到多于 1 个 chunk（旧窗口切逻辑）。

- [ ] **Step 3: Implement table-aware guard**

在 `proposalRetrieve.core.ts` 的 `chunkText` 定义**之前**，新增私有函数：

```typescript
/**
 * 判定一个块是否为 GFM 表格：存在一行「分隔行」——只由 | : - 空白组成、含至少一段 ≥3 个
 * 连字符、且含管道符 `|`。要求含 `|` 是为把表格分隔行与普通水平分割线 `---`（thematicBreak，
 * 无管道符）区分开，后者不该被当表格、仍走窗口硬切。
 */
function isTableBlock(block: string): boolean {
  return block
    .split('\n')
    .some((line) => line.includes('|') && /^\s*\|?[\s|:-]*-{3,}[\s|:-]*\|?\s*$/.test(line))
}
```

再把 `chunkText` 里这段超长块分支：

```typescript
    if (b.length >= CHUNK_MAX) {
      flush()
      for (let i = 0; i < b.length; i += CHUNK_MAX) chunks.push(b.slice(i, i + CHUNK_MAX))
      continue
    }
```

改成：

```typescript
    if (b.length >= CHUNK_MAX) {
      flush()
      // 表格保形：大表整块保留，绝不按定长窗口硬切（那会把行/单元格/分隔行劈碎，召回片段
      // 里表格就不成形了）。代价是单个巨表块可能超 CHUNK_MAX——可接受：上游 retrievePassages
      // 还有 MAX_FILES / MAX_TOTAL_BYTES 兜注入预算，且巨表本就该整块呈现。
      if (isTableBlock(b)) chunks.push(b)
      else for (let i = 0; i < b.length; i += CHUNK_MAX) chunks.push(b.slice(i, i + CHUNK_MAX))
      continue
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/main/core/proposalRetrieve.core.test.ts`
Expected: PASS（新增两个用例 + 原有 chunkText/tokenize/rankChunks 用例全过）。

- [ ] **Step 5: Typecheck + Commit**

Run（仓库根）: `bun run typecheck`
Expected: PASS。

```bash
git add apps/desktop/src/main/core/proposalRetrieve.core.ts apps/desktop/src/main/core/proposalRetrieve.core.test.ts
git commit -m "fix(proposal): chunkText 表格保形——大表整块保留不窗口硬切"
```

---

### Task 3: 安全网测试——表格段引用校验 supported + 含表 markdown 走导出器不抛错

> 本 Task 预计**零生产代码改动**：表格段的 trigram 校验、含表 markdown 的 docx 导出都走现有路径。两条测试是回归护栏；若任一失败，即暴露了一处真问题，按 systematic-debugging 处理后再调代码（届时不在本计划预设的「无改动」范围内）。

**Files:**
- Test: `apps/desktop/src/main/core/proposalVerify.core.test.ts`（在现有 `describe('verifyCitationsCore', ...)` 里加用例）
- Test: `apps/desktop/src/main/core/proposalDocx.test.ts`（新建——冒烟测试）

**Interfaces:**
- Consumes: 现有 `verifyCitationsCore(markdown: string, lookup: (file: string) => string | null): SectionVerification`；现有 `markdownToDocxBuffer(markdown: string, style?: ProposalStyleConfig): Promise<Buffer>`。
- Produces: 无新符号，仅测试。

- [ ] **Step 1: Write the failing/guard tests**

在 `apps/desktop/src/main/core/proposalVerify.core.test.ts` 的 `describe('verifyCitationsCore', () => { ... })` 内追加：

```typescript
  it('表格段落与原文同款表格 → supported', () => {
    const tableMd =
      '| 模块 | 说明 |\n| --- | --- |\n| 分诊 | 智能分诊建议 |\n| 预问诊 | 多轮对话采集 |\n（据《白皮书》）'
    const mirror =
      '产品参数表：\n| 模块 | 说明 |\n| --- | --- |\n| 分诊 | 智能分诊建议 |\n| 预问诊 | 多轮对话采集 |\n以上为核心模块。'
    const r = verifyCitationsCore(tableMd, (f) => (f === '白皮书' ? mirror : null))
    expect(r.citedFileCount).toBe(1)
    expect(r.verdicts[0].status).toBe('supported')
  })
```

新建 `apps/desktop/src/main/core/proposalDocx.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test'

import { markdownToDocxBuffer } from './proposalDocx'

// 仓库无 zip 库、表格导出代码（case 'table'）本就存在未改，故这里只做冒烟：含 GFM 表格的
// 正文 markdown 过真实导出器不抛错、产出非空 docx（zip）。完整 <w:tbl> XML 断言需引 zip 库，
// 划到范围外（见 spec「不在本 spec」）。
describe('markdownToDocxBuffer 表格', () => {
  it('含 GFM 表格的正文不抛错、产出非空 docx', async () => {
    const md =
      '<!--proposal-section:content-->\n\n## 核心参数\n\n| 模块 | 说明 |\n| --- | --- |\n| 分诊 | 智能分诊建议 |\n\n（据《白皮书》）'
    const buf = await markdownToDocxBuffer(md)
    expect(buf.length).toBeGreaterThan(1000)
  })
})
```

- [ ] **Step 2: Run tests to verify status**

Run: `bun test src/main/core/proposalVerify.core.test.ts src/main/core/proposalDocx.test.ts`
Expected: 两条都 **PASS**（验证现有路径已支持表格）。
- 若 verify 用例 FAIL（表格段被判 unsupported）：说明 trigram 阈值对表格偏严，停下按 systematic-debugging 排查 `proposalVerify.core` / `trigramOverlap`，不要为过测试放水阈值。
- 若 docx 用例 FAIL（抛错）：说明含表 markdown 在导出器某处崩，停下排查 `proposalDocx` 的 `case 'table'` 路径。

- [ ] **Step 3: Typecheck + Commit**

Run（仓库根）: `bun run typecheck`
Expected: PASS。

```bash
git add apps/desktop/src/main/core/proposalVerify.core.test.ts apps/desktop/src/main/core/proposalDocx.test.ts
git commit -m "test(proposal): 表格段引用校验 supported + 含表 markdown 导出冒烟"
```

---

### 收尾：全量测试 + typecheck

- [ ] **Step 1: 全量 bun test**

Run（在 `apps/desktop/` 下）: `bun test src/`
Expected: 全绿，无回归。

- [ ] **Step 2: 全量 typecheck**

Run（仓库根）: `bun run typecheck`
Expected: PASS。

---

## Self-Review

**1. Spec coverage：**
- spec 组件 1（提示词教 AI 用表格）→ Task 1。✓
- spec 组件 2（召回保形）→ Task 2（落成「大表不窗口切」真改动；BM25 一项经查 `tokenize` 已丢弃 `|`/`-`，无需改，故计划未含——这是对 spec 的收紧，合理）。✓
- spec 组件 3（引用校验放行）→ Task 3 verify 用例。✓
- spec 组件 4（导出器不改）→ Task 3 docx 冒烟 + 全程不动 `case 'table'`。✓
- spec 组件 5（埋点不改）→ 计划无埋点改动，与 spec 一致。✓
- spec 测试 1–5：提示词(T1)、导出(T3 冒烟，XML 断言因无 zip 库降级并已在 spec 标注范围外)、召回保形(T2)、引用校验(T3)、纯文字回归(收尾全量 + T2 第二个用例护栏)。✓

**2. Placeholder scan：** 无 TBD/TODO/「类似上面」；每个代码步给了完整可粘贴代码与精确锚点。✓

**3. Type consistency：** `chunkText`/`CHUNK_MAX`/`verifyCitationsCore`/`markdownToDocxBuffer`/`buildProposalAppend` 的签名均与现有源文件一致（已读源核对）；`isTableBlock(block: string): boolean` 在 Task 2 定义并仅在 `chunkText` 内调用。✓

**已知降级（非缺口）：** docx 表格用「不抛错 + 非空 buffer」冒烟替代 `<w:tbl>` XML 断言，因仓库无 zip 解包库且表格导出代码未改；spec 已把完整 XML 断言列在范围外。
