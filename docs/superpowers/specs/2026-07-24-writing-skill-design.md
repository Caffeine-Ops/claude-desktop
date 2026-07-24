# writing skill 设计方案

> 面向微信文案 / 短篇小说 / 文章的工程化写作技能，参照 `skills/ppt-master`
> 的流水线架构。2026-07-24 定稿。

## 目标

在 Cowork 里提供一个与 ppt-master 同量级的写作技能：用户点「智能助手 → 设计创意 →
写作」，或在聊天框输入 `/claude-desktop:writing`，即可从零创作或改写三类文本：

- **微信文案** — 带货/推广推送、拼团/裂变活动、私域运营话术、直播/新品预告
- **短篇小说** — 悬疑推理、言情情感、科幻奇幻、都市脑洞、治愈温情、轻松搞笑
- **文章** — 行业观察、产品评测、方法论总结、技术科普

**明确不做**：长篇小说 / 连载（需要跨会话的世界观与人物长期记忆，本轮排除）。

## 为什么是流水线而不是一份提示词

调研了 9 个同类开源技能（见文末），共同问题是：**方法论写得再好，也架不住长文写作
的三个工程缺陷**。ppt-master 用四个机制解决了同构的问题，本设计逐条对应：

| ppt-master 机制 | 本设计的对应物 | 解决什么 |
|---|---|---|
| 策划/执行/质检多角色串行 | 策划 → 写手 → 审校 → 润色 | 边写边自评会护短；换角色重读才挑得出毛病 |
| 八项确认 ⛔ BLOCKING 硬门 | 八项确认（两层：锚点 → 实现层） | 方向错了整篇废掉，该问的一次问清 |
| `spec_lock.md` 每页重读 | 写作契约每节重读 | 长文写到后面人物漂移、文风变了、禁用词回潮 |
| `svg_quality_checker.py` | `ai_slop_checker.py` 等 4 个脚本 | 质检不靠自我感觉，靠可计算的统计信号 |
| 19 种视觉风格 / 5 种叙事模式库 | 8 种文风 / 15 种结构模式库 | 风格与题材是正交维度，必须独立锁定 |

其中**写作契约（`spec_lock.md`）是整个设计的心脏**。ppt-master 在该规则处的注释写得
很直白：*「这条规则的存在是为了抵抗长文档的上下文压缩漂移」*。写 6000 字小说与做 30 页
PPT 是同一类问题——写到后半段，模型早已丢失开头定下的约束。把约束从脆弱的对话上下文
挪到硬盘文件、并强制每节重读，是唯一可靠的解法。

## 一、目录结构

