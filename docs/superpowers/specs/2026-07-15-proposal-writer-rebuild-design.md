# 写方案 skill 重塑 · 设计文档

- 日期：2026-07-15
- 范围：重塑 `skills/proposal-writer`，并为 app 内三阶段增加「可选」开关
- 状态：设计待用户确认

## 背景与目标

现有 `proposal-writer` 是桌面 app「写方案」功能的**方法论文本供应商**（app 写死路径读
`references/append-template.md`，渲染 `{{占位符}}` 注入系统提示词），本体很薄；三阶段硬门、
知识库检索、Word/PDF 导出、配图卡等重机器全在 app 代码里（`apps/studio/electron/**`，
约 40 个 `proposal*` 文件）。

用户的三点不满意（用户自评，明确**未选**「方法论本身不对」）：

1. **跟 app 绑太死、不灵活**：只能在 app 里用，离开 app 就是残废。
2. **流程别扭**：三阶段确认太死板、不够主动一直问、缺料时处理不好。
3. **写出来的方案质量差**。

目标：把 `proposal-writer` 重塑成一个**多模式、自给自足**的 skill（对标
`skills/gpt-image-2` 的三档降级思路），**支持两类任务——从素材生成 + 改写已有方案**，
并在 app 内把三阶段从「强制」升级为「可选」。

## 非目标（明确不做）

- 不重写 app 的知识库检索 / 导出 / 配图 / 接地校验等成熟子系统。
- 不给 skill 加 `scripts/`（写方案独立模式产出 markdown 即可，无外部 API 要调，YAGNI）。
- 不追求消除 `append-template.md` 与 `SKILL.md` 之间核心纪律的少量文字重复（见风险）。

## 开放问题（待用户拍板）

- 暂无。（G8「改写已有方案」已由用户拍板**纳入本期**，设计见 Part A『两类任务』。）

## 运行模式（两边都要）

模式由**运行环境自动决定**，不是手动开关：

| 运行环境 | 模式 | 谁驱动 | 三阶段 |
|---|---|---|---|
| 桌面 app 内（`/proposal-writer` 或侧栏「写方案」卡） | 满血模式 | app 拦截命令、注入 `append-template.md`、开启全套机器 | Part B 后可选 |
| app 外（CLI / claude.ai / 其他宿主） | 独立模式 | 宿主读 `SKILL.md`，AI 照它写 | 默认一口气，可手动要 |

机制关键：app 内那条路**根本不读 SKILL.md**（现有设计，阶段纪律必须无条件常驻系统提示词）；
只有 app 外才会读 `SKILL.md`——「读到 SKILL.md」这一事实本身即等于「不在 app 里 → 走独立」，
所以独立模式**无需探测脚本**（比 gpt-image-2 更省）。独立模式再细分：

- **有素材档**：用户贴产品资料 / 给文件路径 → 照素材忠实写。
- **无素材·顾问档**：没料 → 只给结构骨架，每处标「待填」，绝不编造。

> 注（G9）：两种默认刻意相反——app 满血默认 `staged`（正式交付、稳字优先）、独立默认一口气（轻量试写、快字优先）。
> 这是按「两种场景不同诉求」有意为之，SKILL.md 与设置项文案都要讲清，避免用户困惑「为啥两边不一样」。

## Part A · 重塑 skill 文件夹（低风险）

### 两类任务：从素材生成 / 改写已有方案（G8）

skill 处理两类意图，SKILL.md 第 0 步先判是哪类：
- **从素材生成（generate）**：从零按类型骨架写新方案（本文档主线）。
- **改写已有方案（edit）**：用户丢一份已有方案 + 修改诉求 → 在原稿上做**最小改动**。

**改写流程**：
1. 摄入已有方案（复用「素材摄入」：docx/pdf/md），解析其**现有目录/结构**——edit 不重新选类型，就在原结构里改。
2. 弄清修改诉求（局部改某节 / 增删章节 / 换风格·受众·篇幅 / 某节逐条化 / 融入新素材 / 重排目录），拿不准一次问清。
3. **最小改动原则**：只改用户要动的部分，其余原样保留（像改代码，不重写整篇）；改动仍守接地底线——
   新增内容要有素材依据，无据则标「⚠️ 资料缺失」，绝不为「改得丰满」编造。
