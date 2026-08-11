# 文档处理（doc-convert）技能设计方案

> 在「智能助手 · 日常办公」下新增第 5 个技能，覆盖文档格式转换与内容提取。
> 与「处理表格」（spreadsheets）平级：目录同级 + 侧栏场景卡同级。
> 2026-08-10 定稿。

## 目标

给 app 补上**文档处理**能力：用户丢进 PDF / Word / Excel / 图片，得到另一种格式，
或者得到从里面提取出来的内容。服务的是**日常办公场景里被格式卡住的人**——
甲方发来改不了的 PDF、扫描件里的字要重打一遍、一堆发票要录进表格。

这是「日常办公」四个技能里唯一一个**入口需求**：用户可能想不出该让 AI 干嘛，
但一定遇到过「这个文件我打不开/改不了」。

## 核心产品判断：避开纯转换的红海

纯格式转换是**确定性任务**——输入定了，正确输出只有一个，不需要"理解"。
这类任务用大模型做是杀鸡用牛刀：慢、贵，质量还不如做了十几年版式还原的专业工具。
用户会拿本功能跟 Smallpdf 比，然后发现更慢。

因此功能选择遵循一条原则：**重心放在「必须看懂内容才能转对」的那一类**，
纯转换只保留高频项作为"功能完整性"的门面。

| 传统工具做得好（AI 无优势） | AI 明显更强 |
|---|---|
| word→pdf、图片格式转换 | 扫描件 / 照片里的字提取 |
| PDF 合并拆分加水印 | PDF 里的表格转成能算的 Excel |
| excel↔csv | 一批票据 → 一张结构化台账 |
| — | 长文档 → 摘要 / 大纲 |

## 五个已拍板的决策

| # | 决策点 | 选定 | 被排除的选项与理由 |
|---|---|---|---|
| 1 | 功能形态 | **对话式技能 chip**（同现有 4 个） | 「带 UI 的转换面板」→ 要新做一整套界面、与现有 4 个技能交互不统一、工作量数倍；「混合（对话 + 一键转换快捷区）」→ 要额外设计「哪些走脚本、哪些走模型」的分流规则与 UI |
| 2 | 首版范围 | **A 类 4 条 + B 类 4 条 = 8 条话术** | 「只做 A 类 4 条」→ 用户搜「PDF转Word」找不到，觉得名不副实；「A+B 全 9 条」→ 低频项（图片格式转换、加水印）稀释列表，用户扫一眼看不出重点 |
| 3 | 底层实现 | **完整技能**（脚本 + 依赖清单 + 分领域指南，对标 spreadsheets） | 「零技能，只加伪命令话术」→ 转换质量完全不受控，同一句话两次结果可能不同；「轻技能，仅 SKILL.md + 少量脚本」→ B 类确定性转换仍可能被模型现场重写 |
| 4 | Word→PDF 保真 | **优先调本机 LibreOffice，无则 Python 兜底并明确告知排版可能有出入** | 「只用 Python」→ 复杂排版静默走样，用户拿去投标才发现；「不做这条」→ 用户预期里必须有 |
| 5 | venv 复用 | **各建各的，不与现有 4 个技能合并** | 「合并成共享 venv」→ 要改四个正在正常工作的引导脚本，库版本冲突会横跨四个功能，为省磁盘去动能跑的系统不划算 |

## 实施前的事实核查结果

以下每一条都在 2026-08-10 实测确认，是设计的依据：