```
skills/writing/
  SKILL.md                    主管线 + 全局执行纪律 + 角色切换协议
  bin/ensure-python.sh|.cmd   Python 环境自举（照抄 ppt-master）
  requirements.txt

  scripts/
    project_manager.py        项目 init / validate
    source_to_md/             素材转 Markdown（PDF / Word / 网页 / 公众号文章）
    style_profile.py          从往期文章提取个人文风档案
    ai_slop_checker.py        AI 味检测（核心质检，见 §五）
    readability_check.py      平台合规：段落长度 / 小标题密度 / 字数
    continuity_check.py       连贯性检查（小说：伏笔回收 / 人物名 / 设定一致）
    update_spec.py            改写作契约并同步已写章节（见 §三）
    export.py                 导出：公众号 HTML / docx / md / txt
    README.md

  references/
    strategist.md             策划岗位说明书
    writer-base.md            写手通用基本功（三体裁共用）
    editor.md                 审校岗位说明书（诊断方法论）
    polisher.md               润色岗位说明书
    shared-standards.md       中文写作硬规矩（标点 / 数字 / 引号 / 长句拆分）
    anti-ai-slop.md           去 AI 味总纲（套话库 + AI 句式库 + 书面词替换库）

    voices/                   文风库（8 种 + _index.md）
      leng-jun-ke-zhi.md      冷峻克制
      shi-jing-yan-huo.md     市井烟火
      xi-xue-you-mo.md        戏谑幽默
      wen-yi-shu-qing.md      文艺抒情
      ying-he-gan-lian.md     硬核干练
      wen-run-xi-ni.md        温润细腻
      kou-yu-lao-ke.md        口语唠嗑
      xue-shu-yan-jin.md      学术严谨

    structures/               结构模式库（15 种 + _index.md）
      story/                  五段式 / 双线交织 / 倒叙悬念 / 环形结构 / 书信体
      copy/                   PAS / AIDA / 故事带入 / 清单体 / 对比反差
      article/                金字塔 / 层层递进 / 问答式 / 时间线 / 破立结合

    genres/                   体裁 × 题材手册（3 份 core + 14 份细分）
      wechat/  core.md + 带货推广 / 拼团裂变 / 私域运营 / 直播新品
      story/   core.md + 悬疑 / 言情 / 科幻 / 脑洞 / 治愈 / 搞笑
      article/ core.md + 行业观察 / 产品评测 / 方法论 / 技术科普

  templates/
    design_spec_reference.md  写作方案骨架（策划填）
    spec_lock_reference.md    写作契约骨架
    character_sheet.md        人物档案模板
    foreshadow_table.md       伏笔表模板
    export_styles/            公众号 HTML 排版主题

  workflows/                  独立工作流（7 个，不走主管线）
    style-learn.md            学习个人文风 → 存成可复用档案
    topic-research.md         写前查资料（文章类刚需）
    rewrite.md                改写已有文稿（先诊断后定向改）
    polish-only.md            只润色不重写
    resume-writing.md         换窗口续写（长文分两阶段）
    serialize.md              一稿多平台改编（公众号 → 小红书 → 知乎）
    batch-titles.md           标题批量生成 + 打分挑选

  projects/<项目名>_<日期>/
    sources/    用户素材（原始文件 + 转好的 Markdown）
    analysis/   机器提取的事实（素材摘要 / 文风分析 / AI 味基线分）
    drafts/     初稿分节
    reviews/    质检报告
    output/     定稿 + 各平台导出
    design_spec.md            人类可读的写作方案
    spec_lock.md              机器可读的写作契约
```

**资源库读取纪律**（照抄 ppt-master）：每个库带 `_index.md` 索引，**只读锁定的那一个
文件，禁止 glob 整个目录**——省上下文，也避免模型在十几种风格之间摇摆。

## 二、主管线

```
Step 1 素材处理（可选）  → Step 2 项目初始化 → Step 3 文风学习（条件触发）
  → Step 4 策划 ⛔ 八项确认 → Step 5 查资料（条件：文章类且论据不足）
  → Step 6 写作（逐节，每节重读契约） → Step 7 质检 → Step 8 润色 → Step 9 导出
```

**Step 4 是唯一的硬门。** 确认落地后，Step 5–9 全自动连续跑完，不再打断用户。

### 全局执行纪律（写进 SKILL.md 顶部）

1. **串行执行** — 各 Step 按序执行，上一步的产出是下一步的输入
2. **⛔ BLOCKING = 硬停** — 八项确认必须等到用户明确回复，禁止代替用户决策
3. **禁止跨阶段捆绑** — 不许把确认和产出塞进同一轮
4. **禁止投机执行** — 策划阶段不许提前写正文
5. **每节重读契约** — 写手每写一节前必须 `read_file spec_lock.md`
6. **逐节顺序生成** — 禁止批量并行、禁止分批打包（如「一次写 3 节」）
7. **禁止脚本批量生成正文** — 正文由主 agent 逐节手写。ppt-master 在分支上试过脚本
   批量生成并废弃，理由是「跨页一致性依赖逐页带完整上文创作」；写作同理且更严重
8. **禁止子 agent 代写正文** — 与规则 7 同源

### Step 4：八项确认

两层结构。**先确认锚点，AI 再依据用户的真实选择重新推导实现层**——避免「你把体裁
改成小说了，篇幅还是按文案推荐的 800 字」这类不协调。

| # | 确认项 | 层 | 说明 |
|---|---|---|---|
| 1 | 体裁 | 锚点 | 微信文案 / 短篇小说 / 文章 |
| 2 | 题材·场景 | 锚点 | 14 个细分之一 |
| 3 | 目标读者 | 锚点 | 自由文本，如「通勤时刷手机的上班族」 |
| 4 | 核心信息 / 情绪落点 | 锚点 | 文案＝转化目标；小说＝读完什么感觉；文章＝核心论点 |
| 5 | 篇幅 | 实现层 | 由内容量 × 平台推导 |
| 6 | 文风 | 实现层 | 从 8 种文风库推荐 **≥3 个候选**供选 |
| 7 | 结构模式 + 人称视角 | 实现层 | 结构从对应体裁的 5 种里选 |
| 8 | 平台格式 + 禁用清单 | 实现层 | 公众号段落 ≤150 字等硬指标 + 禁用词表 |

