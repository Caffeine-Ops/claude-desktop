# 写方案·配图密度增强（对标参考方案文档）设计

日期：2026-07-03
状态：已与用户对齐定稿

## 背景与问题

用户反馈「写方案」生成的文档配图太少，给出参考文档《20260621智能导诊和预问诊建设方案》对标。对参考 docx 的逆向分析（48 张图 / 571 段）：

- 3 张**彩色架构图**（系统总体架构图、业务闭环架构、AI 能力架构）——专业彩图，观感远超素色线框；
- 约 30 张**产品 UI 截图**——几乎每个四级功能小节（语音输入、科室推荐、对接挂号、报告编辑……）下面都跟一张对应界面截图；
- 约 15 张**统计分析后台图表截图**（潮汐分析、漏斗分析、性别年龄分析、各类报表）。

即参考文档的密度来自「**每个功能点配一张产品截图 + 每个架构章节配一张彩图**」。

当前「写方案」只有两条出图路径，都远达不到这个密度：

1. **知识库配图**（`proposalPrompt.ts:97`）：硬约束「只能插本段已引用文件名下的图」，且措辞是「图是否要插由你按相关性判断，拿不准就问」——AI 表现极保守，大量库图闲置；
2. **Mermaid 结构图**（`proposalPrompt.ts:102`）：条件式措辞「当某节要表达结构时」，密度低；主题是素色 `neutral`，观感与参考文档彩图差距大。

用户手动的「生成图片」入口（选区弹框 → 审阅卡）已存在，但生成阶段 AI 自己不会发起。

## 已对齐的决策

| 决策点 | 结论 |
|---|---|
| 图的来源 | 库图复用 + AI 现画，两者都加强 |
| AI 生图边界 | **只画结构/示意图**（架构图、流程图等）；绝不生成仿产品 UI 截图（防造假） |
| 出图方式 | Mermaid 为主（快、可编辑、零成本）；仅关键章节门面图调 AI 生图出彩图 |
| 库图复用尺度 | **保留同源约束**（只能插本段已引用文件的图，接地底线不动），但把「拿不准就不插」反转为「有相关图就应插」+ 明确密度目标 |
| AI 彩图触发 | **生成阶段自动发起**，产出走现有图片审阅卡流程，用户过目后落位 |

## 设计总览（四块）

### ① 库图复用积极化（纯提示词改动）

改 `apps/desktop/src/main/core/proposalPrompt.ts:97` 的【正文·按需嵌入知识库配图】：

- 措辞反转：从「图是否要插由你按相关性判断，拿不准就用 AskUserQuestion 问用户」改为「**只要该文件名下有与本小节内容对应的图就应当插入**，仅在相关性明显不足时才不插；不要为插图与否打断提问」；
- 写明密度目标：「叶子级功能小节（最深层标题下的正文）凡所引文件名下有对应界面截图/图表的，应配一张图，一节一图为宜」——这正是参考文档 30 张 UI 截图的排布方式；
- 补一条防滥用：同一张图全文不重复插入（参考文档里同图复用两次属于反例，不效仿）。

**不变**：同源约束、路径 `<>` 包裹、单独成行、图说一句话、封面/目录不插图。

### ② Mermaid 密度提升 + 主题美化

**提示词**（`proposalPrompt.ts:102`）：从条件式「当某节要表达…时」升级为密度要求——「**每个主要章节（## 级）凡涉及架构、流程、部署、组织或实施计划、且知识库事实足以支撑时，应至少配一张结构图**」。原有五条硬纪律（事实源自原文、标来源、纯结构短语、中文标点标签加英文双引号、封面目录不画）逐字保留。

**主题**（`apps/desktop/src/renderer/src/lib/mermaidRender.ts:22-44`）：`theme: 'neutral'` 换成 `theme: 'base'` + 自定义 `themeVariables`（品牌蓝系浅底、深色边框、统一中文字体与字号），节点观感向参考文档彩图靠拢。

