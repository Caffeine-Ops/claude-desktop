# 对话驱动写方案入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「写方案」第一步从单选产品选择器改成纯对话输入——用户用一句话说清「产品+章节结构+逐条标记」，AI 照办；发送时系统轻量匹配产品名收窄检索范围，识别结果以可删 chip 回显。

**Architecture:** 删掉 `ProductPickerDialog` 与写死的章节 Todos；点「写方案」卡直接激活方案模式并往 composer 预填引导模板。发送时渲染层用一个纯函数 `matchProducts` 对用户文本做产品名匹配，结果写进 `proposal` store 并随 `chat:send` 透传给 main；main 据此把命中产品的镜像子目录加进 `additionalDirectories` 并在方案系统提示词里点名（零命中则退回整个镜像根目录）。chip 在 `ProposalDocPanel` 顶部回显、可删。

**Tech Stack:** Electron + electron-vite（main/preload/renderer 三层）、React 19、zustand、assistant-ui、TypeScript composite、bun。

## Global Constraints

- 包管理器是 **bun**，不是 npm。命令：`bun run typecheck`（CI 唯一质量门，跑 `tsc -p node` + `tsc -p web`）、`bun run dev`。
- **本项目没有单元测试、没有 ESLint**。每个任务的验证闭环 = `bun run typecheck` 全绿 +（涉及运行时行为时）dev 下 CDP 9222 实测。唯一例外：纯函数 `matchProducts` 用一次性 `bun` 脚本做真实红绿验证。
- 改 IPC payload 形状要同步：`shared/ipc-channels.ts`（类型）→ main handler（`ipc/register.ts`）→ `engine.send`。本次扩的是**已有** `chat:send` 的可选字段，`preload/index.ts` 原样透传整个 payload、`preload/index.d.ts` 只声明 `chatApi: ChatApi`，**这两处无需改**。
- 主进程改动（engine/ipc/preload/main）HMR 不热更，dev 实测前必须重启 `bun run dev`；渲染层改动热更。
- 不变量（勿动）：会话 `cwd` 不可改，知识库靠 `additionalDirectories` + 提示词告知绝对路径；`canUseTool` 用闭包 `sessionId`；`forkSession: false`；方案模式按 `sessionId` 隔离（`ps.active && ps.sessionId === targetSid` 才透传）。
- `buildProposalAppend` 必须保持纯函数、无副作用（同输入同输出，不破坏上游 `cache_control` 断点）。
- app dev 当前 `permissionMode=bypassPermissions`；dev userData = `~/Library/Application Support/@claude-desktop/desktop`，索引在 `<userData>/kb-index/index.json`，镜像结构 `<userData>/kb-index/<产品线>/<产品>/<标题>.md`。

---

### Task 1: 产品名匹配纯函数 `matchProducts`

新增一个无副作用、可独立测试的纯函数：输入用户文本 + 知识库索引，输出去重的 `{productLine, product}` 命中集。召回优先（误配代价低、漏配有整库兜底）。

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/kbProductMatch.ts`
- Verify (throwaway, 不提交): `scratch/verify-kbProductMatch.ts`

**Interfaces:**
- Consumes: `KbIndex`、`KbIndexFile`（`apps/desktop/src/shared/kbIndex.ts`，已存在，字段 `productLine: string`、`product: string`）。
- Produces:
  - `export interface MatchedProduct { productLine: string; product: string }`
  - `export function matchProducts(text: string, index: KbIndex | null): MatchedProduct[]`

- [ ] **Step 1: 写纯函数实现**

Create `apps/desktop/src/renderer/src/lib/kbProductMatch.ts`：

```ts
import type { KbIndex } from '@shared/kbIndex'

export interface MatchedProduct {
  productLine: string
  product: string
}

// 用户文本里产品名之间的分隔符：中英文顿号/逗号/分号、空白、数字、换行。
// 数字也算分隔，是为了切掉「1 系统功能概述」里的序号，让「系统功能概述」成 token。
const TOKEN_SPLIT = /[、，,；;\s\d\r\n]+/

