# 方案三段式生成（封面 → 目录 → 正文）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把方案写作拆成「封面 → 目录 → 正文」三个有序、显式按钮门控的阶段，三段都落进可编辑的草稿，正文按已确认目录撰写。

**Architecture:** 路线 A「阶段隐式标记」——`proposal` store 增 `phase` 状态作单一真相源，哨兵块到达时按当前 `phase` 打 `kind`；阶段推进靠草稿面板按钮，按钮先推进 `phase`、再向 AI 发一条推进消息（复用 composer 的 send 路径）。系统提示词描述完整三阶段工作流（spawn 时烘焙、不可每轮变），实际转换由按钮消息驱动。

**Tech Stack:** Electron + React 19 + zustand + TypeScript（composite：tsconfig.node + tsconfig.web）。包管理器 **bun**。docx 库做 Word 导出。**无单元测试 / 无 ESLint**——`bun run typecheck` 是唯一自动门，UI 行为靠 dev（CDP 9222）手测。

## Global Constraints

- 包管理器是 **bun**，不是 npm。质量门只有一个：`bun run typecheck`（= `tsc -p node` + `tsc -p web`）。
- **底线：AI 写方案只用知识库、绝不臆想**；查不到标「⚠️ 资料缺失：<缺什么>」，分段标来源。改提示词不得削弱此纪律。
- 哨兵保持唯一一对：`PROPOSAL_DRAFT_BEGIN`=`===方案正文开始===`、`PROPOSAL_DRAFT_END`=`===方案正文结束===`（`shared/proposal.ts`）。三阶段共用同一对，靠 store.phase 区分 kind，**不另立哨兵**。
- IPC `renderProposal` / `exportProposal` 的 payload 形状不变（仍收单个 `markdown` 字符串）。
- 主进程改动需重启 dev（HMR 只热更渲染层）；渲染层改动热重载。
- 注释风格：高密度、解释「为什么这样而不是那样」，沿用既有风格。

## 文件结构（改动地图）

- `apps/desktop/src/shared/proposal.ts` —（改）新增 `ProposalKind` 类型、分页标记常量、`buildProposalMarkdown()` 拼接器。main 与 renderer 共享。
- `apps/desktop/src/renderer/src/stores/proposal.ts` —（改）`ProposalSection` 增 `kind`；store 增 `phase` + `advancePhase`；`appendSections` 按 phase 打 kind；`start`/`reset` 初始化 phase。
- `apps/desktop/src/main/core/proposalPrompt.ts` —（改）`buildProposalAppend` 重写为三阶段工作流提示词。
- `apps/desktop/src/main/core/proposalDocx.ts` —（改）识别分页标记 → 产真 `PageBreak`。
- `apps/desktop/src/renderer/src/lib/sendProposalStageMessage.ts` —（建）程序化发送一条方案推进消息，复用 composer 的 send 语义。
- `apps/desktop/src/renderer/src/components/workspace/ProposalPreview.tsx` —（改）改用 `buildProposalMarkdown`（带分页标记）。
- `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx` —（改）导出改用 `buildProposalMarkdown`；顶部加阶段条 + 推进按钮。
- `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx` —（改）sections 按 kind 分「封面/目录/正文」三区渲染。

---

### Task 1: shared 层 —— ProposalKind 类型、分页标记、markdown 拼接器

**Files:**
- Modify: `apps/desktop/src/shared/proposal.ts`

**Interfaces:**
- Produces:
  - `type ProposalKind = 'cover' | 'toc' | 'content'`
  - `const PROPOSAL_PAGEBREAK = '<!--proposal-pagebreak-->'`
  - `function buildProposalMarkdown(sections: Array<{ markdown: string; kind: ProposalKind }>, opts?: { pageBreaks?: boolean }): string`

- [ ] **Step 1: 在 `shared/proposal.ts` 顶部（哨兵常量之后）新增类型与分页标记**

在 `export const PROPOSAL_DRAFT_END = '===方案正文结束==='` 之后插入：

