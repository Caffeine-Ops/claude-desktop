# 招标文件审标（tender-review）技能接入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把开源技能 tender-review-kit 接进 `skills/tender-review/`，并在侧栏「日常办公」分类里加一张与「写方案」并排的「审标书」场景卡，用户丢进招标文件即可产出带行号出处的投标核对清单与 Excel。

**Architecture:** 上游技能原样 vendor 进 `skills/`（该目录整体是一个 fusion-code 本地插件，子目录自动注册为 `claude-desktop:<name>` 命令），只加一层薄适配：一个自包含的 Python 引导脚本（venv 落用户目录、三镜像源轮换）、主进程多注入一个 `TENDER_PYTHON_HOME`、以及 UI 侧四处小改动。后台场景目录配置先在本地后端闭环验证，生产交由用户操作。

**Tech Stack:** bash / cmd（技能引导）、Python 3.12（技能本体，依赖 python-docx / pypdf / openpyxl）、TypeScript + React 19（studio 前端）、Electron main（engine.ts 环境注入）、bun test（单测）、Go + Vue3（sub2api 后端，仅第 7-8 任务涉及）

## Global Constraints

- **包管理器是 bun，不是 npm。**
- **类型检查是唯一的全局防线**（本仓没有 ESLint）：`bun run typecheck`（根目录，全 workspace）。
- **单测只覆盖三个目录**：`apps/studio/electron/`、`src/chat/lib`、`src/chat/composer`。新写的纯逻辑放进这三处才会被测到。`bun test` 在 `apps/studio` 下跑。
- **技能必须自包含**：`bin/ensure-python.*` 与 `skills/writing/bin/` 平行维护，**绝不抽公共文件**（技能可能被单独打包发布）。
- **venv 绝不建在 skill 目录内**：打包后该目录在 Electron resources 下只读。
- **上游来源钉死**：`matongAI-lab/tender-review-kit` @ `06d0409d4221ae366f25b88fdfe5ad5388b6b37b`（2026-06-21）。
- **命令名** `/claude-desktop:tender-review`；**卡片文案**「审标书」；**卡片描述**「审招标文件，产投标核对清单」。
- **本地改动只允许 3 处**（SKILL.md frontmatter 的 name、SKILL.md 顶部新增段、新增 `bin/`），全部登记进 `UPSTREAM.md`。
- **注释写「为什么这样而不是那样」**，沿用本仓风格。
- 全部对用户可见文案为中文。

---

### Task 1: 技能包 vendor 落地 + 来源记录

**Files:**
- Create: `skills/tender-review/`（整棵目录，来自上游）
- Create: `skills/tender-review/UPSTREAM.md`
- Modify: `skills/tender-review/SKILL.md`（仅 frontmatter 第 2 行）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 目录 `skills/tender-review/` 存在且含 `SKILL.md`（frontmatter `name: tender-review`）、`scripts/`、`references/`、`data/keywords.json`、`tests/fixtures/sample_tender.docx`、`requirements.txt`、`run_pipeline.py`。后续任务依赖这些路径。

- [ ] **Step 1: 克隆上游到临时目录并核对版本**

```bash
rm -rf /tmp/tender-src
git clone https://github.com/matongAI-lab/tender-review-kit.git /tmp/tender-src
cd /tmp/tender-src && git checkout 06d0409d4221ae366f25b88fdfe5ad5388b6b37b
git log -1 --format="%H %cd %s"
```

Expected: 输出 `06d0409... Sun Jun 21 19:54:53 2026 +0800 feat: 新增「投标文件递交规格」检查维度(形式/份数/封装)`

若上游已有更新提交，**仍然 checkout 到这个 commit**——本计划的所有路径与章节号都是按它核对的。升级上游是独立的后续工作。

- [ ] **Step 2: 拷进仓库并剔除不需要的部分**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
rm -rf skills/tender-review
cp -R /tmp/tender-src skills/tender-review
rm -rf skills/tender-review/.git skills/tender-review/.github
rm -f skills/tender-review/.gitignore skills/tender-review/.gitattributes
```

删除理由（逐条）：`.git` 会形成仓库套仓库；`.github` 是上游 CI，与本仓无关；`.gitignore` / `.gitattributes` 在 vendor 后由本仓根部规则统一管辖。

**保留** `tests/`（`fixtures/sample_tender.docx` 是 Task 6 端到端验证的输入）与上游全部文档（`README.md` / `ARCHITECTURE.md` / `FOR_AI.md` / `QUICKSTART.md` / `INSTALL.md` / `CHANGELOG.md`）——它们解释了判词库与护栏的设计意图。

- [ ] **Step 3: 验证拷贝结果**

```bash
test ! -e skills/tender-review/.git && echo "OK: 无嵌套仓库"
test -f skills/tender-review/tests/fixtures/sample_tender.docx && echo "OK: 样例标书在"
ls skills/tender-review/scripts/ | wc -l
```

Expected: 两行 OK；scripts 下 12 个文件。

- [ ] **Step 4: 改 frontmatter 的 name**

`skills/tender-review/SKILL.md` 第 2 行：

```yaml
name: tender-review-skill
```

改成：

```yaml
name: tender-review
```

理由：本仓约定 skill 目录名即命令名（对照 `skills/proposal-writer/`、`skills/writing/`，两者均相同）。不一致会对不上，命令变成 `/claude-desktop:tender-review-skill`。

- [ ] **Step 5: 验证 name 已改且目录名匹配**

```bash
head -3 skills/tender-review/SKILL.md
```

Expected: 第 2 行为 `name: tender-review`

- [ ] **Step 6: 写 UPSTREAM.md**

Create `skills/tender-review/UPSTREAM.md`:

```markdown
# 上游来源与本地改动

本技能不是本仓自研，是 vendor 进来的开源技能。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/matongAI-lab/tender-review-kit |
| 上游 commit | `06d0409d4221ae366f25b88fdfe5ad5388b6b37b` |
| 上游提交日期 | 2026-06-21 |
| 拷入本仓日期 | 2026-08-06 |
| 上游许可 | MIT |