/**
 * 从用户的一段自然语言需求里，匹配出知识库里实际存在的产品。
 *
 * 召回优先（recall-first）：宁可多命中也不漏——多命中只是多给 AI 一个可读
 * 目录、提示词多点一个名，AI 仍按用户文字写，且 chip 可删；漏命中则有「整库
 * 兜底 + AI 自行 Grep」。所以匹配错误代价低，倾向宽松。
 *
 * 纯函数：同输入同输出，无副作用、不读全局。
 */
export function matchProducts(text: string, index: KbIndex | null): MatchedProduct[] {
  if (!index || !text) return []

  // 1) 从索引抽出所有 distinct {productLine, product}（product 非空——空 product
  //    是产品线级文档，不作为可选产品）。
  const candidates: MatchedProduct[] = []
  const seen = new Set<string>()
  for (const f of index.files) {
    if (!f.product) continue
    const key = `${f.productLine}\u0000${f.product}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ productLine: f.productLine, product: f.product })
  }

  // 2) 把用户文本切成 token（长度 ≥2 才算，避免单字误命中）。
  const tokens = text.split(TOKEN_SPLIT).filter((t) => t.length >= 2)

  // 3) 命中规则：用户文本整体包含产品全名（如文本「导诊系统」含目录名），
  //    或某个 token 是产品名的子串（如 token「导诊」⊂ 产品「导诊系统」）。
  const out: MatchedProduct[] = []
  const outKeys = new Set<string>()
  for (const c of candidates) {
    const hit = text.includes(c.product) || tokens.some((tok) => c.product.includes(tok))
    if (!hit) continue
    const key = `${c.productLine}\u0000${c.product}`
    if (outKeys.has(key)) continue
    outKeys.add(key)
    out.push(c)
  }
  return out
}
```

- [ ] **Step 2: 写一次性验证脚本（先让它失败）**

Create `scratch/verify-kbProductMatch.ts`（`import type` 在 bun 下被擦除，不会去解析 `@shared` 别名，故可独立跑）：

```ts
import { matchProducts } from '../apps/desktop/src/renderer/src/lib/kbProductMatch'

const index = {
  version: 1 as const,
  kbRoot: '/kb',
  builtAtMs: 0,
  files: [
    { sourcePath: '', mirrorPath: '', productLine: '智慧医疗', product: '导诊系统', title: 't', mtimeMs: 0, sha1: '', assets: [], ok: true },
    { sourcePath: '', mirrorPath: '', productLine: '智慧医疗', product: '预问诊系统', title: 't', mtimeMs: 0, sha1: '', assets: [], ok: true },
    { sourcePath: '', mirrorPath: '', productLine: '智慧医疗', product: '影像分析', title: 't', mtimeMs: 0, sha1: '', assets: [], ok: true },
    { sourcePath: '', mirrorPath: '', productLine: '产品线A', product: '', title: 't', mtimeMs: 0, sha1: '', assets: [], ok: true }
  ]
}

function eq(label: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  console.log(a === b ? `PASS ${label}` : `FAIL ${label}\n  got=${a}\n  want=${b}`)
  if (a !== b) process.exitCode = 1
}

// 口语化简称命中（「导诊」「预问诊」⊂ 目录全名），按出现顺序、只命中提到的两个。
eq('简称命中两个产品',
  matchProducts('导诊、预问诊两个产品，内容分三部分写', index).map((m) => m.product),
  ['导诊系统', '预问诊系统'])

// 序号行不误命中：「1 系统功能概述」不应命中任何产品。
eq('序号/无关词不误命中',
  matchProducts('1 系统功能概述 2 系统功能架构', index).map((m) => m.product),
  [])

// 空文本 / null index → 空。
eq('空文本返回空', matchProducts('', index), [])
eq('null 索引返回空', matchProducts('导诊', null), [])

// 全名命中。
eq('全名命中',
  matchProducts('请写预问诊系统', index).map((m) => m.product),
  ['预问诊系统'])
```

Run: `bun scratch/verify-kbProductMatch.ts`
Expected（实现已写好，应 PASS；若先 stub 空函数则此步先 FAIL，符合 TDD 红绿）：5 行全 `PASS`，退出码 0。

- [ ] **Step 3: 跑验证脚本确认全绿**

Run: `bun scratch/verify-kbProductMatch.ts`
Expected: 5 行 `PASS ...`，无 `FAIL`。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 通过（`@shared/kbIndex` 别名在 web 工程已配）。

- [ ] **Step 5: 删验证脚本并提交**

```bash
rm scratch/verify-kbProductMatch.ts
git add apps/desktop/src/renderer/src/lib/kbProductMatch.ts
git commit -m "feat(proposal): 新增产品名轻量匹配纯函数 matchProducts"
```

---

### Task 2: 渲染层切换——store 改数组 + 卡片改预填 + 删选择器/章节模板

把「选产品」UI 彻底换成「对话预填」。改动必须一次做完才能保持 typecheck 绿（store 签名变 + 其唯一消费者 `ScenarioQuickStart` 同改）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`（全文重写）
- Modify: `apps/desktop/src/renderer/src/components/chat/ScenarioQuickStart.tsx`（去 dialog/todos/template，加 `onStartProposal`）
- Modify: `apps/desktop/src/renderer/src/i18n.ts:132-133` 与 `:375-376`（`scenarioProposalPrompt` 改引导模板，CN+EN）
- Delete: `apps/desktop/src/renderer/src/components/dialogs/ProductPickerDialog.tsx`
- Delete: `apps/desktop/src/renderer/src/constants/proposalTemplates.ts`

**Interfaces:**
- Consumes: `useComposerRuntime`、`useChatStore`（已有）。
- Produces（后续任务依赖）：
  - `export interface ProposalProduct { productLine: string; product: string }`
  - store: `products: ProposalProduct[]`、`start(sessionId: string): void`、`setProducts(products: ProposalProduct[]): void`、`active`、`sessionId`、`setDoc`、`reset`、`docMarkdown`（保留）。

- [ ] **Step 1: 重写 proposal store**

Replace 全文 `apps/desktop/src/renderer/src/stores/proposal.ts`：

```ts
import { create } from 'zustand'

export interface ProposalProduct {
  productLine: string
  product: string
}

interface ProposalState {
  active: boolean
  // 方案绑定的会话 ID——只有该 session 的 send 才带 proposalMode=true，
  // 只有该 session 的 end 事件输出才被累积进 docMarkdown。
  // null 表示当前没有活跃方案会话。
  sessionId: string | null
  // 本次方案识别到的产品集（可空）。发送时由 matchProducts 写入，chip 删除时更新。
  // 收窄检索范围用：空 = 退回整个镜像根目录由 AI 自行 Grep 定位。
  products: ProposalProduct[]
  docMarkdown: string
  start: (sessionId: string) => void
  setProducts: (products: ProposalProduct[]) => void
  setDoc: (md: string) => void
  reset: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  active: false,
  sessionId: null,
  products: [],
  docMarkdown: '',
  start: (sessionId) => set({ active: true, sessionId, products: [], docMarkdown: '' }),
  setProducts: (products) => set({ products }),
  setDoc: (md) => set({ docMarkdown: md }),
  reset: () => set({ active: false, sessionId: null, products: [], docMarkdown: '' })
}))
```

- [ ] **Step 2: 改 i18n 引导模板（CN）**

`apps/desktop/src/renderer/src/i18n.ts:132-133`，把 `scenarioProposalPrompt` 整条替换为：

```ts
    scenarioProposalPrompt:
      '要写的产品：\n内容分几部分写：\n1. \n2. \n3. \n（哪部分要一条条介绍，就在该部分后面标注「一条条介绍」）',