```ts
/**
 * 方案的三个生成阶段 / 三类草稿节。封面→目录→正文有序推进，每个哨兵块按其到达时的
 * 阶段打 kind（见 stores/proposal.ts appendSections）。放 shared 是因为 store（renderer）
 * 与 docx 拼接器都要用，避免两端各写一份漂移。
 */
export type ProposalKind = 'cover' | 'toc' | 'content'

/**
 * 导出/预览时插在 kind 边界的「分页」标记。单独成行时 remark 解析为一个块级 html 节点，
 * proposalDocx 识别它产出真 PageBreak（封面单独一页、目录单独一页、正文起新页）。
 * 用 html 注释而非 thematicBreak：注释在 .md 里不可见、在 docx 里被我们专门拦截，
 * 不会污染正文，也不和用户写的 `---` 分割线冲突。
 */
export const PROPOSAL_PAGEBREAK = '<!--proposal-pagebreak-->'
```

- [ ] **Step 2: 在文件末尾新增 `buildProposalMarkdown` 拼接器**

```ts
/**
 * 把分节草稿拼成单串 markdown，供「导出 Word」与「真预览」同源消费（两处原先各自
 * `sections.map(s=>s.markdown).join('\n\n')`，现统一到此，保证预览=导出逐像素一致）。
 *
 * pageBreaks=true 时，在相邻节「kind 发生变化」的边界插入 PROPOSAL_PAGEBREAK——即
 * 封面→目录、目录→正文之间各一处分页（docx 渲染为真 PageBreak）。同 kind 的多节之间
 * 不插（正文各章连续排版）。pageBreaks=false（.md 导出）时纯空行拼接，不留任何标记。
 *
 * 纯函数，main 与 renderer 共享。空数组 → ''。
 */
export function buildProposalMarkdown(
  sections: Array<{ markdown: string; kind: ProposalKind }>,
  opts?: { pageBreaks?: boolean }
): string {
  const pageBreaks = opts?.pageBreaks ?? false
  const parts: string[] = []
  let prevKind: ProposalKind | null = null
  for (const sec of sections) {
    const md = sec.markdown.trim()
    if (!md) continue
    if (pageBreaks && prevKind !== null && sec.kind !== prevKind) {
      parts.push(PROPOSAL_PAGEBREAK)
    }
    parts.push(md)
    prevKind = sec.kind
  }
  return parts.join('\n\n').trim()
}
```

- [ ] **Step 3: 运行 typecheck**

Run: `bun run typecheck`
Expected: PASS（无新报错；本任务只加导出，无调用方变更）。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/shared/proposal.ts
git commit -m "feat(proposal): shared 层加 ProposalKind/分页标记/buildProposalMarkdown 拼接器"
```

---

### Task 2: store —— phase 状态 + section.kind + 按阶段打标签

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`

**Interfaces:**
- Consumes: `ProposalKind` from `@shared/proposal`（Task 1）。
- Produces:
  - `ProposalSection` 增 `kind: ProposalKind`
  - `ProposalState.phase: ProposalKind`（复用同一三值联合：cover/toc/content）
  - `advancePhase: (to: ProposalKind) => void`
  - `appendSections` 行为不变（签名不变），内部按当前 `phase` 给新节打 `kind`

- [ ] **Step 1: 引入 ProposalKind 并给 ProposalSection 加 kind**

文件顶部 import 区加：

```ts
import type { ProposalKind } from '@shared/proposal'
```

`ProposalSection` 接口加字段（在 `markdown` 之后）：

```ts
  // 该节属于哪个阶段（封面/目录/正文）。由 appendSections 按「该哨兵块到达时的
  // store.phase」打——阶段被按钮死锁、一次只有一个活跃，故不会错标。决定草稿分区
  // 渲染（ProposalPaper）与导出分页（buildProposalMarkdown）。
  kind: ProposalKind
```

- [ ] **Step 2: 在 ProposalState 接口加 phase 与 advancePhase**