## 为什么是 vendor 拷贝，不是 submodule / subtree

拷入时上游已 1.5 个月无更新，迭代不频繁；而 `skills/` 整体要被 electron-builder
的 extraResources 打进安装包，submodule 会给打包链平添一个「有没有 init」的失败面。
直接拷贝 + 这张改动清单，同步成本更低且可 diff。

## 本地改动清单（同步上游时逐条对照）

| # | 位置 | 改了什么 | 为什么 |
|---|---|---|---|
| 1 | `SKILL.md` frontmatter | `name: tender-review-skill` → `tender-review` | 本仓约定 skill 目录名即命令名，不一致会对不上 |
| 2 | `SKILL.md` 顶部 | 新增「在 Claude Desktop 里运行」一段 | 上游 §-1 让用户自己敲 pip install，桌面产品里不能这样 |
| 3 | `bin/ensure-python.sh` / `.cmd` | 新增（上游没有 `bin/`） | 自动建 venv 装依赖，用户零操作 |

**删除的上游文件**：`.git/`、`.github/`、`.gitignore`、`.gitattributes`。

## 同步上游的做法

1. 拉上游新 commit，与 `06d0409` 做 diff
2. 逐条比对上表三处本地改动是否受影响
3. 合并后更新本文件的 commit 与日期
```

- [ ] **Step 7: 确认技能能被插件机制发现**

```bash
cat skills/.claude-plugin/plugin.json
ls skills/tender-review/SKILL.md
```

Expected: manifest 的 `"skills": "./"`（说明每个直接子目录都会注册），且 `SKILL.md` 存在 → 该技能将注册为 `claude-desktop:tender-review`。

同时确认打包侧不需要任何额外配置：

```bash
grep -n "RESOURCE_DIRS" -A 3 apps/studio/scripts/prebundle-daemon.mjs
```

Expected: `skills` 在列表里，且下方是 `cpSync(src, ..., { recursive: true })` —— **整个目录递归拷进安装包，不是按名单列 skill**，所以新技能自动包含，无需改打包配置。

`__pycache__` 也不用操心：`.gitignore:40` 已有 `skills/**/__pycache__/`，后续跑 Python 脚本产生的字节码缓存不会被误提交。

**这一步是纯确认，不改任何东西。**

- [ ] **Step 8: 提交**

```bash
git add skills/tender-review
git commit -m "feat(tender-review): vendor 上游审标技能，钉死来源 commit

来自 matongAI-lab/tender-review-kit @ 06d0409（2026-06-21，MIT）。
仅改 frontmatter 的 name 以对齐「目录名即命令名」的仓库约定，
其余原样；来源与本地改动清单见 UPSTREAM.md。"
```

---

### Task 2: Python 引导层（bin/ + SKILL.md 顶部段）

**Files:**
- Create: `skills/tender-review/bin/ensure-python.sh`
- Create: `skills/tender-review/bin/ensure-python.cmd`
- Modify: `skills/tender-review/SKILL.md`（顶部插入一段）
- Reference: `skills/writing/bin/ensure-python.sh`、`skills/writing/bin/ensure-python.cmd`（转换来源）

**Interfaces:**
- Consumes: Task 1 产出的 `skills/tender-review/requirements.txt`（含 python-docx / pypdf / openpyxl 三行）
- Produces:
  - `source bin/ensure-python.sh` 后 shell 里有 `$TENDER_PY`，指向 `~/.tender-review-skill/venv/bin/python`
  - Windows 版把 `TENDER_PY=<路径>` 打在 stdout **最后一行**（cmd 无 `source` 语义，没法回灌父进程变量）
  - 读取的环境变量名：`TENDER_PYTHON_HOME`（Task 3 由主进程注入）、`TENDER_VENV_DIR`（可选覆盖）

- [ ] **Step 1: 机械转换生成 sh 版**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
mkdir -p skills/tender-review/bin
sed -e 's/WRITING_PYTHON_HOME/TENDER_PYTHON_HOME/g' \
    -e 's/WRITING_VENV_DIR/TENDER_VENV_DIR/g' \
    -e 's/WRITING_PY/TENDER_PY/g' \
    -e 's/__writing_/__tender_/g' \
    -e 's/\[writing\]/[tender]/g' \
    -e 's|\.writing-skill|.tender-review-skill|g' \
    skills/writing/bin/ensure-python.sh > skills/tender-review/bin/ensure-python.sh
```

**替换顺序是有讲究的**：`WRITING_PYTHON_HOME` 和 `WRITING_VENV_DIR` 必须排在 `WRITING_PY` 之前——它们都以 `WRITING_PY` 开头（`WRITING_PY`+`THON_HOME`），先换短的会把长的切坏。macOS 用的是 BSD sed，不支持 `\b` 词边界，只能靠顺序保证。

- [ ] **Step 2: 同样生成 cmd 版**

```bash
sed -e 's/WRITING_PYTHON_HOME/TENDER_PYTHON_HOME/g' \
    -e 's/WRITING_VENV_DIR/TENDER_VENV_DIR/g' \
    -e 's/WRITING_DEPS_OK/TENDER_DEPS_OK/g' \
    -e 's/WRITING_PY/TENDER_PY/g' \
    -e 's/\[writing\]/[tender]/g' \
    -e 's|\.writing-skill|.tender-review-skill|g' \
    skills/writing/bin/ensure-python.cmd > skills/tender-review/bin/ensure-python.cmd
```

cmd 版多一个 `WRITING_DEPS_OK`（sh 版叫 `__writing_ok`，已被 `__writing_` 规则覆盖）。

- [ ] **Step 3: 核对转换完整，没有残留**

```bash
grep -in "writing" skills/tender-review/bin/ensure-python.sh skills/tender-review/bin/ensure-python.cmd
```

Expected: 只剩头注释里提到 `skills/ppt-master/bin/...` 与 writing 的那几行说明文字（Step 4 会重写它们）。**任何 `WRITING_` 变量名残留都是转换失败**，回到 Step 1 重来。

```bash
diff <(wc -l < skills/writing/bin/ensure-python.sh) <(wc -l < skills/tender-review/bin/ensure-python.sh) && echo "OK: 行数一致"
```