```

- [ ] **Step 3: 改 i18n 引导模板（EN）**

`apps/desktop/src/renderer/src/i18n.ts:375-376`，替换为：

```ts
    scenarioProposalPrompt:
      'Products to cover: \nSections to write:\n1. \n2. \n3. \n(Mark any section that should be itemized with "list one by one")',
```

- [ ] **Step 4: 重写 ScenarioQuickStart——去依赖、加 onStartProposal**

在 `apps/desktop/src/renderer/src/components/chat/ScenarioQuickStart.tsx`：

(a) 删 3 个 import（第 5、7、9 行）：
```ts
import { ProductPickerDialog } from '../dialogs/ProductPickerDialog'
import { useTodosStore } from '../../stores/todos'
import { PROPOSAL_TEMPLATE } from '../../constants/proposalTemplates'
```

(b) `proposal` 卡的注释（第 86-92 行 `promptKey is not used...` 那段）替换为：
```ts
    // 点击这张卡不再弹产品选择器，而是直接激活方案模式 + 把引导模板预填进
    // composer（见 onStartProposal）。scenarioProposalPrompt 现在就是那段引导模板。
    promptKey: 'scenarioProposalPrompt'
```

(c) 删组件内三处（第 104 行 `pickerOpen` state、第 111 行 `setTodos`）：
```ts
  const [pickerOpen, setPickerOpen] = useState(false)