在 `sections: ProposalSection[]` 之后加：

```ts
  // 当前生成阶段，封面→目录→正文有序推进，是给哨兵块打 kind 与驱动阶段条 UI 的
  // 单一真相源。start() 起为 'cover'。仅由 advancePhase 推进（草稿面板按钮调用，
  // 按钮先推进 phase 再给 AI 发推进消息，保证该轮哨兵输出落到对应区）。
  phase: ProposalKind
```

在 action 声明区（`appendSections` 附近）加：

```ts
  // 推进到目标阶段（cover→toc→content）。只改 phase，不动 sections——已生成的封面/
  // 目录节保持原 kind。按钮在调用本方法后另发推进消息给 AI。
  advancePhase: (to: ProposalKind) => void
```

- [ ] **Step 3: 实现里初始化 phase 并在 appendSections 打 kind**

`create<ProposalState>` 初始状态加 `phase: 'cover',`（在 `sections: [],` 附近）。

`start` 的 `set({...})` 里加 `phase: 'cover',`；`reset` 的 `set({...})` 里同样加 `phase: 'cover',`。

`appendSections` 实现改为读当前 phase 打 kind：

```ts
  appendSections: (messageId, blocks, truncated) =>
    set((s) => {
      if (s.consumedDraftIds.has(messageId)) return s
      const consumed = new Set(s.consumedDraftIds)
      consumed.add(messageId)
      // 按当前阶段打 kind：封面阶段的块=cover、目录阶段=toc、正文阶段=content。
      const kind = s.phase
      const added: ProposalSection[] = blocks.map((markdown) => ({
        id: crypto.randomUUID(),
        markdown,
        kind
      }))
      if (truncated) {
        added.push({ id: crypto.randomUUID(), markdown: truncated, kind, truncated: true })
      }
      return { sections: [...s.sections, ...added], consumedDraftIds: consumed }
    }),
```

在 action 实现区加 `advancePhase`：

```ts
  advancePhase: (to) => set({ phase: to }),
```

- [ ] **Step 4: 运行 typecheck**

