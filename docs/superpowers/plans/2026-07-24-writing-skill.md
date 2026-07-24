# writing skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `skills/writing/` 建一个对标 `skills/ppt-master` 的工程化写作技能，支持微信文案 / 短篇小说 / 文章三体裁共 14 个细分场景的从零创作与改写，并在应用「设计创意」分类里露出一张入口卡。

**Architecture:** 四角色串行流水线（策划 → 写手 → 审校 → 润色）。策划阶段产出 `design_spec.md`（人类可读方案）与 `spec_lock.md`（机器可读写作契约）；写手每写一节前强制重读契约以抵抗长文上下文漂移；审校跑 Python 脚本做可计算的质检（AI 味五维打分、可读性、连贯性），润色按诊断清单定向修改。方法论内容以索引式资源库组织（文风库 / 结构模式库 / 体裁题材手册），只读锁定的那一份，禁止 glob 整个目录。

**Tech Stack:** Markdown（SKILL.md + 资源库）、Python 3.12 标准库为主（脚本）、pytest（脚本测试）、TypeScript/React（应用前端三处登记）。包管理器 bun；Python 走技能自带 venv。

**设计文档：** `docs/superpowers/specs/2026-07-24-writing-skill-design.md` — 有疑问先读它。

## Global Constraints

- **技能根目录**：`skills/writing/`。目录名即触发名，落地后自动可用 `/claude-desktop:writing`（`skills/.claude-plugin/plugin.json` 已把整个 `skills/` 注册为本地插件，**后端零改动**）。
- **Python 解释器**：所有 `python3 scripts/...` 命令必须跑在技能自带 venv 里。文档与命令一律先 `source skills/writing/bin/ensure-python.sh`，再用 `$WRITING_PY` 替换 `python3`。venv 落在 `~/.writing-skill/venv`（用户可写目录）——**绝不能建在技能目录里**，打包后它在 Electron resources 下是只读的。
- **脚本依赖**：质检三脚本（`ai_slop_checker` / `readability_check` / `continuity_check`）**只用 Python 标准库**，不引入分词库。`export.py` 的 docx 输出、`source_to_md` 的 PDF/Word 解析可用第三方库。
- **中文优先**：所有面向用户的文案、报告、注释一律中文。代码标识符用英文。
- **注释纪律**：沿用本仓库风格——注释解释「为什么这样而不是那样」，改不变量时把理由写进注释。
- **禁止事项（写进 SKILL.md 的全局纪律，实现时也遵守）**：策划阶段禁止提前写正文；写手禁止批量生成、禁止用脚本批量产出正文、禁止委派子 agent 代写；润色禁止推翻重写。
- **前端改动只有三处**：`apps/studio/public/skill-icons/writing.png`、`apps/studio/src/chat/composer/skillChipRegistry.ts`、`apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx`。不碰 `FusionRuntimeProvider.tsx`（不做客户端拦截）。
- **前端验证命令**：`bun run typecheck`（本仓库唯一的自动化防线，没有 ESLint、没有前端单测）。
- **Python 测试命令**：`$WRITING_PY -m pytest skills/writing/tests/ -v`。

## 研究结论摘要（内容任务的事实来源）

以下是调研 9 个开源写作技能后提炼的可操作结论。Phase B 的内容任务**必须**据此撰写，不要凭空发挥。

**去 AI 味（三体裁通用）**
- **结构均匀度是首要信号**：句长、段落长度分布太整齐本身就是破绽，光换词无效。
- 三库分离维护：**套话库**（时代背景套话、总结套话、程度副词套话、客观中立套话、动词名词化）、**AI 句式库**（「这不是 A 而是 B」、「既…又…」、「一方面…另一方面」、三段式排比等 10 种）、**书面词替换库**（「进行操作」→「用」）。
- 改味不改错，删最少字换最大效果。

**微信文案**
- 论证顺序不可颠倒：定位（讲给谁、解决什么）→ 单一承诺（一篇只讲一件事）→ 证据（具体事实优于形容词）→ 行动号召。
- 标题四类公式，各需真实例句：冲突对比型（弱者身份 + 意外成就）、疑问引导型、数字效果型、否定反转型（「别再…了！…来了」）。
- 硬指标：公众号长文 2000–5000 字、每段 ≤150 字（手机屏 3–5 行）、每 500 字至少一个小标题。
- 金句可公式化：「连〔弱者〕都能〔成就〕，你也一定可以」「我负责〔A〕，AI 负责〔B〕」。
- 改写流程：先出「AI 痕迹仪表盘」（套话频次 / 并列结构 / 客套用语）→ 分 🔴必须改 / 🟡建议改 / 🟢可选 三级 → 按优先级改。

**短篇小说**
- **情绪先行**：动笔前先定「读者读完什么感觉」（意难平 / 反转震撼 / 爽感释放 / 治愈 / 细思极恐 / 共鸣），情节为情绪服务。这是短篇与长篇最大的方法论差异。
- 五段式骨架 + 硬阈值：开头（前 100 字事件密度 ≥3）→ 铺垫 30–40%（埋 ≥3 条反转线索）→ 升级 20–30%（冲突强度必须递增）→ 反转 10–15%（冲击力度超过此前所有节点）→ 结尾 5–10%（安静细节收尾，不写大段抒情）。
- 人物 **Core Four** 公式：Want（外在目标）/ Need（内在需求）/ Wound（伤口）/ Lie（由伤口生出的错误信念）。角色弧光＝克服这个 Lie 的过程。检验法：对任一行为连续追问「为什么」，追不到 Wound 说明动机不成立。
- 场景 **GCOS** 自查：Goal（目标）- Conflict（冲突）- Outcome（结果，必须是「是 / 否 / 是但有代价 / 否但有转机」四选一，不能含糊）- Sequel（后续处理与决策）。缺任一环场景就会「软」。
- **三维度揉进**写法：每个子事件把「发生 - 感知 - 反应」揉进同一段连续正文，不按维度分层堆叠（分层堆叠是 AI 味的典型来源）。
- Show-Don't-Tell 五级光谱（纯告知 → 告知+生理 → 纯生理 → 动作 → 潜台词），**展示深度要匹配情绪重要性**，不是任何时候都展示到底。
- 伏笔用三元组记录：埋点 - 回收点 - 状态（planned / planted / paid-off）。

**文章**
- 说明类骨架：问题 → 方案 → 怎么运作（3–4 步）→ 异议处理 → 结尾行动。
- 钩子三选一：数据冲击型 / 提问型 / 故事型，每种要附一句「为什么它有效」的自评。
- 改稿七轮扫描（每轮只盯一个维度，改完回头复查）：清晰度 → 语气一致 → 「所以呢」（每个论点自问关读者什么事）→ 举证（每个断言要有证据）→ 具体化（模糊词换数字）→ 情绪浓度 → 消除读者犹豫点。
- 五维反 AI 腔打分（直接度 / 节奏 / 信任感 / 真实感 / 密度），低于 35/50 重写。
- 读者评分团终审：假设 3–5 个不同身份读者（目标读者 / 怀疑论者 / 编辑）各打 1–10 分，均分 ≥8 才算过关。档位：9–10 可发布 / 7–8 小改 / 5–6 需重写 / 3–4 大改 / 1–2 推翻重来。

---

## Phase A：Python 工具链

### Task 1: 技能骨架 + Python 自举 + 共享工具模块

**Files:**
- Create: `skills/writing/bin/ensure-python.sh`
- Create: `skills/writing/bin/ensure-python.cmd`
- Create: `skills/writing/requirements.txt`
- Create: `skills/writing/scripts/writing_utils.py`
- Create: `skills/writing/scripts/project_manager.py`
- Test: `skills/writing/tests/test_writing_utils.py`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `writing_utils.split_sentences(text: str) -> list[str]`
  - `writing_utils.split_paragraphs(text: str) -> list[str]`
  - `writing_utils.strip_markdown(text: str) -> str`
  - `writing_utils.coefficient_of_variation(values: list[int|float]) -> float`
  - `writing_utils.Hit` 数据类，字段 `line: int, col: int, text: str, rule: str`
  - `writing_utils.find_hits(text: str, pattern: re.Pattern, rule: str) -> list[Hit]`
  - `writing_utils.load_wordlist(name: str) -> list[str]`（读 `scripts/data/<name>.txt`，跳过空行与 `#` 注释）
  - `writing_utils.char_count(text: str) -> int`
  - `writing_utils.split_data_line(body: str) -> tuple[str, str] | None`（契约数据行切分，竖线优先于冒号）
  - `writing_utils.parse_spec_lock(path: Path) -> dict[str, dict[str, str]]`
  - `project_manager.slugify(name: str) -> str`
  - `project_manager.init_project(name: str, base_dir: Path, today: str) -> Path`
  - `project_manager.validate_project(project_dir: Path) -> list[str]`
  - `project_manager.SUBDIRS: tuple[str, ...]`
  - CLI：`python3 scripts/project_manager.py init <项目名> [--dir <路径>] [--date <YYYYMMDD>]`

- [ ] **Step 1: 建目录骨架**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
mkdir -p skills/writing/{bin,scripts/data,tests,references,templates,workflows,projects}
```

- [ ] **Step 2: 写 `skills/writing/bin/ensure-python.sh`**

照抄 `skills/ppt-master/bin/ensure-python.sh` 的结构（先读那个文件），只做三处替换：变量名 `PPT_` → `WRITING_`、venv 路径 `~/.ppt-master/venv` → `~/.writing-skill/venv`、导出变量 `PPT_PY` → `WRITING_PY`、日志前缀 `[ppt-master]` → `[writing]`。保留三镜像源回退（清华 → 阿里 → 官方）与 `.deps-ok` 哨兵机制，这两条都是踩过坑换来的。同理照抄 `.cmd` 版本。

- [ ] **Step 3: 写 `skills/writing/requirements.txt`**

```
# writing skill 依赖
# 质检三脚本（ai_slop_checker / readability_check / continuity_check）只用标准库，
# 不在此列。以下仅供素材解析与导出使用。

# 测试
pytest>=8.0

# source_to_md：PDF / Word / 网页解析
pymupdf>=1.24
python-docx>=1.1
requests>=2.31
beautifulsoup4>=4.12

# export.py：导出 Word
# （python-docx 已在上面）
```

- [ ] **Step 4: 写失败的测试 `skills/writing/tests/test_writing_utils.py`**

```python
"""writing_utils 的行为测试。

启发式打分的阈值是可调常量，所以这里钉的是**行为**（切分正确、
均匀文本的变异系数低于参差文本），不钉具体数值。
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import writing_utils as wu


def test_split_sentences_handles_chinese_punctuation():
    text = "他走了。你为什么不拦？真可惜！"
    assert wu.split_sentences(text) == ["他走了。", "你为什么不拦？", "真可惜！"]


def test_split_sentences_absorbs_closing_quote():
    text = "他说：“我不去。”她没回答。"
    assert wu.split_sentences(text) == ["他说：“我不去。”", "她没回答。"]


def test_split_sentences_keeps_tail_without_punctuation():
    assert wu.split_sentences("没有句号的结尾") == ["没有句号的结尾"]


def test_split_paragraphs_drops_blank_lines():
    text = "第一段\n\n第二段\n   \n第三段"
    assert wu.split_paragraphs(text) == ["第一段", "第二段", "第三段"]


def test_strip_markdown_removes_headings_and_fences():
    text = "# 标题\n正文一\n```py\ncode()\n```\n> 引用内容\n正文二"
    assert wu.strip_markdown(text) == "正文一\n引用内容\n正文二"


def test_cv_uniform_lower_than_varied():
    uniform = [20, 21, 20, 19, 20]
    varied = [4, 38, 12, 51, 7]
    assert wu.coefficient_of_variation(uniform) < wu.coefficient_of_variation(varied)


def test_cv_single_value_is_zero():
    assert wu.coefficient_of_variation([10]) == 0.0


def test_find_hits_reports_line_and_column():
    text = "首先我们来看\n第二行没有\n其次再说一点"
    hits = wu.find_hits(text, re.compile("首先|其次"), rule="套话")
    assert [(h.line, h.text) for h in hits] == [(1, "首先"), (3, "其次")]
    assert hits[0].col == 1
    assert hits[0].rule == "套话"


def test_load_wordlist_skips_comments_and_blanks(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "demo.txt").write_text("# 注释\n首先\n\n其次\n", encoding="utf-8")
    monkeypatch.setattr(wu, "DATA_DIR", data_dir)
    assert wu.load_wordlist("demo") == ["首先", "其次"]


def test_parse_spec_lock_reads_sections(tmp_path):
    p = tmp_path / "spec_lock.md"
    p.write_text(
        "## 体裁\n- genre: short-story\n- sub: 悬疑推理\n\n"
        "## 禁用清单\n- 禁用词: 首先, 其次\n- 禁用句式: 三段式排比\n",
        encoding="utf-8",
    )
    spec = wu.parse_spec_lock(p)
    assert spec["体裁"]["genre"] == "short-story"
    assert spec["体裁"]["sub"] == "悬疑推理"
    assert spec["禁用清单"]["禁用词"] == "首先, 其次"


def test_split_data_line_simple_key_value():
    assert wu.split_data_line("voice: 冷峻克制") == ("voice", "冷峻克制")


def test_split_data_line_pipe_record_splits_on_pipe_not_colon():
    # 竖线记录里的冒号在竖线之后 —— 按冒号切会得到废键「张明 | want」
    key, value = wu.split_data_line("张明 | want:找到妹妹 | need:原谅自己")
    assert key == "张明"
    assert value == "want:找到妹妹 | need:原谅自己"


def test_split_data_line_returns_none_for_plain_text():
    assert wu.split_data_line("这行没有分隔符") is None


def test_parse_spec_lock_handles_character_and_foreshadow_rows(tmp_path):
    p = tmp_path / "spec_lock.md"
    p.write_text(
        "## 人物档案\n- 张明 | want:找到妹妹 | wound:车祸中独自生还\n\n"
        "## 伏笔表\n- 001 | 埋点:第2节 钥匙 | 回收:第5节 | 状态:已埋未收\n",
        encoding="utf-8",
    )
    spec = wu.parse_spec_lock(p)
    assert "张明" in spec["人物档案"]
    assert "001" in spec["伏笔表"]
    assert spec["伏笔表"]["001"].endswith("状态:已埋未收")
```

- [ ] **Step 5: 跑测试确认失败**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
source skills/writing/bin/ensure-python.sh
$WRITING_PY -m pytest skills/writing/tests/test_writing_utils.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'writing_utils'`

- [ ] **Step 6: 实现 `skills/writing/scripts/writing_utils.py`**

```python
#!/usr/bin/env python3
"""writing skill 的共享文本工具。

所有质检脚本都从这里取切分、统计与定位能力——切句规则只有一份，
避免各脚本各切各的、同一段正文在不同报告里句数不一致。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"

# 句末标点。中文正文一句话以这些收尾，后面可能紧跟收尾引号/括号——
# 那些符号属于上一句，不能切到下一句去（"他说：“我不去。”" 是一句）。
_SENT_END_CHARS = "。！？!?…"
_CLOSING_CHARS = "」』”’）)】》"

_FENCE = re.compile(r"^\s*```")


@dataclass
class Hit:
    """一次规则命中，带行列定位——报告要能让人直接跳到那一行。"""

    line: int
    col: int
    text: str
    rule: str


def split_sentences(text: str) -> list[str]:
    """按中文句末标点切句。

    不用正则 split：收尾引号与连续省略号的归属需要向前吞字，
    正则的 lookaround 写法在这两种情况下都会切错。
    """
    sentences: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        buf.append(ch)
        if ch in _SENT_END_CHARS:
            j = i + 1
            # 吞掉紧跟的句末标点（省略号、！？连用）与收尾引号
            while j < len(text) and (text[j] in _SENT_END_CHARS or text[j] in _CLOSING_CHARS):
                buf.append(text[j])
                j += 1
            chunk = "".join(buf).strip()
            if chunk:
                sentences.append(chunk)
            buf = []
            i = j
            continue
        i += 1
    tail = "".join(buf).strip()
    if tail:
        sentences.append(tail)
    return sentences


def split_paragraphs(text: str) -> list[str]:
    """非空行即一段——中文写作在 Markdown 里的通行习惯。"""
    return [line.strip() for line in text.splitlines() if line.strip()]


def strip_markdown(text: str) -> str:
    """剥掉不该进正文统计的部分：小标题、代码块、引用标记。

    小标题必须剥掉：它们天然极短，留着会把段落长度方差算虚高，
    正好掩盖掉「正文段落长得一样齐」这个 AI 味信号。
    """
    out: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if stripped.startswith(">"):
            stripped = stripped.lstrip("> ").strip()
        out.append(stripped)
    return "\n".join(out)


def coefficient_of_variation(values: list[float]) -> float:
    """变异系数（标准差 ÷ 均值）。

    用它而不是裸标准差：长文与短文的绝对句长差很多，只有归一化后
    才能跨文本比较「参差程度」。
    """
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    if mean == 0:
        return 0.0
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    return (variance**0.5) / mean


def find_hits(text: str, pattern: re.Pattern, rule: str) -> list[Hit]:
    """逐行匹配，返回带行列号的命中列表。"""
    hits: list[Hit] = []
    for idx, line in enumerate(text.splitlines(), start=1):
        for m in pattern.finditer(line):
            hits.append(Hit(line=idx, col=m.start() + 1, text=m.group(0), rule=rule))
    return hits


def load_wordlist(name: str) -> list[str]:
    """读 scripts/data/<name>.txt。空行与 # 开头的注释行跳过。"""
    path = DATA_DIR / f"{name}.txt"
    if not path.exists():
        return []
    words: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        words.append(s)
    return words


def char_count(text: str) -> int:
    """正文字数：不含空白字符。中文写作的「字数」按字算，不按词。"""
    return len(re.sub(r"\s", "", text))


def split_data_line(body: str) -> tuple[str, str] | None:
    """把一条 `- ` 数据行的正文切成 (key, value)。返回 None 表示不是数据行。

    契约里有两种行：
      简单键值   `voice: 冷峻克制`                       → 按第一个冒号切
      竖线记录   `张明 | want:找到妹妹 | need:原谅自己`   → 按第一个竖线切

    必须先判断竖线：竖线记录里的冒号出现在竖线之后，按冒号切会得到
    `张明 | want` 这种废键，人物档案与伏笔表整段静默解析失败（而且不报错，
    只是查不出问题 —— 最难发现的那种坏法）。
    """
    pipe = body.find("|")
    colon = body.find(":")
    if pipe >= 0 and (colon < 0 or pipe < colon):
        key, _, value = body.partition("|")
    elif colon >= 0:
        key, _, value = body.partition(":")
    else:
        return None
    return key.strip(), value.strip()


def parse_spec_lock(path: Path) -> dict[str, dict[str, str]]:
    """解析写作契约。

    格式固定为 `## 段名` + 若干 `- ` 数据行——刻意保持成人类可读的
    Markdown 而不是 JSON/YAML：用户会直接打开它看、偶尔手改，
    Markdown 是唯一两边都舒服的格式。
    """
    result: dict[str, dict[str, str]] = {}
    section = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("## "):
            section = s[3:].strip()
            result.setdefault(section, {})
            continue
        if s.startswith("- ") and section:
            parsed = split_data_line(s[2:])
            if parsed is None:
                continue
            result[section][parsed[0]] = parsed[1]
    return result