4. 输出：改后的完整 markdown（或仅变更章节，按用户要）。方法论细节见 `methodology/editing-existing.md`。

**模式差异（诚实提醒）**：
- **独立模式**：edit 天然顺——读文件 → 改 → 输出 md。
- **app 满血模式**：改「当前右侧草稿」较轻；但「**导入外部 docx 再改**」需 app 增加导入通道，
  建议列为**后续 / Part B 范畴**，不阻塞本期（本期 app 内 edit 先覆盖「改当前草稿」）。

### 目标文件结构

粒度按用户要求对齐 gpt-image-2 的「分类目录 + 细颗粒叶子卡」，约 50 个文件（光 sections 就 27 张）。

```
skills/proposal-writer/
├── SKILL.md                    ← 变厚：独立大脑（判类型 + 模式说明 + 模板索引 + 独立流程）
├── references/
│   ├── append-template.md      ← 保留契约（app 写死路径读它）；优化文字 + 更新快照
│   ├── methodology/            ← 独立模式方法论，按纪律拆开（每张只讲一件事）
│   │   ├── grounding-and-citation.md   不编造 + 逐句溯源（据《X》）
│   │   ├── gap-marking.md              缺料优雅标注（⚠️ 资料缺失：…）
│   │   ├── images-and-figures.md       嵌图 / mermaid 结构图 / genimage 门面图
│   │   ├── tables.md                   结构化数据表格化
│   │   ├── presentation-modes.md       呈现方式（逐条 / 段落 / 表格 / 图文，各自何时用、怎么写）
│   │   ├── emphasis-and-depth.md       详略与侧重（重点章节展开、次要压缩）
│   │   ├── asking-vs-proactive.md      何时问、何时自主（更主动、少打断）
│   │   ├── flow-oneshot-vs-staged.md   独立流程（默认一口气 / 可选逐段确认）
│   │   └── editing-existing.md         改写已有方案（摄入→最小改动→保留其余→守接地）
│   ├── proposal-types/         ← 类型骨架卡（列「调用哪些 section、什么顺序」）
│   │   ├── presales-construction/      售前建设：拆成骨架 + 行业变体
│   │   │   ├── _skeleton.md               通用骨架（章节顺序 + section 索引）
│   │   │   └── healthcare.md              医疗变体 · 扎实款（照真实范例）
│   │   ├── technical-solution.md      技术 · 单骨架卡〔通用款，含行业适配提示〕
│   │   ├── product-solution.md        产品 · 单骨架卡〔通用款〕
│   │   ├── bidding-commercial.md      投标/商务 · 单骨架卡〔通用款〕
│   │   └── poc-pilot.md               POC/试点 · 单骨架卡〔通用款〕
│   ├── sections/               ← 章节写法卡，按大区分组、拆细
│   │   ├── cover.md                    封面
│   │   ├── overview/                   【概述区】
│   │   │   ├── background.md              建设背景
│   │   │   ├── positioning.md             系统定位
│   │   │   ├── product-summary.md         产品总体概述
│   │   │   ├── goals-by-audience.md       总体目标（患者/医生/机构多视角）
│   │   │   ├── business-scope.md          业务范围
│   │   │   ├── entry-points.md            应用入口
│   │   │   ├── value.md                   建设价值
│   │   │   └── outcomes.md                总体成效
│   │   ├── architecture/               【架构区】
│   │   │   ├── overall-architecture.md    总体架构说明 + 门面架构图（genimage）
│   │   │   ├── business-loop.md           业务闭环架构
│   │   │   ├── functional-architecture.md 功能架构
│   │   │   ├── ai-capability.md           AI 能力架构
│   │   │   ├── key-tech.md                关键技术说明
│   │   │   ├── tech-roadmap.md            技术路线
│   │   │   └── system-traits.md           总体特点
│   │   ├── features/                   【功能详述区】按功能形态拆细（有真实范例做地基）
│   │   │   ├── _pattern-guide.md          功能卡通用总则（小标题→定义→说明→截图→来源）
│   │   │   ├── input-methods.md           输入类（语音/文字/转语音）
│   │   │   ├── dialogue.md                对话类（多轮/引导/新会话/停止/点赞）
│   │   │   ├── recommendation.md          推荐类（科室/医生推荐/对接挂号）
│   │   │   ├── integration.md             接入集成类（公众号/小程序/互联网医院/多院区）
│   │   │   ├── report-generation.md       报告生成类（生成/编辑/回写病历/一键引用）
│   │   │   ├── stats-analysis.md          统计分析类（潮汐/漏斗/画像/各类报表）
│   │   │   └── admin-backend.md           后台管理类（科室/提示词/对话轮次管理）
│   │   └── delivery/                   【交付区】
│   │       ├── implementation-plan.md     实施计划（甘特图）
│   │       ├── after-sales.md             售后服务
│   │       └── pricing-config.md          报价/配置（投标类）
│   ├── quality/                ← 质量自检，拆开
│   │   ├── rubric.md                   交付前打分清单
│   │   └── antipatterns.md             常见反模式（编造/装饰图/层级压平…）
│   └── examples/               ← 好/坏对照（从范例脱敏提炼）
│       ├── good-feature-section.md
│       ├── good-architecture-section.md
│       └── bad-fabricated-section.md
└── NOTES.md                    ← 保留并修正陈旧路径（apps/desktop → apps/studio）
```