Expected: `OK: 行数一致`（机械替换不该增减行）

- [ ] **Step 4: 手工重写两个文件的头注释**

`ensure-python.sh` 开头的注释块（第 1-27 行左右）替换为：

```bash
# shellcheck shell=bash
# tender-review skill Python bootstrap — macOS / Linux.
#
# 故意与 writing / ppt-master 平行维护，不抽公共依赖：技能必须自包含——用户
# 可能只装其中一个，它们也可能被分开打包发布。本文件与
# skills/writing/bin/ensure-python.sh 结构逐行对应（由它机械替换前缀生成），
# 改一处记得对照另一处是否也该改（但不要合并成共享文件）。
#
# 必须用 `source` 调用（不是直接执行）：脚本通过 `export TENDER_PY=...` 把就绪的
# 解释器路径回灌给调用方的 shell。直接 `bash ensure-python.sh` 只会在子 shell
# 里 export，父进程拿不到 TENDER_PY。SKILL.md 顶部约定也是 `source`。
#
# 为什么这个技能需要它：上游的 §-1 check_env.py 是「检测缺什么、然后告诉用户
# 自己去敲 pip install」——命令行里这是对的设计，桌面产品里不是。本脚本把那一步
# 变成用户零操作。
#
# 干的事：
#   1. 把 venv 落在 ~/.tender-review-skill/venv（用户可写目录）。打包后的 skill
#      目录在 Electron resources 下是只读的，venv 绝不能建在 skill 目录里。
#   2. 选解释器建 venv：优先 app 自带的 python-runtime（路径由主进程经
#      TENDER_PYTHON_HOME 注入，钉死 3.12，避开本机可能是 py3.14 → 原生扩展无
#      cp314 wheel 退化源码编译卡死的坑）；没注入则回退系统 python3.12 /
#      python3.11 / python3，并对 3.14+ 提前告警。
#   3. 首次 pip install -r requirements.txt（python-docx / pypdf / openpyxl）；
#      之后用一个 .deps-ok 哨兵文件标记完成，命中就秒过。依次尝试清华 → 阿里
#      → 官方 PyPI 三个源（国内直连官方源常被墙握手中断/卡死，见历史教训
#      2026-05-14），每源加超时，卡住就换下一个而不是无限等。
#   4. export TENDER_PY 指向 venv 里的解释器，供文档里所有 `python ...` 命令替换。
#
# 失败时打印明确原因并 return 1（不 exit，避免把调用方 shell 一起带走）。
```

`ensure-python.cmd` 开头注释块同理重写，保留原有的两条 Windows 特有说明（无 `source` 语义 → 走 stdout 最后一行；venv 落 `%USERPROFILE%\.tender-review-skill\venv`），并把「与 ppt-master 平行维护」改成「与 writing 平行维护」。

- [ ] **Step 5: 给 sh 版加可执行位**

```bash
chmod +x skills/tender-review/bin/ensure-python.sh
ls -l skills/tender-review/bin/
```

Expected: `ensure-python.sh` 带 `x` 位。

- [ ] **Step 6: 实跑验证 —— 这一步是本任务的核心，不能跳**

```bash
cd skills/tender-review
source bin/ensure-python.sh
echo "TENDER_PY=$TENDER_PY"
```

Expected: 打印一串 `[tender]` 日志，最后 `[tender] Python 就绪：/Users/kika/.tender-review-skill/venv/bin/python`，且 `TENDER_PY` 非空。首次会装依赖，可能几十秒到几分钟。

- [ ] **Step 7: 验证三个依赖真的能 import**

```bash
"$TENDER_PY" -c "import docx, pypdf, openpyxl; print('deps ok')"
```

Expected: `deps ok`

注意包名与 import 名不同：`python-docx` 装出来的模块叫 `docx`。import 失败说明 requirements 没装全，不是路径问题。

- [ ] **Step 8: 验证哨兵生效（第二次调用应秒过）**

```bash
source bin/ensure-python.sh
```

Expected: 立刻输出 `[tender] Python 就绪：...`，**没有** 「安装依赖」那几行。

- [ ] **Step 9: 用真实脚本跑通一次取数**

```bash
"$TENDER_PY" scripts/extract_text.py tests/fixtures/sample_tender.docx --outdir /tmp/tender-smoke
ls /tmp/tender-smoke/
```

Expected: 生成 `*.lines.txt` 与 `*.tables.json`。这证明引导层产出的解释器能真的驱动技能脚本，而不只是能 import。

- [ ] **Step 10: 在 SKILL.md 顶部插入「在 Claude Desktop 里运行」段**

插入位置：`# 招标文件审标 tender-review-skill`（第 11 行）之后、`## 四条铁律` 之前。内容：

```markdown
## 在 Claude Desktop 里运行（app 内必读，其它宿主可跳过）

本技能随 Claude Desktop 打包分发。在 app 内运行时，Python 环境由技能自带的
引导脚本准备，**用户不需要也不应该被要求手动装任何东西**：

1. **动手前先跑一次引导**（macOS / Linux）：

   ```bash
   source bin/ensure-python.sh
   ```

   Windows：`bin\ensure-python.cmd`，读它 stdout **最后一行** 的 `TENDER_PY=<路径>`。

2. **其后本文档中所有 `python scripts/xxx.py` 一律替换为 `$TENDER_PY scripts/xxx.py`。**
   直接用 `python` 会命中用户系统里的解释器，那里没有本技能的依赖。

3. **跳过下面 §-1 的环境自检**（`check_env.py`）—— 那一步的职责（检测缺什么、
   指导用户安装）已被引导脚本完全覆盖，再跑一遍只会让用户看到「请打开终端敲
   pip install」这类不该出现在桌面产品里的指令。

> 为什么不直接改写下面的正文：本技能是 vendor 进来的上游代码，改动集中在这一段
> 才能让上游更新时的 diff 保持干净。本地改动清单见 `UPSTREAM.md`。
```

- [ ] **Step 11: 更新 UPSTREAM.md 的改动清单**