```
```ts
  const setTodos = useTodosStore((s) => s.setTodos)
```
若 `useState` 不再被使用，把第 1 行 `import { useCallback, useState } from 'react'` 改为 `import { useCallback } from 'react'`。

(d) 把 `onPickProduct`（第 143-176 行整段，连同上面的注释块）替换为：
```ts
  // 点「写方案」卡：直接激活方案模式（绑定当前前台 sessionId），把引导模板
  // 预填进 composer，聚焦编辑器。不再弹任何选择器——产品由用户在对话里说，
  // 发送时由 matchProducts 识别（见 FusionRuntimeProvider）。
  // activeSessionId 为 '' 说明还没有 session，此时本就不应触发方案；透传 '' 无害，
  // FusionRuntimeProvider 的门控（ps.sessionId === targetSid）会天然排掉它。
  const onStartProposal = useCallback(() => {
    startProposal(activeSessionId)
    composer.setText(t('scenarioProposalPrompt'))
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>('.ProseMirror')
      el?.focus()
    })
  }, [activeSessionId, composer, startProposal, t])
```
注意：`startProposal` 现在签名是 `(sessionId)`，上面调用已对齐。

(e) 卡片 onClick（第 191-195 行）改为：
```ts
              onClick={
                card.key === 'proposal'
                  ? onStartProposal
                  : () => onPickScenario(card.promptKey)
              }
```

(f) 删 return 末尾的 `<ProductPickerDialog .../>`（第 219-223 行）。若删后最外层只剩一个 `<div>`，把包裹的 `<>...</>` Fragment 去掉直接返回该 `<div>`（保留也可，typecheck 不报错——优先去掉以保持整洁）。

- [ ] **Step 5: 删两个文件**

```bash
git rm apps/desktop/src/renderer/src/components/dialogs/ProductPickerDialog.tsx
git rm apps/desktop/src/renderer/src/constants/proposalTemplates.ts
```

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: 通过。若报 `ProductPickerDialog`/`PROPOSAL_TEMPLATE`/`useState`/`setTodos` 未使用或找不到，回到 Step 4 检查遗漏的引用。

- [ ] **Step 7: 确认无残留引用并提交**

Run: `grep -rn "ProductPickerDialog\|PROPOSAL_TEMPLATE\|proposalTemplates" apps/desktop/src`
Expected: 无输出。

```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts apps/desktop/src/renderer/src/components/chat/ScenarioQuickStart.tsx apps/desktop/src/renderer/src/i18n.ts
git commit -m "feat(proposal): 写方案卡改纯对话预填，删产品选择器与写死章节模板"
```

---

### Task 3: main 侧——IPC payload 扩展 + engine 收窄 + 提示词升级

让 main 收到识别到的产品集，按它收窄 `additionalDirectories` 并在系统提示词里点名；零命中退回整库。全部是 main 侧、可选字段、向后兼容。

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts:520-540`（`ChatSendPayload` 加 `proposalProducts?`）
- Modify: `apps/desktop/src/main/ipc/register.ts:244-249`（handler 透传）
- Modify: `apps/desktop/src/main/core/engine.ts`（`send` 签名 + 字段 + 辅助方法 + openSession + warm-spawn）
- Modify: `apps/desktop/src/main/core/proposalPrompt.ts`（`buildProposalAppend` 加第二参 + 内容升级）