**粒度决策（用户拍板）**：
- 功能卡按「功能形态」拆细（input/dialogue/recommendation/integration/report/stats/admin）——有真实范例做地基，每张扎实。
- 行业变体只给**有样本**的「售前建设 × 医疗」做扎实变体（`healthcare.md`）；其余 4 种类型保持单骨架卡，行业差异写成「适配提示」内联，不铺空文件（无样本硬写行业变体＝通用套路×通用套路，虚且违背不编造底线）。将来提供样本再展开对应变体。

### SKILL.md 本体设计（触发器 + 按需加载）

**触发器（frontmatter `description`）（G1）**：`description` 决定「用户说什么话能唤起本 skill」，是命根子。
现有 description 专为 app 写（「请通过 Claude Desktop 输入 /proposal-writer…」），多模式下**必须重写**：
覆盖「写方案 / 售前方案 / 建设方案 / 技术方案 / 产品方案 / 投标方案 / POC 方案 / proposal」等触发词，
让 CLI / claude.ai / 其他宿主也能唤起；同时保留 app 内 `/proposal-writer` 斜杠入口语义。
- **待核实（G10）**：app 斜杠拦截（`FusionRuntimeProvider` onNew）是否认 skill 的 `name`/`description`。
  若认，`name: proposal-writer` **不可改**，只重写 `description` 正文——动手前先核实这一点。

**按需加载（progressive disclosure）（G5）**：约 50 个文件不能一次全塞进上下文（烧钱 + 挤爆）。
SKILL.md 顶部放一份「读取指引」，规定每次只读必要的几张：
1. 永远先读 SKILL.md 本体（判模式 / 判类型 / 采集偏好 / 加载指引）。
2. 按判定类型，读**该类型的 `_skeleton.md`（或 healthcare 变体）**——它列出本方案调用哪些 section 卡、何序。
3. 写到某节时，**只读那一节的 section 卡** + 命中的 methodology 卡（如本节要表格才读 `tables.md`）。
4. **绝不预加载全部 40+ 卡**。SKILL.md 只放**索引**（卡名 + 一句何时用），正文在卡里。

### 售前建设方案骨架（照真实范例《AI 患者服务建设方案》提炼）

- 封面：标题 / 编制单位 / 日期。
- 1 系统功能概述：建设背景 / 系统定位 / 产品总体概述 / 总体目标（面向患者·医生·机构）/
  业务范围 / 应用入口 / 建设价值 / 总体成效。
- 2 系统功能架构：总体架构说明 / 总体架构图 / 业务闭环架构 / 功能架构 / AI 能力架构 /
  关键技术 / 技术路线 / 总体特点。
- 3 系统功能：按业务域分组，每域下叶子功能 =「小标题 + 说明 + 产品截图」；含统计分析子域、
  后台管理子域。
- 真实范例特征：364 段 / 8 表 / 49 图 —— 极度图文并茂，印证「每功能小节配一张截图」的密度要求。

### 类型选择（SKILL.md 第 0 步）

独立模式一上来先**自动判定方案类型**（从用户需求推断，如「给 XX 医院写建设方案」→售前建设款；
「写技术架构方案」→技术款），只有**真判断不出**才用一次 AskUserQuestion 卡问。符合「更主动、少问」。

### 偏好采集（SKILL.md 第 0.5 步）—— 让 skill 面对不同需求能调动