确认 Task 1 Step 6 写的三条改动此刻全部落实（第 2、3 条本任务刚完成）。若表述与实际不符，改到相符。

- [ ] **Step 12: 提交**

```bash
git add skills/tender-review/bin skills/tender-review/SKILL.md skills/tender-review/UPSTREAM.md
git commit -m "feat(tender-review): 加自包含 Python 引导，用户零操作

上游 §-1 是「检测缺什么、让用户自己 pip install」，桌面产品里不能这样。
bin/ensure-python.* 由 skills/writing/bin/ 机械替换前缀生成（技能自包含、
平行维护、不抽公共文件），venv 落 ~/.tender-review-skill/venv——打包后
skill 目录只读，venv 不能建在里面。SKILL.md 顶部加 app 内运行约定，
改动集中一处以保持上游 diff 干净。"
```

---

### Task 3: 主进程注入 TENDER_PYTHON_HOME

**Files:**
- Modify: `apps/studio/electron/main/core/engine.ts`（两处：bundled 分支约 2027-2031 行，system 分支约 2050-2054 行）

**Interfaces:**
- Consumes: Task 2 的 `ensure-python.sh` 读取的变量名 `TENDER_PYTHON_HOME`
- Produces: fusion-code 子进程 env 里带 `TENDER_PYTHON_HOME=<app 自带 python 3.12 home>`

- [ ] **Step 1: 读现场，确认两处注入点的形状**

```bash
sed -n '2023,2032p;2046,2055p' apps/studio/electron/main/core/engine.ts
```

Expected: 看到两段结构相同的 `...(process.env.PPT_MASTER_PYTHON_HOME ? {} : pythonHome ? {...} : {})`。**两处都要改，漏一处的后果是「bundled 后端下能用、切到 system claude 就静默降级」，极难排查。**

- [ ] **Step 2: 改 bundled 分支**

把 2023-2031 行那段：

```typescript
            // ppt-creator skill bootstrap reads this to pick its venv base
            // interpreter. Respect a user-exported override; otherwise hand
            // over the bundled 3.12 home (omitted when null so the bootstrap
            // falls back to system python on its own).
            ...(process.env.PPT_MASTER_PYTHON_HOME
              ? {}
              : pythonHome
                ? { PPT_MASTER_PYTHON_HOME: pythonHome }
                : {}),
```

改成：

```typescript
            // ppt-creator skill bootstrap reads this to pick its venv base
            // interpreter. Respect a user-exported override; otherwise hand
            // over the bundled 3.12 home (omitted when null so the bootstrap
            // falls back to system python on its own).
            ...(process.env.PPT_MASTER_PYTHON_HOME
              ? {}
              : pythonHome
                ? { PPT_MASTER_PYTHON_HOME: pythonHome }
                : {}),
            // 同上，给 tender-review skill 的 bin/ensure-python.sh。刻意每个技能
            // 一个独立变量名而不是共用一个 PYTHON_HOME：技能自包含、可被单独
            // 打包发布，共用变量会让「只装了其中一个」的机器上出现名字对得上
            // 但语义不属于自己的注入。不注入的后果不是报错而是**静默降级**到
            // 系统 python（可能是 3.14 → 无 cp314 wheel → 源码编译卡死）。
            ...(process.env.TENDER_PYTHON_HOME
              ? {}
              : pythonHome
                ? { TENDER_PYTHON_HOME: pythonHome }
                : {}),
```

- [ ] **Step 3: 改 system 分支**

把 2046-2054 行那段之后追加同样的块：

```typescript
            // Same passthrough under system claude: PPT_MASTER_PYTHON_HOME is a
            // main-process runtime path, not an env.json gateway key, so it
            // never affects claude's model routing — safe to hand over so the
            // ppt-creator skill works under the system backend too.
            ...(process.env.PPT_MASTER_PYTHON_HOME
              ? {}
              : pythonHome
                ? { PPT_MASTER_PYTHON_HOME: pythonHome }
                : {}),
            // 同上，tender-review skill 在 system 后端下也要能用。理由与 bundled
            // 分支那段一致：这是 main 侧运行时路径，不是 env.json 网关密钥，
            // 不影响 claude 的模型路由。
            ...(process.env.TENDER_PYTHON_HOME
              ? {}
              : pythonHome
                ? { TENDER_PYTHON_HOME: pythonHome }
                : {}),
```

- [ ] **Step 4: 确认改了两处，不多不少**

```bash
grep -c "TENDER_PYTHON_HOME" apps/studio/electron/main/core/engine.ts
```

Expected: `4`（每处两次引用：条件判断一次、赋值一次）

- [ ] **Step 5: 类型检查**

```bash
bun run typecheck
```

Expected: 通过。这是本仓唯一的全局防线。

- [ ] **Step 6: 提交**

```bash
git add apps/studio/electron/main/core/engine.ts
git commit -m "feat(tender-review): 主进程注入 TENDER_PYTHON_HOME

不注入不会报错，会静默降级到系统 python——本机若是 3.14，原生扩展无
cp314 wheel，pip 退化源码编译会卡死。bundled 与 system 两个后端分支都要注入，
漏一处的表现是「切后端才复现」，极难排查。"
```

---

### Task 4: 文件槽认招标文件（TDD）

**Files:**
- Modify: `apps/studio/src/chat/composer/filePlaceholderPlugin.ts:38-52`（`ACCEPT_BY_KEYWORD` 表）
- Test: `apps/studio/src/chat/composer/filePlaceholderPlugin.test.ts`（已存在，追加一个 describe 块）

**Interfaces:**
- Consumes: 现有导出 `acceptForPlaceholder(placeholderText: string): string | undefined`
- Produces: `acceptForPlaceholder('招标文件')` 返回 `'.pdf,.doc,.docx'`。Task 5 的示例 prompt 依赖它——那些 prompt 里写的就是「【招标文件】」。