| # | 事实 | 核查依据 |
|---|---|---|
| 1 | `skills/` 整个目录随安装包发布，落在 `<resourcesPath>/prebundled/skills`；新建一个子目录即自动注册为 `claude-desktop:<name>` | `electron/main/core/skillsDir.ts:21/40` |
| 2 | 打包后的 skill 目录**只读**，venv 绝不能建在里面；已有模式是落到用户 home（`~/.tender-review-skill/venv`） | `skills/tender-review/bin/ensure-python.sh:18-19` |
| 3 | 拟用依赖**全部已有先例**，不是新增依赖面 | `pypdf`/`python-docx`/`openpyxl` 见 `skills/tender-review/requirements.txt`；`Pillow` 见 `skills/spreadsheets/requirements.txt` |
| 4 | 主进程给每个技能注入**独立**的 `*_PYTHON_HOME`，且**同一变量在 engine.ts 出现两次**（bundled 后端分支 + system 后端分支） | `engine.ts:2029-2042`（bundled）、`engine.ts:2062-2074`（system） |
| 5 | 漏注入 `*_PYTHON_HOME` 的后果**不是报错而是静默降级**到系统 python，遇 3.14 无 wheel 会源码编译卡死 | `engine.ts:2034-2038` 注释原文 |
| 6 | 远端场景目录是**整表替换**内置默认表；已登录用户读远端那份，不读代码里的默认表 | `stores/scenarioCatalog.ts` 的 `setCatalog`；`docs/tender-review-scenario-card-deploy.md` §1 |
| 7 | 后台管理台保存是 `PUT` **整份覆盖**，非追加；必须先读线上现有配置再在其上追加 | `docs/tender-review-scenario-card-deploy.md` §2.1 |
| 8 | chip 注册缺失的技能会被 ScenarioRail **整条静默跳过** | `stores/scenarioCatalog.ts:76-79` 注释 |
| 9 | 文件槽关键词表已覆盖 PDF / Word / Excel / Markdown / 图片，本次**无需改表** | `composer/filePlaceholderPlugin.ts:38-64` |
| 10 | 「文档」二字会被 word 规则命中 → 只给 `.doc,.docx`，**PDF 选不了**；「文稿」命中组合规则 → `.txt,.md,.markdown,.docx,.pdf` | `filePlaceholderPlugin.ts:55`（文稿组合）与 `:58`（word 规则） |
| 11 | 现有 4 个技能各建各的 venv，已在重复安装同样的库；`~/.ppt-master/venv` 实测 **255 MB** | `du -sh ~/.ppt-master/venv` |
| 12 | 技能目录本身是纯文本，体积可忽略 | `skills/spreadsheets` 112 KB、`skills/tender-review` 612 KB（后者含 data/tests/references） |
| 13 | 新技能**无需**在打包脚本或插件清单里登记：`skills/` 整目录拷贝，`"skills": "./"` 自动注册每个子目录 | `scripts/prebundle-daemon.mjs:140-208`（`RESOURCE_DIRS` 含 `'skills'`，无逐技能白名单）；`skills/.claude-plugin/plugin.json` |
| 14 | 新技能**无需**改 i18n：分类 label 才回落 `scenarioCat*`，技能条目的 label 来自 skillChipRegistry；本次不加新分类 | `lib/scenarioCatalogDefaults.ts:24` 注释；`grep tender apps/studio/src/canvas/i18n/locales/en.ts` 仅命中 `contenders` 一处误配 |

## 功能清单：8 条推荐话术

命令 `/claude-desktop:doc-convert`，chip 中文名**文档处理**，
描述「提取文字、表格台账、格式转换」（PR 1 时曾临时收窄为「格式转换、PDF
页面操作」以免 over-promise 尚未实现的 A 类；PR 2 落地后已扩回，见
`2026-08-11-doc-convert-skill-pr2-design.md`），
挂在 `daily` 分类，
排在 **spreadsheets 之后、proposal-writer 之前**（与表格同属"处理已有文件"）。

### A 类 · 走模型（需要理解内容）

| 话术标签 | 用途 | 文件槽 | 槽命中的格式 |
|---|---|---|---|
| 图片提取文字 | 照片/截图/扫描件 → 可编辑文本，可输出 Word / Markdown | 【图片文件】 | `image/*` |
| PDF 表格转 Excel | 财报/对账单/报价单里的表格 → 能算的 Excel | 【PDF 文件】 | `.pdf` |
| 票据批量转台账 | 一批发票/收据照片 → 结构化 Excel | 【票据图片】 | `image/*` |
| 长文档提炼 | 几十页文档 → 摘要 / 大纲 / Markdown | **【文稿文件】** | `.txt,.md,.markdown,.docx,.pdf` |

> 「长文档提炼」的槽**必须**写「文稿」不能写「文档」——见事实核查 #10，
> 写「文档」会让用户选不了 PDF，而 PDF 正是该场景的主力格式。

### B 类 · 走脚本（确定性，不经模型判断）

| 话术标签 | 用途 | 文件槽 | 槽命中的格式 |
|---|---|---|---|
| Markdown 转 Word | md → docx | 【Markdown 文件】 | `.md,.markdown` |
| Word 转 PDF | docx → pdf（见「已知限制」） | 【Word 文件】 | `.doc,.docx` |
| Excel 与 CSV 互转 | 双向 | 【Excel 文件】 | `.xls,.xlsx,.csv` |
| PDF 合并拆分 | 合并 / 拆分 / 删页 / 加水印 | 【PDF 文件】 | `.pdf` |

## 技术方案

### 目录结构（对标 `skills/spreadsheets/`）