设计原则：**不枚举每个具体请求，而是抽象出「变化维度」让 AI 每次采集，并把「呈现套路」沉淀成可复用模式卡。**
写死「客户 A 要逐条」无意义（下个客户就变）；沉淀「逐条 vs 段落」模式 + 让 skill 每次搞清客户要哪种，才一劳永逸。

- **采集维度**（遵循「更主动、少问」：能从需求推断的先推断，拿不准才一次性问；并尊重用户随时下的指令，如「这节逐条」「这章重点写安全性」）：
  - 展示方式：逐条列举 / 散文段落 / 表格 / 图文并茂
  - 详略与侧重：哪些章节重点展开、哪些压缩带过（「某目录下侧重重点」落在这）
  - 篇幅：精简版 / 标准 / 详尽
  - 受众 / 语气：技术评委 / 采购决策者 / 高层汇报
- **落地**：偏好在会话内持续生效并逐节应用；`presentation-modes.md` / `emphasis-and-depth.md`
  给出每种呈现怎么写好；每张 section 卡补一行「本节常见呈现变体」（如「建设价值」常用逐条、
  「技术路线」常用表格+图）。

### 独立模式流程重设（治三死板 / 一直问 / 缺料）

- **默认一口气出初稿**：不强制逐阶段停下确认。AI 自主挑模板 → 定骨架 → 填素材 → 连续产出
  封面+目录+正文，最后**一次性**征求修改意见。
- **可选三阶段**：用户说「我们一步步来 / 分封面·目录·正文逐段确认」→ 切回逐阶段确认。
- **更主动、少打断**：挑模板 / 定结构 / 表格 vs 散文，AI 自主决定；只有「关键事实缺失且卡住正文」
  才问，且合并成一次问。
- **缺料优雅标注**：查不到就地写「⚠️ 资料缺失：<具体缺什么>」留在正文，不硬编、不静默跳过、
  不报错打断（沿用现有 GAP 约定，标准化进 SKILL.md）。

### 独立模式：素材摄入 + 产出降级（G2 / G3，独立模式能否出活全看这）

独立模式没有 app 的知识库 / genimage 执行器 / docx 导出器，**必须明确降级行为，否则会诱发编造**。

**素材摄入（G3）**：
- 用户贴文本 → 直接作源料。
- 用户给文件路径（docx / pdf / md / 图片 / 文件夹）→ 读取并组织：docx/pdf 先抽文字（docx 是 zip，取
  `word/document.xml`；无解析手段时提示用户改贴文本），图片登记为「可引用截图」，文件夹递归收集。
- 摄入后先给用户一份「我从素材里读到了什么」的简表，再开写——让接地有据、也让用户及早发现缺料。

**产出降级（G2 / G12）**：
- **配图**：独立模式**没有截图库**，**严禁编造图片路径**（违反接地底线）。改为——① 结构图一律用
  **mermaid**（纯文本、不依赖图库）；② 需要产品截图处写占位「〔建议插入：XX 界面截图〕」，绝不写 `![]()` 假路径；
  ③ 仅当用户确有本地图片素材时才用真实路径嵌入。
- **门面架构图（genimage）**：独立模式**不执行生图**，退化为「仅输出 genimage 描述块 + 提示用户可自行拿去出图」
  （对标 gpt-image-2 顾问档）。
- **导出与序号**：独立模式只产 markdown；封面用 `---` 分隔的纯 markdown；**序号由 AI 手动补**（无导出器自动编号——
  这与 app 满血「不要自己写序号」相反，属 mode 相关规则，SKILL.md 要分模式讲清）；目录也由 AI 按最终章节手写。

### 长文档一致性（G4）

真实方案可达数百段，「一口气出」易撞上超上下文 / 术语漂移 / 跑偏已定目录。策略：
- **逐章产出**：定好目录后一次聚焦一章连续写，而非真在一条消息里吐完整篇。
- **维护运行中的「目录 + 术语表」**：把已确认章节标题、关键术语/缩写的统一译法记在手边，逐章复用防前后不一。
- 章节标题与顺序严格以已定目录为准，不中途增删。

### append-template.md 改进（惠及 app 满血模式）