**背景（为什么需要这个改动）**：改动前「招标文件」命不中 `ACCEPT_BY_KEYWORD` 里任何一条——word 规则 `[/word|docx?(?![a-z])|文档/i, '.doc,.docx']` 匹配的是「文档」二字，不是「文件」，不会误伤——落进「未命中→不限制」这一档，和「资料文件」同档：选择器不做任何引导，用户面对全部格式平铺，找自己的 PDF/Word 标书要自己翻。这次改动不是"解冲突"，是照着 ppt/excel/文稿三条的先例，给审标技能补一条专属格式引导：只把 PDF 和 Word 挑出来。

- [ ] **Step 1: 写失败测试**

在 `apps/studio/src/chat/composer/filePlaceholderPlugin.test.ts` 末尾追加：

```typescript
describe('acceptForPlaceholder · 招标文件（审标技能）', () => {
  const TENDER_FORMATS = '.pdf,.doc,.docx'

  it('招标 / 标书 / 投标 都映射到 pdf + word', () => {
    expect(acceptForPlaceholder('招标文件')).toBe(TENDER_FORMATS)
    expect(acceptForPlaceholder('标书文件')).toBe(TENDER_FORMATS)
    expect(acceptForPlaceholder('投标文件')).toBe(TENDER_FORMATS)
  })

  it('必须含 .pdf——招标文件绝大多数是 PDF，落进 word 规则会让用户选不了自己的标书', () => {
    expect(acceptForPlaceholder('招标文件')!.split(',')).toContain('.pdf')
  })

  it('不含 .txt/.md——招标文件不会是纯文本，混进来只是噪音', () => {
    const tokens = acceptForPlaceholder('招标文件')!.split(',')
    expect(tokens).not.toContain('.txt')
    expect(tokens).not.toContain('.md')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test src/chat/composer/filePlaceholderPlugin.test.ts
```

Expected: FAIL。第一条断言实际得到 `'.doc,.docx'`（被 word 规则抢先命中），缺 `.pdf`。

- [ ] **Step 3: 在关键词表最前面加一条**

`apps/studio/src/chat/composer/filePlaceholderPlugin.ts` 第 38 行起，把：

```typescript
const ACCEPT_BY_KEYWORD: readonly [RegExp, string][] = [
  // 文稿组合映射（优化已有作品的「【文稿文件】」槽，设计 §5.2）：覆盖
```

改成：

```typescript
const ACCEPT_BY_KEYWORD: readonly [RegExp, string][] = [
  // 招标文件（审标技能的「【招标文件】」槽）。**必须排在最前**：下面的
  // word 规则会先命中「招标文件」里的「文件」二字，把选择器限死成
  // .doc/.docx，而招标文件绝大多数是 PDF——用户点开会发现自己的标书是
  // 灰的。也刻意不复用下面的文稿组合（那条会把 .txt/.md 放进来，对招标
  // 文件是噪音）。
  [/招标|标书|投标/i, '.pdf,.doc,.docx'],
  // 文稿组合映射（优化已有作品的「【文稿文件】」槽，设计 §5.2）：覆盖
```

- [ ] **Step 4: 跑测试确认通过，且既有断言不回归**

```bash
cd apps/studio && bun test src/chat/composer/filePlaceholderPlugin.test.ts
```

Expected: 全部 PASS，包括原有的「既有单格式映射不回归」那条（`Word 文档` 仍是 `.doc,.docx`、`PDF 文件` 仍是 `.pdf`）。

- [ ] **Step 5: 类型检查**

```bash
bun run typecheck
```

Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add apps/studio/src/chat/composer/filePlaceholderPlugin.ts apps/studio/src/chat/composer/filePlaceholderPlugin.test.ts
git commit -m "feat(tender-review): 文件槽认招标文件，放行 PDF

「招标文件」四个字原会被 word 规则先命中（含「文件」二字），选择器限死
.doc/.docx，而招标文件绝大多数是 PDF——用户点开发现自己的标书是灰的。
新规则必须排在表首才能抢在 word 规则之前。"
```

---

### Task 5: 侧栏「审标书」场景卡

**Files:**
- Modify: `apps/studio/src/chat/composer/skillChipRegistry.ts`（`SKILL_CHIP_SPECS` 数组）
- Modify: `apps/studio/src/chat/lib/scenarioCatalogDefaults.ts`（新增 `TENDER_PROMPTS` + `daily` 分类里加一条）
- Create: `apps/studio/public/skill-icons/tender.png`
- Test: `apps/studio/src/chat/lib/scenarioCatalogDefaults.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `acceptForPlaceholder('招标文件')`（示例 prompt 里的文件槽靠它决定选择器过滤）；Task 1 产出的命令名 `/claude-desktop:tender-review`
- Produces: 内置场景目录的 `daily` 分类里存在 `value === '/claude-desktop:tender-review'` 的条目，且该 value 能被 `findBuiltinSkillChipSpec` 查到 spec。Task 7 的后台配置以这份内容为蓝本。

**背景（为什么需要这个测试）**：`stores/scenarioCatalog.ts:76-79` 的注释白纸黑字写着——chip 注册查不到的条目会被 ScenarioRail **整条静默跳过**，「配了却看不见，最难查」。所以这个任务必须有测试守住「目录里有 + registry 里查得到」这对关系。

- [ ] **Step 1: 写失败测试**