**Interfaces:**
- Consumes: `ProposalProduct` 概念（结构 `{productLine: string; product: string}`，此处就地内联同形结构，不跨 main/renderer import store）。`kbOutDir()`（`kbIndexStore`，已 import）、`join`（`node:path`）。
- Produces:
  - `ChatSendPayload.proposalProducts?: readonly { productLine: string; product: string }[]`
  - `engine.send(sessionId, text, images?, proposalMode?, proposalProducts?)`
  - `buildProposalAppend(mirrorDir: string, productDirs?: string[]): string`

- [ ] **Step 1: `ChatSendPayload` 加可选字段**

`apps/desktop/src/shared/ipc-channels.ts`，在第 539 行 `proposalMode?: boolean` 之后、第 540 行 `}` 之前插入：

```ts
  /**
   * 方案模式下识别到的产品集（{productLine, product}）。渲染层在 send 时用
   * matchProducts 对用户文本匹配后透传。main 据此把这些产品的镜像子目录加进
   * additionalDirectories 并在方案提示词里点名，收窄检索范围。
   * 缺省/空数组 = 未识别到 → main 退回整个镜像根目录由 AI 自行 Grep 定位。
   */
  proposalProducts?: readonly { productLine: string; product: string }[]
```

- [ ] **Step 2: handler 透传 proposalProducts**

`apps/desktop/src/main/ipc/register.ts:244-249`，把 `engine.send(...)` 调用替换为：

```ts
      return await engine.send(
        payload.sessionId,
        payload.text,
        images,
        payload?.proposalMode === true,
        // 防御：只接受数组形状，过滤畸形 renderer payload。
        Array.isArray(payload?.proposalProducts) ? payload.proposalProducts : undefined
      )
```

- [ ] **Step 3: engine 加 proposalProducts 字段**

`apps/desktop/src/main/core/engine.ts` 第 479 行 `private proposalMode = false` 之后新增：

```ts
  // 本次 turn 识别到的产品集（send() 写入，openSession/warm-spawn 读取）。
  // 空 = 未识别 → 检索范围退回整个镜像根目录。与 proposalMode 同生命周期。
  private proposalProducts: readonly { productLine: string; product: string }[] = []
```

- [ ] **Step 4: engine 加辅助方法 proposalProductDirs**

在 `engine.ts` 同一个 class 内（紧挨上面的字段或 send 方法附近）新增私有方法：

```ts
  // 把识别到的产品映射成镜像子目录绝对路径：<kbOutDir>/<产品线>/<产品>。
  // 镜像目录结构由阶段 A 索引器固定（见 build-kb-index.ts）。
  private proposalProductDirs(): string[] {
    const root = kbOutDir()
    return this.proposalProducts.map((p) => join(root, p.productLine, p.product))
  }
```

确认 `join` 已 import：Run `grep -n "from 'node:path'\|from \"node:path\"" apps/desktop/src/main/core/engine.ts`。若 `join` 不在其中，把该 import 补上 `join`（如 `import { join, dirname } from 'node:path'`）。

- [ ] **Step 5: engine.send 签名加第五参并写入字段**

`engine.ts:888-898`，把 `send` 头部改为：

```ts
  async send(
    sessionId: string,
    text: string,
    images?: readonly ChatImagePayload[],
    proposalMode = false,
    proposalProducts: readonly { productLine: string; product: string }[] = []
  ): Promise<{ messageId: string }> {
    // Record the proposal-mode intent for THIS turn BEFORE anything below
    // can trigger a spawn (ensureSessionReady → openSession reads it). Set
    // unconditionally so leaving proposal mode also takes effect on the
    // next fresh spawn. See the field doc for the "next spawn" semantics.
    this.proposalMode = proposalMode
    this.proposalProducts = proposalProducts
```

- [ ] **Step 6: warm-spawn grounding 带上产品目录**

`engine.ts:1010-1013`，把 `groundedText` 改为：

```ts
    const groundedText =
      proposalMode && !runtime.spawnedWithProposal
        ? `${buildProposalAppend(kbOutDir(), this.proposalProductDirs())}\n\n---\n\n${text}`
        : text
```

- [ ] **Step 7: openSession 收窄 additionalDirectories + 提示词带目录**

`engine.ts:1245-1249`，改为：