```
skills/doc-convert/
├── SKILL.md              # 技能主文档：何时用、A/B 两类分别怎么走
├── requirements.txt      # Python 依赖清单
├── bin/
│   ├── ensure-python.sh  # macOS/Linux 引导（source 后 export DOC_CONVERT_PY）
│   └── ensure-python.cmd # Windows 引导（末行打印 DOC_CONVERT_PY=<path>）
└── scripts/
    ├── md_to_docx.py
    ├── docx_to_pdf.py    # 先探测本机 LibreOffice，无则 Python 兜底
    ├── excel_csv.py      # 双向
    └── pdf_ops.py        # 合并/拆分/删页/加水印
```

### Python 环境引导

照抄 `skills/tender-review/bin/ensure-python.sh` 的成熟模式：

1. venv 落 `~/.doc-convert-skill/venv`（用户可写目录，**不能**建在只读的 skill 目录内）
2. 基座解释器优先用主进程注入的 `DOC_CONVERT_PYTHON_HOME`（app 自带 Python 3.12），
   缺失时才回退系统 python
3. 三镜像源防卡死 + `.deps-ok` 哨兵文件，就绪后秒过（可重入）
4. `export DOC_CONVERT_PY` 指向 venv 解释器，SKILL.md 里所有 `python ...` 命令用它替换

### 依赖清单

```
pypdf>=4.0.0        # PDF 合并/拆分/删页/加水印
pdfplumber>=0.11    # PDF 抽文字与表格（依赖 pdfminer.six）— PR 2 才用到
python-docx>=1.1    # Word 读写（依赖 lxml）
openpyxl>=3.1.0     # Excel 读写
reportlab>=4.0.0    # docx→pdf 的纯文字兜底渲染；本仓已有先例（ppt-creator）
Pillow>=9.0.0       # 图片处理
```

> `pdfplumber` 已于 PR 2 加入（PR 1 刻意未装，因为 B 类脚本用不上它）。
> `pillow-heif` 是 PR 2 新增的，只在 Windows 安装。

另有 `requirements-dev.txt` 只含 `pytest>=8.0`：**用户机器上没人跑单测**，
把 pytest 塞进主清单只是让每个用户白多下几 MB。

**刻意不装 pandas**：它加上 numpy 约 84 MB，比其余所有库加起来还大，
而唯一用得上它的「Excel ↔ CSV 互转」用 Python 内置 `csv` 模块 + openpyxl 就够了。

### docx→pdf 兜底路径需要中文字体

reportlab 默认字体没有 CJK 字形，不注册字体的话中文全渲染成方块。兜底路径会按
平台探测系统字体（macOS 的 Arial Unicode / PingFang、Windows 的微软雅黑 / 宋体、
Linux 的 Noto CJK / 文泉驿）；**一个都找不到时同样拒绝输出**——满纸方块的 PDF
比没有 PDF 更糟。

## 体积与磁盘代价

| 项目 | 增量 | 说明 |
|---|---|---|
| **安装包** | **+0.1 ~ 0.3 MB** | 技能目录是纯文本；Python 库不打包（事实核查 #12） |
| **用户硬盘** | **mac 约 99 MB / Windows 约 111 MB** | PR 1 后为 66 MB；PR 2 加 pdfplumber（+32.9 MB，含 cryptography 13M / pdfminer 9.3M / pypdfium2 7.5M）与仅 Windows 装的 pillow-heif（+12 MB）。均为 2026-08-11 实测 |

mac 实测明细（`du -sh ~/.doc-convert-skill/venv/lib/python3.12/site-packages/*`，
已扣除仅测试用的 pytest 系依赖）：lxml 20 MB、PIL（Pillow）14 MB、
cryptography 13 MB（PR 2 新增，pdfminer.six 硬依赖）、pip 自身 12 MB、
pdfminer 9.3 MB（PR 2 新增，pdfplumber 依赖）、reportlab 8.6 MB、
pypdfium2 全家 7.5 MB（PR 2 新增，随 pdfplumber 白赚的 PDF 渲染能力）、
pypdf 3.7 MB、openpyxl 2.7 MB、docx（python-docx）2.6 MB，其余零散依赖
（pdfplumber 本体 / packaging / cffi / charset_normalizer / pycparser /
typing_extensions / et_xmlfile 等）合计约 2.9 MB。Windows 在此之上另加
仅 Windows 装的 pillow-heif（+12 MB，见上方「依赖清单」一节，此项为
推算非实测——本机是 macOS，走系统 `sips` 不装它）。

这是第 5 份重复的 venv（事实核查 #11）。首版接受这份浪费，理由见决策 #5。
**触发合并的信号**：用户开始反馈"这软件占我十几个 G"。