Create `apps/studio/src/chat/lib/scenarioCatalogDefaults.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'

import { DEFAULT_SCENARIO_CATALOG } from './scenarioCatalogDefaults'
import { findBuiltinSkillChipSpec } from '../composer/skillChipRegistry'
import { acceptForPlaceholder } from '../composer/filePlaceholderPlugin'

const TENDER_VALUE = '/claude-desktop:tender-review'

function allSkillItems() {
  return DEFAULT_SCENARIO_CATALOG.categories.flatMap((c) =>
    c.items.filter((i) => i.kind === 'skill')
  )
}

describe('内置场景目录 · 审标书', () => {
  it('日常办公分类里有审标书，且紧跟在写方案之后', () => {
    const daily = DEFAULT_SCENARIO_CATALOG.categories.find((c) => c.id === 'daily')
    expect(daily).toBeDefined()
    const values = daily!.items.map((i) => i.value)
    const proposalIdx = values.indexOf('/claude-desktop:proposal-writer')
    const tenderIdx = values.indexOf(TENDER_VALUE)
    expect(proposalIdx).toBeGreaterThanOrEqual(0)
    // 先审标、再写标是同一条业务链，摆放顺序即产品叙事
    expect(tenderIdx).toBe(proposalIdx + 1)
  })

  it('审标书有推荐 prompt，且每条都带招标文件槽', () => {
    const item = allSkillItems().find((i) => i.value === TENDER_VALUE)
    expect(item?.prompts?.length).toBeGreaterThan(0)
    for (const p of item!.prompts!) {
      expect(p.text).toContain('【招标文件】')
    }
  })

  it('招标文件槽能选到 PDF（否则用户点开发现自己的标书是灰的）', () => {
    expect(acceptForPlaceholder('招标文件')).toContain('.pdf')
  })
})

describe('内置目录里每个技能条目都能查到 chip 外观', () => {
  // ScenarioRail 对 findSkillChipSpec 返回 null 的 chip 会整条静默跳过
  // （见 stores/scenarioCatalog.ts 的注释：「配了却看不见，最难查」）。
  // 这条断言覆盖全表而不只是新增项——任何人往内置目录加技能却忘了注册
  // chip，都会在这里当场失败，而不是等到肉眼发现卡片消失。
  it('无一遗漏', () => {
    // 收集缺失项再一次性断言，而不是循环里逐个 expect：失败时能直接看到
    // 「缺的是哪几个 value」。bun:test 的 expect 不接受第二个参数当消息
    // （那是 chai/vitest 的用法），循环里断言失败只会打印 "expected not null"。
    const missing = allSkillItems()
      .map((i) => i.value!)
      .filter((v) => findBuiltinSkillChipSpec(v) === null)
    expect(missing).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test src/chat/lib/scenarioCatalogDefaults.test.ts
```

Expected: FAIL —— 目录里还没有审标书条目，第一条断言 `tenderIdx` 为 `-1`。

- [ ] **Step 3: 生成图标**

用 `draw` 技能生成，要求：

> 一枚扁平风格的应用图标，主体是一份文档上叠加一个放大镜、文档右上角有几处清单
> 勾选标记，配色以稳重的蓝灰为主、勾选处点缀绿色；正方形构图，主体居中留边，
> **透明背景**，无文字，风格对齐 Microsoft Office 风格的彩色扁平图标。输出 PNG。

存为 `apps/studio/public/skill-icons/tender.png`，尺寸与现有切片一致（先 `file apps/studio/public/skill-icons/ppt.png` 查现有尺寸再对齐）。

**若一时做不出满意的**：先 `cp apps/studio/public/skill-icons/petal.png apps/studio/public/skill-icons/tender.png` 占位，**不阻塞本任务**——后台可上传 `iconData` 覆盖它且不需发版，这张切片的唯一职责是给未登录 / 离线 / 全新安装的用户兜底。占位的话在提交信息里写明。

- [ ] **Step 4: 注册 chip 外观**

`apps/studio/src/chat/composer/skillChipRegistry.ts`，在 proposal-writer 那段（`...PROPOSAL_WRITER_SLASH_NAMES.map(...)`）之后、代码开发伪命令那段之前插入：

```typescript
  // tender-review — 审标书。namespaced + 裸名双注册，理由同 ppt-creator。
  // 与 proposal-writer（写方案）是同一条业务链的上下游：先审标看清招标方的
  // 规则，再写标产出方案。但两者集成深度不同——写方案走客户端拦截 + 方案模式
  // 工作台，审标是普通 skill，命令原样发给 CLI 不拦截。
  {
    match: '/claude-desktop:tender-review',
    image: '/skill-icons/tender.png',
    label: '审标书',
    description: '审招标文件，产投标核对清单'
  },
  {
    match: '/tender-review',
    image: '/skill-icons/tender.png',
    label: '审标书',
    description: '审招标文件，产投标核对清单'
  },
```

- [ ] **Step 5: 加推荐 prompt 常量**

`apps/studio/src/chat/lib/scenarioCatalogDefaults.ts`，在 `PROPOSAL_PROMPTS` 定义之后插入：

```typescript
const TENDER_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    // 「【招标文件】」是 filePlaceholderPlugin 的文件槽（「招标」关键词 →
    // picker 限定 .pdf/.doc/.docx，见 ACCEPT_BY_KEYWORD 表首那条）。四条
    // prompt 刻意从「全量」到「单项」递进：第一条是主路径，后三条对应技能
    // 内部三条独立的判断线，让已经知道自己要查什么的老手直接切进去。
    label: '完整审标',
    text: '帮我审这份【招标文件】：把废标项、评分项、要准备的证明材料、▲ 标识参数、时间节点和合同条款要点全部列出来，每条带原文出处，最后出一份 Excel 核对清单。'
  },
  {
    label: '只看废标点',
    text: '帮我看这份【招标文件】里所有会导致废标的条款：资格门槛、实质性要求、投标文件递交规格（形式/份数/封装），每条带原文出处，一条都别漏。'
  },
  {
    label: '只看评分项',
    text: '帮我梳理这份【招标文件】的评分规则：价格分怎么算、商务分和技术分各有哪些得分点、每项多少分、要提交什么才能拿到分，每条带原文出处。'
  },
  {
    // 合同条款是「中标后约束」，与废标项（递交时雷区）是两类独立清单——
    // 很多投标人不看合同，单独给一条入口让想看的人直达。
    label: '合同条款要点',
    text: '帮我看这份【招标文件】里的合同条款：付款方式、质保期、违约责任、验收标准这些中标后才生效的约束，每条带原文出处。'
  }
]
```

- [ ] **Step 6: 把条目插进 daily 分类**

同文件的 `DEFAULT_SCENARIO_CATALOG` 里，`daily` 分类的 items 数组，在 proposal-writer 那条之后追加：

```typescript
        {
          kind: 'skill',
          value: '/claude-desktop:tender-review',
          prompts: TENDER_PROMPTS
        }
```

**不写 label/icon**——沿用该文件既定纪律：外观的唯一事实源是 skillChipRegistry，在这里重复迟早漂移（文件头注释已述）。