```ts
    const proposalActive = this.proposalMode
    const mirrorDir = kbOutDir()
    const productDirs = this.proposalProductDirs()
    const systemPromptAppend = proposalActive
      ? `${baseChineseAppend}\n\n${buildProposalAppend(mirrorDir, productDirs)}`
      : baseChineseAppend
```

`engine.ts:1287`，把 additionalDirectories 那行改为：

```ts
      ...(proposalActive
        ? { additionalDirectories: productDirs.length > 0 ? productDirs : [mirrorDir] }
        : {}),
```

- [ ] **Step 8: 升级 buildProposalAppend**

Replace 全文 `apps/desktop/src/main/core/proposalPrompt.ts` 的 `buildProposalAppend` 函数（保留文件顶部的长注释块，仅改函数体与签名）：

```ts
export function buildProposalAppend(mirrorDir: string, productDirs: string[] = []): string {
  const scope =
    productDirs.length > 0
      ? `1. 公司知识库的文本镜像在目录：${mirrorDir}。本次用户要写的产品资料分别在：\n${productDirs
          .map((d) => `   - ${d}`)
          .join('\n')}\n撰写任何内容前，先用 Grep/Glob/Read 优先在这些产品目录内检索，只依据检索到的原文撰写。`
      : `1. 公司知识库的文本镜像在目录：${mirrorDir}。用户会在对话里说明要写哪些产品；撰写任何内容前，先用 Grep/Glob 在该镜像目录内定位对应产品，再 Read 检索原文，只依据检索到的原文撰写。`
  return [
    '【方案写作模式】你正在帮用户撰写商业建设方案。严格遵守以下纪律：',
    scope,
    '2. 绝不使用你自身的知识或想象来填补内容。知识库里查不到的，明确写「⚠️ 资料缺失：<缺什么>」，不要编造。',
    '3. 每写完一段，标注来源文件，格式：（据《<文件名>》）。',
    '4. 用户会用自然语言告诉你内容分哪几部分、各部分写什么、哪部分要「一条条介绍」。严格按用户给的部分与顺序组织，不自行增删章节；标注「一条条介绍」「逐条」的部分要逐条列举（每条：小标题 + 该条内容 + 来源），不要并成一段。',
    '5. 一次聚焦一个部分，先问用户该部分的关键要点，再起草。',
    '6. 全程中文。'
  ].join('\n')
}
```

- [ ] **Step 9: typecheck**

Run: `bun run typecheck`
Expected: 通过（node + web 两个工程都绿）。

- [ ] **Step 10: 提交**

```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/main/ipc/register.ts apps/desktop/src/main/core/engine.ts apps/desktop/src/main/core/proposalPrompt.ts
git commit -m "feat(proposal): main 侧按识别产品收窄镜像检索范围+提示词点名目录"
```

---

### Task 4: 发送时跑匹配并透传产品集

在渲染层 send 处接上 matcher：方案首发时对用户文本匹配产品、写进 store 持久化（后续 turn 复用 + chip 删除生效），并随 payload 透传。