```

- [ ] **Step 7: 跑测试确认通过**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_writing_utils.py -v
```
Expected: PASS，14 passed

- [ ] **Step 8: 实现 `skills/writing/scripts/project_manager.py`**

```python
#!/usr/bin/env python3
"""writing skill 项目管理。

用法：
    python3 scripts/project_manager.py init <项目名> [--dir <路径>]
    python3 scripts/project_manager.py validate <项目路径>
    python3 scripts/project_manager.py info <项目路径>

项目目录即真相：不维护任何中央索引文件，删目录就等于删项目。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PROJECTS_DIR = SKILL_DIR / "projects"

# 项目内的固定子目录。每个都有明确归属，不允许写串：
#   sources/  用户给的原始素材 + 转好的 Markdown
#   analysis/ 机器提取的事实（素材摘要、文风分析、AI 味基线分）
#   drafts/   初稿分节，一节一个文件
#   reviews/  质检报告
#   output/   定稿与各平台导出
SUBDIRS = ("sources", "analysis", "drafts", "reviews", "output")

_SLUG_RE = re.compile(r"[^a-z0-9一-鿿]+")


def slugify(name: str) -> str:
    """项目名 → 目录安全的 slug。保留中文，其余非字母数字压成下划线。"""
    s = _SLUG_RE.sub("_", name.strip().lower()).strip("_")
    return s or "untitled"


def init_project(name: str, base_dir: Path, today: str) -> Path:
    project_dir = base_dir / f"{slugify(name)}_{today}"
    project_dir.mkdir(parents=True, exist_ok=True)
    for sub in SUBDIRS:
        (project_dir / sub).mkdir(exist_ok=True)
    readme = project_dir / "README.md"
    if not readme.exists():
        readme.write_text(
            f"# {name}\n\n"
            f"创建于 {today}。\n\n"
            "- `sources/` 原始素材与转好的 Markdown\n"
            "- `analysis/` 机器提取的事实\n"
            "- `drafts/` 初稿分节\n"
            "- `reviews/` 质检报告\n"
            "- `output/` 定稿与导出\n\n"
            "`design_spec.md` 是写作方案，`spec_lock.md` 是写作契约"
            "（写手每写一节前必须重读）。\n",
            encoding="utf-8",
        )
    return project_dir


def validate_project(project_dir: Path) -> list[str]:
    """返回问题列表，空列表代表结构完整。"""
    problems: list[str] = []
    if not project_dir.is_dir():
        return [f"项目目录不存在：{project_dir}"]
    for sub in SUBDIRS:
        if not (project_dir / sub).is_dir():
            problems.append(f"缺少子目录：{sub}/")
    if not (project_dir / "spec_lock.md").exists():
        problems.append("缺少 spec_lock.md（写作契约尚未生成，策划阶段未完成）")
    return problems


def project_info(project_dir: Path) -> dict:
    drafts = sorted((project_dir / "drafts").glob("*.md")) if (project_dir / "drafts").is_dir() else []
    return {
        "path": str(project_dir),
        "has_design_spec": (project_dir / "design_spec.md").exists(),
        "has_spec_lock": (project_dir / "spec_lock.md").exists(),
        "draft_sections": [p.name for p in drafts],
        "problems": validate_project(project_dir),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="writing skill 项目管理")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="新建项目目录")
    p_init.add_argument("name")
    p_init.add_argument("--dir", default=str(DEFAULT_PROJECTS_DIR))
    p_init.add_argument("--date", default=None, help="日期戳，默认今天（YYYYMMDD）")

    p_val = sub.add_parser("validate", help="校验项目结构")
    p_val.add_argument("project_path")

    p_info = sub.add_parser("info", help="打印项目状态 JSON")
    p_info.add_argument("project_path")

    args = parser.parse_args(argv)

    if args.cmd == "init":
        today = args.date or datetime.now().strftime("%Y%m%d")
        path = init_project(args.name, Path(args.dir), today)
        print(f"[writing] 项目已创建：{path}")
        return 0

    if args.cmd == "validate":
        problems = validate_project(Path(args.project_path))
        if problems:
            for p in problems:
                print(f"[writing] ✗ {p}")
            return 1
        print("[writing] ✓ 项目结构完整")
        return 0

    print(json.dumps(project_info(Path(args.project_path)), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 9: 写 project_manager 的测试并跑通**

追加到 `skills/writing/tests/test_project_manager.py`：

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import project_manager as pm


def test_slugify_keeps_chinese_and_compresses_symbols():
    assert pm.slugify("我的 公众号-文案!!") == "我的_公众号_文案"


def test_init_creates_all_subdirs(tmp_path):
    project = pm.init_project("测试项目", tmp_path, "20260724")
    assert project.name == "测试项目_20260724"
    for sub in pm.SUBDIRS:
        assert (project / sub).is_dir()
    assert (project / "README.md").exists()


def test_validate_flags_missing_spec_lock(tmp_path):
    project = pm.init_project("测试项目", tmp_path, "20260724")
    problems = pm.validate_project(project)
    assert any("spec_lock.md" in p for p in problems)


def test_validate_passes_when_complete(tmp_path):
    project = pm.init_project("测试项目", tmp_path, "20260724")
    (project / "spec_lock.md").write_text("## 体裁\n- genre: article\n", encoding="utf-8")
    assert pm.validate_project(project) == []
```

```bash
$WRITING_PY -m pytest skills/writing/tests/ -v
```
Expected: PASS，18 passed

- [ ] **Step 10: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add skills/writing/
git commit -m "feat(writing): 技能骨架 + Python 自举 + 共享文本工具与项目管理"
```

---

### Task 2: AI 味检测脚本（核心质检）

**Files:**
- Create: `skills/writing/scripts/data/banned_words.txt`
- Create: `skills/writing/scripts/data/ai_patterns.txt`
- Create: `skills/writing/scripts/data/bookish_words.txt`
- Create: `skills/writing/scripts/data/adjectives.txt`
- Create: `skills/writing/scripts/data/concrete_markers.txt`
- Create: `skills/writing/scripts/ai_slop_checker.py`
- Test: `skills/writing/tests/test_ai_slop_checker.py`

**Interfaces:**
- Consumes: `writing_utils` 的 `split_sentences` / `split_paragraphs` / `strip_markdown` / `coefficient_of_variation` / `find_hits` / `load_wordlist` / `char_count` / `parse_spec_lock` / `Hit`
- Produces:
  - `ai_slop_checker.score_text(text: str, extra_banned: list[str] | None = None) -> Report`
  - `Report` 数据类：`total: float`（0–50）、`dimensions: dict[str, float]`（五个维度各 0–10）、`hits: list[Hit]`、`stats: dict[str, float]`
  - `ai_slop_checker.grade(hit: Hit) -> str` 返回 `"🔴"` / `"🟡"` / `"🟢"`
  - CLI：`python3 scripts/ai_slop_checker.py <文件路径> [--spec-lock <路径>] [--json]`

- [ ] **Step 1: 写词表数据文件**

`skills/writing/scripts/data/banned_words.txt`：

```
# 套话库 —— 命中即 🔴。分四组，改词时整组一起想。
# 1. 关联词套话：AI 最爱用它们做「结构化」表达，人写文章很少这么齐整
首先
其次
再次
最后
第一
第二
第三
一方面
另一方面
与此同时
除此之外
# 2. 总结套话
综上所述
总而言之
总的来说
由此可见
不难看出
不难发现
可以说
值得一提的是
值得注意的是
需要注意的是
# 3. 客观中立套话：把观点稀释成废话
在一定程度上
从某种意义上说
在当今社会
随着时代的发展
随着科技的进步
在这个信息爆炸的时代
# 4. 程度副词套话：形容词前的填充物
非常之
极其
十分地
相当地
```

`skills/writing/scripts/data/ai_patterns.txt`（每行一条正则，`|` 后是规则名）：

```
# AI 句式库 —— 命中即 🔴。格式：<正则>|<规则名>
不是[^，。；\n]{1,20}而是|反转对举句
既[^，。；\n]{1,15}又[^，。；\n]{1,15}|既又并列句
不仅[^，。；\n]{1,20}(而且|还|更)|不仅而且句
既是[^，。；\n]{1,15}也是|既是也是句
无论是[^，。；\n]{1,20}还是|无论还是句
从[^，。；\n]{1,10}到[^，。；\n]{1,10}，再到|从到再到句
让我们一起|号召式套话
在这个[^，。；\n]{1,12}的时代|时代背景开场
这不仅仅是|递进强调套话
真正的[^，。；\n]{1,10}在于|定义式断言
的核心在于|定义式断言
```

`skills/writing/scripts/data/bookish_words.txt`：

```
# 书面腔 / 动词名词化 —— 命中即 🟡。口语里没人这么说。
进行操作
进行处理
进行分析
进行优化
进行改进
予以
加以
给予
作出
做出选择
实现了
达成了
具备
拥有着
存在着
起到了
发挥了
产生了
形成了
构建
打造
赋能
抓手
闭环
颗粒度
对齐一下
```

`skills/writing/scripts/data/adjectives.txt`：

```
# 常见形容词/副词 —— 用于「具体度」维度的分母。
# AI 爱堆形容词而不给事实，形容词密度高、具体标记密度低就是信号。
优秀
卓越
出色
显著
明显
巨大
重要
关键
核心
强大
高效
快速
简单
容易
复杂
困难
丰富
多样
全面
深刻
深入
广泛
有效
成功
完美
极致
精准
智能
先进
创新
领先
专业
可靠
稳定
灵活
便捷
美好
温暖
惊人
震撼
```

`skills/writing/scripts/data/concrete_markers.txt`：

```
# 具体度标记 —— 分子。数字/单位/时间/量词命中越多，文章越「有事实」。
# 注意：这里放的是词，纯数字由正则单独统计。
年
月
日
点
分钟
小时
天
周
个月
块
元
万
亿
倍
%
个
次
人
家
款
版
```

- [ ] **Step 2: 写失败的测试 `skills/writing/tests/test_ai_slop_checker.py`**

```python
"""AI 味检测的行为测试。

启发式打分的标定常量会随真实样本调整，所以这里钉的是**相对行为**：
AI 腔文本必须比人话文本得分低、命中必须报出正确行号、总分必须在
0–50 之间。不钉死具体分值，否则每次微调常量都要改测试。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import ai_slop_checker as checker

# 典型 AI 腔：关联词套话齐全、句长整齐、全是形容词没有事实
AI_TEXT = """在这个信息爆炸的时代，内容创作变得非常重要。
首先，优秀的内容需要清晰的结构和深刻的洞察。
其次，高效的表达能够显著提升读者的阅读体验。
再次，创新的视角可以带来巨大的价值和广泛的影响。
综上所述，这不仅仅是技巧问题，更是思维方式的转变。"""

# 典型人话：句长参差、有具体数字和细节、没有套话
HUMAN_TEXT = """上周我改了 37 版标题。
最后用的那版是我在地铁上想出来的，只有 9 个字。
数据出来那天，打开率从 4.2% 涨到 11.8%，我盯着后台看了很久，
突然意识到前面 36 版全都在自说自话——我一直在讲产品多好，
从没讲过读者早上七点挤地铁时到底在想什么。
那天之后我改了写标题的顺序。先写读者，再写产品。"""


def test_report_total_within_range():
    report = checker.score_text(HUMAN_TEXT)
    assert 0 <= report.total <= 50
    assert len(report.dimensions) == 5
    for value in report.dimensions.values():
        assert 0 <= value <= 10


def test_ai_text_scores_lower_than_human_text():
    ai = checker.score_text(AI_TEXT)
    human = checker.score_text(HUMAN_TEXT)
    assert ai.total < human.total


def test_banned_words_reported_with_line_numbers():
    report = checker.score_text(AI_TEXT)
    banned = [h for h in report.hits if h.rule == "套话"]
    texts = {h.text for h in banned}
    assert "首先" in texts
    assert "其次" in texts
    assert "综上所述" in texts
    for hit in banned:
        assert hit.line >= 1


def test_ai_pattern_detected():
    report = checker.score_text("这不是一次改版，而是一次重生。")
    rules = {h.rule for h in report.hits}
    assert "反转对举句" in rules


def test_extra_banned_words_from_spec_lock_are_applied():
    text = "我们要拥抱变化，实现闭环。"
    base = checker.score_text(text)
    with_extra = checker.score_text(text, extra_banned=["拥抱变化"])
    assert len(with_extra.hits) > len(base.hits)
    assert any(h.text == "拥抱变化" for h in with_extra.hits)


def test_uniform_sentences_lower_structure_score():
    uniform = "他走进房间里去。\n她坐在椅子上面。\n风吹过窗帘边上。\n猫跳上桌子中央。"
    varied = "他进来了。\n她没抬头，手里那本翻了一半的书停在第三章，页角卷着，"\
        "像被人反复捏过很多次。\n风。\n猫跳上桌子，把水杯撞翻了，水顺着桌沿滴到她鞋上，她还是没动。"
    assert (
        checker.score_text(uniform).dimensions["结构均匀度"]
        < checker.score_text(varied).dimensions["结构均匀度"]
    )


def test_grade_levels():
    hit_banned = checker.wu.Hit(line=1, col=1, text="首先", rule="套话")
    hit_bookish = checker.wu.Hit(line=1, col=1, text="进行操作", rule="书面腔")
    assert checker.grade(hit_banned) == "🔴"
    assert checker.grade(hit_bookish) == "🟡"


def test_empty_text_does_not_crash():
    report = checker.score_text("")
    assert report.total >= 0
```

- [ ] **Step 3: 跑测试确认失败**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_ai_slop_checker.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'ai_slop_checker'`

- [ ] **Step 4: 实现 `skills/writing/scripts/ai_slop_checker.py`**

```python
#!/usr/bin/env python3
"""AI 味检测 —— 五维打分，满分 50，低于 35 打回重写。

用法：
    python3 scripts/ai_slop_checker.py <文件路径> [--spec-lock <路径>] [--json]

为什么要脚本而不是让模型自查：五个维度里最关键的「结构均匀度」是纯
统计量（句长/段长的变异系数），模型对自己写的东西估不准这个数——
它读起来觉得「挺有变化的」，算出来 CV 只有 0.28。调研里那条
「结构均匀度是 AI 味首要信号，光换词无效」正是靠算才立得住。

标定常量（下面的 *_FLOOR / *_CEIL）是种子值，用真实样本调。调它们
不该动测试：测试钉的是相对行为（AI 腔 < 人话），不是具体分数。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# ── 标定常量 ─────────────────────────────────────────────────────────
# 句长变异系数：中文人写正文通常 0.55–0.80，AI 生成常落在 0.28–0.45。
SENT_CV_FLOOR, SENT_CV_CEIL = 0.25, 0.65
# 段长变异系数：AI 爱写「每段三句话」，人写作段落长短差得多。
PARA_CV_FLOOR, PARA_CV_CEIL = 0.20, 0.70
# 每千字命中数 → 扣分斜率。套话比书面腔更刺眼，斜率更陡。
BANNED_SLOPE = 1.5
PATTERN_SLOPE = 3.0
BOOKISH_SLOPE = 2.0
# 「的」字密度（每百字）：人写 3–5，书面腔堆到 7 以上。
DE_FLOOR, DE_CEIL = 7.0, 3.5
# 具体度：具体标记 ÷（具体标记 + 形容词）的比值区间。
CONCRETE_FLOOR, CONCRETE_CEIL = 0.15, 0.55

PASS_THRESHOLD = 35.0

_NUMBER = re.compile(r"\d+(?:\.\d+)?%?")
_DE = re.compile("的")

# 命中分级：套话与 AI 句式是硬伤，书面腔是建议改。
_GRADE_BY_RULE_PREFIX = {"套话": "🔴", "书面腔": "🟡"}


@dataclass
class Report:
    total: float
    dimensions: dict[str, float]
    hits: list[wu.Hit] = field(default_factory=list)
    stats: dict[str, float] = field(default_factory=dict)


def _clamp(value: float, low: float = 0.0, high: float = 10.0) -> float:
    return max(low, min(high, value))


def _scale(value: float, floor: float, ceil: float) -> float:
    """把 value 从 [floor, ceil] 线性映射到 [0, 10]。

    floor > ceil 时自动反向（用于「越小越好」的指标，如「的」字密度）。
    """
    if floor == ceil:
        return 10.0
    return _clamp((value - floor) / (ceil - floor) * 10.0)


def _load_patterns() -> list[tuple[re.Pattern, str]]:
    """ai_patterns.txt 每行 `<正则>|<规则名>`。"""
    out: list[tuple[re.Pattern, str]] = []
    for line in wu.load_wordlist("ai_patterns"):
        raw, _, name = line.rpartition("|")
        if not raw:
            continue
        out.append((re.compile(raw), name.strip() or "AI句式"))
    return out


def grade(hit: wu.Hit) -> str:
    """命中分级：🔴 必须改 / 🟡 建议改 / 🟢 可选。"""
    return _GRADE_BY_RULE_PREFIX.get(hit.rule, "🔴" if hit.rule != "书面腔" else "🟡")


