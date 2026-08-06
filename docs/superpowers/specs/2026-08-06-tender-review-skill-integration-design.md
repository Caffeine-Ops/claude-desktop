# 招标文件审标（tender-review）技能接入设计方案

> 把外部开源技能 [tender-review-kit](https://github.com/matongAI-lab/tender-review-kit)
> 接进 `skills/`，与「写方案」（proposal-writer）平级：目录同级 + 侧栏场景卡同级。
> 2026-08-06 定稿。

## 目标

给 app 补上**招标文件审标**能力：用户丢进一份招标文件（PDF/Word），产出一份
「投标核对清单」——废标项、评分项、证明材料、▲ 标识参数、时间节点、合同条款要点，
每条带原文行号出处。服务的是**要去投标的人**，帮他在动手写投标文件之前把招标方的
规则吃透。

与「写方案」构成一条完整业务链：**先审标（看清规则）→ 再写标（产出方案）**。
这也是侧栏卡紧邻写方案摆放的理由。

## 四个已拍板的决策

| # | 决策点 | 选定 | 被排除的选项与理由 |
|---|---|---|---|
| 1 | 集成深度 | **目录同级 + 侧栏卡** | 「只放目录」→ 用户在界面上找不到它；「满血集成」（命令拦截 / 专属 UI / Excel 内嵌预览）→ 要动 engine、IPC、新 UI 组件，是多天工程，本轮不做 |
| 2 | 改造尺度 | **原样拿进来 + 薄适配层** | 「完全原样」→ 用户首次用会被要求自己去终端敲 `pip install`，与桌面产品定位冲突；「深度本地化重写」→ 等于 fork，上游更新要手工合 |
| 3 | 命名与位置 | **「审标书」· 日常办公分类** | 「招标审查」→ 容易被误读成"给招标方用"（实际服务投标方）；「单开一个分类」→ 现在只有一张卡，tab 会显得空 |
| 4 | 后台配置 | **先本地跑通，再交付生产** | 直接改生产 → 影响全体用户且 `PUT` 是整份覆盖，风险不对等；只给文档不动手 → 配置没经过真机验证 |

## 实施前的事实核查结果

以下每一条都在 2026-08-06 实测确认，是设计的依据：

| # | 事实 | 核查依据 |
|---|---|---|
| 1 | `skills/` 整个目录是一个本地 fusion-code 插件，每个直接子目录 `skills/<name>/SKILL.md` 自动注册为 `claude-desktop:<name>` | `skills/.claude-plugin/plugin.json` 的 `"skills": "./"`；`electron/main/core/skillsDir.ts:32` 的 `resolveBundledSkillsPluginDir()` |
| 2 | 上游技能依赖的 3 个 Python 库在本仓已有先例，不是新增依赖面 | `openpyxl` 见 `skills/spreadsheets/requirements.txt:13`；`python-docx` 见 `skills/writing/requirements.txt:10`；`pypdf` 与 `pymupdf` 同属 PDF 解析层 |
| 3 | 本仓已有成熟的 Python 引导模式：venv 落用户目录、三镜像源防卡死、哨兵文件秒过 | `skills/writing/bin/ensure-python.sh`（打包后 skill 目录只读，venv **绝不能**建在 skill 目录内——该文件头注释已记此约束） |
| 4 | 主进程目前**只**注入 `PPT_MASTER_PYTHON_HOME`，其余技能的 `*_PYTHON_HOME` 均未注入 | `grep -rn "PYTHON_HOME" electron/main/` 仅命中 `engine.ts:2027/2050`、`cliDetect.ts:263`、`pptSkillInstaller.ts:332` |
| 5 | 远端场景目录是**整表替换**内置默认表，不是逐条合并 | `stores/scenarioCatalog.ts:52` 的 `setCatalog` 直接 `set({catalog})`；`lib/scenarioCatalogDefaults.ts` 头注释亦述此意 |
| 6 | 「【招标文件】」占位槽在现有规则下命不中任何关键词，落进「未命中→不限制」这一档（和「资料文件」同档），没有专属格式引导——**不是**被 word 规则误判成只收 Word | `composer/filePlaceholderPlugin.ts:46` 的 word 规则 `[/word|docx?(?![a-z])|文档/i, '.doc,.docx']` 匹配的是「文档」二字，「招标文件」不含该子串也不含 word/docx，不会被它命中；实测 `acceptForPlaceholder('招标文件')` 改动前返回 `undefined` |
| 7 | chip 注册缺失的技能会被 ScenarioRail **整条静默跳过** | `stores/scenarioCatalog.ts:76-79` 注释：「配了却看不见，最难查」 |
| 8 | 本地 docker 后端（`sub2api-dev`，代码停在 7-22 `dbfa5f4`）**没有**场景目录接口 | `curl 127.0.0.1:8080/api/v1/client/scenario-catalog` → **404**；`origin/main` 已领先，含 11 个 scenario 相关文件 |
| 9 | 生产后端 `https://cowork.cntcn.com` 接口存在但需管理员 token | 匿名 curl → `401 UNAUTHORIZED` |
| 10 | 后端已支持**图标后台上传**（`iconData`，64×64 webp，优先级高于客户端静态切片） | `cowork_admin` `origin/main` 提交 `5d2455c`；`service/scenario_catalog_service.go` 的 `IconData` 字段注释 |
| 11 | 管理端有独立的可视化编辑页，不是裸 JSON 文本框 | `frontend/src/views/admin/ScenarioCatalogView.vue` + `components/admin/ScenarioCatalogPanel.vue`（设置页只留入口卡） |
| 12 | 上游仓库已 1.5 个月未更新，迭代不频繁 | 最新 commit `06d0409`，日期 2026-06-21 |

**事实 12 的设计含义**：不必为「频繁同步上游」做特殊设计（submodule / subtree）。
直接 vendor 拷贝 + 一份来源记录即可，改动集中、可 diff。

## 一、技能包本体

落到 `skills/tender-review/`，来源 `matongAI-lab/tender-review-kit` @ `06d0409`
（2026-06-21）。上游 38 个受版本控制的文件，总计 656KB，全部为文本 + 一个测试样例。

**取舍：**

- **删** `.git/`（仓库套仓库）、`.github/`（上游 CI 与本仓无关）、`.gitignore` /
  `.gitattributes`（vendor 进来后由本仓根部的规则统一管辖）
- **留** `tests/`（72KB，其中 `fixtures/sample_tender.docx` 正是本设计验证环节的输入）
- **留** 上游全部文档（`README.md` / `ARCHITECTURE.md` / `FOR_AI.md` / `QUICKSTART.md` /
  `INSTALL.md` / `CHANGELOG.md`）——它们解释了判词库与护栏的设计意图，删掉会让以后
  接手的人只剩代码可读

**唯一的内容改动（1 行）**：`SKILL.md` frontmatter 的 `name: tender-review-skill`
→ `tender-review`。本仓约定 skill 目录名即命令名，frontmatter 与目录名不一致会
对不上（对照 `skills/proposal-writer/`、`skills/writing/` 均为两者相同）。

命令因此是 `/claude-desktop:tender-review`。

**新增 `skills/tender-review/UPSTREAM.md`**：记录来源仓库、commit、拷贝日期，以及
本地改动清单（本设计共 3 处：frontmatter name、SKILL.md 顶部 app 内运行段、新增
`bin/`）。以后上游若更新，照这张单子就知道该怎么合。

## 二、Python 环境薄适配层

### 问题

上游第 `-1` 步是 `scripts/check_env.py`——检测缺哪些库，然后**告诉用户自己去装**
（Windows / macOS / Linux 各给一条 pip 命令）。这在命令行里是对的设计，在桌面
产品里不是：用户不该看到"请打开终端敲 pip install"。

### 做法

新增 `skills/tender-review/bin/ensure-python.sh` 与 `ensure-python.cmd`，**结构逐行
对照 `skills/writing/bin/`**（该文件头注释明确要求技能自包含、平行维护、**不抽公共
文件**——技能可能被单独打包发布）：

| 项 | 取值 | 理由 |
|---|---|---|
| venv 位置 | `~/.tender-review-skill/venv` | 打包后 skill 目录在 Electron resources 下**只读**，venv 不能建在里面 |
| 解释器来源 | 优先 `$TENDER_PYTHON_HOME`，回退系统 `python3.12` → `3.11` → `python3` | 钉死 3.12 避开「本机是 3.14 → 原生扩展无 cp314 wheel → 退化源码编译卡死」 |
| 依赖安装 | 首次 `pip install -r requirements.txt`，依次试清华 → 阿里 → 官方，每源带超时 | 国内直连官方源常被墙握手中断（本仓 2026-05-14 教训） |
| 完成标记 | `venv/.deps-ok` 哨兵文件 | 命中即秒过，不重复检测 |
| 回灌方式 | `export TENDER_PY=<venv 解释器>`，必须 `source` 调用 | 直接执行只在子 shell 生效，父进程拿不到 |

**主进程加一行注入**：在 `engine.ts` 已有的 `PPT_MASTER_PYTHON_HOME` 注入处，把同一个
`pythonHome` 也注入为 `TENDER_PYTHON_HOME`（两个 backend 分支各一处，共 2 处）。
不注入的后果不是报错而是**静默降级**到系统 Python——即事实核查第 4 条描述的现状。

**SKILL.md 顶部新增一段「在 Claude Desktop 里运行」**：

1. 先 `source bin/ensure-python.sh`
2. 其后文档中所有 `python scripts/xxx.py` 一律替换为 `$TENDER_PY scripts/xxx.py`
3. **跳过上游 §-1 的 check_env 手工装包指引**（`bin/` 已覆盖其职责）

段落刻意加在顶部而非改写正文各处：改动集中在一处，上游更新时 diff 干净。

## 三、UI 入口（内置默认表）

四处改动，全在 `apps/studio/src/chat/`：

1. **`composer/skillChipRegistry.ts`** —— 加两条注册：`/claude-desktop:tender-review`
   与裸名 `/tender-review`（本仓所有技能均双注册，见该文件 ppt-creator 条的注释：
   历史会话里存的 chip value 是 wire 格式、绝不追溯改写）。
   - `label`: 「审标书」
   - `description`: 「审招标文件，产投标核对清单」
   - `image`: `/skill-icons/tender.png`

2. **`public/skill-icons/tender.png`** —— 新增图标，风格对齐现有 10 张切片
   （透明底 PNG）。用 `draw` 技能生成，交付前先给用户过目。
   **万一一时做不出，先用现有 `petal.png` 顶上，不阻塞主线**——事实核查第 10 条
   说明后台可上传图标覆盖它，这张切片的唯一职责是给未登录 / 离线 / 全新安装
   的用户兜底。

3. **`lib/scenarioCatalogDefaults.ts`** —— `daily` 分类里，**紧跟 proposal-writer
   之后**插入一条 `{ kind: 'skill', value: '/claude-desktop:tender-review', prompts: TENDER_PROMPTS }`。
   内置条目**不写 label/icon**（沿用该文件既定纪律：外观的唯一事实源是
   skillChipRegistry，在这里重复迟早漂移）。

   `TENDER_PROMPTS` 四条：

   | label | 用途 |
   |---|---|
   | 完整审标 | 走全流程，产出完整核对清单 + Excel |
   | 只看废标点 | 快查递交时的雷区（漏一条今天就废） |
   | 只看评分项 | 查分怎么给、哪些是可争取的分 |
   | 合同条款要点 | 中标后的约束（与废标项是两类独立清单） |

   四条均以「【招标文件】」文件槽开头。

4. **`composer/filePlaceholderPlugin.ts`** —— `ACCEPT_BY_KEYWORD` 表**最前面**加一条
   `[/招标|标书|投标/i, '.pdf,.doc,.docx']`。

   必须放在表首：现有 `[/word|docx?|文档/i, '.doc,.docx']` 会先命中「招标文件」里的
   「文件」二字，导致用户点开选择器时自己的 PDF 标书是灰的、选不了（事实核查第 6 条）。
   放在「文稿组合映射」之前同理——那条会把 `.txt/.md` 也放进来，对招标文件是噪音。

## 四、后台配置（先本地跑通）

分四步，前三步在本地闭环，第四步交付给用户自己往生产搬：

**4a. 更新本地后端** —— `~/Desktop/project/cowork_admin` 从 `dbfa5f4` 拉到
`origin/main`（含 scenario-catalog 全套），重建 `deploy/docker-compose.dev.yml`。
**预期会撞上已记录的构建坑**：colima + FlClash 代理链（daemon.json 的 proxies 指向
`192.168.5.2:7890`、去掉 registry-mirrors、给 containerd 单独配代理 drop-in、
build 时传 `--build-arg HTTP_PROXY`）。这一步是本设计**耗时最不可控**的环节。

**4b. 本地管理台配卡** —— 登录本地管理台（任意手机号 + 验证码 `123456`，需先在
settings 表开 `phone_login_enabled` / `registration_enabled` 两个开关），进
`/admin/scenario-catalog`，在日常办公分类里加「审标书」卡，上传图标（走 `iconData`）。

**4c. 真机验证** —— app 默认就连 `127.0.0.1:8080`（`SUB2API_BASE_URL` 未配时的
`DEFAULT_BASE_URL`），登录后确认：卡片出现在写方案旁、图标正常、点击插入 chip、
二级 prompt 展开、文件槽能选中 PDF。

**4d. 交付生产** —— 导出验证过的配置 JSON + 图标文件，连同「在管理台点哪里」的
逐步说明交给用户，由用户在生产管理台操作。

> **⚠️ 无论谁往生产写，第一步必须是先 GET 拉下现有配置。**
> `PUT /api/v1/admin/scenario-catalog` 是**整份覆盖**——提交什么线上就变成什么，
> 不是往里加一条。若生产已配过目录（运营改过的文案），拿内置表直接盖上去会把
> 那些改动全部抹掉且无法撤销。正确顺序恒为**读 → 在读到的那份上改 → 写**。
> （`version` 字段由服务端自己 +1，管理端不必也不该手工填。）

## 五、验证方式

按本仓纪律，"能用"必须有证据，不接受"我觉得能用"：

1. **`bun run typecheck`** —— 本仓唯一的全局防线（没有 ESLint）。studio 包是双 tsc
   （Next 侧 + electron 侧）。
2. **`bun test`**（在 `apps/studio` 下跑）—— 新增两条断言，都落在被测目录内：
   - `src/chat/lib/`：内置目录里存在「审标书」条目，且其 value 能在 skillChipRegistry
     查到 spec（直接防事实核查第 7 条那个"配了却看不见"的静默失败）
   - `src/chat/composer/`：`acceptForPlaceholder('招标文件')` 返回含 `.pdf` 的 accept
3. **端到端真机走查** —— 起 app，点侧栏「审标书」，喂上游自带的
   `tests/fixtures/sample_tender.docx`，走完 `check_env → extract_text → scan_keywords
   → 专项判断 → 护栏 → build_excel`，确认最终**真的落盘了一个 Excel**。
   驱动方式用已跑通的 CDP 远程走查（9222 端口）。

**第 3 项不可省**：本设计风险最高的是第二块（Python 环境在打包后的只读 skill 目录 +
自带 runtime 下能不能真跑起来），只有端到端跑一遍才能证伪。

## 不做什么

- **不做命令拦截 / 专属 UI 面板 / Excel 在 app 内预览** —— 属于满血集成，决策 1 已排除
- **不改上游的判词库与 Python 脚本逻辑** —— 那是技能的核心资产，改了就等于 fork
- **不顺手修 `writing` 技能的 `WRITING_PYTHON_HOME` 未注入问题** —— 是既有问题、本轮
  范围外。已记录在此备查，但**纯修复与本次新增要分两次做**
- **不为上游同步做 submodule / subtree** —— 事实核查第 12 条：上游 1.5 个月未更新
- **不碰生产后台凭据** —— 决策 4：本地闭环，生产由用户自己操作

## 已知风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 本地后端重建撞代理坑（4a） | 耗时不可控，可能卡住数小时 | 已有完整的踩坑记录可照做；若久攻不下，第 4 块可降级为"只交付 JSON + 步骤"，不阻塞第 1~3 块 |
| 打包后 venv 首次安装需联网拉 wheel | 用户首次使用要等几十秒到几分钟 | 与 `writing` / `ppt-master` 现状一致，非本设计引入；三镜像源轮换已是现成缓解 |
| 生产若已配过场景目录，内置表新增的卡登录用户看不到 | 卡片"只有未登录能看见" | 第 4 块即为此存在；交付说明里会明确写"必须先 GET 再改再 PUT" |
| 图标一时做不出 | 卡片视觉不达标 | 用 `petal.png` 兜底，后台 `iconData` 可随时覆盖且不需发版 |