**Files:**
- Modify: `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（import + send 块，约第 19、432-449 行）

**Interfaces:**
- Consumes: `matchProducts`（Task 1）、`useProposalStore` 的 `products`/`setProducts`/`active`/`sessionId`（Task 2）、`ChatSendPayload.proposalProducts`（Task 3）、`window.chatApi.readKbIndex()`（已有，返回 `KbIndex | null`）。
- Produces: 给 main 的 `chat:send` payload 携带 `proposalProducts`。

- [ ] **Step 1: 加 import**

`FusionRuntimeProvider.tsx`，在第 19 行 `import { useProposalStore } from '../stores/proposal'` 之后新增（`ProposalProduct` 用 `import type`）：

```ts
import type { ProposalProduct } from '../stores/proposal'
import { matchProducts } from '../lib/kbProductMatch'
```

- [ ] **Step 2: send 前算出 proposalProducts**

`FusionRuntimeProvider.tsx`，在第 432 行 `try {` 之后、`await window.chatApi.send({` 之前插入：

```ts
        // 方案模式：门控同 proposalMode——只有当前发送的 targetSid 与方案绑定
        // 的 sessionId 相同才算（防泄漏到其他 tab / 后台 agent）。
        const ps = useProposalStore.getState()
        const isProposal = ps.active && ps.sessionId === targetSid
        let proposalProducts: ProposalProduct[] | undefined
        if (isProposal) {
          if (ps.products.length === 0) {
            // 方案首发：对用户文本匹配产品播种产品集，并持久化——后续 turn（逐部分
            // 推进）复用这套已确认的集合，chip 删除也据此生效。召回优先：多命中无害
            // （多一个可读目录，AI 仍按用户文字写），可在 ProposalDocPanel 的 chip 删。
            const idx = await window.chatApi.readKbIndex()
            const matched = matchProducts(text, idx)
            if (matched.length > 0) useProposalStore.getState().setProducts(matched)
            proposalProducts = matched
          } else {
            proposalProducts = ps.products
          }
        }
```

- [ ] **Step 3: 把 payload 的 proposalMode 块替换为透传两字段**

把第 433-449 行 `await window.chatApi.send({ ... proposalMode: (() => {...})() })` 整块替换为：

```ts
        await window.chatApi.send({
          sessionId: targetSid,
          // Engine validator accepts empty strings when images are present.
          // We still pass an empty string (not undefined) so the wire
          // shape stays stable.
          text: text,
          images: images.length > 0 ? images : undefined,
          // 方案模式：透传给 engine，本次 spawn 据此烘焙方案系统提示词 +
          // 把识别产品的镜像子目录加进可读范围（零命中退回整库）。
          proposalMode: isProposal,
          proposalProducts
        })
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(proposal): 发送时匹配产品名并随 send 透传，首发播种后续复用"
```

---

### Task 5: ProposalDocPanel 顶部产品 chip 回显（可删）

在已有的方案草稿面板顶部展示识别到的产品 chip，可逐个删除（更新 store，影响后续 turn）。选这里而非 composer 区，是因为该面板本就只在 `proposal.active` 时渲染，且不必动 `ThreadView` 内部。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`

**Interfaces:**
- Consumes: `useProposalStore` 的 `products`、`setProducts`（Task 2）。

- [ ] **Step 1: 取 products/setProducts**

`ProposalDocPanel.tsx`，在第 7 行 `const setDoc = useProposalStore((s) => s.setDoc)` 之后新增：

```ts
  const products = useProposalStore((s) => s.products)
  const setProducts = useProposalStore((s) => s.setProducts)
```

- [ ] **Step 2: 在标题栏与正文之间插入 chip 条**

`ProposalDocPanel.tsx`，在标题栏那个 `</div>`（第 19 行）之后、正文 `<div className="flex-1 overflow-auto ...">`（第 26 行）之前插入：

```tsx
      {/* 识别到的产品 chip：方案首发时由 matchProducts 写入。可删——删除即从
          store 移除，后续 turn 不再把它列入可读目录（召回优先下用于纠误配）。
          空集时提示 AI 会自行在知识库定位（整库兜底）。 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 px-3 py-1.5">
        {products.length === 0 ? (
          <span className="text-[11px] text-neutral-500">未识别到产品，AI 将自行在知识库定位</span>
        ) : (
          products.map((p) => (
            <span
              key={`${p.productLine}\u0000${p.product}`}
              className="inline-flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-200"
            >
              {p.product}
              <button
                type="button"
                aria-label={`移除 ${p.product}`}
                className="text-neutral-500 hover:text-neutral-200"
                onClick={() =>
                  setProducts(
                    products.filter(
                      (x) => !(x.productLine === p.productLine && x.product === p.product)
                    )
                  )
                }
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx
git commit -m "feat(proposal): 方案面板顶部回显识别到的产品 chip，可删纠错"
```

---

### Task 6: dev 端到端实测 + 收尾

把全链路在 dev 跑通，对照验收标准逐条确认。无单测，靠 CDP 实测。

**Files:** 无代码改动（除非实测暴露 bug，回对应 Task 修）。

- [ ] **Step 1: 重启 dev（main 改过，必须重启）**

Run: `bun run dev`
Expected: app 起来，dev 后端 = system claude，CDP 端口 9222 可用。

- [ ] **Step 2: 验收①——卡片不弹 dialog、预填模板**

操作：开一个 thread，点左栏「写方案」卡。
Expected: 不弹任何对话框；composer 里出现引导模板（「要写的产品：…」多行），焦点在编辑器。
注意：assistant-ui 的 `composer.setText` 若把 `\n` 折叠成单行，模板会挤成一行——此时把 i18n 模板（Task 2 Step 2/3）改成单行引导句（如「写哪些产品、分几部分、哪部分一条条介绍，请在这里描述」），重跑本步。

- [ ] **Step 3: 验收②——发送范本，产品识别 + 收窄 + 守纪律**

操作：把 composer 内容改成（按库内真实产品名）类似：
```
导诊、预问诊两个产品
内容分三部分写：
1 系统功能概述
2 系统功能架构
3 系统功能（一条条介绍）
```
发送。
Expected：
- 右侧方案面板顶部出现 chip：识别到的产品（如「导诊系统」「预问诊系统」）。
- AI 按三部分结构写、第 3 部分逐条、每段标来源、查不到标「⚠️ 资料缺失」。
- 验证收窄生效：CDP 控制台或 main 日志确认 spawn 的 `additionalDirectories` 是这两个产品子目录（非整库）。可在 `engine.ts` openSession 临时 `console.log(productDirs)` 观察后删除，或用 CDP 看 send payload 的 `proposalProducts`。

- [ ] **Step 4: 验收③——删 chip 生效**

操作：点某个产品 chip 的 ✕。
Expected：该 chip 消失；store.products 少一个；下一条 send 的 payload `proposalProducts` 不再含它。

- [ ] **Step 5: 验收④——零命中兜底**

操作：新开 thread → 点写方案卡 → 发一段不含任何库内产品名的话（如「随便写个通用方案」）。
Expected：不阻塞发送；面板 chip 区显示「未识别到产品…」；AI 仍能在镜像目录 Grep 定位（additionalDirectories 退回整库 `[mirrorDir]`）。

- [ ] **Step 6: 验收⑤——静态门 + 无残留**

Run: `bun run typecheck`
Expected: 全绿。

Run: `grep -rn "ProductPickerDialog\|PROPOSAL_TEMPLATE\|proposalTemplates" apps/desktop/src`
Expected: 无输出。

- [ ] **Step 7: 收尾提交（若 Step 3 加过临时日志，确认已删）**

```bash
git status   # 确认无未提交的临时调试代码
```
如全部干净且前 5 个 commit 已落，本任务无需额外 commit；若实测改了代码，按所属 Task 的 commit message 风格提交。

---

## Self-Review

**Spec 覆盖：**
- 纯对话入口、删选择器 → Task 2。
- 自然语言「产品+结构+逐条」由 AI 照办 → Task 3 Step 8（提示词 rule 4）。
- 发送时轻量匹配 + 收窄 → Task 1（匹配）+ Task 4（发送时调用）+ Task 3（收窄 additionalDirectories/提示词）。
- chip 回显可删 → Task 5。
- 默认①砍写死章节 Todos → Task 2 Step 4（删 setTodos/PROPOSAL_TEMPLATE）。
- 默认②纠错只做删 → Task 5（只有 ✕，无补选 UI）。
- 默认③发送时匹配一次 → Task 4（首发匹配、后续复用，无实时匹配）。
- warm-spawn 收窄沿用注入 → Task 3 Step 6。
- 验收 5 条 → Task 6 全覆盖。

**类型一致性：** `matchProducts(text, index): MatchedProduct[]`（Task 1）；store `ProposalProduct`/`setProducts`/`start(sessionId)`（Task 2）；`ChatSendPayload.proposalProducts`/`engine.send` 第五参/`buildProposalAppend(mirrorDir, productDirs?)`（Task 3）——Task 4/5 的调用签名均与之对齐。`MatchedProduct` 与 `ProposalProduct` 是同形结构（`{productLine, product}`），Task 4 把 `matchProducts` 的返回（`MatchedProduct[]`）赋给 `ProposalProduct[]`——结构兼容，TS 结构化类型下通过。

**Placeholder 扫描：** 无 TBD/TODO；每个代码步骤均给完整代码与确切命令、预期输出。
