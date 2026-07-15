# 方法论纪律的来龙去脉（自 proposalPrompt.ts 迁移，2026-07-03）

模板正文见 `references/append-template.md`。下面每段解释「为什么这样写而不是那样写」，
原为 buildProposalAppend 数组元素间的行间注释，模板化后无处安放、迁到这里。

## 提问纪律（AskUserQuestion 硬约束）
> 提问纪律：硬性约束——AI 在写方案全程任何需要用户回答/拍板的问题，都必须经
> AskUserQuestion 工具发起，绝不在普通回复文字里直接问。该工具在本应用里会被渲染成
> 内联的可点选卡片（见 AskUserQuestionView），比让用户在聊天框里逐句敲答案体验好得多，
> 也能把答案结构化回传。即便是「客户单位全称」这类开放式信息也走它——工具自带「其他」
> 自由填写项兜底，用户没有合适候选时可直接键入。

## 资料缺失标记（P3-2）
> 资料缺失标记（P3-2）：底线仍是「绝不编造」，但缺口的落点从「甩在对话里飘走」改为
> 「写进正文哨兵块内、缺料的那一行」——这样它锚定到所在章节、随草稿持久化、在预览/导出里
> 可见，界面会把全篇缺口汇总成清单供用户补料。前缀「⚠️ 资料缺失：」务必原样保留，renderer
> 据它（GAP_RE）识别聚合（见 shared/proposal.ts parseGaps）。

## 表格化呈现
> 表格化呈现：源料是结构化数据时用 GFM 表格，而非摊成散文。接地纪律与第 3 条同源——
> 表里每个值都必须来自镜像原文，空缺写「—」而非编造（客户据此采购，编表与编文等害）。
> 用表 vs 用段的判断权交给 AI（与「AI 自动、数据支持就用」一致），拿不准走 AskUserQuestion。

## 积极嵌图（配图密度增强 ①）
> 嵌图（配图密度增强 ①）：措辞从「拿不准就不插」反转为「有相关图就应插」+ 明确密度目标——
> 对标客户方案的「每个功能小节配一张产品截图」排布。同源约束（只能用本节已引用文件名下的
> 图）原样保留，这是接地底线：防止往客户方案塞 logo/无关装饰图。封面/目录不插图。

## Mermaid 结构图（配图密度增强 ②）
> Mermaid 结构图（配图密度增强 ②）：从条件式「当某节要表达…时」升级为密度要求——每个一级章
> 有事实可依就应至少一张。知识库配图是「引用既有位图」，这条是「按方案设计画结构图」，互补。
> 底线仍是溯源：图里的组件/步骤/环节必须来自原文事实，绝不为「画得好看」编造不存在的模块。
> mermaid 是 code 块、不走 ![]() 接地校验，故纪律全靠这条提示词约束。

## genimage 彩图指令（配图密度增强 ③）
> AI 彩图指令（配图密度增强 ③）：mermaid 管日常结构图；门面级架构图（总体架构/业务闭环/
> 能力全景）用生图模型出彩图，观感对标专业美工。AI 只负责在正文里留一个 genimage 指令块，
> 真正的生图由应用在落节时自动调出图 API、走「先审后落地」的图片审阅卡——AI 自己不调工具、
> 不知道也不需要知道生图何时完成。数量硬限 3 个防费用失控（renderer 另有每会话 5 次兜底）。

## 哨兵规则
> 哨兵规则：把「要收入文档的正文」与「提问/过程对话」物理分开。renderer 只把哨兵
> 之间的内容累积进右侧方案文档；不带哨兵的输出（提问、确认、说明）不会进文档。
> 编号从 5 改为 6 以延续「哨兵/中文」两条硬纪律的既有措辞，与阶段块混排是有意的
> ——三阶段块用中括号小标题更醒目，不必追求连号。

## HTML 禁令
> HTML 禁令：哨兵之间的正文会被原样收进右侧文档并导出 Word。AI 曾为「封面居中」自作主张
> 输出 <div align="center">、<br>、</div> 等裸 HTML——预览用的 react-markdown 未启用
> rehype-raw，这些标签会原样当成纯文本显示、污染成品（见用户反馈）。居中、留白、分页等
> 排版交给导出器处理，正文里只写纯 markdown。

---

# 开发者维护指引（2026-07-15 多模式重塑后补；原住 SKILL.md「维护须知」，重写后迁来此处）

本 skill 2026-07-15 从「app 专用薄模板」重塑为**多模式、自给自足**：`SKILL.md` 是 app 外独立模式的大脑
（判模式/任务/类型、按需加载 `references/` 下约 50 张卡）；`references/append-template.md` 仍是 app 满血
模式的注入契约。两侧并存，改动前务必分清改的是哪一侧。

## app 如何消费本 skill（满血模式）

- **注入**：`apps/studio/electron/main/core/proposalPrompt.ts` 的 `buildProposalAppend` **按目录名**读
  `skills/proposal-writer/references/append-template.md`，渲染 `{{占位符}}` 后注入系统提示词。
  **app 根本不读 SKILL.md**（阶段纪律必须无条件常驻系统提示词）。
- **斜杠拦截**：`apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx`（onNew）+
  `apps/studio/src/chat/lib/proposalSlash.ts` 的硬编码 `PROPOSAL_WRITER_SLASH_NAMES`
  （`claude-desktop:proposal-writer` / `proposal-writer`）。**拦截认目录名/命令名，不读 frontmatter**——
  故 `SKILL.md` 的 `description` 可自由改，但 **`name` 保持 `proposal-writer`、目录 `proposal-writer/` 不可改名**。
- **协议事实源**：`apps/studio/electron/shared/proposal.ts`（哨兵、`⚠️ 资料缺失：`＝GAP_PREFIX、确认 header 等）。

## 改 append-template.md 的纪律（高危）

- **只动散文，绝不碰 `{{占位符}}` 及其贴邻常量**（哨兵/GAP 前缀/确认 header 是解析器逐字节硬协议）。
- 改后测试**从 `apps/studio` 跑**（cwd 决定 skills 插件目录解析，仓库根跑会全红）：
  - 契约测试（先跑，必须 PASS）：`cd apps/studio && bun test electron/main/core/proposalPromptTemplate`
  - 快照（刷新基线）：`cd apps/studio && bun test electron/main/core/proposalPrompt.snapshot --update-snapshots`，`.snap` 一起提交。
- 两类后果别混：契约测试红＝碰到硬协议要回退措辞；快照红＝散文改动，刷新即可。

## 双份方法论的漂移警告（重要）

核心底线（**不编造 / 逐句溯源（据《X》）/ 缺料标注 / 图文并茂**）在 `append-template.md`（app 用）
与 `SKILL.md`＋`references/methodology/`（独立用）**各写了一份**。改其中任一处的这些底线纪律，
**必须同步改另一处**，否则两种模式行为漂移。v1 有意接受此重复（彻底消除需更大重构）。
