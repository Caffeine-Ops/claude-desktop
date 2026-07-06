# 方案草稿分节化 + 真 .docx 导出 — 代码评审整改 Spec

日期：2026-06-24
分支：Install-Plan
来源：`/code-review 方案草稿`（high effort，8 finder 角度 → 事实核验）
被审范围：`b9c8a88e..HEAD`（功能 6 提交 + 注释修复 53353ccf）

## 背景

「方案草稿分节化 + 真 .docx 导出」功能实现完成并通过手动验收后，做了一轮高强度
代码评审（8 个独立 finder 角度 + 源码事实核验）。本 spec 把评审确认的 10 项发现
固化下来，作为后续修复计划的依据。按处置优先级分三档：**合并前必修**、**建议修**、
**可选 cleanup**。

涉及文件：
- `apps/desktop/src/main/core/proposalDocx.ts`（markdown→docx 转换器）
- `apps/desktop/src/main/core/proposalExport.ts`（导出适配）
- `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（end 累积）
- `apps/desktop/src/shared/proposal.ts`（哨兵抽取）
- `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`（面板）
- `apps/desktop/package.json`（打包配置）

---

## A. 合并前必修

### A1. blockquote 嵌套内容被压平/重复/损坏（真·数据损坏）

- **位置**：`proposalDocx.ts:142-158`（blockquote 分支）
- **现象**：分支先 `for (const el of blockToDocx(child))` 拿到递归结果 `el`，但当
  `el instanceof Paragraph` 时**丢弃 `el`**，改用 `inlineRuns(child.children as PhrasingContent[])`
  重建段落。当 `child` 是嵌套 `list` 时，`blockToDocx(child)` 返回 N 个段落（每条目一段），
  循环对每个都 push 一个由整个 list 的 `ListItem[]`（被强转 `PhrasingContent[]`）构造的段落
  → list 结构丢失、条目内容重复 N 次；引用内嵌 `table` 时被丢成空/乱段。
- **失败场景**：草稿用 `> - 条目A` / `> - 条目B` 写带列表的引用块 → 导出的 .docx 里该列表
  被压平、内容重复、结构错乱。
- **修法**：直接复用 `blockToDocx(child)` 的返回值——对返回的 `Paragraph` 追加
  `indent: { left: 480 }`（如需斜体则在构造时带上），对 `Table` 原样透传；删除
  `child.children` 重建逻辑与 `style: undefined` 死代码。
- **备注**：最终全分支评审当时把此项 triage 为「浪费但不丢内容」，本轮核验推翻——
  嵌套场景会**真丢内容**，升级为必修。

### A2. 主进程新依赖在打包后可能缺失（production-only，dev 测不出）

- **位置**：`apps/desktop/package.json` 的 `build.files`
- **现象**：`build.files` 仅列 `["out/**/*", "env.json", "package.json"]`，不含
  `node_modules`。`docx`/`unified`/`remark-parse` 经 electron-vite 的 `externalizeDepsPlugin`
  保持为外部依赖（运行时 `require` 自 node_modules），靠 electron-builder 自动收集
  生产依赖打包。这是本功能**首次引入主进程外部运行时依赖**，且 CI 用 **bun**
  安装（`node_modules/.bun/` 符号链接式布局），electron-builder 对非 npm 布局的依赖
  收集历史上有踩坑。
- **失败场景**：production 包里点「导出 Word」→ 主进程 `require('docx')` 抛
  `MODULE_NOT_FOUND` → 导出失败。dev 正常，只有打包版复现。
- **修法/验证**：打 production 包（`bun run build:mac`）后实测「导出 Word」；若缺失，
  在 `build.files` 或 `asarUnpack` 显式纳入 `docx`/`unified`/`remark-parse` 及其传递依赖，
  或确认 electron-builder 的生产依赖收集在 bun 布局下生效。**必须在发版前验证。**

---

## B. 建议修

### B1. 有序列表 numbering 只注册 0–3 级，深层嵌套断裂

- **位置**：`proposalDocx.ts:210`（`[0, 1, 2, 3].map(...)`）+ `listItemParagraphs` 递归 `level+1`
- **现象**：numbering config 只定义 4 级，但递归层级无上限。第 5 层引用 `level:4`，
  config 无此级。
- **失败场景**：AI 写出 5 层及以上嵌套有序列表（多层条款）→ Word/LibreOffice 打开报
  「numbering reference not found」需修复，或深层编号丢失/错乱。
- **修法**：二选一——把 `levels` 数组扩到 9 级（Word 有序列表上限）；或在
  `listItemParagraphs` 对 `level` 做 `Math.min(level, MAX_LEVEL)` clamp。后者一行，
  并加注释说明这是有意上限。

### B2. 哨兵截断时正文静默丢弃且不可恢复

- **位置**：`shared/proposal.ts`（`extractProposalDraftBlocks` 未闭合即忽略）+
  `FusionRuntimeProvider.tsx:1051-1057`
- **现象**：AI 漏写结束哨兵（流截断 / 超 token / 断网）时，`extractProposalDraftBlocks`
  静默返回 `[]` → 走 `markDraftConsumed` 记账 → 用户看不到草稿也无错误；`consumedDraftIds`
  已含该 id，后续 end 重发也无法补回。无「有头无尾＝截断」的降级路径。
- **失败场景**：正文输出到一半被截断，只有 `===方案正文开始===` 没有结束哨兵 → 该段
  永久丢失、无任何提示。
- **修法**：区分「完全无哨兵（纯对话轮）」与「有起始哨兵但无结束哨兵（截断）」。后者可
  降级为取起始哨兵后的全文、或向用户展示「本段疑似截断」警告，而非静默丢弃 + 记账。
  需让 `extractProposalDraftBlocks` 返回截断标志（如 `{ blocks, truncated }`），调用侧分流。

### B3. 陈旧 JSDoc 与实现相悖（CLAUDE.md 违规）

- **位置**：`proposalExport.ts:17-19`（函数头 `@param format` JSDoc）
- **现象**：注释仍写「Currently only `'md'` is wired; future formats would convert
  markdown here before writing (e.g. via pandoc / docx-builder)」，但 docx 已落地、
  且用的是 `proposalDocx.ts` 的 mdast 路线而非 pandoc/docx-builder。前一轮注释修复
  （53353ccf）覆盖了 switch 内的 exhaustiveness 注释，**漏了这处函数头 JSDoc**。
- **违反规则**：仓库根 `CLAUDE.md`「注释密度很高，且专门解释『为什么这样而不是那样』……
  改不变量时把理由写进注释」。陈旧的「将来时」描述误导后续读者。
- **修法**：更新 JSDoc 为「`'md'` 直写、`'docx'` 经 `markdownToDocxBuffer`（mdast→docx）」，
  并保留「为什么选 mdast 而非 pandoc/html→docx」的理由。

---

## C. 可选 cleanup

### C1. unified processor 每次导出重建（效率）

- **位置**：`proposalDocx.ts:199`
- **现象**：`markdownToDocxBuffer` 每次调用都 `unified().use(remarkParse).use(remarkGfm)`，
  重新分配 processor 链并注册插件。
- **修法**：提升为模块级单例 `const mdProcessor = unified().use(remarkParse).use(remarkGfm)`，
  导出时 `mdProcessor.parse(markdown)`。

### C2. 导出格式三处各自维护、无 exhaustiveness 保护（altitude）

- **位置**：`proposalExport.ts:28,35`（filters / defaultPath 的 if/else）+
  `register.ts:1012`（IPC guard 白名单）+ `ipc-channels.ts`（`ProposalExportFormat`）
- **现象**：三处与类型联合各自独立维护。将来加 `'pdf'`：只改类型，filters/defaultPath
  会静默回退到 `.md`、register guard 会静默拦截，均无编译报错。
- **修法**：filters/defaultPath 改 `const FORMAT_META: Record<ProposalExportFormat, {...}>`
  查表；IPC guard 用 `const VALID = new Set<ProposalExportFormat>([...])`。加新格式时
  TS 在缺 key 处报错，与 switch 的 `never` 守卫对齐。

### C3. heading 深度未 clamp 下界（理论，零成本）

- **位置**：`proposalDocx.ts:126`
- **现象**：`Math.min(node.depth, 6) - 1` 只 clamp 上界；若上游传 `depth=0` → 索引 `-1`
  → `HEADING_BY_DEPTH[-1]` 为 `undefined` → 静默降级普通段、标题与目录条目丢失。
  remark 标准不产 depth0，属理论。
- **修法**：`HEADING_BY_DEPTH[Math.max(0, Math.min(node.depth, 6) - 1)]`，一行。

### C4. msg 未找到时记账被移除（removed-behavior，低影响）

- **位置**：`FusionRuntimeProvider.tsx:1042-1058`
- **现象**：记账（`markDraftConsumed`/`appendSections`）现都在 `if (msg && msg.role === 'assistant')`
  内；重构前有一条**无条件** `markDraftConsumed(event.messageId)` 在 `if(msg)` 块外。
  若 msg 为 undefined（end 早于消息入 store 的竞态 / role 非 assistant），该 id 不再被记账。
- **影响**：低——该路径没 append 任何内容，重发时 msg 通常已就绪、正确入一次，无重复
  累积。但属原不变量（「永远在 markDraftConsumed 一处兜底记账」）的退化。
- **修法**：可在 `if(msg)` 之外保留一条兜底 `markDraftConsumed`，恢复「无论是否取到正文
  都记账」的原语义；或显式接受该退化并加注释说明为何安全。

### C5. 面板 6 个 selector 中 4 个订阅永不变的 action（冗余）

- **位置**：`ProposalDocPanel.tsx:9-14`
- **现象**：`updateSection`/`removeSection`/`moveSection`/`setProducts` 是 zustand 稳定
  引用，单独 selector 订阅无意义；store 每次更新都空跑这 4 个 selector。
- **修法**：用 `useProposalStore.getState()` 取 action（不订阅），只订阅 `sections`/`products`
  （配 `useShallow` 合并）。纯冗余优化。

---

## 验证

项目无测试框架，质量门为 `bun run typecheck`。各项修复后：
- `bun run typecheck` 须全绿。
- A1：临时脚本喂「引用内嵌列表/表格」的 markdown，导出 .docx 打开确认结构保留、无重复。
- A2：`bun run build:mac` 出包后实测「导出 Word」不报 MODULE_NOT_FOUND。
- B1：喂 5 层嵌套有序列表，导出 .docx 打开无修复提示、编号正确。
- B2：喂「只有起始哨兵、无结束哨兵」的消息，确认有降级（取全文或警告）而非静默丢弃。

## 非目标

不在本轮整改范围（评审未发现、或前序 spec 已界定）：公司 Word 模板、PDF 导出、
富文本 WYSIWYG、草稿持久化。复用类 cleanup（`useTimedReset` hook、`RemovableChip`
公共组件、`tableCellContent` 内联）评审认为价值低，暂不纳入。