**确认值优先于 AI 推荐**：用户改过的字段一律照办；用户没碰、但因锚点变更而失去
协调性的下游字段，重新推导并在交接说明里讲明调整了什么。

**本轮走聊天确认**，不做原生确认页。ppt-master 的两层确认页机制（`confirm_ui` +
CanvasConfirm）已存在，未来若要升级可直接复用，届时聊天路径仍作为兜底保留。

### Step 6：写作阶段

- 按 `design_spec.md` 的分节大纲逐节写
- **每节开写前 `read_file spec_lock.md`**，取出：文风、人称、禁用清单、本节字数区间、
  本节要碰的人物档案与伏笔状态
- 写完一节，更新契约里的伏笔表状态（`已埋未收` → `已回收`）

## 三、写作契约（`spec_lock.md`）

机器可读的执行契约，字段随体裁裁剪（小说专用段落在文案/文章项目里不出现）。

```
## 体裁
- genre: short-story
- sub: 悬疑推理

## 目标
- audience: 通勤时刷手机的上班族
- emotional_target: 意难平
- core_message: 真相有时比谎言更残忍

## 文风锁定
- voice: 冷峻克制
- person: 第三人称限知
- colloquial_level: 3/5

## 结构
- structure: 倒叙悬念
- total_words: 6000
- section_words: 800-1200

## 人物档案（小说专用）
- 张明 | want:找到妹妹 | need:原谅自己 | wound:车祸中独自生还
       | lie:"活下来的人不配幸福"
       | 语料:"……我知道。"（他从不说完整的句子）

## 伏笔表（小说专用）
- 001 | 埋点:第2节 抽屉里的钥匙 | 回收:第5节 | 状态:已埋未收

## 禁用清单
- 禁用词: 首先/其次/最后, 综上所述, 值得注意的是, 不难看出
- 禁用句式: "这不是A而是B", 三段式排比, "既…又…"

## 平台格式
- platform: 公众号
- paragraph_max: 150
- subhead_every: 500
```

**修改契约要走 `scripts/update_spec.py`**（对应 ppt-master 的同名脚本）：改文风、禁用
清单或人物档案后，脚本负责标出受影响的已写章节、交由润色角色回改。手动编辑契约文件
不会追溯已写内容，属已知限制，在 SKILL.md 里写明。

## 四、四个角色

| 角色 | 职责 | 禁止事项 |
|---|---|---|
| 策划 Strategist | 读素材、定方案、填 `design_spec.md` + `spec_lock.md` | 禁止提前写正文 |
| 写手 Writer | 按契约逐节写 | 禁止改契约、禁止批量生成 |
| 审校 Editor | 跑脚本 + 人工诊断，产出问题清单 | 只诊断不动手改 |
| 润色 Polisher | 按清单定向改 | 禁止推翻重写；改味不改错，删最少字换最大效果 |

角色切换时显式宣告 `[角色切换：审校]`，让用户看得见现在是谁在说话。

**审校与润色分离的理由**：让同一个角色边写边自评，它会护短；换个角色重新读，才挑得
出毛病。这是 ppt-master「多角色协作」的核心价值，不是形式主义。

## 五、质检机制

### `ai_slop_checker.py` — 五维打分（满分 50，**< 35 打回重写**）

| 维度 | 计算方式 | 依据 |
|---|---|---|
| 结构均匀度 | 句长方差 + 段落长度分布 | **AI 味的首要信号**：句子长得整整齐齐就是破绽，光换词无效 |
| 禁用词密度 | 每千字命中次数 | 「首先/其次」「综上所述」「值得注意的是」 |
| AI 句式密度 | 正则匹配 | 「这不是 A 而是 B」、三段式排比、「既…又…」 |
| 书面腔浓度 | 动词名词化比例、「的」字密度 | 「进行操作」→「用」 |
| 具体度 | 数字/专名/细节密度 ÷ 形容词密度 | AI 爱堆形容词、不给具体事实 |

输出**定位到行号**的问题清单，分级 🔴必须改 / 🟡建议改 / 🟢可选。