- [ ] **Step 7: 跑测试确认通过**

```bash
cd apps/studio && bun test src/chat/lib/scenarioCatalogDefaults.test.ts
```

Expected: 全部 PASS，含「无一遗漏」那条全表扫描。

- [ ] **Step 8: 跑全量单测确认无回归**

```bash
cd apps/studio && bun test
```

Expected: 全绿。

- [ ] **Step 9: 类型检查**

```bash
bun run typecheck
```

Expected: 通过。

- [ ] **Step 10: 提交**

```bash
git add apps/studio/src/chat/composer/skillChipRegistry.ts \
        apps/studio/src/chat/lib/scenarioCatalogDefaults.ts \
        apps/studio/src/chat/lib/scenarioCatalogDefaults.test.ts \
        apps/studio/public/skill-icons/tender.png
git commit -m "feat(tender-review): 侧栏加「审标书」卡，紧邻写方案

先审标、再写标是同一条业务链，摆放顺序即产品叙事。新增的全表断言守住
「目录里有 + registry 里查得到」这对关系——ScenarioRail 对查不到 spec 的
chip 会整条静默跳过，配了却看不见是最难排查的一类故障。"
```

---

### Task 6: 端到端真机走查

**Files:**
- 不改代码。产出：走查记录（贴进 PR / 会话）

**Interfaces:**
- Consumes: Task 1-5 的全部产出
- Produces: 「Python 链路在真实 app 里跑得通」的证据。**这是本计划风险最高环节的唯一证伪手段**——前面所有测试都只覆盖纯函数，没有一条证明打包/运行期的 Python 能起来。

- [ ] **Step 1: 起 app**

```bash
bun run dev
```

Expected: Electron 窗口起来，Next dev server 在 3100。

- [ ] **Step 2: 肉眼确认卡片**

在空态侧栏「日常办公」分类里，确认「审标书」卡出现在「写方案」右侧，图标正常渲染（**不是**灰块或缺图占位）。

若卡片不见：查 `findBuiltinSkillChipSpec('/claude-desktop:tender-review')` 是否返回 null（Task 5 的测试应已挡住，走到这里还不见说明图标文件路径写错）。

- [ ] **Step 3: 确认二级 prompt 与文件槽**

点「审标书」卡 → 确认展开四条推荐 prompt → 点「完整审标」→ 确认输入框里插入了 chip + 正文，其中「【招标文件】」渲染成虚线 pill。

点那个 pill → 确认弹出的文件选择器里 **PDF 文件是可选的**（不是灰的）。这是 Task 4 的真机验证。

- [ ] **Step 4: 喂样例标书跑全流程**

选 `skills/tender-review/tests/fixtures/sample_tender.docx`，发送。观察 agent 是否：

1. 先 `source bin/ensure-python.sh`（而不是直接 `python`，也不是跑上游的 `check_env.py` 让用户装包）
2. 走 `extract_text` → `scan_keywords` → 专项判断 → 护栏 → `build_excel`

- [ ] **Step 5: 确认真的落盘了 Excel**

```bash
find ~ -name "*.xlsx" -newermt "-10 minutes" 2>/dev/null | head
```

Expected: 找到本次产出的 Excel。打开确认里面有内容（不是空表）。

**这一步是整个计划的验收线**：产出了 Excel 才算「接进来能用」，其余都只是「装上了」。

- [ ] **Step 6: 记录走查结果**

把以下内容写进会话（或 PR 描述）：卡片截图、agent 实际跑的命令序列、Excel 产物路径与行数。**如实记录**——若某一步没按预期走（比如 agent 跳过了 ensure-python 直接用系统 python），照实写并回到对应任务修，不要含糊带过。

---

### Task 7: 本地后端更新 + 管理台配卡（可降级）

> **这是本计划耗时最不可控的任务。** 若久攻不下，直接跳到 Task 8 的降级路径——
> 第 1-6 任务的产出（技能可用 + 内置卡可见）已经是完整可交付的功能，不依赖本任务。

**Files:**
- Modify: `~/Desktop/project/cowork_admin`（外部仓库，只更新不改代码）
- 不改本仓任何文件

**Interfaces:**
- Consumes: Task 5 产出的卡片内容（label / description / 四条 prompt / 图标）
- Produces: 本地后端 `GET /api/v1/client/scenario-catalog` 返回含审标书条目的目录；以及一份验证过的配置 JSON（Task 8 的输入）

- [ ] **Step 1: 确认现状（本地后端确实没这个接口）**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/api/v1/client/scenario-catalog
```

Expected: `404`。这印证了本地后端代码停在 7-22（`dbfa5f4`），场景目录功能不在其中。

- [ ] **Step 2: 更新后端源码**

```bash
cd ~/Desktop/project/cowork_admin
git status --short   # 先确认工作区干净，有未提交改动就停下来问用户
git pull origin main
git log -1 --format="%h %s"
```

Expected: 拉到 `2405c13` 或更新。确认 `backend/internal/handler/client_scenario_catalog_handler.go` 存在。

- [ ] **Step 3: 重建并重启容器**

```bash
cd ~/Desktop/project/cowork_admin
docker compose -f deploy/docker-compose.dev.yml build
docker compose -f deploy/docker-compose.dev.yml up -d
```

**预期会撞代理坑**（已记录的完整链路，逐条核对）：
- Docker 运行时是 colima（不是 Docker Desktop），VM 内访问宿主用 `192.168.5.2`
- FlClash 混合代理端口 `127.0.0.1:7890` → VM 内走 `192.168.5.2:7890`
- `/etc/docker/daemon.json` 的 `proxies` 曾被坏代理 `42.192.60.90:31867` 污染，必须指向 `192.168.5.2:7890`
- 去掉 daemon.json 的 `registry-mirrors`（daocloud 401 会干扰 buildkit）
- 给 **containerd** 也配 http-proxy drop-in（buildkit 走 containerd，不读 dockerd 的代理）
- build 时传 `--build-arg HTTP_PROXY=http://192.168.5.2:7890 --build-arg NO_PROXY=...goproxy.cn,.npmmirror.com...`