**不变量**（改主题时逐字保留，注释里已解释原因）：
- `htmlLabels: false`（含 `flowchart.htmlLabels`）——librsvg 不支持 foreignObject，动了导出就废；
- `securityLevel: 'strict'`、`suppressErrorRendering: true`；
- 导出栅格化路径不动——docx/pdf 走同一 `renderMermaid`，主题变化自然跟随，无需改导出器。

### ③ genimage 指令块：生成阶段自动发起 AI 彩图（核心新增）

#### 指令块语法

AI 在正文哨兵内、需要门面彩图的位置输出一个 fenced 代码块：

````markdown
```genimage
图说: 系统总体架构图
构图描述：分层架构，自下而上为基础设施层（…）、数据层（…）、AI 能力层（…）、应用层（…），各层组件与连线关系……
```
````

第一行 `图说: <一句话>`（落位后作图片 alt 文字），其余行是给生图模型的构图描述。

#### 提示词新条目（proposalPrompt.ts 新增）

- 适用范围：**仅门面级结构图**——系统总体架构、业务闭环、能力全景这类需要彩图质感的图；普通流程/时序/甘特仍用 mermaid；
- 数量约束：**全文 1~3 张**，防生图费用失控；
- 接地纪律与 mermaid 同源：构图描述里的分层/组件/连线**必须来自知识库原文事实**，绝不为画面丰满编造模块；描述所依据的事实在指令块所在段落标注（据《文件名》）；
- 构图描述提示要求「图中文字少而精、用短中文标签」（降低生图模型中文渲染错乱概率）；
- 封面、目录一律禁止。

#### 触发机制：落节后扫描（三选一的取舍）

- ✅ **落节后扫描**（选定）：renderer 在 section 落库收口处（`stores/proposal.ts` 的 section 注册/更新路径，与 `syncSections` 轮内即时同步共用时机）扫描新出现的 genimage 块 → 逐个调**已有的** `PROPOSAL_IMAGE_GENERATE` IPC（`ipc-channels.ts:508` → `register.ts:1286`，零新 IPC）→ 产出登记进现有 `imageReviews` 审阅卡。
- ❌ chunk 流实时扫描：在飞文本不稳定、可能命中半个围栏块——与「幻影哨兵」同根的坑（raw 扫描 vs 渲染结构），风险高收益小；
- ❌ 生成后独立 pass：多一轮对话、慢，且 AI 通读定位不如指令块锚定精确。

**幂等与重放防护**：以 `sectionId + 指令块内容 hash` 做内存 seen 集合，每个指令块只自动发起一次。**草稿重建路径（reopen / transcript 哨兵重建 / restore）不自动发起**——重建出的 genimage 块渲染成「点此生成」手动卡片，防止每次重开会话都烧一遍生图费。自动发起仅限生成会话进行中的落节时机。

#### 渲染与审阅

- **编辑态渲染**：`lang === 'genimage'` 的代码块不渲染成代码，渲染成卡片（复用改图/生图已有的转圈动画+说明文字样式）：
  - 生成中 → spinner +「正在生成：<图说>」；
  - 失败 / 未配置生图 API → 图说 + 错误说明 +「点此生成/重试」按钮（点击走同一条 IPC）；
  - 生成完成 → 旁边出现现有 `ProposalImageReview` 审阅卡（沿用登记后自动滚进可视区的既有行为）。
- **锚定与落位**：指令块本身留在草稿 markdown 里当锚点。审阅卡「应用」= 用 `![<图说>](<path>)` **原地替换整个指令块**；「丢弃」= 删除整个指令块。没有 blockIndex 漂移问题。
  - `imageReviews` 数据模型（`stores/proposal.ts:52-64`）扩 mode `'directive'`，定位字段为 `sectionId` + 指令块在该节内的 occurrence（同内容指令块按出现次序数第几个）；应用/丢弃手术走 `shared/proposalImageOps.ts` 新增的纯函数 `replaceGenImageDirective` / `removeGenImageDirective`（与既有 remove/replace 同风格：代码跨度遮罩、occurrence 定位、纯函数可测）。