def score_text(text: str, extra_banned: list[str] | None = None) -> Report:
    body = wu.strip_markdown(text)
    total_chars = wu.char_count(body)
    per_k = (total_chars / 1000.0) or 1.0
    per_hundred = (total_chars / 100.0) or 1.0

    sentences = wu.split_sentences(body)
    paragraphs = wu.split_paragraphs(body)
    sent_lengths = [wu.char_count(s) for s in sentences]
    para_lengths = [wu.char_count(p) for p in paragraphs]

    # 1. 结构均匀度 —— 句长权重 0.6、段长 0.4（句子是更细的信号）
    sent_cv = wu.coefficient_of_variation(sent_lengths)
    para_cv = wu.coefficient_of_variation(para_lengths)
    structure = round(
        0.6 * _scale(sent_cv, SENT_CV_FLOOR, SENT_CV_CEIL)
        + 0.4 * _scale(para_cv, PARA_CV_FLOOR, PARA_CV_CEIL),
        1,
    )

    hits: list[wu.Hit] = []

    # 2. 套话密度
    banned = wu.load_wordlist("banned_words") + list(extra_banned or [])
    if banned:
        pattern = re.compile("|".join(re.escape(w) for w in banned))
        hits.extend(wu.find_hits(body, pattern, rule="套话"))
    banned_count = sum(1 for h in hits if h.rule == "套话")
    banned_score = round(_clamp(10.0 - (banned_count / per_k) * BANNED_SLOPE), 1)

    # 3. AI 句式密度
    pattern_count = 0
    for regex, name in _load_patterns():
        found = wu.find_hits(body, regex, rule=name)
        hits.extend(found)
        pattern_count += len(found)
    pattern_score = round(_clamp(10.0 - (pattern_count / per_k) * PATTERN_SLOPE), 1)

    # 4. 书面腔浓度 —— 动词名词化命中 + 「的」字密度，各占一半
    bookish_words = wu.load_wordlist("bookish_words")
    bookish_count = 0
    if bookish_words:
        pattern = re.compile("|".join(re.escape(w) for w in bookish_words))
        found = wu.find_hits(body, pattern, rule="书面腔")
        hits.extend(found)
        bookish_count = len(found)
    de_density = len(_DE.findall(body)) / per_hundred
    bookish_score = round(
        0.5 * _clamp(10.0 - (bookish_count / per_k) * BOOKISH_SLOPE)
        + 0.5 * _scale(de_density, DE_FLOOR, DE_CEIL),
        1,
    )

    # 5. 具体度 —— 具体标记（数字 + 单位量词）对形容词的比值
    concrete_markers = wu.load_wordlist("concrete_markers")
    concrete_count = len(_NUMBER.findall(body))
    if concrete_markers:
        pattern = re.compile("|".join(re.escape(w) for w in concrete_markers))
        concrete_count += len(pattern.findall(body))
    adjectives = wu.load_wordlist("adjectives")
    adj_count = 0
    if adjectives:
        pattern = re.compile("|".join(re.escape(w) for w in adjectives))
        adj_count = len(pattern.findall(body))
    denominator = concrete_count + adj_count
    ratio = (concrete_count / denominator) if denominator else 0.0
    concrete_score = round(_scale(ratio, CONCRETE_FLOOR, CONCRETE_CEIL), 1)

    dimensions = {
        "结构均匀度": structure,
        "套话密度": banned_score,
        "AI句式密度": pattern_score,
        "书面腔浓度": bookish_score,
        "具体度": concrete_score,
    }
    return Report(
        total=round(sum(dimensions.values()), 1),
        dimensions=dimensions,
        hits=sorted(hits, key=lambda h: (h.line, h.col)),
        stats={
            "字数": float(total_chars),
            "句数": float(len(sentences)),
            "段数": float(len(paragraphs)),
            "句长变异系数": round(sent_cv, 3),
            "段长变异系数": round(para_cv, 3),
            "的字密度_每百字": round(de_density, 2),
            "具体度比值": round(ratio, 3),
        },
    )