## 已知限制

### Word → PDF 无法保证高保真

纯 Python 没有靠谱方案。处理方式是**降级 + 明确告知**：

1. 先探测本机是否装有 LibreOffice，有则调用它转换（效果等同本机另存为）。**不探测
   Microsoft Office**——实现只有 `find_soffice()`，没有任何 Office 探测逻辑；
   2026-08-11 评审时发现本节曾错误地写过"或 Microsoft Office"，与 SKILL.md
   的准确措辞不一致，已订正为只提 LibreOffice
2. 没有则走 Python 兜底，**并在输出里明确告诉用户"排版可能有出入"**

第 2 步的告知是硬要求。降级而不告知等于制造一个用户不知情的错误——
用户拿转好的标书去投标，发现字体全乱，比"转不了"更糟。

### 首次使用有几分钟等待

装 Python 依赖不可避免，与 PPT 技能首次使用体验一致。要求有明确进度提示，
不能让用户对着不动的界面干等。

## 改动清单

| # | 文件 | 改什么 | 漏了会怎样 |
|---|---|---|---|
| 1 | **新建** `skills/doc-convert/` | 见上方目录结构 | — |
| 2 | `electron/main/core/engine.ts` | 注入 `DOC_CONVERT_PYTHON_HOME`，**两处**（bundled + system 分支） | 静默降级到系统 python，3.14 上源码编译卡死（事实核查 #5） |
| 3 | `src/chat/composer/skillChipRegistry.ts` | 注册 **两份**：`/claude-desktop:doc-convert` 与 `/doc-convert` | 另一种写法的 chip 退化成光秃秃的英文命令，无中文标签与图标 |
| 4 | **新建** `public/skill-icons/doc-convert.png` | 图标切片 | chip 无图标 |
| 5 | `src/chat/lib/scenarioCatalogDefaults.ts` | 8 条话术 + 挂进 `daily` 分类（spreadsheets 之后） | 未登录用户看不到卡片 |
| 6 | `src/chat/lib/scenarioCatalogDefaults.test.ts` | 补测试（分类项存在、话术条数） | 后续改动无回归防线 |
| 7 | **生产管理台**（非代码） | 手动加一张场景卡，先读后改，图标走上传 | **已登录用户（即真实用户）看不到新卡片**（事实核查 #6/#7） |

**不需要改的地方**（已核实，避免实施时无谓改动）：
`scripts/prebundle-daemon.mjs`（整目录拷贝，无逐技能白名单）、
`skills/.claude-plugin/plugin.json`（`"skills": "./"` 自动注册）、
`src/canvas/i18n/locales/*.ts`（技能条目 label 来自 chip 注册表，不走 i18n）、
`composer/filePlaceholderPlugin.ts`（关键词表已覆盖全部 8 条话术所需格式）。

## 测试策略

三层，缺一层就有东西漏出去：

1. **自动化**：`bun test`（补 #6 的测试）+ `bun run typecheck`。
   项目无 ESLint，类型检查是唯一的全局防线。
2. **手动真机**：`bun run dev` 起应用，8 条话术逐条点。重点确认——
   文件槽格式限制正确（尤其「长文档提炼」能选 PDF）；
   首次 Python 环境装得起来且有进度提示；
   B 类 4 条确实走预置脚本（快、结果稳定），不是模型现场编。
3. **登录态验收**：后台配好后，**用真实登录账号**再看一遍卡片在不在。

## 交付顺序

分两个 PR，不混：

1. **PR 1 — B 类 4 条（纯脚本）**：确定性强、可自动测、不依赖模型表现。
   先把 Python 环境引导这条链路跑通，风险最大的部分先落地。
2. **PR 2 — A 类 4 条（走模型）**：提示词要反复调、验收靠人工看效果，
   节奏本就慢，不应拖累 PR 1。
   PR 2 的详细设计见 `2026-08-11-doc-convert-skill-pr2-design.md`。

后台场景卡配置（改动清单 #8）在 PR 2 合并后统一做一次。

## 本轮不做

| 不做的事 | 理由 |
|---|---|
| PDF → Word 高保真版式还原 | 用户呼声最高但最易翻车；还原不准会让用户判定整个功能是废的 |
| PPT ↔ PDF 互转 | 保真度同样差，且低频 |
| 图片格式转换与压缩（PNG/JPG/WebP/HEIC） | 低频，会稀释 8 条列表的重点 |
| 合并 5 个技能的 venv | 见决策 #5 |
| 带 UI 的转换面板 | 见决策 #1 |