- 把「更主动 / 少问」「缺料优雅标注」两条加强进方法论文本——这两条不与 app 硬门冲突，纯文字改。
- 补一句「尊重用户的呈现/侧重偏好」（逐条 vs 段落、重点章节详写、篇幅、受众语气）——app 满血模式同样受益。
- 更新快照测试基线（`bun test` 相关 `proposalPrompt*` + `--update-snapshots`，`.snap` 一起提交）。
- **不动**三阶段硬门（那是 Part B）。

## Part B · app 内「三阶段可选」开关（较高风险，隔离进行）

三阶段由两层驱动：① 提示词层（`append-template.md` 让 AI 每阶段停下确认）；② 执行层
（app 状态机 + 硬门：没确认就丢弃早到的正文）。要变「可选」两层都要能切换。

- **设置项**：`appSettingsNormalize.ts` 的 `AppSettings` 加 `proposalStageMode: 'staged' | 'oneshot'`，
  **默认 `staged`（逐段确认，用户拍板）**；`getAppSettings` / `updateAppSettings` 已具备读写。
- **提示词注入**：`proposalPrompt.ts` 按 `proposalStageMode` 注入两套方法论变体
  （staged = 现有三阶段；oneshot = 一口气出稿 + 结尾一次征求修改）。
- **执行层放松**：动手**第一步**先精确定位「硬门」丢弃逻辑（`proposal.ts` / `engine.ts` /
  `proposalDraftStore.ts` / renderer 待核实），oneshot 模式下不丢弃早到正文。
- **UI 开关**：设置页加一个「方案生成方式：逐段确认 / 一口气出稿」选择（走已在迁 chat 栈的
  设置页；shadcn 原语 + utility）。
- **快照/契约测试**：更新 `proposalPrompt.snapshot.test.ts` 等基线。

## 耦合契约与风险

- **契约**：`proposalPrompt.ts` 写死读 `skills/proposal-writer/references/append-template.md`，
  内含 `{{占位符}}`（哨兵 / GAP 前缀 / 确认 header）。此文件**不可挪、不可删**；改文字必触发
  快照测试（有意更新）。协议字样事实源在 `apps/studio/electron/shared/proposal.ts`。
- **风险 0 · 改 append-template 有两类测试后果（G6，别低估）**：① **快照测试**（`proposalPrompt.snapshot` 等）——
  文字一改就 diff，确认后 `--update-snapshots` 刷新即可，无害；② **契约测试**（`proposalPromptTemplate.test` 等）——
  哨兵 / 「⚠️ 资料缺失：」前缀 / 确认 header 是解析器**逐字节匹配的硬协议**，动到占位符附近措辞可能**真回归**，
  不是刷快照能了事。改 append-template 时**只动散文、不碰占位符及其贴邻常量**；改前先读 NOTES.md 的两段警告。
- **风险 1 · 双份方法论漂移**：`append-template.md`（app 用）与 `SKILL.md`（独立用）各写一份，
  核心纪律（不编造 / 标来源 / 图文并茂）少量重复，将来可能改一份忘一份。v1 接受，NOTES.md
  写明「这两处的『不编造 / 溯源』底线必须同步改」。
- **风险 2 · Part B 触碰成熟子系统**：三阶段是交付给客户的正式流程，放松硬门若有回归会直接
  影响成品质量。故 Part B 与 Part A 分离、独立验证、可单独回退。
- **风险 3 · 通用款质量**：技术/产品/投标/POC 四种无真实样本，为通用套路，卡内显眼标注
  「通用款·待升级」；用户后续提供样本即升级对应单卡，不影响其他。

## 分阶段与验证

- **先做 Part A**（安全、见效快）：完成后 `bun run typecheck` + `bun test`（proposal 相关），
  并在 app 内 + CLI 各跑一遍写方案看行为。
- **质量验收（G7）**：跑通 ≠ 写得好。用真实范例《AI 患者服务建设方案》的**源料**喂新 skill 重新生成，与真品对比：
  章节结构是否对齐、是否逐句可溯源、图文/结构图密度是否达标、有无编造、缺料标注是否到位——以此作为「质量比旧版好」
  的证据，而非口号。（可借 skill-creator 的 eval 能力做成可重复评测。）
- **再做 Part B**（隔离）：第一步先定位并写清硬门逻辑，再加开关；每步 `bun run typecheck` +
  相关快照/契约测试通过后再继续。
- 全项目无 ESLint、typecheck 是主要自动化防线；proposal 子系统有 bun test 快照/契约测试。
