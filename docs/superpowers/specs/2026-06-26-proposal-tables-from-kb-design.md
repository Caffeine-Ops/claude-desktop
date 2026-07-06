# 方案写作·表格化呈现知识库数据（子项目 A）

日期：2026-06-26
状态：设计已认可，待用户复核 → writing-plans

## 背景与目标

「写方案」功能当前生成的正文几乎全是段落文字。知识库镜像里大量源料其实是**结构化数据**（参数规格、功能对比、清单、实施计划、报价项），被 AI 摊成大段散文后，客户读起来既不直观、也丢了原本的表结构。

目标：让 AI 在源料是结构化数据时，**用表格组织**而不是堆段落，且表格数据同样可溯源到知识库文件，导出的 Word 里是**真 Word 表格**。

这是「图片 + 表格」整体增强的**第一个子项目**。图片是独立的第二份 spec（链路更长、有本地图进渲染进程的安全风险），本 spec 不含图片。

边界（YAGNI）：
- 不做表格样式模板化（边框/底纹/斑马纹配置）——先用 docx 现有默认表样式，呈现正确优先。
- 不做「AI 把散文反向重排成表」的二次加工——只在**起草时**按源料形态决定用表还是段。
- 不改 `KbIndex` 契约、不预建索引。

## 现状（已查证）

端到端管道其实**已经支持** GFM 表格，缺的是「教 AI 用」+「别在中途被破坏」：

- **导出**：`apps/desktop/src/main/core/proposalDocx.ts` 的 `case 'table'`（第 274–300 行）已把 mdast `table` 节点构造成真 `Table`/`TableRow`/`TableCell`，且对畸形行/空表有降级（绝不抛错中断导出）。**无需改导出器**。
- **镜像原文**：知识库由 markitdown 转换（`scripts/kb-index/convert.ts`），源文档里的表格已是 GFM markdown 表格，保留在镜像 `.txt` 里。
- **提示词**：`apps/desktop/src/main/core/proposalPrompt.ts` 全程只教 AI 写「段落 + 段末 `（据《X》）`」（规则 3、阶段三），**从没提过表格**。这是「方案全是文字」的直接原因。
- **召回**：`apps/desktop/src/main/core/proposalRetrieve.core.ts` 的 `chunkText`（第 58 行起）按空行 `\n\s*\n` 切块。markdown 表格行之间是单换行、不含空行，单张表**不会**被切散；但需确认「表格 + 紧邻说明文字」在合并/截断时不被劈开，且整块 `|` 不被 BM25 误判低分。
- **引用校验**：`apps/desktop/src/shared/proposal.ts` 的 `parseCitations` / `trigramOverlap`（第 237、266 行）按「段落」做字符 trigram 重叠。表格作为段落，其 markdown 与镜像里同款表格 markdown 应高重叠、判 `supported`。`stripDraftHtml`（第 96 行）不会误删表格（表格无 HTML 标签）。

## 设计

### 组件 1：提示词——教 AI 按数据形态选「表 vs 段」

文件：`proposalPrompt.ts`，`buildProposalAppend` 的阶段三/规则 3 附近。

新增一条纪律（中文，并入现有规则编号体系，沿用注释风格写清「为什么」）：

> 当某节要呈现的源料是**结构化数据**（参数/规格、功能或方案对比、分项清单、实施/时间计划、报价或配置项等），**用 GFM markdown 表格**组织，不要摊成大段文字——表格更直观、也保留源料原本的结构。表头用源料里的字段名，单元格只填知识库查到的真值，查不到的留空或写「—」，**绝不为凑满表格而编数据**。表格紧接的下一行仍按规则 3 标 `（据《X》）`。是否该上表由你按源料形态判断；拿不准时用 AskUserQuestion 问用户（遵守提问纪律），不要默认堆成散文。

要点：
- 接地纪律与现有引用规则同源——表里每个值都来自镜像原文，空缺写「—」而非编造。
- 用表 vs 用段的判断权交给 AI（与已确认的「AI 自动、数据支持就用」一致），不确定走 AskUserQuestion。
- 表格 markdown 照旧包在正文哨兵（`PROPOSAL_DRAFT_BEGIN.content`）里，归档/导出链路不变。