def format_report(report: Report, source: str) -> str:
    lines = [f"# AI 味检测报告 — {source}", ""]
    verdict = "✅ 通过" if report.total >= PASS_THRESHOLD else "❌ 打回重写"
    lines.append(f"**总分 {report.total} / 50 — {verdict}**（阈值 {PASS_THRESHOLD}）")
    lines.append("")
    lines.append("| 维度 | 得分 |")
    lines.append("|---|---|")
    for name, value in report.dimensions.items():
        lines.append(f"| {name} | {value} / 10 |")
    lines.append("")
    lines.append("## 统计")
    for name, value in report.stats.items():
        lines.append(f"- {name}: {value}")
    if report.hits:
        lines.append("")
        lines.append("## 命中清单")
        lines.append("")
        lines.append("| 级别 | 行:列 | 命中 | 规则 |")
        lines.append("|---|---|---|---|")
        for hit in report.hits:
            lines.append(f"| {grade(hit)} | {hit.line}:{hit.col} | {hit.text} | {hit.rule} |")
    else:
        lines.append("")
        lines.append("## 命中清单")
        lines.append("")
        lines.append("无命中。")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AI 味检测")
    parser.add_argument("path", help="待检测的文本文件（.md / .txt）")
    parser.add_argument("--spec-lock", default=None, help="写作契约路径，取其中的禁用词")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而非报告")
    args = parser.parse_args(argv)

    text = Path(args.path).read_text(encoding="utf-8")

    extra: list[str] = []
    if args.spec_lock:
        spec = wu.parse_spec_lock(Path(args.spec_lock))
        raw = spec.get("禁用清单", {}).get("禁用词", "")
        extra = [w.strip() for w in re.split(r"[,，、]", raw) if w.strip()]

    report = score_text(text, extra_banned=extra)

    if args.json:
        print(
            json.dumps(
                {
                    "total": report.total,
                    "pass": report.total >= PASS_THRESHOLD,
                    "dimensions": report.dimensions,
                    "stats": report.stats,
                    "hits": [
                        {"line": h.line, "col": h.col, "text": h.text, "rule": h.rule, "grade": grade(h)}
                        for h in report.hits
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(format_report(report, Path(args.path).name))

    return 0 if report.total >= PASS_THRESHOLD else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: 跑测试确认通过**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_ai_slop_checker.py -v
```
Expected: PASS，9 passed

若 `test_ai_text_scores_lower_than_human_text` 失败，调整标定常量而不是改测试——测试钉的行为是对的。

- [ ] **Step 6: 手动跑一遍验证输出可读**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
printf '在这个信息爆炸的时代，内容创作非常重要。\n首先，优秀的内容需要清晰的结构。\n其次，高效的表达能显著提升体验。\n综上所述，这不仅仅是技巧问题。\n' > /tmp/ai_sample.md
$WRITING_PY skills/writing/scripts/ai_slop_checker.py /tmp/ai_sample.md
```
Expected: 打印报告，总分明显低于 35，命中清单里能看到「在这个…的时代」「首先」「其次」「综上所述」各自的行号；退出码 1。

- [ ] **Step 7: 提交**

```bash
git add skills/writing/scripts skills/writing/tests
git commit -m "feat(writing): AI 味检测脚本 — 五维打分 + 行号定位命中清单"
```

---

### Task 3: 可读性 / 平台合规检查脚本

**Files:**
- Create: `skills/writing/scripts/readability_check.py`
- Test: `skills/writing/tests/test_readability_check.py`

**Interfaces:**
- Consumes: `writing_utils` 的 `split_paragraphs` / `strip_markdown` / `char_count` / `parse_spec_lock` / `Hit`
- Produces:
  - `readability_check.PLATFORM_RULES: dict[str, dict[str, int]]` — 平台 → `{"paragraph_max": int, "subhead_every": int, "total_min": int, "total_max": int}`
  - `readability_check.check(text: str, platform: str, overrides: dict[str, int] | None = None) -> CheckResult`
  - `CheckResult` 数据类：`ok: bool`、`problems: list[Hit]`、`stats: dict[str, float]`
  - CLI：`python3 scripts/readability_check.py <文件路径> [--platform 公众号] [--spec-lock <路径>]`

- [ ] **Step 1: 写失败的测试 `skills/writing/tests/test_readability_check.py`**

```python
"""平台合规检查测试。

这些是硬指标（段落上限、小标题密度、字数区间），不是启发式，
所以可以钉死具体数值。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import readability_check as rc


def test_platform_rules_cover_wechat():
    rules = rc.PLATFORM_RULES["公众号"]
    assert rules["paragraph_max"] == 150
    assert rules["subhead_every"] == 500


def test_long_paragraph_flagged_with_line_number():
    text = "短段落。\n" + ("很长的一段" * 40) + "\n又一个短段落。"
    result = rc.check(text, platform="公众号")
    assert not result.ok
    over = [p for p in result.problems if p.rule == "段落过长"]
    assert len(over) == 1
    assert over[0].line == 2


def test_short_paragraphs_pass_paragraph_rule():
    text = "## 小标题\n" + "\n".join(["这是一段正常长度的话。"] * 3)
    result = rc.check(text, platform="公众号")
    assert not any(p.rule == "段落过长" for p in result.problems)


def test_missing_subheads_flagged():
    # 1200 字正文、零个小标题 → 公众号要求每 500 字一个，缺 2 个
    text = "\n".join(["这是一段大约六十个字的正文内容用来凑够检测所需要的总字数长度。" * 2] * 10)
    result = rc.check(text, platform="公众号")
    assert any(p.rule == "小标题不足" for p in result.problems)


def test_subheads_counted_from_markdown_headings():
    body = "\n".join(["这是一段大约六十个字的正文内容用来凑够检测所需要的总字数长度。" * 2] * 10)
    text = "## 一\n" + body + "\n## 二\n" + body + "\n## 三\n" + body
    result = rc.check(text, platform="公众号")
    assert result.stats["小标题数"] == 3


def test_word_count_below_minimum_flagged():
    result = rc.check("太短了。", platform="公众号")
    assert any(p.rule == "字数不足" for p in result.problems)


def test_overrides_take_precedence():
    text = "短段落。\n" + ("很长的一段" * 40)
    loose = rc.check(text, platform="公众号", overrides={"paragraph_max": 10000})
    assert not any(p.rule == "段落过长" for p in loose.problems)


def test_unknown_platform_falls_back_to_generic():
    result = rc.check("随便写点东西。", platform="不存在的平台")
    assert isinstance(result.stats["正文字数"], float)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_readability_check.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'readability_check'`

- [ ] **Step 3: 实现 `skills/writing/scripts/readability_check.py`**

```python
#!/usr/bin/env python3
"""平台合规 / 可读性检查。

用法：
    python3 scripts/readability_check.py <文件路径> [--platform 公众号] [--spec-lock <路径>]

与 ai_slop_checker 的分工：那个查「像不像人写的」（启发式、有得分），
这个查「能不能发出去」（硬指标、只有过不过）。两者刻意分开——硬指标
不该被平均进一个总分里稀释掉，段落超 300 字就是超了，不能靠别的维度
拉高分数蒙混过关。
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# 各平台的硬指标。数字来源见设计文档「研究结论摘要」：
# 公众号每段 ≤150 字＝手机屏 3–5 行，超了读者会滑走。
PLATFORM_RULES: dict[str, dict[str, int]] = {
    "公众号": {"paragraph_max": 150, "subhead_every": 500, "total_min": 800, "total_max": 5000},
    "朋友圈": {"paragraph_max": 80, "subhead_every": 0, "total_min": 20, "total_max": 500},
    "小红书": {"paragraph_max": 100, "subhead_every": 0, "total_min": 100, "total_max": 1000},
    "知乎": {"paragraph_max": 300, "subhead_every": 800, "total_min": 800, "total_max": 20000},
    "通用": {"paragraph_max": 300, "subhead_every": 0, "total_min": 0, "total_max": 100000},
}

_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+\S")


@dataclass
class CheckResult:
    ok: bool
    problems: list[wu.Hit] = field(default_factory=list)
    stats: dict[str, float] = field(default_factory=dict)


def _count_headings(text: str) -> int:
    return sum(1 for line in text.splitlines() if _HEADING.match(line))


def check(text: str, platform: str, overrides: dict[str, int] | None = None) -> CheckResult:
    rules = dict(PLATFORM_RULES.get(platform, PLATFORM_RULES["通用"]))
    rules.update(overrides or {})

    body = wu.strip_markdown(text)
    paragraphs = wu.split_paragraphs(body)
    total_chars = wu.char_count(body)
    heading_count = _count_headings(text)

    problems: list[wu.Hit] = []

    # 段落上限：行号按原文（未剥 Markdown）算，用户要能直接跳过去改
    para_max = rules["paragraph_max"]
    for idx, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or _HEADING.match(line) or stripped.startswith(("```", ">", "|", "-", "*")):
            continue
        length = wu.char_count(stripped)
        if length > para_max:
            problems.append(
                wu.Hit(line=idx, col=1, text=f"{length} 字（上限 {para_max}）", rule="段落过长")
            )

    # 小标题密度：subhead_every 为 0 表示该平台不要求
    every = rules["subhead_every"]
    if every > 0 and total_chars > 0:
        expected = total_chars // every
        if heading_count < expected:
            problems.append(
                wu.Hit(
                    line=1,
                    col=1,
                    text=f"{total_chars} 字只有 {heading_count} 个小标题，建议至少 {expected} 个",
                    rule="小标题不足",
                )
            )

    # 字数区间
    if total_chars < rules["total_min"]:
        problems.append(
            wu.Hit(line=1, col=1, text=f"{total_chars} 字，低于下限 {rules['total_min']}", rule="字数不足")
        )
    if total_chars > rules["total_max"]:
        problems.append(
            wu.Hit(line=1, col=1, text=f"{total_chars} 字，超过上限 {rules['total_max']}", rule="字数超限")
        )

    return CheckResult(
        ok=not problems,
        problems=problems,
        stats={
            "正文字数": float(total_chars),
            "段落数": float(len(paragraphs)),
            "小标题数": float(heading_count),
            "最长段落": float(max((wu.char_count(p) for p in paragraphs), default=0)),
        },
    )


def format_result(result: CheckResult, source: str, platform: str) -> str:
    lines = [f"# 平台合规检查 — {source}（{platform}）", ""]
    lines.append("**✅ 全部通过**" if result.ok else f"**❌ {len(result.problems)} 项不合规**")
    lines.append("")
    lines.append("## 统计")
    for name, value in result.stats.items():
        lines.append(f"- {name}: {value:g}")
    if result.problems:
        lines.append("")
        lines.append("## 问题清单")
        lines.append("")
        lines.append("| 行 | 问题 | 详情 |")
        lines.append("|---|---|---|")
        for p in result.problems:
            lines.append(f"| {p.line} | {p.rule} | {p.text} |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="平台合规检查")
    parser.add_argument("path")
    parser.add_argument("--platform", default="通用")
    parser.add_argument("--spec-lock", default=None, help="从契约读 platform 与段落/小标题覆盖值")
    args = parser.parse_args(argv)

    text = Path(args.path).read_text(encoding="utf-8")
    platform = args.platform
    overrides: dict[str, int] = {}

    if args.spec_lock:
        spec = wu.parse_spec_lock(Path(args.spec_lock))
        fmt = spec.get("平台格式", {})
        platform = fmt.get("platform", platform)
        for key, field_name in (("paragraph_max", "paragraph_max"), ("subhead_every", "subhead_every")):
            if key in fmt and fmt[key].isdigit():
                overrides[field_name] = int(fmt[key])

    result = check(text, platform=platform, overrides=overrides)
    print(format_result(result, Path(args.path).name, platform))
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 跑测试确认通过**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_readability_check.py -v
```
Expected: PASS，8 passed

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/readability_check.py skills/writing/tests/test_readability_check.py
git commit -m "feat(writing): 平台合规检查脚本 — 段落上限/小标题密度/字数区间"
```

---

### Task 4: 小说连贯性检查脚本

**Files:**
- Create: `skills/writing/scripts/continuity_check.py`
- Test: `skills/writing/tests/test_continuity_check.py`

**Interfaces:**
- Consumes: `writing_utils` 的 `parse_spec_lock` / `find_hits` / `Hit`
- Produces:
  - `continuity_check.parse_characters(spec: dict) -> list[Character]`，`Character` 字段 `name: str, want: str, need: str, wound: str, lie: str, voice: str`
  - `continuity_check.parse_foreshadows(spec: dict) -> list[Foreshadow]`，`Foreshadow` 字段 `fid: str, plant: str, payoff: str, status: str`
  - `continuity_check.check(text: str, spec: dict) -> ContinuityResult`
  - `ContinuityResult` 数据类：`ok: bool`、`problems: list[Hit]`、`stats: dict[str, float]`
  - `problems` 里的 `rule` 取值只有三种：`伏笔未回收` / `人物未登场` / `档案外人名`
  - CLI：`python3 scripts/continuity_check.py <正文路径> --spec-lock <契约路径>`

- [ ] **Step 1: 写失败的测试 `skills/writing/tests/test_continuity_check.py`**

```python
"""小说连贯性检查测试。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import continuity_check as cc

SPEC_TEXT = """## 体裁
- genre: short-story
- sub: 悬疑推理

## 人物档案
- 张明 | want:找到妹妹 | need:原谅自己 | wound:车祸中独自生还 | lie:活下来的人不配幸福 | 语料:……我知道。
- 李芸 | want:掩盖真相 | need:被理解 | wound:年少被抛弃 | lie:没人会留下来 | 语料:随你怎么想。

## 伏笔表
- 001 | 埋点:第2节 抽屉里的钥匙 | 回收:第5节 | 状态:已埋未收
- 002 | 埋点:第1节 窗台的烟头 | 回收:第4节 | 状态:已回收
"""


def _spec(tmp_path):
    p = tmp_path / "spec_lock.md"
    p.write_text(SPEC_TEXT, encoding="utf-8")
    import writing_utils as wu

    return wu.parse_spec_lock(p)


def test_parse_characters(tmp_path):
    chars = cc.parse_characters(_spec(tmp_path))
    assert [c.name for c in chars] == ["张明", "李芸"]
    assert chars[0].wound == "车祸中独自生还"
    assert chars[0].lie == "活下来的人不配幸福"


def test_parse_foreshadows(tmp_path):
    items = cc.parse_foreshadows(_spec(tmp_path))
    assert [f.fid for f in items] == ["001", "002"]
    assert items[0].status == "已埋未收"
    assert items[1].status == "已回收"


def test_unpaid_foreshadow_reported(tmp_path):
    text = "第一节。张明走进房间。\n第二节。他打开抽屉，里面有一把钥匙。"
    result = cc.check(text, _spec(tmp_path))
    assert not result.ok
    assert any(p.rule == "伏笔未回收" and "001" in p.text for p in result.problems)


def test_paid_foreshadow_not_reported(tmp_path):
    text = "第一节。窗台上有个烟头。"
    result = cc.check(text, _spec(tmp_path))
    assert not any(p.rule == "伏笔未回收" and "002" in p.text for p in result.problems)


def test_character_never_appears_reported(tmp_path):
    text = "张明一个人走了很久。"
    result = cc.check(text, _spec(tmp_path))
    assert any(p.rule == "人物未登场" and "李芸" in p.text for p in result.problems)


def test_suspected_typo_name_reported(tmp_path):
    # 「张鸣」与档案里的「张明」同姓、同长、只差一个字 —— 疑似写错名字
    text = "张明走进来。张鸣坐下了。李芸没说话。"
    result = cc.check(text, _spec(tmp_path))
    problems = [p for p in result.problems if p.rule == "档案外人名"]
    assert any("张鸣" in p.text for p in problems)
    assert problems[0].line == 1


def test_ordinary_words_do_not_trigger_name_check(tmp_path):
    # 「张明打开」这类跨词窗口不能被当成人名 —— 满屏假警报比漏报更糟
    text = "张明打开抽屉，钥匙还在。李芸站在窗台边。"
    result = cc.check(text, _spec(tmp_path))
    assert not any(p.rule == "档案外人名" for p in result.problems)


def test_clean_text_passes(tmp_path):
    text = "张明打开抽屉，钥匙还在。李芸站在窗台边，烟头掉在地上。"
    spec = _spec(tmp_path)
    # 把 001 也标成已回收，模拟完稿状态
    spec["伏笔表"]["001"] = "埋点:第2节 抽屉里的钥匙 | 回收:第5节 | 状态:已回收"
    result = cc.check(text, spec)
    assert result.ok


def test_missing_sections_do_not_crash():
    result = cc.check("随便一段文字。", {})
    assert result.ok
```

- [ ] **Step 2: 跑测试确认失败**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_continuity_check.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'continuity_check'`

- [ ] **Step 3: 实现 `skills/writing/scripts/continuity_check.py`**

```python
#!/usr/bin/env python3
"""小说连贯性检查 —— 拿写作契约当标准答案，扫正文找矛盾。

用法：
    python3 scripts/continuity_check.py <正文路径> --spec-lock <契约路径>

查三件事：
  1. 伏笔埋了没回收（契约的伏笔表状态 vs 正文）
  2. 档案里的人物压根没登场（策划定了却没用上，通常是大纲漂了）
  3. 档案外人名（与某个档案人名同姓、同长、只差一个字的词）

第 3 项**刻意不做分词也不做模糊相似度**。中文分词要么引入重依赖、要么在
人名上本来就不准；而在没有词边界的情况下按 n-gram 滑窗算相似度会把
「张明打开」这种跨词窗口判成「张明」的笔误——满屏假警报的报告审校根本
不会看，比漏报更糟。这里用一个很窄的条件（同姓 + 同长 + 差一字），
只抓「张明→张鸣」这类最常见的手滑，代价是「张明→张明明」这种变长的
抓不到。宁可漏报。

副作用是有意保留的：正文里出现档案外的其他人名（如「张三」）也会被报
出来——策划本就该把所有有名字的人物登记进档案，报出来是对的。
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# 候选词必须整体是汉字：跨标点/数字的窗口不可能是人名。
_CJK_ONLY = re.compile(r"[一-龥]+")


@dataclass
class Character:
    name: str
    want: str = ""
    need: str = ""
    wound: str = ""
    lie: str = ""
    voice: str = ""


@dataclass
class Foreshadow:
    fid: str
    plant: str = ""
    payoff: str = ""
    status: str = ""


@dataclass
class ContinuityResult:
    ok: bool
    problems: list[wu.Hit] = field(default_factory=list)
    stats: dict[str, float] = field(default_factory=dict)


def _split_fields(body: str) -> dict[str, str]:
    """把 `want:x | need:y` 这种竖线分隔的字段串解析成字典。"""
    out: dict[str, str] = {}
    for part in body.split("|"):
        part = part.strip()
        if ":" not in part:
            continue
        key, _, value = part.partition(":")
        out[key.strip()] = value.strip()
    return out


def parse_characters(spec: dict) -> list[Character]:
    section = spec.get("人物档案", {})
    chars: list[Character] = []
    for name, body in section.items():
        fields = _split_fields(body)
        chars.append(
            Character(
                name=name.strip(),
                want=fields.get("want", ""),
                need=fields.get("need", ""),
                wound=fields.get("wound", ""),
                lie=fields.get("lie", ""),
                voice=fields.get("语料", ""),
            )
        )
    return chars


def parse_foreshadows(spec: dict) -> list[Foreshadow]:
    section = spec.get("伏笔表", {})
    items: list[Foreshadow] = []
    for fid, body in section.items():
        fields = _split_fields(body)
        items.append(
            Foreshadow(
                fid=fid.strip(),
                plant=fields.get("埋点", ""),
                payoff=fields.get("回收", ""),
                status=fields.get("状态", ""),
            )
        )
    return items


def check(text: str, spec: dict) -> ContinuityResult:
    problems: list[wu.Hit] = []
    characters = parse_characters(spec)
    foreshadows = parse_foreshadows(spec)

    # 1. 伏笔未回收
    for f in foreshadows:
        if f.status and f.status != "已回收":
            problems.append(
                wu.Hit(
                    line=1,
                    col=1,
                    text=f"伏笔 {f.fid}（{f.plant}）状态为「{f.status}」，计划回收点：{f.payoff}",
                    rule="伏笔未回收",
                )
            )

    # 2. 人物未登场
    known_names = {c.name for c in characters}
    for c in characters:
        if c.name and c.name not in text:
            problems.append(
                wu.Hit(line=1, col=1, text=f"人物「{c.name}」在正文中一次也没出现", rule="人物未登场")
            )

    # 3. 档案外人名：与某个档案人名同姓、同长、只差一个字
    seen: set[str] = set()
    for idx, line in enumerate(text.splitlines(), start=1):
        for name in sorted(known_names):
            length = len(name)
            if length < 2:
                continue
            for i in range(len(line) - length + 1):
                token = line[i : i + length]
                if token == name or token in seen or token in known_names:
                    continue
                if not _CJK_ONLY.fullmatch(token):
                    continue
                if token[0] != name[0]:
                    continue
                if sum(1 for a, b in zip(token, name) if a != b) != 1:
                    continue
                problems.append(
                    wu.Hit(
                        line=idx,
                        col=i + 1,
                        text=f"「{token}」不在人物档案里，与「{name}」只差一个字——写错了还是漏登记？",
                        rule="档案外人名",
                    )
                )
                seen.add(token)

    return ContinuityResult(
        ok=not problems,
        problems=problems,
        stats={
            "人物数": float(len(characters)),
            "伏笔数": float(len(foreshadows)),
            "未回收伏笔": float(sum(1 for f in foreshadows if f.status and f.status != "已回收")),
        },
    )


def format_result(result: ContinuityResult, source: str) -> str:
    lines = [f"# 连贯性检查 — {source}", ""]
    lines.append("**✅ 全部通过**" if result.ok else f"**❌ {len(result.problems)} 项待处理**")
    lines.append("")
    lines.append("## 统计")
    for name, value in result.stats.items():
        lines.append(f"- {name}: {value:g}")
    if result.problems:
        lines.append("")
        lines.append("## 问题清单")
        lines.append("")
        lines.append("| 行 | 类型 | 详情 |")
        lines.append("|---|---|---|")
        for p in result.problems:
            lines.append(f"| {p.line} | {p.rule} | {p.text} |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="小说连贯性检查")
    parser.add_argument("path")
    parser.add_argument("--spec-lock", required=True)
    args = parser.parse_args(argv)

    text = Path(args.path).read_text(encoding="utf-8")
    spec = wu.parse_spec_lock(Path(args.spec_lock))
    result = check(text, spec)
    print(format_result(result, Path(args.path).name))
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 跑测试确认通过**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_continuity_check.py -v
```
Expected: PASS，9 passed

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/continuity_check.py skills/writing/tests/test_continuity_check.py
git commit -m "feat(writing): 小说连贯性检查 — 伏笔回收/人物登场/人名笔误"
```

---

### Task 5: 契约更新 + 资源库结构校验

**Files:**
- Create: `skills/writing/scripts/update_spec.py`
- Create: `skills/writing/scripts/validate_library.py`
- Test: `skills/writing/tests/test_update_spec.py`
- Test: `skills/writing/tests/test_validate_library.py`

**Interfaces:**
- Consumes: `writing_utils` 的 `parse_spec_lock` / `Hit`
- Produces:
  - `update_spec.set_field(spec_path: Path, section: str, key: str, value: str) -> None` — 原地改契约，保留其余行与注释
  - `update_spec.affected_drafts(project_dir: Path, section: str) -> list[Path]` — 返回受该段变更影响、需要润色回改的初稿文件
  - `update_spec.IMPACT_MAP: dict[str, str]` — 段名 → 影响说明
  - CLI：`python3 scripts/update_spec.py <项目路径> --section 文风锁定 --key voice --value 市井烟火`
  - `validate_library.validate(skill_dir: Path) -> list[str]` — 返回资源库结构问题列表
  - CLI：`python3 scripts/validate_library.py [--skill-dir <路径>]`

- [ ] **Step 1: 写失败的测试 `skills/writing/tests/test_update_spec.py`**

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import update_spec as us

SPEC_TEXT = """## 体裁
- genre: short-story
- sub: 悬疑推理

## 文风锁定
- voice: 冷峻克制
- person: 第三人称限知

## 禁用清单
- 禁用词: 首先, 其次
"""


def _spec_file(tmp_path):
    p = tmp_path / "spec_lock.md"
    p.write_text(SPEC_TEXT, encoding="utf-8")
    return p


def test_set_field_replaces_value_in_place(tmp_path):
    p = _spec_file(tmp_path)
    us.set_field(p, "文风锁定", "voice", "市井烟火")
    content = p.read_text(encoding="utf-8")
    assert "- voice: 市井烟火" in content
    assert "- voice: 冷峻克制" not in content
    # 其余内容原样保留
    assert "- person: 第三人称限知" in content
    assert "- genre: short-story" in content


def test_set_field_appends_when_key_absent(tmp_path):
    p = _spec_file(tmp_path)
    us.set_field(p, "文风锁定", "colloquial_level", "3/5")
    lines = p.read_text(encoding="utf-8").splitlines()
    idx_section = lines.index("## 文风锁定")
    idx_new = lines.index("- colloquial_level: 3/5")
    # 新键必须落在本段内，不能跑到文件末尾
    assert idx_new > idx_section
    assert "## 禁用清单" in lines[idx_new:]


def test_set_field_creates_section_when_absent(tmp_path):
    p = _spec_file(tmp_path)
    us.set_field(p, "平台格式", "platform", "公众号")
    content = p.read_text(encoding="utf-8")
    assert "## 平台格式" in content
    assert "- platform: 公众号" in content


def test_affected_drafts_lists_all_when_voice_changes(tmp_path):
    project = tmp_path / "proj"
    (project / "drafts").mkdir(parents=True)
    (project / "drafts" / "01.md").write_text("第一节", encoding="utf-8")
    (project / "drafts" / "02.md").write_text("第二节", encoding="utf-8")
    affected = us.affected_drafts(project, "文风锁定")
    assert len(affected) == 2


def test_impact_map_covers_known_sections():
    for section in ("文风锁定", "禁用清单", "人物档案", "平台格式"):
        assert section in us.IMPACT_MAP
```

- [ ] **Step 2: 写失败的测试 `skills/writing/tests/test_validate_library.py`**

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import validate_library as vl


def _make_lib(tmp_path, *, index_lists_all=True, with_required_sections=True):
    refs = tmp_path / "references" / "voices"
    refs.mkdir(parents=True)
    body = ""
    if with_required_sections:
        body = "\n".join(
            f"## {s}" for s in vl.REQUIRED_SECTIONS["voices"]
        )
    (refs / "leng-jun-ke-zhi.md").write_text(f"# 冷峻克制\n{body}\n", encoding="utf-8")
    (refs / "shi-jing-yan-huo.md").write_text(f"# 市井烟火\n{body}\n", encoding="utf-8")
    listed = ["leng-jun-ke-zhi.md"]
    if index_lists_all:
        listed.append("shi-jing-yan-huo.md")
    index = "# 文风库索引\n" + "\n".join(f"- [{n}](./{n})" for n in listed)
    (refs / "_index.md").write_text(index, encoding="utf-8")
    return tmp_path


def test_valid_library_passes(tmp_path):
    lib = _make_lib(tmp_path)
    assert vl.validate(lib) == []


def test_index_missing_sibling_reported(tmp_path):
    lib = _make_lib(tmp_path, index_lists_all=False)
    problems = vl.validate(lib)
    assert any("shi-jing-yan-huo.md" in p and "索引" in p for p in problems)


def test_missing_required_section_reported(tmp_path):
    lib = _make_lib(tmp_path, with_required_sections=False)
    problems = vl.validate(lib)
    assert any("缺少章节" in p for p in problems)


def test_missing_index_file_reported(tmp_path):
    lib = _make_lib(tmp_path)
    (lib / "references" / "voices" / "_index.md").unlink()
    problems = vl.validate(lib)
    assert any("_index.md" in p for p in problems)
```

- [ ] **Step 3: 跑两个测试确认失败**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_update_spec.py skills/writing/tests/test_validate_library.py -v
```
Expected: FAIL — 两个 `ModuleNotFoundError`

- [ ] **Step 4: 实现 `skills/writing/scripts/update_spec.py`**

```python
#!/usr/bin/env python3
"""改写作契约，并标出受影响、需要回改的已写章节。

用法：
    python3 scripts/update_spec.py <项目路径> --section 文风锁定 --key voice --value 市井烟火

为什么要有这个脚本而不是直接手改契约：契约是写手每节都要重读的执行
合同，改了它，**已经写完的章节并不会自动跟着变**。手改的人常常忘了
这一点，结果前三节是冷峻克制、后三节是市井烟火。这个脚本改完会明确
列出受影响的初稿文件，交给润色角色回改——把「改契约」和「回改正文」
绑成一件事，而不是两件容易漏做后半截的事。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# 段名 → 改这一段会影响什么。用于提示回改范围。
IMPACT_MAP: dict[str, str] = {
    "体裁": "体裁变更影响全篇结构，通常应重新走策划阶段而不是改契约",
    "目标": "读者/核心信息变更影响全篇取材与例子，所有已写章节需复核",
    "文风锁定": "文风/人称变更影响所有已写章节的语气与叙述视角",
    "结构": "结构或字数变更影响分节安排，需复核大纲",
    "人物档案": "人物设定变更影响所有该人物出场的章节",
    "伏笔表": "伏笔变更影响埋点与回收所在的章节",
    "禁用清单": "禁用词/句式变更需对所有已写章节重跑 AI 味检测",
    "平台格式": "平台变更影响段落长度与小标题密度，需重跑平台合规检查",
}


def set_field(spec_path: Path, section: str, key: str, value: str) -> None:
    """原地改契约的某个字段。

    逐行改而不是「解析成对象再整体重写」：契约里可能有用户自己加的
    注释行和空行，整体重写会把它们抹掉。
    """
    lines = spec_path.read_text(encoding="utf-8").splitlines()
    target_header = f"## {section}"

    if target_header not in lines:
        # 段不存在：在文件末尾补一段
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(target_header)
        lines.append(f"- {key}: {value}")
        spec_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return

    start = lines.index(target_header)
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].strip().startswith("## "):
            end = i
            break

    for i in range(start + 1, end):
        stripped = lines[i].strip()
        if not stripped.startswith("- "):
            continue
        # 用 writing_utils 的同一个切分器，别在这里自己 split(":")——
        # 人物档案/伏笔表是竖线记录，按冒号切会认错键（见 split_data_line 注释）
        parsed = wu.split_data_line(stripped[2:])
        if parsed and parsed[0] == key:
            indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
            lines[i] = f"{indent}- {key}: {value}"
            spec_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return

    # 键不存在：插在本段最后一条数据行之后（不是文件末尾）
    insert_at = start + 1
    for i in range(start + 1, end):
        if lines[i].strip().startswith("- "):
            insert_at = i + 1
    lines.insert(insert_at, f"- {key}: {value}")
    spec_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def affected_drafts(project_dir: Path, section: str) -> list[Path]:
    """受该段变更影响、需要回改的初稿文件。

    当前策略：只要契约变了，全部已写章节都要复核。刻意不做「智能」
    的按人物名筛选——漏掉一节的代价（读者读到不一致）远大于多看一节。
    """
    drafts_dir = project_dir / "drafts"
    if not drafts_dir.is_dir():
        return []
    return sorted(drafts_dir.glob("*.md"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="修改写作契约并标出受影响章节")
    parser.add_argument("project_path")
    parser.add_argument("--section", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--value", required=True)
    args = parser.parse_args(argv)

    project = Path(args.project_path)
    spec_path = project / "spec_lock.md"
    if not spec_path.exists():
        print(f"[writing] 错误：找不到写作契约 {spec_path}")
        return 1

    before = wu.parse_spec_lock(spec_path).get(args.section, {}).get(args.key, "（未设置）")
    set_field(spec_path, args.section, args.key, args.value)
    print(f"[writing] 契约已更新：[{args.section}] {args.key}：{before} → {args.value}")

    impact = IMPACT_MAP.get(args.section)
    if impact:
        print(f"[writing] 影响范围：{impact}")

    affected = affected_drafts(project, args.section)
    if affected:
        print(f"[writing] 以下 {len(affected)} 个已写章节需要润色角色回改：")
        for p in affected:
            print(f"  - {p.relative_to(project)}")
    else:
        print("[writing] 尚无已写章节，无需回改。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: 实现 `skills/writing/scripts/validate_library.py`**

```python
#!/usr/bin/env python3
"""资源库结构校验 —— 内容任务的自动化防线。

用法：
    python3 scripts/validate_library.py [--skill-dir <路径>]

资源库（文风 / 结构 / 体裁手册）是几十份 Markdown，人写容易漏：
新增一份文风却忘了登记进 _index.md，SKILL.md 让模型「只读索引里
列出的那一份」，这份新文风就永远不会被选中——静默失效、零报错。
这个脚本把「索引必须列全同级文件」和「每份手册必须有约定章节」
变成可执行的检查。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 各资源库要求的章节标题。改这里等于改内容规范，两边不会漂移。
REQUIRED_SECTIONS: dict[str, list[str]] = {
    "voices": ["识别特征", "句式偏好", "词汇取向", "适配体裁", "反例"],
    "structures": ["骨架", "各段职责", "适用场景", "常见失败", "骨架示例"],
    # 「目标定义」刻意用中性词：小说填情绪落点、文案填转化目标、文章填核心论点，
    # 三体裁共用一套章节骨架，校验脚本才不用按体裁分叉。
    "genres": ["目标定义", "结构要点", "写作手法", "自检清单", "改写诊断要点"],
}

_LINK = re.compile(r"\(\./([^)]+\.md)\)")


def _check_dir(lib_dir: Path, kind: str, problems: list[str]) -> None:
    rel = lib_dir.name
    index = lib_dir / "_index.md"
    siblings = sorted(p.name for p in lib_dir.glob("*.md") if p.name != "_index.md")

    if not siblings:
        return

    if not index.exists():
        problems.append(f"{rel}/ 缺少 _index.md（索引缺失，模型无从选择）")
    else:
        listed = set(_LINK.findall(index.read_text(encoding="utf-8")))
        for name in siblings:
            if name not in listed:
                problems.append(f"{rel}/_index.md 索引里没有列出 {name}（该文件将永远不会被选中）")

    required = REQUIRED_SECTIONS.get(kind, [])
    for name in siblings:
        content = (lib_dir / name).read_text(encoding="utf-8")
        headings = {
            line.strip().lstrip("#").strip()
            for line in content.splitlines()
            if line.strip().startswith("#")
        }
        for section in required:
            if section not in headings:
                problems.append(f"{rel}/{name} 缺少章节「{section}」")


def validate(skill_dir: Path) -> list[str]:
    problems: list[str] = []
    references = skill_dir / "references"
    if not references.is_dir():
        return [f"找不到 references/ 目录：{references}"]

    for kind in REQUIRED_SECTIONS:
        base = references / kind
        if not base.is_dir():
            continue
        # voices/ 是平铺的；structures/ 与 genres/ 下还有一层子目录
        if any(p.is_dir() for p in base.iterdir()):
            for sub in sorted(p for p in base.iterdir() if p.is_dir()):
                _check_dir(sub, kind, problems)
        else:
            _check_dir(base, kind, problems)

    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="资源库结构校验")
    parser.add_argument("--skill-dir", default=str(Path(__file__).resolve().parent.parent))
    args = parser.parse_args(argv)

    problems = validate(Path(args.skill_dir))
    if problems:
        for p in problems:
            print(f"[writing] ✗ {p}")
        print(f"[writing] 共 {len(problems)} 处问题")
        return 1
    print("[writing] ✓ 资源库结构完整")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: 跑测试确认通过**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_update_spec.py skills/writing/tests/test_validate_library.py -v
```
Expected: PASS，9 passed

- [ ] **Step 7: 提交**

```bash
git add skills/writing/scripts/update_spec.py skills/writing/scripts/validate_library.py skills/writing/tests/
git commit -m "feat(writing): 契约更新脚本 + 资源库结构校验"
```

---

### Task 6: 导出脚本

**Files:**
- Create: `skills/writing/scripts/export.py`
- Create: `skills/writing/templates/export_styles/wechat-default.json`
- Create: `skills/writing/templates/export_styles/wechat-serif.json`
- Test: `skills/writing/tests/test_export.py`

**Interfaces:**
- Consumes: `writing_utils` 的 `strip_markdown`（不直接用，导出要保留 Markdown 结构）
- Produces:
  - `export.load_style(name: str) -> dict[str, str]` — 读 `templates/export_styles/<name>.json`
  - `export.md_to_wechat_html(markdown: str, style: dict[str, str]) -> str` — 全内联样式的 HTML（公众号编辑器不认 `<style>` 标签，必须内联）
  - `export.md_to_plain(markdown: str) -> str`
  - CLI：`python3 scripts/export.py <md路径> --format wechat|plain|docx [--style wechat-default] [--out <路径>]`

- [ ] **Step 1: 写样式预设**

`skills/writing/templates/export_styles/wechat-default.json`：

```json
{
  "name": "公众号默认",
  "body": "font-size:16px;line-height:1.75;color:#333333;letter-spacing:0.5px;margin:0 0 1.2em 0;",
  "h1": "font-size:22px;font-weight:bold;color:#1a1a1a;margin:1.6em 0 0.8em 0;line-height:1.4;",
  "h2": "font-size:19px;font-weight:bold;color:#1a1a1a;margin:1.5em 0 0.7em 0;line-height:1.4;border-left:4px solid #07C160;padding-left:10px;",
  "h3": "font-size:17px;font-weight:bold;color:#333333;margin:1.3em 0 0.6em 0;line-height:1.4;",
  "quote": "font-size:15px;color:#666666;border-left:3px solid #dddddd;padding:0.6em 0 0.6em 1em;margin:1.2em 0;background:#fafafa;",
  "strong": "font-weight:bold;color:#07C160;",
  "em": "font-style:italic;color:#666666;",
  "li": "font-size:16px;line-height:1.75;color:#333333;margin:0.4em 0;",
  "hr": "border:none;border-top:1px solid #eeeeee;margin:2em 0;"
}
```

`skills/writing/templates/export_styles/wechat-serif.json`：同结构，把 `body` / `h1` / `h2` / `h3` / `li` 的样式串各加 `font-family:Georgia,'Songti SC','SimSun',serif;`，强调色 `#07C160` 换成 `#8B4513`，其余不变。

- [ ] **Step 2: 写失败的测试 `skills/writing/tests/test_export.py`**

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import export


STYLE = {
    "body": "font-size:16px;",
    "h1": "font-size:22px;",
    "h2": "font-size:19px;",
    "h3": "font-size:17px;",
    "quote": "color:#666;",
    "strong": "font-weight:bold;",
    "em": "font-style:italic;",
    "li": "font-size:16px;",
    "hr": "border:none;",
}


def test_load_style_reads_bundled_preset():
    style = export.load_style("wechat-default")
    assert "body" in style
    assert "font-size" in style["body"]


def test_paragraph_gets_inline_style():
    html = export.md_to_wechat_html("这是一段正文。", STYLE)
    assert '<p style="font-size:16px;">这是一段正文。</p>' in html


def test_headings_mapped_to_levels():
    html = export.md_to_wechat_html("# 一级\n## 二级\n### 三级", STYLE)
    assert '<h1 style="font-size:22px;">一级</h1>' in html
    assert '<h2 style="font-size:19px;">二级</h2>' in html
    assert '<h3 style="font-size:17px;">三级</h3>' in html


def test_no_style_tag_emitted():
    # 公众号编辑器会剥掉 <style>，样式必须全内联
    html = export.md_to_wechat_html("# 标题\n正文", STYLE)
    assert "<style" not in html


def test_bold_and_italic_inline():
    html = export.md_to_wechat_html("这里**很重要**也*有点意思*。", STYLE)
    assert '<strong style="font-weight:bold;">很重要</strong>' in html
    assert '<em style="font-style:italic;">有点意思</em>' in html


def test_blockquote_and_list():
    html = export.md_to_wechat_html("> 引用一句\n\n- 第一条\n- 第二条", STYLE)
    assert '<blockquote style="color:#666;">引用一句</blockquote>' in html
    assert '<li style="font-size:16px;">第一条</li>' in html
    assert "<ul" in html


def test_html_escaped_in_body_text():
    html = export.md_to_wechat_html("a < b & c > d", STYLE)
    assert "&lt;" in html and "&amp;" in html and "&gt;" in html


def test_md_to_plain_strips_markup():
    plain = export.md_to_plain("# 标题\n\n这里**很重要**。\n\n- 一条")
    assert "#" not in plain
    assert "**" not in plain
    assert "很重要" in plain
    assert "一条" in plain
```

- [ ] **Step 3: 跑测试确认失败**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_export.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'export'`

- [ ] **Step 4: 实现 `skills/writing/scripts/export.py`**

```python
#!/usr/bin/env python3
"""导出定稿到各平台格式。

用法：
    python3 scripts/export.py <md路径> --format wechat|plain|docx [--style wechat-default] [--out <路径>]

为什么自己写 Markdown → HTML 而不用现成库：公众号编辑器会剥掉
`<style>` 标签和 class，样式**必须全部内联**在每个元素的 style 属性上。
现成的 markdown 库输出的是干净的语义 HTML（靠外部样式表），粘进公众号
就是一片没有格式的黑字。这里的转换刻意只覆盖写作真正会用到的语法子集
（标题/段落/粗斜体/引用/列表/分隔线），不追求 CommonMark 完备。
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
STYLES_DIR = SKILL_DIR / "templates" / "export_styles"

_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
_QUOTE = re.compile(r"^>\s?(.*)$")
_LIST_ITEM = re.compile(r"^[-*]\s+(.*)$")
_HR = re.compile(r"^\s*(-{3,}|\*{3,})\s*$")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")


def load_style(name: str) -> dict[str, str]:
    path = STYLES_DIR / f"{name}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if k != "name"}


def _inline(text: str, style: dict[str, str]) -> str:
    """行内标记 → 内联样式的 HTML。先转义再替换，避免用户文本里的 < > 破坏结构。"""
    escaped = html.escape(text, quote=False)
    escaped = _BOLD.sub(lambda m: f'<strong style="{style["strong"]}">{m.group(1)}</strong>', escaped)
    escaped = _ITALIC.sub(lambda m: f'<em style="{style["em"]}">{m.group(1)}</em>', escaped)
    return escaped


def md_to_wechat_html(markdown: str, style: dict[str, str]) -> str:
    out: list[str] = []
    in_list = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    for raw in markdown.splitlines():
        line = raw.rstrip()
        if not line.strip():
            close_list()
            continue

        if _HR.match(line):
            close_list()
            out.append(f'<hr style="{style["hr"]}" />')
            continue

        m = _HEADING.match(line)
        if m:
            close_list()
            level = len(m.group(1))
            tag = f"h{level}"
            out.append(f'<{tag} style="{style[tag]}">{_inline(m.group(2), style)}</{tag}>')
            continue

        m = _QUOTE.match(line)
        if m:
            close_list()
            out.append(f'<blockquote style="{style["quote"]}">{_inline(m.group(1), style)}</blockquote>')
            continue

        m = _LIST_ITEM.match(line)
        if m:
            if not in_list:
                out.append('<ul style="margin:1em 0;padding-left:1.4em;">')
                in_list = True
            out.append(f'<li style="{style["li"]}">{_inline(m.group(1), style)}</li>')
            continue

        close_list()
        out.append(f'<p style="{style["body"]}">{_inline(line, style)}</p>')

    close_list()
    return "\n".join(out)


def md_to_plain(markdown: str) -> str:
    """剥掉所有标记，只留可读文本。用于朋友圈/私域话术这类纯文本场景。"""
    lines: list[str] = []
    for raw in markdown.splitlines():
        line = raw.strip()
        if _HR.match(line):
            continue
        line = _HEADING.sub(r"\2", line)
        line = _QUOTE.sub(r"\1", line)
        line = _LIST_ITEM.sub(r"· \1", line)
        line = _BOLD.sub(r"\1", line)
        line = _ITALIC.sub(r"\1", line)
        lines.append(line)
    # 折叠连续空行
    result: list[str] = []
    for line in lines:
        if not line and result and not result[-1]:
            continue
        result.append(line)
    return "\n".join(result).strip()


def md_to_docx(markdown: str, out_path: Path) -> None:
    """导出 Word。依赖 python-docx（requirements.txt 已列）。"""
    try:
        from docx import Document
    except ImportError:
        raise SystemExit("[writing] 错误：导出 docx 需要 python-docx，请先跑 bin/ensure-python.sh 装依赖")

    doc = Document()
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line or _HR.match(line):
            continue
        m = _HEADING.match(line)
        if m:
            doc.add_heading(_BOLD.sub(r"\1", m.group(2)), level=len(m.group(1)))
            continue
        m = _LIST_ITEM.match(line)
        if m:
            doc.add_paragraph(_BOLD.sub(r"\1", m.group(1)), style="List Bullet")
            continue
        m = _QUOTE.match(line)
        if m:
            doc.add_paragraph(_BOLD.sub(r"\1", m.group(1)), style="Intense Quote")
            continue
        doc.add_paragraph(_ITALIC.sub(r"\1", _BOLD.sub(r"\1", line)))
    doc.save(out_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导出定稿")
    parser.add_argument("path")
    parser.add_argument("--format", choices=("wechat", "plain", "docx"), default="wechat")
    parser.add_argument("--style", default="wechat-default")
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)

    src = Path(args.path)
    markdown = src.read_text(encoding="utf-8")

    suffix = {"wechat": ".html", "plain": ".txt", "docx": ".docx"}[args.format]
    out_path = Path(args.out) if args.out else src.with_suffix(suffix)

    if args.format == "wechat":
        out_path.write_text(md_to_wechat_html(markdown, load_style(args.style)), encoding="utf-8")
    elif args.format == "plain":
        out_path.write_text(md_to_plain(markdown), encoding="utf-8")
    else:
        md_to_docx(markdown, out_path)

    print(f"[writing] 已导出：{out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: 跑测试确认通过**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_export.py -v
```
Expected: PASS，8 passed

- [ ] **Step 6: 提交**

```bash
git add skills/writing/scripts/export.py skills/writing/templates/export_styles skills/writing/tests/test_export.py
git commit -m "feat(writing): 导出脚本 — 公众号全内联 HTML / 纯文本 / Word"
```

---

### Task 7: 素材转换 + 个人文风提取

**Files:**
- Create: `skills/writing/scripts/source_to_md.py`
- Create: `skills/writing/scripts/style_profile.py`
- Test: `skills/writing/tests/test_style_profile.py`

**Interfaces:**
- Consumes: `writing_utils` 的 `split_sentences` / `split_paragraphs` / `strip_markdown` / `char_count` / `coefficient_of_variation`
- Produces:
  - `source_to_md.convert(src: Path, out_dir: Path) -> Path` — 支持 `.md/.txt`（直通）、`.pdf`、`.docx`、`http(s)` URL
  - `style_profile.build(texts: list[str]) -> dict` — 返回文风档案（统计特征 + 高频句式 + 口头禅）
  - `style_profile.render_markdown(profile: dict) -> str` — 档案渲染成人类可读 Markdown
  - CLI：`python3 scripts/style_profile.py <文件或目录> --out <档案路径>`

- [ ] **Step 1: 写失败的测试 `skills/writing/tests/test_style_profile.py`**

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import style_profile as sp

SAMPLE_A = """我不太喜欢讲大道理。
说白了，就是把事情做完。
上周改了 37 版标题，最后用的是地铁上想出来的那版，9 个字。
说白了，写东西这件事没什么捷径。"""

SAMPLE_B = """周三下午开了三个小时的会。
说白了，没人真的在听。
我数了数，全程有 14 次有人在看手机。"""


def test_build_returns_expected_keys():
    profile = sp.build([SAMPLE_A, SAMPLE_B])
    for key in ("样本数", "总字数", "平均句长", "句长变异系数", "平均段长", "高频短语", "标点偏好"):
        assert key in profile


def test_frequent_phrase_detected():
    profile = sp.build([SAMPLE_A, SAMPLE_B])
    phrases = [p["短语"] for p in profile["高频短语"]]
    assert "说白了" in phrases


def test_frequent_phrase_requires_repetition():
    # 只出现一次的短语不该进高频表
    profile = sp.build(["这句话只说一次而已。"])
    phrases = [p["短语"] for p in profile["高频短语"]]
    assert "只说一次" not in phrases


def test_average_sentence_length_is_positive():
    profile = sp.build([SAMPLE_A])
    assert profile["平均句长"] > 0


def test_punctuation_preference_counts_question_marks():
    profile = sp.build(["真的吗？为什么呢？我不信。"])
    assert profile["标点偏好"]["？"] == 2


def test_render_markdown_contains_sections():
    md = sp.render_markdown(sp.build([SAMPLE_A, SAMPLE_B]))
    assert "# 个人文风档案" in md
    assert "## 统计特征" in md
    assert "## 高频短语" in md
    assert "## 写作契约建议" in md


def test_render_markdown_suggests_voice_fields():
    md = sp.render_markdown(sp.build([SAMPLE_A]))
    # 契约建议段必须给出可直接抄进 spec_lock.md 的行
    assert "- colloquial_level:" in md


def test_build_on_empty_input_does_not_crash():
    profile = sp.build([])
    assert profile["样本数"] == 0
```

- [ ] **Step 2: 跑测试确认失败**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_style_profile.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'style_profile'`

- [ ] **Step 3: 实现 `skills/writing/scripts/style_profile.py`**

```python
#!/usr/bin/env python3
"""从用户往期文章提取个人文风档案。

用法：
    python3 scripts/style_profile.py <文件或目录> --out <档案路径>

产出的档案给两个人看：用户（「原来我爱这么写」）和策划角色（把
建议行直接抄进 spec_lock.md）。所以档案末尾必须有一段可直接复制的
契约字段，而不是只给一堆统计数字——数字本身不构成可执行的约束。

方法上刻意只用频次统计，不做语义分析：文风的可操作特征（句子多长、
爱用什么口头禅、标点习惯）恰好都是可数的，而「语气偏温暖」这类判断
模型自己读几段就能得出，不需要脚本。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# 候选短语长度：2–4 字。中文口头禅（「说白了」「我觉得」「其实吧」）
# 基本都落在这个区间，再长就是句子而非习惯用语了。
PHRASE_MIN, PHRASE_MAX = 2, 4
# 进高频表的门槛：至少出现 2 次。只出现一次的不是习惯，是巧合。
PHRASE_MIN_COUNT = 2
PHRASE_TOP_N = 20

_CJK = re.compile(r"[一-龥]+")
_PUNCT_OF_INTEREST = "？！…，；：、"


def _extract_phrases(text: str) -> Counter:
    """从连续汉字片段里切出 2–4 字候选短语并计数。"""
    counter: Counter = Counter()
    for chunk in _CJK.findall(text):
        for size in range(PHRASE_MIN, PHRASE_MAX + 1):
            for i in range(len(chunk) - size + 1):
                counter[chunk[i : i + size]] += 1
    return counter


def build(texts: list[str]) -> dict:
    bodies = [wu.strip_markdown(t) for t in texts]
    joined = "\n".join(bodies)

    sentences = wu.split_sentences(joined)
    paragraphs = wu.split_paragraphs(joined)
    sent_lengths = [wu.char_count(s) for s in sentences]
    para_lengths = [wu.char_count(p) for p in paragraphs]
    total_chars = wu.char_count(joined)

    phrase_counter = _extract_phrases(joined)
    # 过滤：出现次数达标，且不是更长高频短语的子串（避免「说白」「白了」
    # 与「说白了」同时上榜刷屏）
    candidates = [
        (phrase, count)
        for phrase, count in phrase_counter.items()
        if count >= PHRASE_MIN_COUNT
    ]
    candidates.sort(key=lambda kv: (-kv[1], -len(kv[0])))
    kept: list[tuple[str, int]] = []
    for phrase, count in candidates:
        if any(phrase in longer and phrase != longer and c >= count for longer, c in kept):
            continue
        kept.append((phrase, count))
        if len(kept) >= PHRASE_TOP_N:
            break

    punct = {ch: joined.count(ch) for ch in _PUNCT_OF_INTEREST if joined.count(ch) > 0}

    return {
        "样本数": len(texts),
        "总字数": total_chars,
        "句数": len(sentences),
        "段数": len(paragraphs),
        "平均句长": round(sum(sent_lengths) / len(sent_lengths), 1) if sent_lengths else 0.0,
        "句长变异系数": round(wu.coefficient_of_variation(sent_lengths), 3),
        "平均段长": round(sum(para_lengths) / len(para_lengths), 1) if para_lengths else 0.0,
        "段长变异系数": round(wu.coefficient_of_variation(para_lengths), 3),
        "高频短语": [{"短语": p, "次数": c} for p, c in kept],
        "标点偏好": punct,
    }


def _suggest_colloquial_level(profile: dict) -> int:
    """口语化程度 1–5。句子越短、问号叹号越多，越口语。

    这是个粗判断，给策划一个起点，用户可在八项确认里改。
    """
    avg = profile.get("平均句长", 0) or 0
    punct = profile.get("标点偏好", {})
    lively = punct.get("？", 0) + punct.get("！", 0)
    total = max(profile.get("句数", 1), 1)
    score = 3
    if avg < 18:
        score += 1
    if avg > 32:
        score -= 1
    if lively / total > 0.15:
        score += 1
    return max(1, min(5, score))


def render_markdown(profile: dict) -> str:
    lines = ["# 个人文风档案", ""]
    lines.append("> 由 `style_profile.py` 从往期文章统计得出。策划角色可把末尾")
    lines.append("> 「写作契约建议」整段抄进 `spec_lock.md`。")
    lines.append("")
    lines.append("## 统计特征")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("|---|---|")
    for key in ("样本数", "总字数", "句数", "段数", "平均句长", "句长变异系数", "平均段长", "段长变异系数"):
        lines.append(f"| {key} | {profile.get(key, 0)} |")
    lines.append("")

    lines.append("## 高频短语")
    lines.append("")
    if profile.get("高频短语"):
        lines.append("| 短语 | 次数 |")
        lines.append("|---|---|")
        for item in profile["高频短语"]:
            lines.append(f"| {item['短语']} | {item['次数']} |")
        lines.append("")
        lines.append("> 这些是你的口头禅。写手应当**适度**复用（每千字 1–2 处），")
        lines.append("> 而不是每段都塞——高频词堆密了反而假。")
    else:
        lines.append("样本太少，未识别出稳定的高频短语。")
    lines.append("")

    lines.append("## 标点偏好")
    lines.append("")
    punct = profile.get("标点偏好", {})
    lines.append("、".join(f"{k}×{v}" for k, v in punct.items()) if punct else "无显著偏好。")
    lines.append("")

    level = _suggest_colloquial_level(profile)
    lines.append("## 写作契约建议")
    lines.append("")
    lines.append("```")
    lines.append("## 文风锁定")
    lines.append(f"- colloquial_level: {level}/5")
    lines.append(f"- 目标平均句长: {profile.get('平均句长', 0)} 字")
    lines.append(f"- 目标句长变异系数: ≥ {profile.get('句长变异系数', 0)}")
    phrases = "、".join(item["短语"] for item in profile.get("高频短语", [])[:6])
    lines.append(f"- 个人口头禅: {phrases or '（无）'}")
    lines.append("```")
    return "\n".join(lines)


def _collect_texts(target: Path) -> list[str]:
    if target.is_file():
        return [target.read_text(encoding="utf-8")]
    texts: list[str] = []
    for path in sorted(target.rglob("*")):
        if path.suffix.lower() in (".md", ".txt") and path.is_file():
            texts.append(path.read_text(encoding="utf-8"))
    return texts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="提取个人文风档案")
    parser.add_argument("target", help="单个文件或包含往期文章的目录")
    parser.add_argument("--out", default=None, help="档案输出路径（.md）")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    texts = _collect_texts(Path(args.target))
    if not texts:
        print(f"[writing] 错误：{args.target} 下没有找到 .md / .txt 文件")
        return 1

    profile = build(texts)

    if args.json:
        print(json.dumps(profile, ensure_ascii=False, indent=2))
        return 0

    markdown = render_markdown(profile)
    if args.out:
        Path(args.out).write_text(markdown, encoding="utf-8")
        print(f"[writing] 文风档案已生成：{args.out}（样本 {len(texts)} 篇）")
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 跑测试确认通过**

```bash
$WRITING_PY -m pytest skills/writing/tests/test_style_profile.py -v
```
Expected: PASS，8 passed

- [ ] **Step 5: 实现 `skills/writing/scripts/source_to_md.py`**

```python
#!/usr/bin/env python3
"""素材 → Markdown。

用法：
    python3 scripts/source_to_md.py <文件路径或URL> --out-dir <项目>/sources

只覆盖写作真正会遇到的四种来源：纯文本直通、PDF、Word、网页。
刻意不做 Excel / PPT —— 写作素材极少来自它们，真遇到让用户先另存为
文本更省事，多养一个解析器不划算。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

TEXT_SUFFIXES = {".md", ".markdown", ".txt"}


def _from_pdf(src: Path) -> str:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise SystemExit("[writing] 错误：解析 PDF 需要 pymupdf，请先跑 bin/ensure-python.sh")
    doc = fitz.open(src)
    return "\n\n".join(page.get_text() for page in doc)


def _from_docx(src: Path) -> str:
    try:
        from docx import Document
    except ImportError:
        raise SystemExit("[writing] 错误：解析 Word 需要 python-docx，请先跑 bin/ensure-python.sh")
    doc = Document(src)
    lines: list[str] = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        # 保留标题层级，写作素材的结构信息比正文更值钱
        style = (para.style.name or "").lower()
        if style.startswith("heading"):
            level = "".join(ch for ch in style if ch.isdigit()) or "1"
            lines.append(f"{'#' * min(int(level), 6)} {text}")
        else:
            lines.append(text)
    return "\n\n".join(lines)


def _from_url(url: str) -> str:
    try:
        import requests
        from bs4 import BeautifulSoup
    except ImportError:
        raise SystemExit("[writing] 错误：抓网页需要 requests 与 beautifulsoup4，请先跑 bin/ensure-python.sh")
    resp = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    title = soup.title.get_text(strip=True) if soup.title else ""
    blocks: list[str] = [f"# {title}"] if title else []
    for el in soup.find_all(["h1", "h2", "h3", "p", "li"]):
        text = el.get_text(strip=True)
        if not text:
            continue
        if el.name in ("h1", "h2", "h3"):
            blocks.append(f"{'#' * int(el.name[1])} {text}")
        elif el.name == "li":
            blocks.append(f"- {text}")
        else:
            blocks.append(text)
    return "\n\n".join(blocks)


def convert(src: str | Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)

    if isinstance(src, str) and src.startswith(("http://", "https://")):
        text = _from_url(src)
        stem = re.sub(r"[^a-zA-Z0-9]+", "_", urlparse(src).path).strip("_") or "webpage"
    else:
        path = Path(src)
        suffix = path.suffix.lower()
        if suffix in TEXT_SUFFIXES:
            text = path.read_text(encoding="utf-8")
        elif suffix == ".pdf":
            text = _from_pdf(path)
        elif suffix == ".docx":
            text = _from_docx(path)
        else:
            raise SystemExit(f"[writing] 不支持的格式：{suffix}（请另存为 .txt / .md / .docx / .pdf）")
        stem = path.stem

    out_path = out_dir / f"{stem}.md"
    out_path.write_text(text, encoding="utf-8")
    return out_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="素材转 Markdown")
    parser.add_argument("source")
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args(argv)

    out = convert(args.source, Path(args.out_dir))
    print(f"[writing] 已转换：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: 手动验证 source_to_md 的文本直通路径**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
printf '这是一段测试素材。\n' > /tmp/sample_source.txt
$WRITING_PY skills/writing/scripts/source_to_md.py /tmp/sample_source.txt --out-dir /tmp/out_sources
cat /tmp/out_sources/sample_source.md
```
Expected: 打印 `[writing] 已转换：/tmp/out_sources/sample_source.md`，文件内容为原文

- [ ] **Step 7: 跑全量测试 + 提交**

```bash
$WRITING_PY -m pytest skills/writing/tests/ -v
git add skills/writing/scripts skills/writing/tests
git commit -m "feat(writing): 素材转换 + 个人文风档案提取"
```
Expected: 全部通过（69 passed）

---

## Phase B：方法论内容库

> **Phase B 的所有内容任务共用同一条验证命令**：
> `$WRITING_PY skills/writing/scripts/validate_library.py`
> 它检查索引列全、章节齐备。**内容质量靠人读，结构完整性靠脚本**——
> 没有第二种自动化手段，别为此发明测试。
>
> **写作要求（每个内容任务都适用）**：
> - 一律中文；用「研究结论摘要」里的事实，不要凭空发挥
> - 每条方法必须**可执行**：给公式、给阈值、给例句。禁止「要有吸引力的开头」这类空话
> - 每份手册都要有**好/坏对照例句**，坏例句要标出问题在哪
> - 篇幅控制在 150–400 行；超了拆子文件并在索引里登记

### Task 8: 共享标准 + 去 AI 味总纲

**Files:**
- Create: `skills/writing/references/shared-standards.md`
- Create: `skills/writing/references/anti-ai-slop.md`

**Interfaces:**
- Consumes: 无（纯内容）
- Produces: 被 `writer-base.md`、`editor.md`、三份 `genres/*/core.md` 引用的通用标准

- [ ] **Step 1: 写 `references/shared-standards.md`**

必须包含这些一级章节，每节给可执行规则 + 好坏对照：

```markdown
# 中文写作共享标准

## 1. 标点
（中英文标点混用规则、省略号用「……」不用「...」、破折号、引号嵌套、
数字与单位之间不加空格但中英文之间加，各给正反例）

## 2. 数字
（什么时候用阿拉伯数字什么时候用汉字、约数写法、百分比、金额）

## 3. 长句拆分
（超过 40 字的句子必须检查能否拆；给三种拆法：断句、提取主语、改语序，各配例子）

## 4. 段落
（一段一个意思；段首不缩进用空行分隔；每段字数按平台走 —— 指向
readability_check.py 的 PLATFORM_RULES）

## 5. 称谓与人称
（第一/第二/第三人称各自的适用场景与切换禁忌）

## 6. 引用与事实
（引用他人观点必须标出处；数字必须可溯源；不确定的事实标记为待核，
禁止编造具体数字——这是硬红线）
```

- [ ] **Step 2: 写 `references/anti-ai-slop.md`**

按「研究结论摘要」的三库结构组织，必须包含：

```markdown
# 去 AI 味总纲

## 0. 第一原则：结构均匀度
（说明为什么句长/段长的参差度比用词更重要；给出目标值：
句长变异系数 ≥ 0.55、段长变异系数 ≥ 0.50；说明怎么改 —— 
故意插入短句、把长句拆成不等长的几句、让某段只有一行）

## 1. 套话库
（四组：关联词套话 / 总结套话 / 客观中立套话 / 程度副词套话。
每组列词 + 给「为什么它是套话」+ 改写示例。
词表本身在 scripts/data/banned_words.txt，本文件解释怎么改）

## 2. AI 句式库
（10 种句式，每种给 ❌原句 / ✅改法 对照。
正则本身在 scripts/data/ai_patterns.txt，本文件解释怎么改）

## 3. 书面词替换库
（动词名词化：进行操作→用；黑话：赋能/抓手/闭环/颗粒度→说人话。
表格形式，左边书面词右边口语替换）

## 4. 三维度揉进（叙事类专用）
（「发生-感知-反应」不要分层堆叠写，给分层写法的坏例 + 揉进写法的好例）

## 5. 改味纪律
（改味不改错；删最少字换最大效果；不要为了避开禁用词而换成更别扭的说法；
Show-Don't-Tell 五级光谱，展示深度匹配情绪重要性 —— 不是任何时候都展示到底）

## 6. 与脚本的分工
（脚本查得出的：密度、方差、命中位置。
脚本查不出、要人/模型判断的：这处套话是不是刻意为之、这段整齐是不是排比修辞）
```

- [ ] **Step 3: 校验并提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
$WRITING_PY skills/writing/scripts/validate_library.py
git add skills/writing/references
git commit -m "docs(writing): 中文写作共享标准 + 去 AI 味总纲"
```
Expected: `✓ 资源库结构完整`（此时 voices/structures/genres 尚未建，脚本会跳过）

---

### Task 9: 文风库（8 种）

**Files:**
- Create: `skills/writing/references/voices/_index.md`
- Create: `skills/writing/references/voices/leng-jun-ke-zhi.md`（冷峻克制）
- Create: `skills/writing/references/voices/shi-jing-yan-huo.md`（市井烟火）
- Create: `skills/writing/references/voices/xi-xue-you-mo.md`（戏谑幽默）
- Create: `skills/writing/references/voices/wen-yi-shu-qing.md`（文艺抒情）
- Create: `skills/writing/references/voices/ying-he-gan-lian.md`（硬核干练）
- Create: `skills/writing/references/voices/wen-run-xi-ni.md`（温润细腻）
- Create: `skills/writing/references/voices/kou-yu-lao-ke.md`（口语唠嗑）
- Create: `skills/writing/references/voices/xue-shu-yan-jin.md`（学术严谨）

**Interfaces:**
- Consumes: `anti-ai-slop.md` 的三库（文风文件引用它，不重复列词）
- Produces: 供 `spec_lock.md` 的 `文风锁定 → voice` 字段取值；策划在八项确认第 6 项从这里推荐 ≥3 个候选

- [ ] **Step 1: 写 `_index.md`**

结构照抄 `skills/ppt-master/references/modes/_index.md`（先读它），必须包含：

1. 一句话说清**文风是什么、不是什么**：文风管「读起来什么味道」，结构模式管「怎么组织」，两者**独立锁定、任意组合**（冷峻克制的悬疑可以是双线交织也可以是倒叙悬念）
2. 8 种文风的一句话对照表（文风 | 一句话特征 | 最适合）
3. **自动推荐表**：内容/受众信号 → 推荐文风 + 备选
4. **易混对**：哪两种最容易选错、各自的判别句
5. 使用方式：策划在确认 6 推荐 ≥3 个候选 → 锁进 `spec_lock.md` 的 `- voice:` → 写手**只读锁定的那一份**，禁止 glob 整个目录
6. `custom` 逃生舱：预设都不合适时，写 `- voice: custom` + 一段 `- voice_behavior:` 散文描述

每个 `- [xxx](./xxx.md)` 链接必须写全 8 个，否则 `validate_library.py` 会报错。

- [ ] **Step 2: 写 8 份文风文件**

每份**必须**有这五个二级章节（章节名逐字一致，`validate_library.py` 按名字检查）：

```markdown
# 文风：冷峻克制

（一句话定位）

## 识别特征
（3–5 条。读者凭什么一眼认出这是这个文风）

## 句式偏好
（句子长度倾向、主动被动、并列还是递进、标点习惯。
给目标值：如「平均句长 12–20 字，短句占比 ≥40%」）

## 词汇取向
（爱用什么词、避开什么词。给具体词表，不要「用词精准」这种空话）

## 适配体裁
（哪些体裁/题材天然合适、哪些会打架。要说明**为什么**）

## 反例
（❌ 一段写偏了的例子 + 标出问题在哪 → ✅ 改对的版本。
这一节最重要：模型靠反例校准，比正面描述有效得多）
```

八种文风的定位（不要写串）：
- **冷峻克制** — 不动声色，情绪藏在动作与细节里；短句多，几乎不用感叹号与形容词最高级
- **市井烟火** — 有生活质感的口语，具体的物、具体的价钱、具体的地名
- **戏谑幽默** — 自嘲与反差，节奏靠「铺垫—反转」的小单元推进
- **文艺抒情** — 意象与通感，长句为主，允许留白与跳跃
- **硬核干练** — 信息密度高，动词强、修饰少，像给同行讲话
- **温润细腻** — 体察情绪的细微处，语气柔和但不腻，多用具体感官细节
- **口语唠嗑** — 像面对面说话，有口头禅、有停顿、有自我修正
- **学术严谨** — 结论有据、边界清楚，主动承认不确定性

- [ ] **Step 3: 校验并提交**

```bash
$WRITING_PY skills/writing/scripts/validate_library.py
git add skills/writing/references/voices
git commit -m "docs(writing): 文风库 8 种 + 索引"
```
Expected: `✓ 资源库结构完整`

---

### Task 10: 结构模式库（15 种）

**Files:**
- Create: `skills/writing/references/structures/_index.md`
- Create: `skills/writing/references/structures/story/_index.md` 及 5 份：`wu-duan-shi.md`（五段式）、`shuang-xian.md`（双线交织）、`dao-xu-xuan-nian.md`（倒叙悬念）、`huan-xing.md`（环形结构）、`shu-xin-ti.md`（书信体）
- Create: `skills/writing/references/structures/copy/_index.md` 及 5 份：`pas.md`、`aida.md`、`gu-shi-dai-ru.md`（故事带入）、`qing-dan-ti.md`（清单体）、`dui-bi-fan-cha.md`（对比反差）
- Create: `skills/writing/references/structures/article/_index.md` 及 5 份：`jin-zi-ta.md`（金字塔/结论先行）、`ceng-ceng-di-jin.md`（层层递进）、`wen-da-shi.md`（问答式）、`shi-jian-xian.md`（时间线）、`po-li-jie-he.md`（破立结合）

**Interfaces:**
- Consumes: `genres/*/core.md` 的体裁骨架（结构模式在其之上做变体）
- Produces: `spec_lock.md` 的 `结构 → structure` 字段取值

- [ ] **Step 1: 写三个子目录的 `_index.md` 和一个顶层 `_index.md`**

顶层 `structures/_index.md` 说清三件事：结构 ≠ 文风（正交，任意组合）；结构按体裁分三组，**只读自己体裁那一组**；一篇锁一个结构，混搭走 `custom`。

每个子目录 `_index.md` 列全本组 5 份（链接格式 `- [xxx](./xxx.md)`），带自动推荐表（内容信号 → 结构）。

- [ ] **Step 2: 写 15 份结构文件**

每份**必须**有这五个二级章节（名字逐字一致）：

```markdown
# 结构：五段式

（一句话说清这个结构解决什么问题）

## 骨架
（各段名称 + 占比。用「研究结论摘要」里的硬阈值：
开头 / 铺垫 30–40% / 升级 20–30% / 反转 10–15% / 结尾 5–10%）

## 各段职责
（每一段要完成什么、不该做什么。给可检查的阈值，
如「开头前 100 字事件密度 ≥3」「升级段冲突强度必须递增」）

## 适用场景
（什么内容适合、什么内容会被这个结构拖累）

## 常见失败
（3–4 种典型走样 + 症状 + 补救。这是审校角色的诊断依据）

## 骨架示例
（一个具体题材的分节表：节次 | 字数 | 本节任务 | 结束时读者应有的感受）
```

- [ ] **Step 3: 校验并提交**

```bash
$WRITING_PY skills/writing/scripts/validate_library.py
git add skills/writing/references/structures
git commit -m "docs(writing): 结构模式库 15 种（小说/文案/文章各 5）"
```

---

### Task 11: 微信文案手册（core + 4 场景）

**Files:**
- Create: `skills/writing/references/genres/wechat/_index.md`
- Create: `skills/writing/references/genres/wechat/core.md`
- Create: `skills/writing/references/genres/wechat/dai-huo-tui-guang.md`（带货/推广推送）
- Create: `skills/writing/references/genres/wechat/pin-tuan-lie-bian.md`（拼团/裂变活动）
- Create: `skills/writing/references/genres/wechat/si-yu-yun-ying.md`（私域运营话术）
- Create: `skills/writing/references/genres/wechat/zhi-bo-xin-pin.md`（直播/新品预告）

**Interfaces:**
- Consumes: `shared-standards.md`、`anti-ai-slop.md`、`structures/copy/*`
- Produces: 被 `SKILL.md` 的体裁路由指向；`spec_lock.md` 的 `体裁 → sub` 字段取值

- [ ] **Step 1: 写 `core.md`（通用方法论）**

五个必需二级章节（名字逐字一致）+ 必须落实的研究结论：

```markdown
# 微信文案 · 通用方法论

## 目标定义
（文案的目标是**转化**，不是表达。开篇要求写手先写下一句
「读者读完这篇，应该做什么」——写不出来就别动笔）

## 结构要点
（论证顺序不可颠倒：定位 → 单一承诺 → 证据 → 行动号召。
每一步给判据。硬指标：长文 2000–5000 字、每段 ≤150 字、
每 500 字一个小标题 —— 与 readability_check.py 的 PLATFORM_RULES 对齐）

## 写作手法
（① 标题四类公式，各带 3 个真实例句：冲突对比型「弱者身份+意外成就」/
疑问引导型 / 数字效果型 / 否定反转型「别再…了！…来了」
② 金句公式：「连〔弱者〕都能〔成就〕，你也一定可以」等，给 5 个可套模板
③ 开头 3 秒法则：前 50 字必须出现读者的处境或一个具体数字
④ 信任状的四种给法：数据 / 案例 / 权威背书 / 自曝其短）

## 自检清单
（10–15 条可勾选项。每条都要能判定真假，
如「□ 全文只有一个核心卖点」「□ 结尾的行动指令是具体动作而非'了解更多'」）

## 改写诊断要点
（AI 痕迹仪表盘：先跑 ai_slop_checker.py 拿五维分，
再叠加转化要素缺失检查 → 合并成 🔴/🟡/🟢 三级清单 → 按优先级改。
给一个完整的诊断报告样例）
```

- [ ] **Step 2: 写 4 份场景文件**

同样五个章节，但**只写「在 core 之上，这个场景额外要注意什么」**，不重复 core 的内容。各场景的独有要点：

- **带货/推广推送** — 痛点铺垫的三层递进（现象→代价→紧迫）；价格锚定；风险逆转（退款承诺/试用）；避免硬广腔的三个开关
- **拼团/裂变活动** — 稀缺与紧迫的真实性底线（**禁止编造虚假倒计时**，这是硬红线）；分享动机设计（利他理由 > 利己理由）；规则必须一句话说清
- **私域运营话术** — 人设一致性；不推销的日常内容占比（建议 7:3）；一对一话术与群发话术的语气差异；避免机器人感的具体手法
- **直播/新品预告** — 期待感的三段搭建；到场理由必须具体到「几点有什么」；预告与正式发布的信息差控制

- [ ] **Step 3: 写 `_index.md` 并校验提交**

```bash
$WRITING_PY skills/writing/scripts/validate_library.py
git add skills/writing/references/genres/wechat
git commit -m "docs(writing): 微信文案手册 — 通用方法论 + 4 个转化场景"
```

---

### Task 12: 短篇小说手册（core + 6 题材）

**Files:**
- Create: `skills/writing/references/genres/story/_index.md`
- Create: `skills/writing/references/genres/story/core.md`
- Create: `skills/writing/references/genres/story/xuan-yi.md`（悬疑推理）
- Create: `skills/writing/references/genres/story/yan-qing.md`（言情情感）
- Create: `skills/writing/references/genres/story/ke-huan.md`（科幻奇幻）
- Create: `skills/writing/references/genres/story/nao-dong.md`（都市脑洞/反转向）
- Create: `skills/writing/references/genres/story/zhi-yu.md`（治愈温情）
- Create: `skills/writing/references/genres/story/gao-xiao.md`（轻松搞笑）

**Interfaces:**
- Consumes: `shared-standards.md`、`anti-ai-slop.md`、`structures/story/*`、`templates/character_sheet.md`、`templates/foreshadow_table.md`
- Produces: 被 `SKILL.md` 体裁路由指向；`continuity_check.py` 依赖的人物档案与伏笔表字段约定

- [ ] **Step 1: 写 `core.md`**

这是三份 core 里最重的一份。五个必需章节 + 必须落实的研究结论：

```markdown
# 短篇小说 · 通用方法论

## 目标定义
（**情绪先行**：动笔前先定「读者读完什么感觉」——
意难平 / 反转震撼 / 爽感释放 / 治愈 / 细思极恐 / 共鸣，六选一。
所有情节为这个情绪服务，而不是先编情节再配情绪。
这是短篇与长篇最大的方法论差异，必须讲透为什么）

## 结构要点
（五段式骨架 + 硬阈值：
开头（前 100 字事件密度 ≥3）→ 铺垫 30–40%（埋 ≥3 条反转线索）→
升级 20–30%（冲突强度必须递增）→ 反转 10–15%（冲击力度超过此前所有节点）→
结尾 5–10%（安静细节收尾，不写大段抒情）。
每个数字都要解释为什么是这个数）

## 写作手法
（① 人物 Core Four：Want / Need / Wound / Lie。
角色弧光＝克服 Lie 的过程。检验法：对任一行为连续追问「为什么」，
追不到 Wound 说明动机不成立 —— 给一个完整的追问示范
② 场景 GCOS 自查：Goal-Conflict-Outcome-Sequel，
Outcome 必须是「是 / 否 / 是但有代价 / 否但有转机」四选一，不能含糊
③ 三维度揉进：「发生-感知-反应」写进同一段连续正文，
给分层堆叠的坏例 + 揉进的好例
④ Show-Don't-Tell 五级光谱：纯告知 → 告知+生理 → 纯生理 → 动作 → 潜台词，
展示深度**匹配情绪重要性**，不是任何时候都展示到底 —— 给五级各一个例句
⑤ 对话：功能是推进而非交代；每句对话要么改变关系要么泄露信息）

## 自检清单
（分两组：结构组（五段占比、伏笔数、冲突递增）与
人物组（每个出场人物的 Core Four 是否齐全、语料是否被真正用上））

## 改写诊断要点
（三步：① 跑 continuity_check.py 查伏笔与人名
② 逐场景过 GCOS，标出「软场景」
③ 跑 ai_slop_checker.py 查文字层。
给一份完整诊断报告样例）
```

- [ ] **Step 2: 写 6 份题材文件**

同样五个章节，只写题材独有的部分：

- **悬疑推理** — 公平性原则（**线索必须在揭示前给过，不许信息作弊**，硬红线）；误导（red herring）的合法与非法用法；伏笔密度与回收节奏；「读者领先侦探半步」的张力控制
- **言情情感** — 心动时刻的经营（具体的一个瞬间 > 一段总结）；关系张力靠障碍而非误会堆砌；避免悬浮的三个抓地手法；结尾的「不圆满但成立」
- **科幻奇幻** — 世界观自洽其说（设定一旦立就不许破）；高概念的导入手法（先给现象再给规则）；设定投射现实的做法；避免设定倾倒（info dump）
- **都市脑洞/反转向** — 日常场景 + 一个反常设定的配比；结尾反转的铺垫与「括号回收」；反转必须让人回头看前文时发现处处有暗示
- **治愈温情** — 低冲突叙事怎么保持张力（靠细节与情绪温度而非事件）；避免煽情/说教/廉价升华的具体开关；结尾要「轻」
- **轻松搞笑** — 笑点的三种来源（反差、误会、自嘲）与节奏；密度控制（每 300–500 字一个笑点）；避免尬笑的判别法；喜剧节奏的「三拍」结构

- [ ] **Step 3: 写 `_index.md` 并校验提交**

```bash
$WRITING_PY skills/writing/scripts/validate_library.py
git add skills/writing/references/genres/story
git commit -m "docs(writing): 短篇小说手册 — 通用方法论 + 6 个题材"
```

---

### Task 13: 文章手册（core + 4 领域）

**Files:**
- Create: `skills/writing/references/genres/article/_index.md`
- Create: `skills/writing/references/genres/article/core.md`
- Create: `skills/writing/references/genres/article/hang-ye-guan-cha.md`（行业观察/趋势评论）
- Create: `skills/writing/references/genres/article/chan-pin-ce-ping.md`（产品/工具评测）
- Create: `skills/writing/references/genres/article/fang-fa-lun.md`（方法论/经验总结）
- Create: `skills/writing/references/genres/article/ji-shu-ke-pu.md`（技术/概念科普）

**Interfaces:**
- Consumes: `shared-standards.md`、`anti-ai-slop.md`、`structures/article/*`
- Produces: 被 `SKILL.md` 体裁路由指向

- [ ] **Step 1: 写 `core.md`**

```markdown
# 文章 · 通用方法论

## 目标定义
（先分流：**观点输出型**（讲一个论点）还是**说明介绍型**（讲清一件事）。
给判别问题：「读者读完是要被说服，还是要学会/搞懂？」
两型的后续路径不同，必须先定）

## 结构要点
（说明类骨架：问题 → 方案 → 怎么运作（3–4 步）→ 异议处理 → 结尾行动。
观点类骨架：结论 → 论据分层 → 反方处理 → 边界声明 → 收束。
两套骨架各给判据与常见走样）

## 写作手法
（① 钩子三选一：数据冲击型 / 提问型 / 故事型，
每种给 2 个例句 + 要求写手附一句「为什么它有效」的自评
② 论据的四个等级：一手数据 > 可溯源二手数据 > 具体案例 > 类比。
类比只能辅助不能承重
③ 「所以呢」测试：每个论点自问「关读者什么事」，答不出就删
④ 说明类的层次控制：一次只引入一个新概念；
类比先行、术语后置；每个抽象说明后面跟一个具体例子）

## 自检清单
（12–15 条。含反 AI 腔五维（直接度/节奏/信任感/真实感/密度）
与「每个断言都有证据支撑」的逐条核对）

## 改写诊断要点
（**七轮扫描法**，每轮只盯一个维度、改完回头复查前几轮：
清晰度 → 语气一致 → 「所以呢」→ 举证 → 具体化（模糊词换数字）→
情绪浓度 → 消除读者犹豫点。
七轮之后跑**读者评分团**：3–5 个身份（目标读者/怀疑论者/编辑）各打 1–10，
均分 ≥8 放行。档位：9–10 可发布 / 7–8 小改 / 5–6 需重写 / 3–4 大改 / 1–2 推翻重来）
```

- [ ] **Step 2: 写 4 份领域文件**

- **行业观察/趋势评论** — 观点必须可证伪；趋势论证的三支柱（数据/案例/机制）；避免「正确的废话」的判别法；时效性声明
- **产品/工具评测** — 利益披露（是否收费/送测，硬红线）；对比维度必须先声明再逐项走；「适合谁/不适合谁」比「好不好」更有用；给可复现的测试条件
- **方法论/经验总结** — 从个例抽象到方法的三步；必须交代适用边界与失败案例；避免幸存者偏差的自查；给可执行的第一步
- **技术/概念科普** — 类比的选择与其失效边界（**必须主动说明类比在哪里不成立**）；概念依赖的自底向上铺垫；术语首次出现即解释；避免「懂的人才看得懂」的自查法

- [ ] **Step 3: 写 `_index.md` 并校验提交**

```bash
$WRITING_PY skills/writing/scripts/validate_library.py
git add skills/writing/references/genres/article
git commit -m "docs(writing): 文章手册 — 通用方法论 + 4 个领域"
```

---

### Task 14: 四个角色说明书

**Files:**
- Create: `skills/writing/references/strategist.md`
- Create: `skills/writing/references/writer-base.md`
- Create: `skills/writing/references/editor.md`
- Create: `skills/writing/references/polisher.md`

**Interfaces:**
- Consumes: 全部资源库与模板；`scripts/*.py` 的 CLI 用法
- Produces: 被 `SKILL.md` 各 Step 用 `Read references/<角色>.md` 加载

- [ ] **Step 1: 写 `strategist.md`（策划）**

必须覆盖：

1. **岗位边界** — 只读素材、定方案、填两份文件。**禁止提前写正文**（哪怕一句示例开头也不行；写了就是违规，因为用户会拿它当已定稿）
2. **八项确认的推荐方法** — 逐项说明「凭什么信号推荐什么」：
   - 锚点四项（体裁/题材场景/目标读者/核心信息或情绪落点）怎么从素材与用户话里读出来
   - 实现四项（篇幅/文风/结构+人称/平台格式+禁用清单）怎么**由锚点重新推导**
   - 创作性字段（文风、结构）必须给 **≥3 个候选**，各带一句「选它会是什么效果」
3. **确认值优先** — 用户改过的字段一律照办；用户没碰、但因锚点变更而失去协调性的下游字段要重新推导，并在交接说明里讲明调了什么、为什么
4. **两份产物的写法** — `design_spec.md` 按 `templates/design_spec_reference.md` 的章节骨架填；`spec_lock.md` 按 `templates/spec_lock_reference.md` 填，**只输出数据行，不许把模板里的说明性引用块抄进去**
5. **分节大纲的粒度** — 每节 800–1200 字；每节要写明「本节任务」与「本节结束时读者应有的感受」
6. **小说专属** — 人物档案（Core Four 齐全）与伏笔表（三态）必须在开写前填完，否则 `continuity_check.py` 无标准可依

- [ ] **Step 2: 写 `writer-base.md`（写手）**

必须覆盖：

1. **每节开写前的固定动作**（写成可勾选清单）：
   - `read_file <project>/spec_lock.md`
   - 取出：文风、人称、禁用清单、本节字数区间、本节涉及的人物档案与伏笔状态
   - 读锁定的 `voices/<voice>.md` 与 `structures/<体裁>/<structure>.md`（**各只读一份**）
2. **为什么每节都要重读**（把设计文档里的理由写进来）：上下文压缩会让约束悄悄失效，模型自己感觉不到；这是纪律不是建议
3. **逐节顺序写** — 禁止批量、禁止并行、禁止写脚本生成正文、禁止委派子 agent。每条给理由
4. **写完一节的收尾动作** — 更新伏笔表状态；自查本节字数是否落在区间内
5. **文风落地手法** — 怎么把 `voices/*.md` 的「句式偏好」变成实际句子；口头禅每千字 1–2 处（多了假）
6. **禁止事项** — 不改契约（要改走 `update_spec.py` 并回到策划）；不自评（自评是审校的活）

- [ ] **Step 3: 写 `editor.md`（审校）**

必须覆盖：

1. **岗位边界** — **只诊断不动手**。产出问题清单，不产出改好的文字
2. **三步诊断流程**：
   - 跑脚本：`ai_slop_checker.py`（五维分）、`readability_check.py`（平台合规）、小说加 `continuity_check.py`
   - 按体裁跑人工诊断：文案＝AI 痕迹仪表盘 + 转化要素；小说＝逐场景 GCOS；文章＝七轮扫描
   - 合并成一张 🔴/🟡/🟢 三级清单，每条带行号与「为什么要改」
3. **读者评分团** — 3–5 个身份各打 1–10 分，**均分 ≥8 放行**。档位表照抄研究结论。低于阈值退回润色，**最多两轮**；两轮仍不过关如实报告并交还用户决定（不许无限循环，也不许糊弄过关）
4. **诊断报告模板** — 给一份完整样例
5. **脚本与人的分工** — 脚本给密度/方差/位置，人判断「这处是不是刻意为之」

- [ ] **Step 4: 写 `polisher.md`（润色）**

必须覆盖：

1. **岗位边界** — 只按审校的清单定向改。**禁止推翻重写**；禁止顺手改清单外的地方（用户会对不上账）
2. **改味纪律** — 改味不改错；删最少字换最大效果；不为避开禁用词换成更别扭的说法
3. **优先级** — 先 🔴 后 🟡，🟢 问用户要不要动
4. **结构均匀度的改法**（最常见的 🔴）：故意插短句、拆长句成不等长几句、让某段只有一行 —— 给改前改后对照
5. **改完的验证** — 重跑脚本，把分数变化写进报告；分数没升说明改法不对，回头找原因而不是继续堆改动

- [ ] **Step 5: 提交**

```bash
git add skills/writing/references/strategist.md skills/writing/references/writer-base.md skills/writing/references/editor.md skills/writing/references/polisher.md
git commit -m "docs(writing): 四个角色说明书 — 策划/写手/审校/润色"
```

---

### Task 15: 模板文件

**Files:**
- Create: `skills/writing/templates/design_spec_reference.md`
- Create: `skills/writing/templates/spec_lock_reference.md`
- Create: `skills/writing/templates/character_sheet.md`
- Create: `skills/writing/templates/foreshadow_table.md`

**Interfaces:**
- Consumes: 无
- Produces: 策划角色按这些骨架产出 `<project>/design_spec.md` 与 `<project>/spec_lock.md`；字段名必须与 `writing_utils.parse_spec_lock` / `continuity_check.parse_characters` / `parse_foreshadows` 解析的一致

- [ ] **Step 1: 写 `spec_lock_reference.md`**

顶部必须有一段警告块（照抄 `skills/ppt-master/templates/spec_lock_reference.md` 的写法）：**这是给策划看的骨架，不要原样抄进项目**；产出时只输出 `##` 段与填好的 `- key: value` 数据行，所有 `>` 说明块都是作者期指引、不是运行期数据。

段与字段**必须**与解析器对齐（字段名写错会静默失效）：

```markdown
## 体裁
- genre: short-story | wechat | article
- sub: <题材或场景名，取自 genres/<体裁>/_index.md>

## 目标
- audience: <自由文本>
- emotional_target: <小说填；六选一>
- conversion_goal: <文案填；读者读完应该做什么>
- core_message: <文章填；一句话论点>

## 文风锁定
- voice: <取自 voices/_index.md，或 custom>
- person: 第一人称 | 第三人称限知 | 第三人称全知
- colloquial_level: <1–5>/5

## 结构
- structure: <取自 structures/<体裁>/_index.md，或 custom>
- total_words: <整数>
- section_words: <下限>-<上限>

## 人物档案
- <人物名> | want:… | need:… | wound:… | lie:… | 语料:…

## 伏笔表
- <三位编号> | 埋点:… | 回收:… | 状态:已规划|已埋未收|已回收

## 禁用清单
- 禁用词: <逗号分隔>
- 禁用句式: <逗号分隔>

## 平台格式
- platform: 公众号 | 朋友圈 | 小红书 | 知乎 | 通用
- paragraph_max: <整数>
- subhead_every: <整数，0 表示不要求>
```

**关键约束**（写进模板的说明块）：`人物档案` 与 `伏笔表` 两段的竖线字段名（`want`/`need`/`wound`/`lie`/`语料`/`埋点`/`回收`/`状态`）由 `continuity_check.py` 逐字解析，改名字要同步改脚本。

- [ ] **Step 2: 写 `design_spec_reference.md`**

人类可读的方案骨架，章节：I 项目信息 / II 八项确认结果与理由 / III 文风方案 / IV 结构方案 / V 内容大纲（分节表：节次·字数·本节任务·结束时读者感受）/ VI 人物设定（小说）/ VII 伏笔设计（小说）/ VIII 素材与论据清单（文章）/ IX 质检计划（要跑哪些脚本、阈值多少）/ X 导出计划。

- [ ] **Step 3: 写 `character_sheet.md` 与 `foreshadow_table.md`**

人物档案模板：Core Four 四栏 + 语料（要求 2–3 句示例台词）+ 外貌/背景 + 角色弧光三点（起点-转折-终点）+ 与其他人物的关系。附一个填好的示范。

伏笔表模板：编号 | 伏笔内容 | 埋点（第几节·具体句子）| 计划回收点 | 状态 | 备注。附填写示范与「短篇建议 3–5 条伏笔」的密度建议。

- [ ] **Step 4: 用模板跑一遍解析器验证字段对齐**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
$WRITING_PY - << 'PY'
import sys, tempfile
from pathlib import Path
sys.path.insert(0, "skills/writing/scripts")
import writing_utils as wu, continuity_check as cc

demo = """## 体裁
- genre: short-story
- sub: 悬疑推理

## 人物档案
- 张明 | want:找到妹妹 | need:原谅自己 | wound:车祸中独自生还 | lie:活下来的人不配幸福 | 语料:……我知道。

## 伏笔表
- 001 | 埋点:第2节 抽屉里的钥匙 | 回收:第5节 | 状态:已埋未收
"""
p = Path(tempfile.mkdtemp()) / "spec_lock.md"
p.write_text(demo, encoding="utf-8")
spec = wu.parse_spec_lock(p)
chars = cc.parse_characters(spec)
fs = cc.parse_foreshadows(spec)
assert chars[0].name == "张明" and chars[0].lie == "活下来的人不配幸福", chars
assert fs[0].fid == "001" and fs[0].status == "已埋未收", fs
print("✓ 模板字段与解析器对齐")
PY
```
Expected: `✓ 模板字段与解析器对齐`

- [ ] **Step 5: 提交**

```bash
git add skills/writing/templates
git commit -m "docs(writing): 写作方案与契约模板 + 人物档案/伏笔表"
```

---

## Phase C：主管线与工作流

### Task 16: SKILL.md 主管线

**Files:**
- Create: `skills/writing/SKILL.md`

**Interfaces:**
- Consumes: 全部 `references/`、`templates/`、`scripts/`、`workflows/`
- Produces: 技能入口。frontmatter 的 `name: writing` 决定触发名 `/claude-desktop:writing`

- [ ] **Step 1: 写 frontmatter**

```markdown
---
name: writing
description: >
  工程化中文写作系统。微信文案（带货推广/拼团裂变/私域运营/直播预告）、
  短篇小说（悬疑/言情/科幻/脑洞/治愈/搞笑）、文章（行业观察/产品评测/
  方法论/技术科普）三大体裁的从零创作与改写。四角色流水线 + 写作契约防
  长文漂移 + AI 味量化检测。Use when the user asks to 写文案 / 写小说 /
  写文章 / 写公众号 / 改写 / 润色 / 去 AI 味, or mentions "writing".
---
```

- [ ] **Step 2: 写顶部两个 CAUTION 块**

**块一 · Python 环境**（照抄 ppt-master 的写法，改成本技能的路径）：
每条 `python3 scripts/...` 必须先 `source ${SKILL_DIR}/bin/ensure-python.sh`，然后把文档里所有 `python3` 换成 `$WRITING_PY`；Windows 跑 `.cmd` 取最后一行的 `WRITING_PY=<path>`。自举失败要如实报告并停下，**不许回退裸 `python3`**。

**块二 · 全局执行纪律**（八条，逐条给理由）：
1. 串行执行
2. ⛔ BLOCKING = 硬停（八项确认必须等用户明确回复）
3. 禁止跨阶段捆绑
4. 每个 Step 有前置门（🚧 GATE），进入前必须核对
5. 禁止投机执行（策划阶段不许写正文）
6. **每节重读契约**（写手每写一节前必须 `read_file spec_lock.md`）—— 理由写透：抗上下文压缩漂移
7. 逐节顺序生成，禁止分批打包
8. **禁止脚本批量生成正文、禁止子 agent 代写** —— 理由：跨节一致性依赖逐节带完整上文创作

- [ ] **Step 3: 写脚本索引表与资源库索引表**

两张表，格式照抄 ppt-master 的 `Main Pipeline Scripts` / `Template Index`：脚本表列 7 个脚本各自的用途；资源库表列 `voices/_index.md`、`structures/_index.md`、`genres/<体裁>/_index.md` 三个查询入口，并写明**只读锁定的那一份，禁止 glob 目录**。

- [ ] **Step 4: 写九步主管线**

```
Step 1 素材处理（可选）      🚧 GATE: 无
Step 2 项目初始化            🚧 GATE: Step 1 完成或跳过
Step 3 文风学习（条件触发）  🚧 GATE: 用户提供了往期文章
Step 4 策划 ⛔ 八项确认      🚧 GATE: 项目已初始化
Step 5 查资料（条件触发）    🚧 GATE: 体裁=文章 且论据不足
Step 6 写作                  🚧 GATE: spec_lock.md 已生成
Step 7 质检                  🚧 GATE: 全部分节初稿完成
Step 8 润色                  🚧 GATE: 诊断清单已产出
Step 9 导出                  🚧 GATE: 质检放行
```

每个 Step 写明：前置门、要 `Read` 哪份角色说明书、具体命令（含参数）、产物路径、完成检查点（`## ✅ 阶段完成` 勾选块，照抄 ppt-master 的写法）。

**Step 4 必须写全**：两层确认的字段清单、聊天呈现格式、创作性字段给 ≥3 候选的硬规则、确认值优先于推荐、锚点变更后重新推导下游字段的对照表。

**Step 6 必须写全**：每节固定动作清单、逐节循环、伏笔状态更新。

**Step 7 必须写全**：三个脚本的调用命令与阈值、体裁对应的人工诊断法、读者评分团、**最多两轮**的退回上限。

- [ ] **Step 5: 写角色切换协议与独立工作流索引**

角色切换协议：切换时显式输出 `## [角色切换：审校]`，并说明该角色的边界。

独立工作流表：7 个工作流各自的触发条件与路径（`workflows/*.md`）。

- [ ] **Step 6: 校验 frontmatter 可被解析并提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
head -20 skills/writing/SKILL.md
$WRITING_PY -c "
import re, pathlib
t = pathlib.Path('skills/writing/SKILL.md').read_text(encoding='utf-8')
m = re.match(r'^---\n(.*?)\n---\n', t, re.S)
assert m, 'frontmatter 缺失或格式错误'
assert re.search(r'^name:\s*writing\s*$', m.group(1), re.M), 'name 必须是 writing'
assert 'description:' in m.group(1), 'description 缺失'
print('✓ frontmatter 正确')
"
git add skills/writing/SKILL.md
git commit -m "feat(writing): SKILL.md 主管线 — 九步流水线 + 八条全局纪律"
```
Expected: `✓ frontmatter 正确`

---

### Task 17: 七个独立工作流

**Files:**
- Create: `skills/writing/workflows/style-learn.md`
- Create: `skills/writing/workflows/topic-research.md`
- Create: `skills/writing/workflows/rewrite.md`
- Create: `skills/writing/workflows/polish-only.md`
- Create: `skills/writing/workflows/resume-writing.md`
- Create: `skills/writing/workflows/serialize.md`
- Create: `skills/writing/workflows/batch-titles.md`

**Interfaces:**
- Consumes: `references/*`、`scripts/*`
- Produces: 被 `SKILL.md` 的独立工作流表索引

- [ ] **Step 1: 写 `rewrite.md`（最重要的一个）**

必须覆盖：

1. **两条路径的分流**：用户只说「帮我改一下」→ 走全套诊断；用户已明确方向（「改口语点」「压到 800 字」「换成小红书」）→ 直接按方向改，跳过完整诊断。判别规则要写清
2. **全套诊断路径**：落项目目录（原文进 `sources/`）→ 识别体裁与题材（识别不出就问）→ 跑三个脚本 → 按体裁跑人工诊断 → 产出 🔴/🟡/🟢 清单进 `reviews/` → **⛔ 停下问用户按不按清单改** → 改写稿进 `output/`
3. **改写稿必须标注改了哪里、为什么** —— 用户要能对账
4. 完整的诊断报告样例与改写交付样例

- [ ] **Step 2: 写 `style-learn.md`**

流程：收集往期文章（≥3 篇，少于 3 篇要提示样本不足）→ 跑 `style_profile.py` → 人工补充脚本看不出的特征（语气、立场、幽默方式）→ 产出文风档案 → 说明怎么在后续项目里复用（把「写作契约建议」段抄进 `spec_lock.md`）。

- [ ] **Step 3: 写 `topic-research.md`**

流程：从核心论点拆出待验证清单 → WebSearch/WebFetch 取证 → 每条论据记录来源 URL 与取证日期 → 产出 `analysis/research.md` → **明确红线：找不到证据的数字绝不编造，标「待核实」交还用户**。

- [ ] **Step 4: 写 `polish-only.md`**

用户只要润色不要重写时的轻量路径：跳过策划与写作，直接进审校 → 润色两步。强调「不动结构、不动观点、只动文字」。

- [ ] **Step 5: 写 `resume-writing.md`**

长文分两阶段（对应 ppt-master 的 split mode）：Phase A（Step 1–5，出契约与大纲）在一个会话完成；换新窗口输入「继续写作 projects/<项目名>」进入 Phase B（Step 6–9）。写明 Phase B 的入口动作：先 `read_file spec_lock.md` + `design_spec.md` + 已有 `drafts/`，再从下一节接着写。

- [ ] **Step 6: 写 `serialize.md` 与 `batch-titles.md`**

`serialize.md` — 一稿多平台：先定主稿平台，再按目标平台的 `PLATFORM_RULES` 改造（长度、段落、语气、标题风格），每个平台产出独立文件；强调**不是简单删减**，各平台的读者预期不同。

`batch-titles.md` — 批量出 10–15 个标题（覆盖四类公式各 3–4 个）→ 按三维度打分（信息量/好奇缺口/可信度）→ 推荐前 3 并说明理由 → 用户选定后写回 `spec_lock.md`。

- [ ] **Step 7: 提交**

```bash
git add skills/writing/workflows
git commit -m "docs(writing): 七个独立工作流 — 改写/学文风/查资料/润色/续写/多平台/批量标题"
```

---

## Phase D：应用入口

### Task 18: 「设计创意」新增写作卡片

**Files:**
- Create: `apps/studio/public/skill-icons/writing.png`
- Modify: `apps/studio/src/chat/composer/skillChipRegistry.ts`（在 remotion 那组之后、proposal-writer 那组之前插入）
- Modify: `apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx`（`PROMPTS_BY_SKILL` 第 73 行起的对象里加 `writing` 键；`CATEGORIES` 的 `design` 分类 `items` 数组加一条）

**Interfaces:**
- Consumes: `skills/writing/SKILL.md`（Task 16 已落地，`/claude-desktop:writing` 才有意义）
- Produces: 用户可见入口。**后端零改动** —— `skills/.claude-plugin/plugin.json` 已把整个 `skills/` 注册为本地插件

- [ ] **Step 1: 生成图标**

用 `draw` 技能生成 `apps/studio/public/skill-icons/writing.png`，要求：
- 与现有图标同系列：圆角方形、右上角折角（文件隐喻）、蓝色渐变底、白色线条主体
- 主体图形用「钢笔尖 + 一行文字线」或「稿纸 + 笔」，**必须与 `write.png`（写方案，钢笔尖 + 波浪线）明显区分** —— 两者会同时出现在斜杠菜单里，撞脸用户会点错
- 尺寸 256×256 PNG，透明底

先看一眼现有图标定基调：

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
ls -la apps/studio/public/skill-icons/
```

- [ ] **Step 2: 在 `skillChipRegistry.ts` 注册 chip**

在 remotion 的两条之后、`// proposal-writer — 写方案。` 注释之前插入：

```ts
  // writing — 写作。namespaced + 裸名双注册，理由同 ppt-master。
  // 与 proposal-writer（写方案）的分工：那个写商业方案/售前文档、有方案模式
  // 的双栏工作台并走客户端拦截；这个是通用内容写作（文案/小说/文章），是普通
  // skill，命令原样发给 CLI 不拦截。图标也刻意不同，两者会同时出现在斜杠菜单。
  {
    match: '/claude-desktop:writing',
    image: '/skill-icons/writing.png',
    label: '写作',
    description: '公众号文案、小说、文章的创作与改写'
  },
  {
    match: '/writing',
    image: '/skill-icons/writing.png',
    label: '写作',
    description: '公众号文案、小说、文章的创作与改写'
  },
```

- [ ] **Step 3: 在 `ScenarioRail.tsx` 的 `PROMPTS_BY_SKILL` 加预设 prompt**

在 `remotion:` 那组之后、`// ── 代码开发场景` 注释之前插入。key 用**裸名** `writing`（第 271 行的 `bareSkillName` 会把 `/claude-desktop:writing` 归一化成 `writing`）：

```ts
  writing: [
    {
      label: '公众号文案',
      text: '帮我写一篇公众号文案，主题是【主题】，目标读者是【读者画像】，希望读者读完【去做什么】。'
    },
    {
      label: '短篇小说',
      text: '帮我写一篇短篇小说，题材是【悬疑/言情/科幻/脑洞/治愈/搞笑】，核心设定是【一句话设定】，我希望读者读完的感觉是【意难平/反转震撼/爽感/治愈/细思极恐】。'
    },
    {
      label: '文章',
      text: '帮我写一篇文章，主题是【主题】，我的核心观点是【一句话观点】，发在【平台】给【读者】看。'
    },
    {
      // 改写走 workflows/rewrite.md：只说「改一下」会先诊断再改，
      // 说了具体方向则直接按方向改。这条 prompt 刻意留白让用户二选一。
      label: '改写这段文字',
      text: '帮我改写下面这段文字：\n\n【粘贴原文】\n\n【可选：说明想改的方向，比如更口语、压到 800 字、换成小红书风格；不说就先给我诊断】'
    },
    {
      label: '学我的文风',
      text: '读一下【我的往期文章文件或目录】，分析我的写作风格，生成一份文风档案，以后写东西都按这个风格来。'
    }
  ],
```

- [ ] **Step 4: 在 `CATEGORIES` 的 `design` 分类加卡片**

把 `design` 分类的 `items` 改成（写作放第一位——它是这次新增的主角，且比 ppt-master 更常用）：

```ts
    items: [
      { kind: 'skill', value: '/claude-desktop:writing' },
      { kind: 'skill', value: '/claude-desktop:imagegen' },
      { kind: 'skill', value: '/claude-desktop:remotion' },
      { kind: 'skill', value: '/claude-desktop:ppt-master' }
    ]
```

- [ ] **Step 5: 跑类型检查**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
```
Expected: 通过，无报错。（这是本仓库唯一的自动化防线——没有 ESLint、没有前端单测）

- [ ] **Step 6: 起应用人工验证**

```bash
bun run dev
```

逐项确认：
1. 「智能助手」→「设计创意」分类里出现「写作」卡片，图标显示正常且与「写方案」不撞脸
2. 点「写作」卡 → 输入框出现 `/claude-desktop:writing` chip，中文显示「写作」
3. 卡片下方出现 5 条预设 prompt；点「短篇小说」→ 正文填入预设文本，chip 保留
4. 直接发送 → CLI 能识别并触发 skill（能看到 SKILL.md 的流程开始跑，而不是把命令当普通文字）
5. 在斜杠菜单里输入 `/writ` → 「写作」与「写方案」两条都出现且能区分

- [ ] **Step 7: 提交**

```bash
git add apps/studio/public/skill-icons/writing.png apps/studio/src/chat/composer/skillChipRegistry.ts apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx
git commit -m "feat(studio): 设计创意新增写作卡片 — chip 注册 + 5 条预设 prompt"
```

---

## Phase E：端到端验收

### Task 19: 三体裁走查 + 文档收口

**Files:**
- Modify: `CLAUDE.md`（在「命令」小节后补一句写作技能的存在与位置）
- Create: `skills/writing/scripts/README.md`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可交付的完整技能

- [ ] **Step 1: 写 `scripts/README.md`**

一张表列全 7 个脚本：名称 | 用途 | 典型命令 | 退出码含义。顶部写明必须先 `source bin/ensure-python.sh` 并用 `$WRITING_PY`。

- [ ] **Step 2: 跑全量脚本测试**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
source skills/writing/bin/ensure-python.sh
$WRITING_PY -m pytest skills/writing/tests/ -v
$WRITING_PY skills/writing/scripts/validate_library.py
```
Expected: 全部 PASS；资源库校验 `✓ 资源库结构完整`

- [ ] **Step 3: 端到端走查一 · 微信文案**

在应用里点「写作」→「公众号文案」，填一个真实主题发送。逐项核对：

1. 是否**先做八项确认**并停下等回复（不许自己往下写）
2. 锚点四项确认后，是否**重新推导**了实现四项（改一个锚点试试，看下游有没有跟着变）
3. 文风与结构是否各给了 **≥3 个候选**
4. 确认后是否**自动连续跑完**后续步骤（不再反复打断）
5. 产物是否落在 `skills/writing/projects/<名>_<日期>/` 下的正确子目录
6. 质检阶段是否真的**跑了脚本**（能看到命令与分数），而不是嘴上说「已检查」
7. 若 AI 味总分 < 35，是否退回润色并重跑

- [ ] **Step 4: 端到端走查二 · 短篇小说**

重点核对小说专属机制：

1. `spec_lock.md` 里人物档案的 **Core Four 是否齐全**、伏笔表是否有三态
2. 写每一节前是否**真的重读了契约**（观察工具调用记录里有没有 `read_file spec_lock.md`）
3. 写完一节后伏笔状态是否更新
4. 质检是否跑了 `continuity_check.py`，未回收伏笔是否被报出
5. 全文完成后，人物语气是否前后一致（这是「每节重读契约」要解决的核心问题，也是最值得亲眼验证的一条）

- [ ] **Step 5: 端到端走查三 · 文章 + 改写**

1. 文章：是否先分流「观点输出型 / 说明介绍型」；论据是否标了来源；找不到证据的数字是否标「待核实」而非编造
2. 改写：贴一段文字只说「帮我改一下」→ 应走**全套诊断**并停下问要不要按清单改
3. 改写：贴同一段文字说「改口语一点」→ 应**跳过完整诊断**直接按方向改
4. 改写稿是否标注了改了哪里、为什么

- [ ] **Step 6: 更新 `CLAUDE.md`**

在项目 `CLAUDE.md` 的「命令」小节之后加一段（不要改动已有内容的其他部分）：

```markdown
## 内置写作技能

`skills/writing/` 是对标 ppt-master 的工程化写作技能（微信文案 / 短篇小说 /
文章）。四角色串行流水线，`spec_lock.md` 是写作契约、**写手每写一节前必须
重读**（抗长文上下文漂移，与 ppt-master 每页重读 spec_lock 同源）。质检靠
`scripts/` 下的 Python 脚本量化（AI 味五维打分 / 平台合规 / 小说连贯性），
不靠模型自评。改资源库（`references/voices|structures|genres`）后必须跑
`scripts/validate_library.py`——新增手册漏登记进 `_index.md` 会静默失效。
设计与实施记录见 `docs/superpowers/specs/2026-07-24-writing-skill-design.md`。
```

- [ ] **Step 7: 最终提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
git add CLAUDE.md skills/writing/scripts/README.md
git commit -m "docs(writing): 脚本说明 + CLAUDE.md 登记内置写作技能"
```

---

## 附录：任务依赖关系

```
Task 1（骨架+工具）
  ├─ Task 2（AI味检测）─┐
  ├─ Task 3（平台合规）─┤
  ├─ Task 4（连贯性）  ─┼─ Task 14（角色说明书，要引用脚本用法）
  ├─ Task 5（契约更新+校验器）─┬─ Task 9–13（内容库，要用校验器）
  ├─ Task 6（导出）    ─┤      └─ Task 15（模板，字段要与 Task 4 解析器对齐）
  └─ Task 7（素材+文风）┘
                              Task 8（共享标准）─ Task 9–13 引用
                                        ↓
                              Task 16（SKILL.md，要索引全部前置产物）
                                        ↓
                              Task 17（工作流）
                                        ↓
                              Task 18（UI，要 SKILL.md 已存在）
                                        ↓
                              Task 19（端到端验收）
```

**可并行**：Task 2–7 之间互不依赖（都只依赖 Task 1）；Task 9–13 之间互不依赖（都依赖 Task 5 与 Task 8）。

**串行硬约束**：Task 15 的字段名必须与 Task 4 的解析器一致；Task 16 必须在全部内容任务之后；Task 18 必须在 Task 16 之后（否则卡片点了没东西可触发）。