Run: `bun run typecheck`
Expected: PASS。若报「`kind` 缺失」，是 Task 7 之外某处构造 ProposalSection 漏填——本任务内所有构造点（appendSections）都已带 kind，其余构造在后续任务，正常应只剩 appendSections。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts
git commit -m "feat(proposal): store 加 phase 状态与 section.kind，按阶段打标签"
```

---

### Task 3: 系统提示词 —— 三阶段工作流

**Files:**
- Modify: `apps/desktop/src/main/core/proposalPrompt.ts`

**Interfaces:**
- Consumes: 无新增。`buildProposalAppend(mirrorDir, products)` 签名不变。
- Produces: 改写后的提示词文本（纯函数，无副作用，同输入同输出——保持上游 cache_control 断点不变）。

- [ ] **Step 1: 重写 `buildProposalAppend` 的返回数组**

把 `return [ ... ].join('\n')` 整块替换为下面内容（`scope` 变量与 `renderProductBlock` 等保持不变，仅改数组里的纪律文案，把原「规则 3~6」扩成三阶段工作流 + 哨兵规则）：

```ts
  return [
    '【方案写作模式】你正在帮用户撰写要直接交付给客户的「售前/商业建设方案」。',
    '本功能的作用：把用户公司沉淀在知识库里的真实产品资料，按用户指定的结构组织、提炼成可对客交付的方案文稿。你的全部价值在于「忠实搬运 + 结构化呈现」，而不是创作内容——客户会据此做采购决策，任何编造都会造成实质损害。',
    '这份方案分三个阶段【有序】生成：① 封面 → ② 目录 → ③ 正文。用户会通过界面按钮发来「确认封面，生成目录」「确认目录，开始正文」之类的推进消息；只有收到推进消息才进入下一阶段。绝不自行跳阶段——封面阶段不要写目录或正文，目录阶段不要写正文。',
    '请严格遵守以下纪律：',
    scope,
    '【阶段一·封面】先向用户询问生成封面所需的关键信息：客户单位全称、方案主题/标题、落款单位与日期等；信息齐了再生成封面。封面通常含：方案标题、客户单位、编制单位、日期。把封面正文用下面第 6 条的哨兵包裹输出。',
    '【阶段二·目录】收到「确认封面」推进消息后，参考该产品在知识库里的资料结构与售前建设方案的常见章节（如：项目背景、需求分析、建设目标、总体方案设计、功能详述、实施计划、售后服务等），提出一份【章节目录大纲】（用有序列表逐章列出），同样用哨兵包裹。用户可能直接编辑目录，或用自然语言要你增删/调整章节——按用户修订重新输出目录，不自行发挥。',
    '【阶段三·正文】收到「确认目录，开始正文」推进消息后（消息里会带上已确认的目录），严格【按该目录逐章撰写正文】：章节标题与顺序以目录为准，不自行增删章节。一次聚焦一章；原文清晰、足以直接组织时可直接起草，不必逐段确认；只有该章关键要点确实不明确时，才先问用户再起草。用户标注「一条条介绍」「逐条」的部分要逐条列举（每条：小标题 + 该条内容），不要并成一段。',
    '2. 绝不使用你自身的知识或想象来填补内容。知识库里查不到的，明确写「⚠️ 资料缺失：<缺什么>」，不要编造。',
    `6. 当你产出某阶段要【收进方案文档】的正文（封面正文 / 目录大纲 / 某章正文）时，把这段正文单独用下面这对标记包起来，标记各自独立成行：\n${PROPOSAL_DRAFT_BEGIN}\n（这里是该部分的正文 markdown，含小标题）\n${PROPOSAL_DRAFT_END}\n只有包在这对标记之间的内容会被收进方案文档。你的提问、确认、思路说明、「资料缺失」提示一律【不要】加标记，让它们留在对话里。每完成一个部分就输出一个这样的标记块；同一条消息里可以有多个标记块。',
    '7. 全程中文。'
  ].join('\n')
```

> 说明：编号从原文的连续 1~6 调整为「阶段块 + 关键纪律编号」混排是有意的——三阶段块用中括号小标题更醒目，编号 2/6/7 保留是为延续既有「资料缺失/哨兵/中文」三条硬纪律的措辞，不必追求连号。

- [ ] **Step 2: 运行 typecheck**

Run: `bun run typecheck`
Expected: PASS（纯字符串函数，`PROPOSAL_DRAFT_BEGIN/END` 已 import，无新依赖）。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/core/proposalPrompt.ts
git commit -m "feat(proposal): 系统提示词改写为封面→目录→正文三阶段工作流"
```

---

### Task 4: docx 导出 —— 分页标记产出真 PageBreak

**Files:**
- Modify: `apps/desktop/src/main/core/proposalDocx.ts`

**Interfaces:**
- Consumes: `PROPOSAL_PAGEBREAK` from `../../shared/proposal`（Task 1）。
- Produces: 无新导出；`markdownToDocxBuffer` 行为增强（遇分页标记产 PageBreak）。

- [ ] **Step 1: import PageBreak 与分页标记常量**

`from 'docx'` 的 import 列表里加 `PageBreak,`（放 `Paragraph,` 之后）。文件 import 区加：

```ts
import { PROPOSAL_PAGEBREAK } from '../../shared/proposal'
```

- [ ] **Step 2: 在 blockToDocx 的 switch 里加 'html' 分支识别分页标记**

在 `case 'thematicBreak':` 之前插入：

```ts
    case 'html':
      // 块级 html 节点：唯一我们关心的是分页标记（renderer 拼接时插在 kind 边界）。
      // 命中 → 产一个只含 PageBreak 的段落，得到真分页；其它 html（用户极少在方案里写）
      // 降级为可见文本，不静默吞。
      if (node.value.trim() === PROPOSAL_PAGEBREAK) {
        return [new Paragraph({ children: [new PageBreak()] })]
      }
      return [new Paragraph({ children: [new TextRun(node.value)] })]
```

> 注意：`RootContent` 联合含 `html` 节点（`node.value` 为 string），TS 在该 case 内会把 node 收窄到含 `value` 的类型，`node.value` 可直接访问。

- [ ] **Step 3: 运行 typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 4: 手测 docx 分页（dev）**

启动 `bun run dev`，在方案预览里造一份含封面+目录+正文的草稿（可在 Task 7 完成后回归；此刻可临时手动构造 sections 验证）。预期：导出/预览的 Word 中封面、目录、正文各自起新页。
> 若 Task 7 尚未做完，本步可记为「待 Task 7 后回归」，先靠 typecheck 通过即可提交。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/core/proposalDocx.ts
git commit -m "feat(proposal): docx 识别分页标记产出真 PageBreak"
```

---

### Task 5: 预览与导出改用 buildProposalMarkdown（同源 + 分页）

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalPreview.tsx`
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`

**Interfaces:**
- Consumes: `buildProposalMarkdown` from `@shared/proposal`（Task 1）；section 现带 `kind`（Task 2）。

- [ ] **Step 1: ProposalPreview 改用拼接器（带分页）**

顶部 import 加：

```ts
import { buildProposalMarkdown } from '@shared/proposal'
```

把第 45 行：

```ts
    const markdown = sections.map((s) => s.markdown).join('\n\n').trim()
```

改为：

```ts
    // 与「导出 Word」同源：用 buildProposalMarkdown 在 kind 边界插分页标记，
    // 故预览的封面/目录/正文分页与最终 Word 逐像素一致。
    const markdown = buildProposalMarkdown(sections, { pageBreaks: true })
```

- [ ] **Step 2: ProposalDocPanel 导出改用拼接器**

顶部 import 加：

```ts
import { buildProposalMarkdown } from '@shared/proposal'
```

`handleExport` 内把：

```ts
    const markdown = sections.map((s) => s.markdown).join('\n\n').trim()
```

改为（docx 带分页、md 不带——纯 markdown 里分页标记无意义且会显示为注释）：

```ts
    // docx 走分页标记（kind 边界分页）；.md 是纯文本，不插标记（否则注释外漏）。
    const markdown = buildProposalMarkdown(sections, { pageBreaks: format === 'docx' })
```

- [ ] **Step 3: 运行 typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalPreview.tsx apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx
git commit -m "feat(proposal): 预览与导出统一走 buildProposalMarkdown（kind 边界分页）"
```

---

### Task 6: 程序化发送推进消息的通道

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/sendProposalStageMessage.ts`

**Interfaces:**
- Consumes: `useChatStore`、`useProposalStore`、`window.chatApi.send`。
- Produces: `function sendProposalStageMessage(text: string): Promise<void>`——把一条文本作为「用户消息」发进方案会话，复用 composer 的 proposalMode/products 语义；消息会显示在对话里并触发 AI 回复。

- [ ] **Step 1: 新建文件**

```ts
import { useChatStore } from '../stores/chat'
import { useProposalStore } from '../stores/proposal'

/**
 * 从草稿面板的「阶段按钮」程序化发起一条方案推进消息（如「封面已确认，请生成目录」）。
 *
 * 为什么不复用 assistant-ui composer 的 onNew：那是 ComposerRuntime 适配器闭包，按钮
 * 拿不到。这里直接走与 onNew 等价的最小路径——append 用户气泡 + 预翻转 spinner +
 * window.chatApi.send，且带 proposalMode/products，使该轮落在方案进程、AI 拿到方案纪律。
 *
 * 前置：方案已 active 且已播种（按钮只在工作台里、首发之后出现，products 已定），故
 * 直接复用 ps.products，不再 readKbIndex/matchProducts。非方案前台调用是 no-op。
 */
export async function sendProposalStageMessage(text: string): Promise<void> {
  const ps = useProposalStore.getState()
  const chat = useChatStore.getState()
  const sid = ps.sessionId
  // 仅当方案会话就是当前前台会话才发（防泄漏到别的 tab/会话）。
  if (!ps.active || sid === null || chat.sessionId !== sid) return

  chat.appendUserMessage(sid, [{ type: 'text', text }])
  // 预翻转 spinner：与 composer 一致，避免冷启动期间界面静默。startAssistantMessage
  // 幂等，真正的 start 事件到达时对 turn meta 是 no-op。
  const pendingMessageId = `pending_${Date.now()}`
  chat.startAssistantMessage(sid, pendingMessageId)
  try {
    await window.chatApi.send({
      sessionId: sid,
      text,
      proposalMode: true,
      proposalProducts: ps.products
    })
  } catch (err) {
    console.error('[proposal-stage] send failed', err)
    const errMessageId = `err_${Date.now()}`
    chat.startAssistantMessage(sid, errMessageId)
    chat.setError(sid, errMessageId, err instanceof Error ? err.message : String(err))
    chat.endAssistantMessage(sid)
  }
}
```

> 类型核对（已在现有代码确认）：`appendUserMessage(sessionId, content: ContentPart[])`、`startAssistantMessage(sessionId, messageId)`、`setError(sessionId, messageId, error)`、`endAssistantMessage(sessionId)`；`window.chatApi.send({ sessionId, text, proposalMode, proposalProducts })` 与 FusionRuntimeProvider 第 457 行一致。`ContentPart` 的 text 形状为 `{ type: 'text', text }`。

- [ ] **Step 2: 运行 typecheck**

Run: `bun run typecheck`
Expected: PASS。若 `ContentPart` 类型不匹配，按 `stores/chat.ts` 里 `ContentPart` 定义调整（应为 `{ type: 'text'; text: string }`）。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/sendProposalStageMessage.ts
git commit -m "feat(proposal): 加程序化发送方案推进消息的通道（复用 composer send 语义）"
```

---

### Task 7: 草稿面板 —— kind 分区渲染 + 阶段条与推进按钮

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`

**Interfaces:**
- Consumes: `phase`、`advancePhase`、`sections[].kind`（Task 2）；`buildProposalMarkdown`（Task 1，取已确认目录文本）；`sendProposalStageMessage`（Task 6）。

- [ ] **Step 1: ProposalPaper 按 kind 分三区渲染**

ProposalPaper 当前把 `sections` 平铺。改为按 kind 分「封面 / 目录 / 正文」三区，每区一个小标题，区内沿用现有「悬停工具条 + 就地编辑」逐节渲染。把现有 `sections.map(...)` 的单节渲染提成一个内部函数 `renderSection(sec, i, all)` 复用，再按区调用。

在组件内、`return` 之前加分组与渲染辅助：

```ts
  const KIND_LABEL: Record<ProposalKind, string> = {
    cover: '封面',
    toc: '目录',
    content: '正文'
  }
  // 保持 sections 原有顺序的前提下按 kind 切组（同 kind 连续，故顺序天然分块）。
  const groups: Array<{ kind: ProposalKind; items: typeof sections }> = []
  for (const sec of sections) {
    const last = groups[groups.length - 1]
    if (last && last.kind === sec.kind) last.items.push(sec)
    else groups.push({ kind: sec.kind, items: [sec] })
  }
```

顶部 import 加 `import type { ProposalKind } from '@shared/proposal'`。

把原 `sections.map((sec, i) => ( ... ))` 整段提取为函数（参数用「全局下标」以保留上移/下移的边界判断）：

```ts
  const renderSection = (sec: (typeof sections)[number], globalIndex: number) => (
    <section key={sec.id} className="group relative py-0.5">
      {/* …原有工具条与编辑/预览 JSX 原样搬入，把判断里的 i 换成 globalIndex，
          sections.length 仍用 sections.length（全局首尾禁用上/下移）… */}
    </section>
  )
```

> 实现细节：把 Task 前的原 `sections.map` 回调体（第 40~93 行的 `<section>…</section>`）原样移入 `renderSection`，仅将 `i` 改名为 `globalIndex`、`disabled={i === 0}`→`disabled={globalIndex === 0}`、`disabled={i === sections.length - 1}`→`disabled={globalIndex === sections.length - 1}`。逻辑不变。

把纸面里的 `sections.length === 0 ? (空态) : (sections.map(...))` 改为按组渲染：

```ts
        {sections.length === 0 ? (
          <div className="text-center text-[13px] text-neutral-400">
            {generating ? '方案正在生成，完成的部分会陆续出现在这里…' : '等待 AI 起草…'}
          </div>
        ) : (
          (() => {
            let running = -1 // 跨组累计全局下标，喂给 renderSection 做首尾禁用判断
            return groups.map((g) => (
              <div key={g.kind} className="mb-2">
                <div className="mb-1 border-b border-neutral-200 pb-0.5 text-[11px] font-medium tracking-wide text-neutral-400">
                  {KIND_LABEL[g.kind]}
                </div>
                {g.items.map((sec) => {
                  running += 1
                  return renderSection(sec, running)
                })}
              </div>
            ))
          })()
        )}
```

- [ ] **Step 2: typecheck（ProposalPaper 单独先过）**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 3: ProposalDocPanel 顶部加阶段条与推进按钮**

import 加：

```ts
import { buildProposalMarkdown } from '@shared/proposal'
import { sendProposalStageMessage } from '../../lib/sendProposalStageMessage'
```

订阅 phase 与 action、派生各区是否有内容：

```ts
  const phase = useProposalStore((s) => s.phase)
  const { advancePhase } = useProposalStore.getState()
  const hasCover = sections.some((s) => s.kind === 'cover')
  const hasToc = sections.some((s) => s.kind === 'toc')
```

加两个推进处理函数（放组件内、`handleExport` 附近）：

```ts
  // 阶段一→二：先把 phase 推到 toc（使后续哨兵块落入目录区），再让 AI 生成目录大纲。
  function confirmCover(): void {
    advancePhase('toc')
    void sendProposalStageMessage(
      '封面已确认。请进入【阶段二·目录】：参考知识库里该产品的资料结构与售前方案常见章节，给出一份章节目录大纲（有序列表逐章列出），用方案正文哨兵包裹。'
    )
  }
  // 阶段二→三：把已确认的目录正文带给 AI（目录驱动正文），phase 推到 content。
  function confirmToc(): void {
    const tocMd = buildProposalMarkdown(
      sections.filter((s) => s.kind === 'toc'),
      { pageBreaks: false }
    )
    advancePhase('content')
    void sendProposalStageMessage(
      `目录已确认，最终目录如下：\n\n${tocMd}\n\n请进入【阶段三·正文】：严格按上面目录逐章撰写正文，章节标题与顺序以目录为准，一次聚焦一章，每章用方案正文哨兵包裹。`
    )
  }
```

在面板顶部工具条（「方案草稿」标题那一行的下方，或编辑/预览 segmented 同排右侧）插入阶段条 JSX。建议放在 `editMsg` 提示行之上、产品 chip 行之上，单独一行：

```tsx
      {/* 阶段条：封面 → 目录 → 正文，显式按钮门控推进，一次只推进一阶段。 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px]">
        <span className={phase === 'cover' ? 'font-medium text-foreground' : 'text-muted-foreground'}>① 封面</span>
        <span className="text-muted-foreground">→</span>
        <span className={phase === 'toc' ? 'font-medium text-foreground' : 'text-muted-foreground'}>② 目录</span>
        <span className="text-muted-foreground">→</span>
        <span className={phase === 'content' ? 'font-medium text-foreground' : 'text-muted-foreground'}>③ 正文</span>
        <span className="flex-1" />
        {phase === 'cover' && (
          <button
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
            disabled={!hasCover}
            onClick={confirmCover}
            title={hasCover ? '' : '封面尚未生成'}
          >
            确认封面，生成目录
          </button>
        )}
        {phase === 'toc' && (
          <button
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
            disabled={!hasToc}
            onClick={confirmToc}
            title={hasToc ? '' : '目录尚未生成'}
          >
            确认目录，开始正文
          </button>
        )}
        {phase === 'content' && <span className="text-muted-foreground">正文撰写中</span>}
      </div>
```

- [ ] **Step 4: 运行 typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 5: 手测全流程（dev / CDP 9222）**

启动 `bun run dev`（主进程改过，需重启 dev）。验证：
1. 开方案会话 → 阶段条停在「① 封面」高亮，按钮「确认封面，生成目录」因无封面而禁用。
2. 发首条需求 → AI 问关键信息 → 回答 → AI 生成封面 → 封面落入「封面」区、按钮变可用。
3. 点「确认封面，生成目录」→ 阶段条进「② 目录」→ 对话里出现推进消息 → AI 出目录大纲落「目录」区。改一行目录文字（就地编辑）生效。
4. 点「确认目录，开始正文」→ 阶段条进「③ 正文」→ 对话里推进消息含目录全文 → AI 按目录逐章写、落「正文」区。
5. 切「预览」：封面/目录/正文分页正确。导出 Word：分页、顺序、内容与草稿一致。
6. 底线复核：内容可溯源知识库、缺料标注、无臆想。

> dev 实测提示（见项目记忆）：app 为 bypassPermissions；主进程改动要重启 dev；紧贴 boot 驱动会因 chat store sessionId 未同步致 proposalMode 偶发 false，需等几秒。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx
git commit -m "feat(proposal): 草稿按 kind 分区渲染 + 阶段条与封面/目录推进按钮"
```

---

## Self-Review

**Spec 覆盖核对：**
- 封面 AI 问关键信息后生成、可编辑 → Task 3（提示词阶段一）+ Task 2（kind=cover 入封面区）+ Task 7（封面区渲染、就地编辑沿用）。✓
- 目录 AI 提建议大纲、可改/口述调整、AI 跟随 → Task 3（阶段二）+ Task 7（目录区 + confirmToc 带目录文本）。✓
- 正文按确认目录逐章写（现有能力）→ Task 3（阶段三）+ confirmToc 注入目录。✓
- 三段都落草稿、可编辑 → Task 2（kind）+ Task 7（分区渲染复用既有编辑）。✓
- 显式按钮门控、不可跳步 → Task 7（阶段条按钮，空区禁用）+ Task 2（advancePhase 单一推进入口）。✓
- 目录定稿即正文真相源、确认后不自动变 → confirmToc 注入目录文本；正文不回写目录（无此逻辑即满足）。✓
- 导出/预览封面→目录→正文分页 → Task 1（buildProposalMarkdown）+ Task 4（PageBreak）+ Task 5（接线）。✓
- 只用知识库不臆想底线 → Task 3 保留并强化「资料缺失/忠实搬运」纪律。✓

**Placeholder 扫描：** 各步均含可直接落地的真实代码/文案，无 TBD/TODO/「类似上文」。Task 4 Step 4 的「待 Task 7 后回归」是显式排序说明，非占位。✓

**类型一致性：** `ProposalKind`（shared）贯穿 store.phase / section.kind / buildProposalMarkdown / KIND_LABEL / advancePhase 全部一致；`buildProposalMarkdown(sections, {pageBreaks})` 三处调用（Preview、DocPanel 导出、confirmToc）签名一致；`sendProposalStageMessage(text)` 定义与两处调用一致；chat store action 签名已对照源码核实。✓

## YAGNI / 不做（与 spec 一致）

- 不另立封面/目录哨兵；不做目录改→自动重写正文；不做 phase 跨重启持久化；不做封面图/Logo 上传；不做章节↔目录锚点跳转。