### 组件 2：召回保形——表格不被切碎、不被 BM25 埋没

文件：`proposalRetrieve.core.ts`。

- **确认**单张 markdown 表格在 `chunkText` 中保持整块（按空行切，表内无空行 → 天然整块）。补一条针对「表格 + 前后说明」的用例：若某块的合并/截断逻辑会把连续 `|...|` 行劈开，则让分块识别表格边界（连续以 `|` 起止的行视为不可分割单元），整块保留。
- **确认** BM25（`rankChunks`）不因表格块里大量 `|` 与短单元格而系统性低分到召回不到；若实测明显偏低，在归一化时把表格分隔符 `|`、`---` 行当作低信息 token 处理（具体策略实现时按实测定，先不过度设计）。

若实测两点都已天然满足，则本组件**仅新增测试**、不改逻辑。

### 组件 3：引用校验放行——表格不被误判 unsupported

文件：`apps/desktop/src/shared/proposal.ts`（`parseCitations` / `trigramOverlap`）与 `proposalVerify.ts`。

- **确认**含表格的正文段，trigram 与镜像里同款表格 markdown 重叠率达阈值、判 `supported`。
- **确认** `stripDraftHtml` 不破坏表格、`parseCitations` 能把「表格块 + 其后 `（据《X》）`」正确归为一段一引用。
- 预计无需改逻辑，以测试锁定行为；若实测阈值对表格偏严（表格规整化后 gram 稀疏），再单独评估，不在本 spec 预先改阈值。

### 组件 4：埋点

文件：`proposal.ts` 的 `buildProposalMetric`。表格只是更多正文字符，`deliverability` 字数代理与引用快照逻辑天然兼容，**不改**。（是否加「含表格节数」这类信号留到有需要再说，YAGNI。）

## 数据流

```
用户确认目录 → AI 写某章
  └─ 源料是结构化数据？
       是 → 输出 GFM 表格（哨兵包裹）+ 下一行 （据《X》）
       否 → 照旧段落
  → renderer 累积进 content 节（markdown 原样）
  → 引用校验：表格段 trigram vs 镜像 → supported（组件 3 已验证）
  → 导出 Word：proposalDocx 的 case 'table' → 真 Word 表（现状已支持）
  → 导出预览（docx-preview）：随真 docx 出表
  → live 纸面预览（react-markdown）：GFM 表格原生渲染
```

## 测试（bun test，沿用现有基建）

1. **提示词**：`buildProposalAppend` 输出含新表格纪律（纯函数快照/包含断言）。
2. **导出**：构造含 GFM 表格的正文 markdown → `markdownToDocxBuffer` → 解包 docx，断言存在 `<w:tbl>`、行列数正确、单元格文本正确（参照 `proposalDocx` 现有测试或 fixture）。
3. **召回保形**：含表格的镜像文本过 `chunkText`，断言表格在单一 chunk 内、行未被劈；`rankChunks` 对含表格 query 能召回该块。
4. **引用校验**：含表格 + `（据《X》）` 的正文段 vs 含同款表格的镜像 → `verifyCitations` 判 `supported`；`parseCitations` 正确切段取文件名。
5. **回归**：纯文字方案的导出/校验/召回行为不变。

## 验收标准

- 给定一段表格型源料，AI 起草时产出 markdown 表格而非散文段落（提示词生效）。
- 含表格的方案导出 .docx，在 Word/LibreOffice 打开是**真表格**（非纯文本），引用校验显示 supported，召回片段里表格不碎。
- 纯文字方案的现有行为零回归。
- `bun run typecheck` 通过，新增 bun test 全绿。

## 不在本 spec（下一份：子项目 B·图片）

- 召回/提示词暴露文件 `assets[]` 给 AI、`![]()` 嵌图。
- `proposalDocx` 新增 `case 'image'`（ImageRun + SVG 特判 + 尺寸缩放 + 坏图降级）。
- 本地图进渲染进程的安全通道（`kbasset://` 协议或 IPC data-uri）供 react-markdown 预览。
- 图接地校验（图必属本节所引文件的 `assets[]`）并入 `SectionVerification`。