- **并发**：多个指令块并行发起互不阻塞；`imageReviews` 本就支持多卡并存。

### ④ 导出剥除、校验兼容与测试

- **导出剥除**：未处理的 genimage 指令块在一切导出/写盘路径剥除——`markdownToDocxBuffer`（docx）、`renderProposalPdfHtml`（PDF）、md 写盘前——与 `stripCitations` 同收口位置加 `stripGenImageDirectives`。docx 导出器对 `lang === 'genimage'` 的 code 节点直接跳过（区别于 mermaid 查不到图时的降级文字），不输出任何占位文字；未生成的指令块在编辑态有卡片可见，用户不会无感丢图。
- **解析**：`shared/proposal.ts` 新增 `parseGenImageDirectives(markdown)` → `[{ blockIndex, caption, prompt }]`，围栏识别须独占成块（吸取幻影哨兵教训：不裸 indexOf）。
- **校验兼容**：落位后的 `![图说](<userData>/proposal-drafts/<sid>/assets/gen-*.png)` 与既有「生成图」同路径（P 图功能已交付同款落盘），确认引用落地校验/图片接地校验对该路径放行（预期已兼容，实施时加断言确认）。
- **测试**（bun test，沿用既有基建）：
  - `parseGenImageDirectives` 解析（正常/缺图说行/嵌在代码示例里不误报）；
  - `replaceGenImageDirective` / `removeGenImageDirective` 手术（occurrence、代码跨度遮罩）；
  - 导出剥除：node:zlib 解 docx 的 XML 断言（无 genimage 残留文本）；
  - `proposalPrompt.test.ts`：新指令条目存在性与关键措辞断言。

## 明确不做（本期范围外）

- **图片级全库检索索引**（放宽到全库图池 + 语义匹配）——下一期独立立项；
- **仿产品 UI 截图生成**——违反接地底线，永不做；
- **chunk 流内实时识别生图指令**——风险收益比差，落节扫描已够快；
- 统计图表类配图的凭空生成——图表必须来自库图，没有就走「⚠️ 资料缺失」既有机制。

## 风险与对策

| 风险 | 对策 |
|---|---|
| AI 彩图中文文字错乱 | 提示词要求图中文字少而精；审阅卡人工过目是最终关口 |
| 生图费用失控 | 全文 1~3 张硬约束 + 幂等 seen 集合 + 重建路径不自动发起 |
| genimage 块泄漏进成品 | 导出/写盘三路径统一剥除 + docx XML 断言测试 |
| 库图积极化后插入不相关图 | 同源约束未放宽，最坏情况是同文件内选图不准，编辑态点图工具栏可删 |
| mermaid 主题改动破坏导出 | `htmlLabels:false` 等不变量逐字保留 + 导出走同一渲染路径 |

## 实施入口清单

| 块 | 文件 |
|---|---|
| ① 库图积极化 | `apps/desktop/src/main/core/proposalPrompt.ts`（L97 条目改写 + test） |
| ② mermaid | `proposalPrompt.ts`（L102 条目改写）、`renderer/src/lib/mermaidRender.ts`（主题） |
| ③ 指令块解析/手术 | `shared/proposal.ts`、`shared/proposalImageOps.ts`（+ 各自 test） |
| ③ 自动发起+渲染 | `renderer/src/stores/proposal.ts`（落节扫描、seen、imageReviews 扩展）、`ProposalPaper.tsx` / `AssistantMarkdown.tsx`（genimage 卡片渲染、应用/丢弃）、复用 `PROPOSAL_IMAGE_GENERATE` IPC |
| ③ 提示词 | `proposalPrompt.ts`（genimage 新条目 + test） |
| ④ 导出剥除 | `main/core/proposalDocx.ts`、`main/core/proposalExport.ts`、`renderer/src/lib/renderProposalPdfHtml.ts`（+ docx XML 断言测试） |