- [ ] **Step 4: 确认接口活了**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/api/v1/client/scenario-catalog
```

Expected: `401`（要 token）而不是 `404`。**从 404 变 401 就是这一步的成功信号。**

- [ ] **Step 5: 登录本地管理台**

浏览器开 `http://127.0.0.1:8080`，任意手机号 + 验证码 `123456`。

若报 `PHONE_LOGIN_DISABLED` / `REGISTRATION_DISABLED`，先开两个开关：

```bash
docker exec -it sub2api-postgres-dev psql -U sub2api -d sub2api -c \
"INSERT INTO settings(key,value,updated_at) VALUES('phone_login_enabled','true',now()) ON CONFLICT(key) DO UPDATE SET value='true';
 INSERT INTO settings(key,value,updated_at) VALUES('registration_enabled','true',now()) ON CONFLICT(key) DO UPDATE SET value='true';"
docker restart sub2api-dev
```

- [ ] **Step 6: 先 GET 拉现有配置（读-改-写的第一步）**

进 `/admin/scenario-catalog`。若显示「尚未配置」，说明是空的，可以从头建；若已有内容，**在它基础上加**，绝不整份替换。

> `PUT` 是整份覆盖：提交什么线上就变成什么。这个习惯在本地就要养成，因为
> Task 8 要在生产上做同样的事，而生产没有撤销。

- [ ] **Step 7: 配「审标书」卡**

在「日常办公」分类里，写方案之后加一条：

| 字段 | 值 |
|---|---|
| kind | `skill` |
| value | `/claude-desktop:tender-review` |
| label | `审标书` |
| description | `审招标文件，产投标核对清单` |
| iconData | 上传 Task 5 的 `tender.png`（管理台会自动压成 64×64 webp） |
| pseudo | 否（这是真实技能，不是导航伪命令） |
| prompts | Task 5 `TENDER_PROMPTS` 的四条，label 与 text 逐字照抄 |

保存。**`version` 不要手填**——服务端读当前值 +1。

- [ ] **Step 8: 验证客户端真的拉到了**

重启 app（`bun run dev`），登录同一账号，确认：
- 「审标书」卡仍在写方案旁
- 图标是后台上传的那张（`iconData` 优先级高于客户端静态切片）
- 四条 prompt 正常展开

**这一步同时验证了两件事**：后台配置生效，以及内置表与远端表的内容一致（否则卡片会跳变）。

- [ ] **Step 9: 导出验证过的配置**

```bash
# 从管理台页面复制完整 JSON，或直接从数据库取
docker exec -it sub2api-postgres-dev psql -U sub2api -d sub2api -t -c \
"SELECT value FROM settings WHERE key LIKE '%scenario%';" > /tmp/scenario-catalog-verified.json
```

留作 Task 8 的输入。

---

### Task 8: 生产交付物

**Files:**
- Create: `docs/tender-review-scenario-card-deploy.md`

**Interfaces:**
- Consumes: Task 7 Step 9 导出的配置（若 Task 7 降级，则用 Task 5 的卡片内容直接编写）
- Produces: 用户可独立执行的生产配置说明。**本任务不碰任何生产凭据。**

- [ ] **Step 1: 写交付文档**

Create `docs/tender-review-scenario-card-deploy.md`，包含五节：

1. **这份文档解决什么** —— 内置默认表只对未登录 / 离线 / 全新安装的用户生效；已登录用户看到的是后台下发的那份，且**远端是整表替换不是合并**，所以后台不配就看不见这张卡。
2. **⚠️ 动手前必读：先 GET 再改再 PUT** —— `PUT /api/v1/admin/scenario-catalog` 是整份覆盖，提交什么线上就变成什么。若生产已配过目录（运营改过的文案），拿别处的表直接盖上去会把那些改动**全部抹掉且无法撤销**。正确顺序恒为读 → 在读到的那份上改 → 写。`version` 由服务端 +1，不要手填。
3. **操作步骤** —— 登录生产管理台（`https://cowork.cntcn.com`）→ 进 `/admin/scenario-catalog`（设置页也有入口卡）→ 在「日常办公」分类、写方案之后新增一条 → 逐字段填（照抄下一节的表）→ 上传图标 → 保存。
4. **要填的内容** —— Task 7 Step 7 那张字段表 + 四条 prompt 的完整 label/text（逐字可复制）。
5. **怎么确认生效** —— 用生产账号登录 app，看卡片是否出现在写方案旁；后台入口卡的 `version` 是否 +1。

- [ ] **Step 2: 附上图标文件位置**

在文档里写明图标取自 `apps/studio/public/skill-icons/tender.png`，以及体积约束：整份目录有 1MB 硬上限（客户端 `MAX_CATALOG_BYTES`），**超了整份配置被拒、客户端回落内置表**——比「某个图标不显示」严重得多。管理台上传时会自动压到 64×64 webp（约 2-4KB），走管理台上传即可，不要手工塞 base64。

- [ ] **Step 3: 提交**

```bash
git add docs/tender-review-scenario-card-deploy.md
git commit -m "docs(tender-review): 生产场景卡配置说明

后台远端目录是整表替换不是合并，不配后台则已登录用户看不到这张卡。
文档把「先 GET 再改再 PUT」立为硬纪律——生产没有撤销。"
```

- [ ] **Step 4: 交付给用户**

告知用户文档路径，并说明：生产那一步由他自己操作（我不碰生产凭据）；若 Task 7 降级了，一并说明本地未验证、文档内容基于 Task 5 的内置表编写。

---

## 降级路径

若 Task 7 的后端重建卡住：

1. **跳过 Task 7，直接做 Task 8**，文档内容改用 Task 5 的内置表卡片内容编写
2. 在 Task 8 的交付说明里**明确写「本配置未经本地后端验证」**——不要让用户以为它验过了
3. 第 1-6 任务的产出不受影响：技能可用、命令可触发、未登录用户能看到卡片

**判断何时降级**：Docker 构建连续失败超过 3 轮、或代理链排查超过 1 小时，即降级。这个功能的价值不在后台配置那一步。