### `continuity_check.py` — 小说连贯性

从契约读人物档案与伏笔表，扫描正文：埋了没回收的伏笔、写错的人物名、与档案矛盾的
设定，逐条列出并给出行号。

### 读者评分团 — 审校的第二关

跑完脚本后，AI 扮演 3–5 个不同身份的读者（目标读者 / 杠精 / 编辑）各打 1–10 分，
**均分 ≥8 才放行**。低于阈值时回到润色，最多两轮；两轮仍不过关则如实报告并交还用户
决定。

## 六、改写模式

三个体裁共享「**先诊断，后定向改**」原则，但诊断工具不同：

| 体裁 | 诊断工具 |
|---|---|
| 微信文案 | AI 痕迹仪表盘（脚本五维分 + 转化要素缺失项）→ 三级清单 |
| 短篇小说 | GCOS 场景自查（目标-冲突-结果-后续）+ 连贯性脚本 + 去 AI 味分级 |
| 文章 | 七轮扫描（清晰度 → 语气 → 「所以呢」→ 举证 → 具体化 → 情绪浓度 → 消除犹豫） |

用户若已明确说了改写方向（「改口语一点」「压到 800 字」），直接按方向改，跳过完整
诊断；只说「帮我改一下」才走全套诊断。

改写同样落项目目录：原文进 `sources/`，诊断报告进 `reviews/`，改写稿进 `output/`——
用户可以对照看改了什么、为什么改。

## 七、应用入口

「设计创意」分类新增 1 张**「写作」卡**，与「生成图片」「制作视频」平级。后端零改动
（`skills/.claude-plugin/plugin.json` 已把整个 `skills/` 注册为本地插件，新目录自动
获得 `/claude-desktop:writing` 触发能力）。前端改三处，全部照抄 imagegen/remotion 的
现成模式：

1. `apps/studio/public/skill-icons/writing.png` — 新图标，沿用现有蓝色渐变圆角方块 +
   白色线条图形的视觉系列（用 `draw` 技能生成，不复用「写方案」的 `write.png`）
2. `apps/studio/src/chat/composer/skillChipRegistry.ts` — 登记 chip，
   **namespaced + 裸名成对注册**（`/claude-desktop:writing` 与 `/writing`）
3. `apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx` —
   - `CATEGORIES` 的 `design` 分类 `items` 加一条
   - `PROMPTS_BY_SKILL` 加 `writing` 的 5 条预设：
     公众号文案 · 短篇小说 · 文章 · 改写这段文字 · 学我的文风

**不做客户端拦截**：走 imagegen/remotion 的「真实 skill，斜杠命令原样发给 CLI」路径。
proposal-writer 的拦截路径是全局唯一特例（它需要方案模式那套有状态的双栏工作台），
本技能无此需求，照抄会平白引入 `startOrReopenProposal`、`ComposerModeStore` 一整套
状态机。

题材细分（悬疑/带货/科普…）**不露出成按钮**，由 SKILL.md 在对话里追问或自动识别——
UI 保持简洁，深度放在内容里。

## 八、范围边界

**本轮做**：三体裁 × 14 细分场景、从零写 + 改写、四角色流水线、写作契约、三个质检脚本
（AI 味 / 可读性 / 连贯性）+ 素材与导出工具、七个独立工作流、聊天确认、1 张 UI 卡片。

**本轮不做**：
- 长篇小说 / 连载（跨会话世界观与人物长期记忆）
- 原生确认页（复用 ppt-master 的 confirm_ui 机制，未来可补）
- 跨会话的「写作偏好」长期记忆（每个项目独立，靠 `style-learn` 产出的文风档案手动复用）

## 附：调研来源

微信文案 / 文章方向：
[wordflowlab/article-writer](https://github.com/wordflowlab/article-writer)、
[TanShilongMario/ArticleSkill](https://github.com/TanShilongMario/ArticleSkill)、
[xiaomoBoy/claude-writing-skills](https://github.com/xiaomoBoy/claude-writing-skills)、
[boraoztunc/skills](https://github.com/boraoztunc/skills)、
[coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills)、
[ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)

小说方向：
[worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)、
[danjdewhurst/story-skills](https://github.com/danjdewhurst/story-skills)、
[rhavekost/author-toolkit](https://github.com/rhavekost/author-toolkit)

架构范本：本仓库 `skills/ppt-master`
