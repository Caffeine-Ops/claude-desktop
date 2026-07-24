# 写作契约（spec_lock）

> **⚠️ 这是给策划看的骨架，不要原样抄进项目。** 产出 `<project>/spec_lock.md` 时，**只输出 `##` 段头与填好的 `- key: value` 数据行**；本文所有 `>` 引用块、示例注释、候选值列表都是**作者期指引**，不是运行期数据，一律不要抄进去。
>
> 契约是机器与写手共同读的**执行合同**：写手每节都 `read_file` 它取约束，`continuity_check.py` / `readability_check.py` 也机读它取字段。混进散文注释会干扰机读、也稀释写手要抓的约束。契约必须**干净、可机读、每行一个字段**。
>
> **段名固定**（`scripts/update_spec.py` 的 `IMPACT_MAP` 认这 8 个段头，逐字对齐）：`体裁` / `目标` / `文风锁定` / `结构` / `人物档案` / `伏笔表` / `禁用清单` / `平台格式`。段名写错，改契约脚本会当成新段追加、连贯性检查读不到该段。
>
> **改契约走脚本**：SVG 生成开始后要改字段，用 `scripts/update_spec.py` 改，它会同步标出受影响、需回改的已写章节，别手改（手改容易忘了回改正文）。

## 体裁
- genre: short-story
- sub: 悬疑推理

> `genre` 三选一：`short-story`（短篇小说）| `wechat`（微信文案）| `article`（文章）。
> `sub` = 题材/场景名，取自对应体裁手册的题材表：`references/genres/story/_index.md`（悬疑推理/言情情感/科幻奇幻/都市脑洞/治愈温情/轻松搞笑）、`references/genres/wechat/_index.md`、`references/genres/article/_index.md`。

## 目标
- audience: 25-35 岁、爱看反转短故事的通勤读者
- emotional_target: 意难平

> 四个字段按体裁取用，填相关的、删无关的（`parse_spec_lock` 只读存在的行，缺行不报错）：
> - `audience`（三体裁都填）：自由文本，写给谁看。
> - `emotional_target`（**小说填**）：六选一，取自 `references/genres/story/core.md`——`意难平` / `反转震撼` / `爽感释放` / `治愈` / `细思极恐` / `共鸣`。只能选一个。
> - `conversion_goal`（**文案填**）：读者读完应该做的那一个动作（今晚下单 / 点击领券）。
> - `core_message`（**文章填**）：一句话论点。

## 文风锁定
- voice: 冷峻克制
- person: 第三人称限知
- colloquial_level: 2/5

> `voice` 取自 `references/voices/_index.md`（8 种：冷峻克制/市井烟火/戏谑幽默/文艺抒情/硬核干练/温润细腻/口语唠嗑/学术严谨），或字面量 `custom`。
> `custom` 时**补一条兄弟行** `- voice_behavior: <一段散文>`，具体到写手能照着落笔（爱用什么句式、避开什么词、情绪档位往哪压）——写手只读契约，读不到聊天记录。
> `person` 三选一：`第一人称` | `第三人称限知` | `第三人称全知`（按 `shared-standards.md §5` 定）。
> `colloquial_level` 口语化程度 `1-5`/`5`（1 最书面、5 最口语）。

## 结构
- structure: 倒叙悬念
- total_words: 2400
- section_words: 800-1200

> `structure` 取自对应**体裁组**的结构库索引，**注意子目录名与体裁不一定同名**：
> - 小说 → `references/structures/story/_index.md`（五段式/双线交织/倒叙悬念/环形结构/书信体）
> - 微信文案 → `references/structures/copy/_index.md`（PAS/AIDA/故事带入/清单体/对比反差）**（注意是 copy，不是 wechat）**
> - 文章 → `references/structures/article/_index.md`（金字塔/层层递进/问答式/时间线/破立结合）
> 或字面量 `custom`（同 `voice`，补 `- structure_behavior:` 兄弟行）。
> `total_words` 整数总字数；`section_words` 每节字数区间 `<下限>-<上限>`（小说/文章建议 800-1200）。

## 人物档案
- 张明 | want:找到失踪的妹妹 | need:原谅自己 | wound:车祸中他独自生还 | lie:活下来的人不配得到幸福 | 语料:……我知道。你不用说了。
- 林珊 | want:查清丈夫死因 | need:走出丧夫的自责 | wound:出事那晚她拒接了丈夫电话 | lie:是我害死了他 | 语料:电话我没接。就这么简单。

> **⚠️ 竖线字段名由 `scripts/continuity_check.py` 的 `parse_characters` 逐字解析——`want` / `need` / `wound` / `lie` / `语料` 五个名字一个字都不能改，改名字必须同步改脚本，否则字段静默解析成空、连贯性检查形同虚设。**
> 行格式：`- <人物名> | want:… | need:… | wound:… | lie:… | 语料:…`。分隔符 `|` 与字段冒号 `:` **都用半角**（脚本按半角 `|` 切记录、半角 `:` 切字段）。字段值内部可用全角标点。
> Core Four 定义见 `references/genres/story/core.md §写作手法①`；每个有名字的人物都要登记，主角必须能追问「为什么」追到 wound。`语料` 填 2-3 句该人物的示例台词，写手照它的说话习惯写。
> 非小说体裁可整段省略此段。

## 伏笔表
- 001 | 埋点:第2节 抽屉里那把不知开哪的黄铜钥匙 | 回收:第5节 反转时打开保险柜 | 状态:已埋未收
- 002 | 埋点:第1节 妹妹手机壳上的划痕 | 回收:第5节 认出遗物 | 状态:已规划

> **⚠️ 竖线字段名由 `parse_foreshadows` 逐字解析——`埋点` / `回收` / `状态` 三个名字不能改，改名同步改脚本。**
> 行格式：`- <三位编号> | 埋点:… | 回收:… | 状态:…`。编号三位数字（`001`/`002`…），分隔符与冒号同样**半角**。
> `状态` 三态：`已规划`（还没埋）| `已埋未收`（埋了没回收）| `已回收`（终态）。**`continuity_check.py` 只认 `已回收` 为终态**，任何非 `已回收` 的伏笔到终稿都会被报为「未回收」。
> 非小说体裁可整段省略此段。

## 禁用清单
- 禁用词: 竟然, 不禁, 缓缓, 嘴角勾起, 眸子
- 禁用句式: 不是…而是…, 既…又…, 这一刻…

> 在 `anti-ai-slop.md` 通用套话表之上，按本篇再加的额外禁用项。两行都是**逗号分隔**的清单。审校的 AI 味检测会读它。

## 平台格式
- platform: 公众号
- paragraph_max: 4
- subhead_every: 0

> `platform` 决定段落长度与小标题密度，取值对齐 `readability_check.py` 的 `PLATFORM_RULES`：`公众号` | `朋友圈` | `小红书` | `知乎` | `通用`。
> `paragraph_max` 单段最大句数（整数）；`subhead_every` 每隔几段要一个小标题（整数，`0` 表示不要求）。
