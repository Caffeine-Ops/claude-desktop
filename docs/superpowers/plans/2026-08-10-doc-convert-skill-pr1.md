# 文档处理技能 PR 1（B 类·纯脚本转换）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `claude-desktop:doc-convert` 技能并交付 4 条确定性文档转换能力（Markdown→Word、Word→PDF、Excel↔CSV、PDF 合并拆分），在「日常办公」分类下可见可用。

**Architecture:** 技能自包含在 `skills/doc-convert/`，结构对标 `skills/spreadsheets/`：`bin/ensure-python.sh(.cmd)` 在用户 home 建独立 venv，`scripts/*.py` 是四个可独立执行、可独立测试的 CLI 脚本，`SKILL.md` 是给模型看的调度说明。前端仅新增 chip 注册与场景目录条目，不动任何渲染逻辑。

**Tech Stack:** Python 3.12（app 自带 runtime）、pypdf、python-docx、openpyxl、reportlab、Pillow；TypeScript / bun test（前端侧）。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md`，本计划覆盖其中「B 类 · 走脚本」4 条与全部前端接入。A 类 4 条属 PR 2，本计划不实现。
- **venv 绝不能建在 skill 目录内**——打包后该目录在 Electron resources 下只读。venv 落 `~/.doc-convert-skill/venv`。
- **不装 pandas**：唯一用得上它的 Excel↔CSV 用内置 `csv` + openpyxl 即可，pandas+numpy 约 84 MB，比其余依赖总和还大。
- 环境变量名 `DOC_CONVERT_PYTHON_HOME`（主进程注入）/ `DOC_CONVERT_PY`（引导脚本导出）。每个技能一个独立变量名，**不复用** `PPT_MASTER_PYTHON_HOME` / `TENDER_PYTHON_HOME`。
- 技能命令 `/claude-desktop:doc-convert`，chip 中文名 `文档处理`，描述 `格式转换、提取文字、批量整理`。
- 场景目录条目挂 `daily` 分类，位置在 `/claude-desktop:spreadsheets` **之后**、`/claude-desktop:proposal-writer` **之前**。
- 注释用中文，解释「为什么这样而不是那样」，沿用仓库既有风格。
- 项目无 ESLint，`bun run typecheck` 是唯一全局防线；`bun test` 在 `apps/studio` 下跑。
- 分支 `feat/doc-convert-skill`（已建，设计文档已提交在上面）。

---

### Task 1: 技能骨架 + Python 引导 + 主进程注入

**Files:**
- Create: `skills/doc-convert/requirements.txt`
- Create: `skills/doc-convert/requirements-dev.txt`
- Create: `skills/doc-convert/bin/ensure-python.sh`
- Create: `skills/doc-convert/bin/ensure-python.cmd`
- Create: `skills/doc-convert/.gitignore`
- Modify: `apps/studio/electron/main/core/engine.ts:2043`（bundled 分支）与 `:2074`（system 分支）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `source skills/doc-convert/bin/ensure-python.sh` 后 shell 里有 `$DOC_CONVERT_PY` 指向 venv 解释器；Windows 上 `bin\ensure-python.cmd` 末行打印 `DOC_CONVERT_PY=<path>`。后续所有 Task 的 Python 命令一律用 `"$DOC_CONVERT_PY"` 而非裸 `python`。

- [ ] **Step 1: 写 requirements.txt**

```
# doc-convert skill dependencies / 文档处理 skill 依赖
# =====================================================
#
# 安装由 bin/ensure-python.sh（macOS/Linux，须 `source`）或 bin/ensure-python.cmd
# （Windows）负责：基于 app 自带 Python 3.12 在 ~/.doc-convert-skill/venv 建虚拟
# 环境后安装本清单。打包后的 runtime 只读，禁止直装。

# PDF 页级操作：合并 / 拆分 / 删页 / 加水印（pdf_ops.py）
pypdf>=4.0.0

# Word 读写：md_to_docx.py 生成、docx_to_pdf.py 兜底路径解析正文
python-docx>=1.1

# Excel 读写（excel_csv.py 双向转换）
openpyxl>=3.1.0

# docx→pdf 的纯文字兜底渲染。本仓已有先例（skills-src/ppt-creator）。
# 只在本机没有 LibreOffice 且用户显式同意「纯文字版」时才会被用到。
reportlab>=4.0.0

# openpyxl 嵌图与图片校验的常规伴生依赖，与 spreadsheets 技能一致
Pillow>=9.0.0
```

> **刻意不列 pandas**：见 Global Constraints。任何人想加回来之前，先确认那件事真的用 `csv` + openpyxl 做不了。

- [ ] **Step 2: 写 requirements-dev.txt**

```
# 仅开发/测试用，不进用户 venv 的默认安装路径——用户机器上没人跑单测，
# 把 pytest 塞进 requirements.txt 只是让每个用户白多下几 MB。
# 跑测试前手动装一次：
#   "$DOC_CONVERT_PY" -m pip install -r skills/doc-convert/requirements-dev.txt
pytest>=8.0
```

- [ ] **Step 3: 写 bin/ensure-python.sh**

照抄 `skills/tender-review/bin/ensure-python.sh` 的结构，把前缀 `tender`→`doc_convert`、`TENDER_`→`DOC_CONVERT_`、venv 目录 `~/.tender-review-skill`→`~/.doc-convert-skill`。完整内容：

```bash
# shellcheck shell=bash
# doc-convert skill Python bootstrap — macOS / Linux.
#
# 故意与 tender-review / writing / ppt-master 平行维护，不抽公共依赖：技能必须
# 自包含——用户可能只装其中一个，它们也可能被分开打包发布。本文件与
# skills/tender-review/bin/ensure-python.sh 结构逐行对应（由它机械替换前缀生成），
# 改一处记得对照另一处是否也该改（但不要合并成共享文件）。
#
# 必须用 `source` 调用（不是直接执行）：脚本通过 `export DOC_CONVERT_PY=...` 把
# 就绪的解释器路径回灌给调用方的 shell。直接 `bash ensure-python.sh` 只会在子
# shell 里 export，父进程拿不到 DOC_CONVERT_PY。SKILL.md 顶部约定也是 `source`。
#
# 干的事：
#   1. venv 落 ~/.doc-convert-skill/venv（用户可写目录）。打包后的 skill 目录在
#      Electron resources 下是只读的，venv 绝不能建在 skill 目录里。
#   2. 选解释器建 venv：优先 app 自带 python-runtime（路径由主进程经
#      DOC_CONVERT_PYTHON_HOME 注入，钉死 3.12，避开本机可能是 py3.14 → 原生
#      扩展无 cp314 wheel 退化源码编译卡死的坑）；没注入则回退系统 python3.12 /
#      python3.11 / python3，并对 3.14+ 提前告警。
#   3. 首次 pip install -r requirements.txt；之后用 .deps-ok 哨兵秒过。依次尝试
#      清华 → 阿里 → 官方 PyPI，每源加超时，卡住就换下一个而不是无限等。
#   4. export DOC_CONVERT_PY 指向 venv 解释器，供文档里所有 python 命令替换。
#
# 失败时打印明确原因并 return 1（不 exit，避免把调用方 shell 一起带走）。

DOC_CONVERT_VENV_DIR="${DOC_CONVERT_VENV_DIR:-$HOME/.doc-convert-skill/venv}"
__dc_req="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/requirements.txt"

# ── 1. 已就绪：venv 存在 + 依赖装好哨兵在 → 直接导出，秒过 ──────────────
__dc_py="$DOC_CONVERT_VENV_DIR/bin/python"
if [ -x "$__dc_py" ] && [ -f "$DOC_CONVERT_VENV_DIR/.deps-ok" ]; then
  export DOC_CONVERT_PY="$__dc_py"
  echo "[doc-convert] Python 就绪：$DOC_CONVERT_PY"
  unset __dc_py __dc_req
  return 0 2>/dev/null || exit 0
fi

# ── 2. 选 base 解释器 ─────────────────────────────────────────────────
__dc_base=""
if [ -n "$DOC_CONVERT_PYTHON_HOME" ]; then
  for __c in "$DOC_CONVERT_PYTHON_HOME/bin/python3" "$DOC_CONVERT_PYTHON_HOME/bin/python" "$DOC_CONVERT_PYTHON_HOME/python3"; do
    if [ -x "$__c" ]; then __dc_base="$__c"; break; fi
  done
  [ -z "$__dc_base" ] && echo "[doc-convert] 警告：DOC_CONVERT_PYTHON_HOME=$DOC_CONVERT_PYTHON_HOME 下没找到解释器，回退系统 python"
fi
if [ -z "$__dc_base" ]; then
  for __c in python3.12 python3.11 python3; do
    if command -v "$__c" >/dev/null 2>&1; then __dc_base="$(command -v "$__c")"; break; fi
  done
fi
if [ -z "$__dc_base" ]; then
  echo "[doc-convert] 错误：没有可用的 Python 解释器。请安装 Python 3.12（推荐）或确保 app 自带 runtime 完整。"
  unset __dc_py __dc_req __dc_base __c
  return 1 2>/dev/null || exit 1
fi

__dc_ver="$("$__dc_base" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)"
case "$__dc_ver" in
  3.14|3.15|3.16|3.17|3.18|3.19)
    echo "[doc-convert] 警告：base 解释器是 Python $__dc_ver，部分依赖可能无预编译 wheel，pip 会退化源码编译（慢/可能失败）。建议改用 Python 3.12。"
    ;;
esac

# ── 3. 建 venv（缺则建）+ pip install ─────────────────────────────────
if [ ! -x "$__dc_py" ]; then
  echo "[doc-convert] 用 $__dc_base (Python $__dc_ver) 建 venv → $DOC_CONVERT_VENV_DIR"
  if ! "$__dc_base" -m venv "$DOC_CONVERT_VENV_DIR"; then
    echo "[doc-convert] 错误：创建 venv 失败。"
    unset __dc_py __dc_req __dc_base __c __dc_ver
    return 1 2>/dev/null || exit 1
  fi
fi

echo "[doc-convert] 安装依赖（首次约几分钟，之后秒过）…"
"$__dc_py" -m pip install --upgrade pip >/dev/null 2>&1

__dc_mirrors=(
  "https://pypi.tuna.tsinghua.edu.cn/simple"
  "https://mirrors.aliyun.com/pypi/simple"
  ""
)
__dc_ok=0
for __dc_idx in "${__dc_mirrors[@]}"; do
  if [ -n "$__dc_idx" ]; then
    echo "[doc-convert] 尝试镜像源：$__dc_idx"
    __dc_host="$(echo "$__dc_idx" | sed -E 's#https?://([^/]+).*#\1#')"
    if "$__dc_py" -m pip install -r "$__dc_req" -i "$__dc_idx" --trusted-host "$__dc_host" --timeout 30; then
      __dc_ok=1
      break
    fi
  else
    echo "[doc-convert] 尝试官方源：pypi.org"
    if "$__dc_py" -m pip install -r "$__dc_req" --timeout 30; then
      __dc_ok=1
      break
    fi
  fi
  echo "[doc-convert] 该源失败/超时，换下一个…"
done

if [ "$__dc_ok" = 1 ]; then
  : > "$DOC_CONVERT_VENV_DIR/.deps-ok"
  export DOC_CONVERT_PY="$__dc_py"
  echo "[doc-convert] Python 就绪：$DOC_CONVERT_PY"
  unset __dc_py __dc_req __dc_base __c __dc_ver __dc_mirrors __dc_idx __dc_host __dc_ok
  return 0 2>/dev/null || exit 0
fi

echo "[doc-convert] 错误：清华/阿里/官方三个源均安装失败。检查网络后重跑本脚本（venv 已建，只补依赖）。"
unset __dc_py __dc_req __dc_base __c __dc_ver __dc_mirrors __dc_idx __dc_host __dc_ok
return 1 2>/dev/null || exit 1
```

- [ ] **Step 4: 写 bin/ensure-python.cmd**

照抄 `skills/tender-review/bin/ensure-python.cmd`，同样做前缀替换：venv 目录 `%USERPROFILE%\.doc-convert-skill\venv`，读 `DOC_CONVERT_PYTHON_HOME`，末行打印 `DOC_CONVERT_PY=<path>`。

先读原文件再改，别凭空写：

```bash
cat skills/tender-review/bin/ensure-python.cmd
```

替换规则（逐项对照，一处不漏）：`TENDER_VENV_DIR`→`DOC_CONVERT_VENV_DIR`、`TENDER_PYTHON_HOME`→`DOC_CONVERT_PYTHON_HOME`、`TENDER_PY`→`DOC_CONVERT_PY`、`.tender-review-skill`→`.doc-convert-skill`、日志前缀 `[tender]`→`[doc-convert]`。

- [ ] **Step 5: 写 .gitignore**

```
# 运行时产物护栏。与 skills/tender-review/.gitignore 同源同理：
# 这道门守的是 git 提交，发版侧另有一道（prebundle-daemon.mjs 的
# RUNTIME_ARTIFACT_DIR_NAMES + assertNoRuntimeArtifacts 硬断言）。
# 两条路径互相独立，缺一不可，别因为「打包那边已经拦了」就删掉这份。
workspace/
__pycache__/
.pytest_cache/
venv/
.venv/
```

- [ ] **Step 6: 改 engine.ts —— bundled 分支**

在 `engine.ts:2043` 那段 `TENDER_PYTHON_HOME` 注入之后紧接着插入：

```ts
            // 同上，给 doc-convert skill 的 bin/ensure-python.sh。变量名独立于
            // PPT_MASTER / TENDER 的理由见上一段注释——技能自包含、可被单独
            // 打包发布，共用变量会让「只装了其中一个」的机器上出现名字对得上
            // 但语义不属于自己的注入。
            ...(process.env.DOC_CONVERT_PYTHON_HOME
              ? {}
              : pythonHome
                ? { DOC_CONVERT_PYTHON_HOME: pythonHome }
                : {}),
```

- [ ] **Step 7: 改 engine.ts —— system 分支**

在 `engine.ts:2074` 那段 `TENDER_PYTHON_HOME` 注入之后紧接着插入：

```ts
            // 同上，doc-convert skill 在 system 后端下也要能用。理由与 bundled
            // 分支那段一致：这是 main 侧运行时路径，不是 env.json 网关密钥，
            // 不影响 claude 的模型路由。
            ...(process.env.DOC_CONVERT_PYTHON_HOME
              ? {}
              : pythonHome
                ? { DOC_CONVERT_PYTHON_HOME: pythonHome }
                : {}),
```

> **两处都要改。** 漏一处不会报错，而是在那个后端下静默降级到系统 python——用户机器若是 3.14，pip 会退化源码编译卡死几十分钟且无任何提示。这是 `engine.ts:2034-2038` 注释里写明的历史教训。

- [ ] **Step 8: 验证注入点确实是两处**

Run:
```bash
grep -c "DOC_CONVERT_PYTHON_HOME" apps/studio/electron/main/core/engine.ts
```
Expected: `4`（每处 2 行：`process.env.` 判断一行 + 赋值一行）

- [ ] **Step 9: 跑通引导脚本**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" -c "import pypdf, docx, openpyxl, reportlab, PIL; print('deps ok')"
```
Expected: 最后一行输出 `deps ok`；`$DOC_CONVERT_PY` 指向 `~/.doc-convert-skill/venv/bin/python`。

- [ ] **Step 10: 实测 venv 体积并回填设计文档**

Run:
```bash
du -sh ~/.doc-convert-skill/venv
```
把实测值写回 `docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md` 的「体积与磁盘代价」一节，替换掉那个标注「估算，未实测」的约 80 MB，并去掉「未实测」标注。设计文档里已写明这一步是实施时的必做项。

- [ ] **Step 11: 提交**

```bash
git add skills/doc-convert apps/studio/electron/main/core/engine.ts docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md
git commit -m "feat(doc-convert): 技能骨架与 Python 引导，主进程注入 DOC_CONVERT_PYTHON_HOME"
```

---

### Task 2: Markdown → Word

**Files:**
- Create: `skills/doc-convert/scripts/md_to_docx.py`
- Test: `skills/doc-convert/tests/test_md_to_docx.py`

**Interfaces:**
- Consumes: Task 1 的 `$DOC_CONVERT_PY`
- Produces: `md_to_docx.convert(src: Path, dst: Path) -> None`；CLI `python md_to_docx.py <input.md> -o <output.docx>`

- [ ] **Step 1: 装测试依赖（一次性）**

Run:
```bash
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" -m pip install -r skills/doc-convert/requirements-dev.txt
```

- [ ] **Step 2: 写失败的测试**

`skills/doc-convert/tests/test_md_to_docx.py`：

```python
"""md_to_docx 的行为契约。

只测「结构映射对不对」，不测排版细节——排版由 Word 默认样式决定，
断言它等于把 python-docx 的实现细节钉进测试里。
"""
import sys
from pathlib import Path

import pytest
from docx import Document

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import md_to_docx  # noqa: E402


def test_headings_paragraphs_and_bullets(tmp_path):
    src = tmp_path / "a.md"
    src.write_text(
        "# 标题一\n\n正文一段。\n\n- 项目甲\n- 项目乙\n\n## 标题二\n",
        encoding="utf-8",
    )
    dst = tmp_path / "a.docx"

    md_to_docx.convert(src, dst)

    doc = Document(str(dst))
    texts = [p.text for p in doc.paragraphs]
    styles = [p.style.name for p in doc.paragraphs]
    assert texts[:5] == ["标题一", "正文一段。", "项目甲", "项目乙", "标题二"]
    assert styles[0] == "Heading 1"
    assert styles[1] == "Normal"
    assert styles[2] == "List Bullet"
    assert styles[4] == "Heading 2"


def test_bold_and_italic_become_runs(tmp_path):
    src = tmp_path / "b.md"
    src.write_text("这是**重点**和*强调*。\n", encoding="utf-8")
    dst = tmp_path / "b.docx"

    md_to_docx.convert(src, dst)

    doc = Document(str(dst))
    runs = doc.paragraphs[0].runs
    assert "".join(r.text for r in runs) == "这是重点和强调。"
    assert any(r.bold and r.text == "重点" for r in runs)
    assert any(r.italic and r.text == "强调" for r in runs)


def test_fenced_code_block_kept_verbatim(tmp_path):
    src = tmp_path / "c.md"
    src.write_text("```\nline1\nline2\n```\n", encoding="utf-8")
    dst = tmp_path / "c.docx"

    md_to_docx.convert(src, dst)

    doc = Document(str(dst))
    # 代码块逐行成段，且不被行内标记解析（`*` 之类原样保留）
    assert [p.text for p in doc.paragraphs[:2]] == ["line1", "line2"]


def test_missing_input_exits_with_message(tmp_path, capsys):
    with pytest.raises(SystemExit) as e:
        md_to_docx.main([str(tmp_path / "nope.md"), "-o", str(tmp_path / "x.docx")])
    assert e.value.code != 0
    assert "找不到输入文件" in capsys.readouterr().err
```

- [ ] **Step 3: 跑测试确认失败**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_md_to_docx.py -v
```
Expected: FAIL，`ModuleNotFoundError: No module named 'md_to_docx'`

- [ ] **Step 4: 写实现**

`skills/doc-convert/scripts/md_to_docx.py`：

```python
#!/usr/bin/env python3
"""Markdown → Word（.docx）。

**刻意只支持 Markdown 的常用子集**，不引 markdown/mistune 之类解析库：
用户在办公场景写的 md 就是标题 / 段落 / 列表 / 粗斜体 / 代码块这几样，
为覆盖表格嵌套引用等长尾多背一个解析依赖不划算。真遇到复杂 md，
正确做法是让模型先把它规整成这个子集，而不是把解析器做厚。

支持：# ~ ###### 标题、空行分段、- / * 无序列表、1. 有序列表、
     **粗体**、*斜体*、`行内代码`、``` 围栏代码块、--- 分隔线。
不支持（会原样当普通文本输出，不报错）：表格、引用块、图片、链接语法。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from docx import Document

# 行内标记：粗体优先于斜体（`**x**` 必须先被吃掉，否则会被斜体规则劈成
# `*` + `*x*` + `*`）。行内代码单独一档，命中后不再解析里面的星号。
_INLINE = re.compile(r"(\*\*.+?\*\*|\*.+?\*|`.+?`)")

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET = re.compile(r"^\s*[-*]\s+(.*)$")
_ORDERED = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_HRULE = re.compile(r"^\s*([-*_])\s*(\1\s*){2,}$")


def _add_inline(paragraph, text: str) -> None:
    """把一行正文按行内标记切成多个 run 加进段落。"""
    for piece in _INLINE.split(text):
        if not piece:
            continue
        if piece.startswith("**") and piece.endswith("**") and len(piece) > 4:
            paragraph.add_run(piece[2:-2]).bold = True
        elif piece.startswith("`") and piece.endswith("`") and len(piece) > 2:
            run = paragraph.add_run(piece[1:-1])
            run.font.name = "Consolas"
        elif piece.startswith("*") and piece.endswith("*") and len(piece) > 2:
            paragraph.add_run(piece[1:-1]).italic = True
        else:
            paragraph.add_run(piece)


def convert(src: Path, dst: Path) -> None:
    """把 src 这份 Markdown 转成 dst 这份 .docx。"""
    doc = Document()
    in_code = False

    for raw in src.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()

        # 围栏代码块：进入后逐行原样成段，直到再遇到围栏。放在最前面判断——
        # 代码块里的 `# ` 是注释不是标题，任何结构规则都不该在这里生效。
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            run = doc.add_paragraph().add_run(line)
            run.font.name = "Consolas"
            continue

        if not line.strip():
            continue

        if _HRULE.match(line):
            doc.add_paragraph("―" * 20)
            continue

        m = _HEADING.match(line)
        if m:
            doc.add_heading(m.group(2).strip(), level=len(m.group(1)))
            continue

        m = _BULLET.match(line)
        if m:
            _add_inline(doc.add_paragraph(style="List Bullet"), m.group(1))
            continue

        m = _ORDERED.match(line)
        if m:
            _add_inline(doc.add_paragraph(style="List Number"), m.group(1))
            continue

        _add_inline(doc.add_paragraph(), line)

    dst.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(dst))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Markdown 转 Word")
    ap.add_argument("input", help="输入 .md 文件")
    ap.add_argument("-o", "--output", required=True, help="输出 .docx 文件")
    args = ap.parse_args(argv)

    src = Path(args.input)
    if not src.is_file():
        print(f"[doc-convert] 错误：找不到输入文件 {src}", file=sys.stderr)
        raise SystemExit(2)

    dst = Path(args.output)
    convert(src, dst)
    print(f"[doc-convert] 已生成 {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_md_to_docx.py -v
```
Expected: 4 passed

- [ ] **Step 6: 提交**

```bash
git add skills/doc-convert/scripts/md_to_docx.py skills/doc-convert/tests/test_md_to_docx.py
git commit -m "feat(doc-convert): Markdown 转 Word"
```

---

### Task 3: Excel ↔ CSV 双向

**Files:**
- Create: `skills/doc-convert/scripts/excel_csv.py`
- Test: `skills/doc-convert/tests/test_excel_csv.py`

**Interfaces:**
- Consumes: Task 1 的 `$DOC_CONVERT_PY`
- Produces: `excel_csv.xlsx_to_csv(src, dst, sheet=None)`、`excel_csv.csv_to_xlsx(src, dst)`；CLI `python excel_csv.py <input> -o <output> [--sheet 名称]`，方向按输入扩展名自动判定

- [ ] **Step 1: 写失败的测试**

`skills/doc-convert/tests/test_excel_csv.py`：

```python
"""excel_csv 的行为契约。

最重要的一条是 BOM：中文用户双击打开无 BOM 的 UTF-8 CSV，Excel 会按
本地代码页解码 → 满屏乱码。这不是锦上添花，是这条功能能不能用的分界线。
"""
import csv
import sys
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import excel_csv  # noqa: E402


def _make_xlsx(path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "数据"
    ws.append(["姓名", "金额"])
    ws.append(["张三", 100])
    wb.save(str(path))


def test_xlsx_to_csv_writes_utf8_bom(tmp_path):
    src = tmp_path / "a.xlsx"
    _make_xlsx(src)
    dst = tmp_path / "a.csv"

    excel_csv.xlsx_to_csv(src, dst)

    raw = dst.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf"), "缺 BOM 会让 Excel 打开中文 CSV 乱码"
    rows = list(csv.reader(dst.read_text(encoding="utf-8-sig").splitlines()))
    assert rows == [["姓名", "金额"], ["张三", "100"]]


def test_csv_to_xlsx_roundtrip(tmp_path):
    src = tmp_path / "b.csv"
    src.write_text("姓名,金额\n李四,200\n", encoding="utf-8-sig")
    dst = tmp_path / "b.xlsx"

    excel_csv.csv_to_xlsx(src, dst)

    ws = load_workbook(str(dst)).active
    assert [[c.value for c in row] for row in ws.iter_rows()] == [
        ["姓名", "金额"],
        ["李四", "200"],
    ]


def test_multi_sheet_requires_explicit_choice(tmp_path):
    src = tmp_path / "c.xlsx"
    wb = Workbook()
    wb.active.title = "一月"
    wb.create_sheet("二月")
    wb.save(str(src))

    # 多表时静默只导第一张 = 用户丢数据还不知道。必须报错要求指定。
    with pytest.raises(SystemExit):
        excel_csv.xlsx_to_csv(src, tmp_path / "c.csv")

    excel_csv.xlsx_to_csv(src, tmp_path / "c.csv", sheet="二月")
    assert (tmp_path / "c.csv").is_file()


def test_unknown_extension_exits_with_message(tmp_path, capsys):
    bad = tmp_path / "d.txt"
    bad.write_text("x", encoding="utf-8")
    with pytest.raises(SystemExit):
        excel_csv.main([str(bad), "-o", str(tmp_path / "d.csv")])
    assert "只支持" in capsys.readouterr().err
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_excel_csv.py -v
```
Expected: FAIL，`ModuleNotFoundError: No module named 'excel_csv'`

- [ ] **Step 3: 写实现**

`skills/doc-convert/scripts/excel_csv.py`：

```python
#!/usr/bin/env python3
"""Excel ↔ CSV 双向转换。

**刻意不用 pandas**：这件事用内置 csv + openpyxl 就够了，而 pandas 连同
numpy 约 84 MB，比本技能其余依赖加起来还大。为一次读写背这个包不划算。

两个非显然的决定，都是「不这么做用户就会踩坑」：

1. **写 CSV 一律带 UTF-8 BOM**（encoding="utf-8-sig"）。中文用户双击打开
   无 BOM 的 UTF-8 CSV 时，Excel 按本地代码页解码 → 满屏乱码，然后用户
   会认为是我们转错了。BOM 让 Excel 认出编码。读 CSV 同样用 utf-8-sig，
   它对没有 BOM 的文件也能正常工作（只在有 BOM 时吃掉它）。
2. **多工作表时拒绝猜**。静默只导第一张表 = 用户丢了数据还不知道。宁可
   报错要求他指定 --sheet。
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from openpyxl import Workbook, load_workbook

_XLSX_SUFFIXES = {".xlsx", ".xlsm"}
_CSV_SUFFIXES = {".csv"}


def xlsx_to_csv(src: Path, dst: Path, sheet: str | None = None) -> None:
    wb = load_workbook(str(src), data_only=True)
    names = wb.sheetnames
    if sheet is None:
        if len(names) > 1:
            print(
                f"[doc-convert] 错误：{src.name} 有 {len(names)} 张工作表"
                f"（{'、'.join(names)}），请用 --sheet 指定要导出哪一张。",
                file=sys.stderr,
            )
            raise SystemExit(2)
        ws = wb[names[0]]
    else:
        if sheet not in names:
            print(
                f"[doc-convert] 错误：没有名为「{sheet}」的工作表。"
                f"可选：{'、'.join(names)}",
                file=sys.stderr,
            )
            raise SystemExit(2)
        ws = wb[sheet]

    dst.parent.mkdir(parents=True, exist_ok=True)
    # newline="" 是 csv 模块的硬要求，不写会在 Windows 上多出空行
    with dst.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        for row in ws.iter_rows(values_only=True):
            writer.writerow(["" if v is None else v for v in row])


def csv_to_xlsx(src: Path, dst: Path) -> None:
    wb = Workbook()
    ws = wb.active
    with src.open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            ws.append(row)
    dst.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(dst))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Excel 与 CSV 互转（方向按输入扩展名自动判定）")
    ap.add_argument("input", help="输入 .xlsx / .xlsm / .csv 文件")
    ap.add_argument("-o", "--output", required=True, help="输出文件")
    ap.add_argument("--sheet", default=None, help="仅 xlsx→csv：指定工作表名")
    args = ap.parse_args(argv)

    src = Path(args.input)
    if not src.is_file():
        print(f"[doc-convert] 错误：找不到输入文件 {src}", file=sys.stderr)
        raise SystemExit(2)

    suffix = src.suffix.lower()
    dst = Path(args.output)
    if suffix in _XLSX_SUFFIXES:
        xlsx_to_csv(src, dst, args.sheet)
    elif suffix in _CSV_SUFFIXES:
        csv_to_xlsx(src, dst)
    else:
        print(
            f"[doc-convert] 错误：只支持 .xlsx / .xlsm / .csv，收到的是 {suffix or '（无扩展名）'}",
            file=sys.stderr,
        )
        raise SystemExit(2)

    print(f"[doc-convert] 已生成 {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_excel_csv.py -v
```
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add skills/doc-convert/scripts/excel_csv.py skills/doc-convert/tests/test_excel_csv.py
git commit -m "feat(doc-convert): Excel 与 CSV 互转，写 CSV 带 BOM 防 Excel 乱码"
```

---

### Task 4: PDF 合并 / 拆分 / 删页 / 加水印

**Files:**
- Create: `skills/doc-convert/scripts/pdf_ops.py`
- Test: `skills/doc-convert/tests/test_pdf_ops.py`

**Interfaces:**
- Consumes: Task 1 的 `$DOC_CONVERT_PY`
- Produces: CLI 四个子命令 `merge` / `split` / `delete` / `watermark`；函数 `merge(inputs, dst)`、`split(src, out_dir, ranges=None)`、`delete(src, dst, pages)`、`watermark(src, dst, stamp_pdf)`。页码一律 **1 起、闭区间**

- [ ] **Step 1: 写失败的测试**

`skills/doc-convert/tests/test_pdf_ops.py`：

```python
"""pdf_ops 的行为契约。

页码全部按「人类习惯」：1 起、闭区间。这是唯一会被用户直接说出口的参数
（"删第 3 页"），如果内部 0 起而对外 1 起，转换层迟早错一页——所以对外
对内统一 1 起，只在调 pypdf 时减 1。
"""
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import pdf_ops  # noqa: E402


def _make_pdf(path: Path, pages: int) -> None:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    with path.open("wb") as f:
        w.write(f)


def test_merge_concatenates_in_order(tmp_path):
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    _make_pdf(a, 2)
    _make_pdf(b, 3)
    dst = tmp_path / "out.pdf"

    pdf_ops.merge([a, b], dst)

    assert len(PdfReader(str(dst)).pages) == 5


def test_split_one_file_per_page(tmp_path):
    src = tmp_path / "s.pdf"
    _make_pdf(src, 3)
    out_dir = tmp_path / "parts"

    written = pdf_ops.split(src, out_dir)

    assert len(written) == 3
    assert sorted(p.name for p in written) == ["s_01.pdf", "s_02.pdf", "s_03.pdf"]
    assert all(len(PdfReader(str(p)).pages) == 1 for p in written)


def test_split_by_ranges(tmp_path):
    src = tmp_path / "s.pdf"
    _make_pdf(src, 5)
    out_dir = tmp_path / "parts"

    written = pdf_ops.split(src, out_dir, ranges="1-2,4-5")

    assert len(written) == 2
    assert len(PdfReader(str(written[0])).pages) == 2
    assert len(PdfReader(str(written[1])).pages) == 2


def test_delete_pages_is_one_based(tmp_path):
    src = tmp_path / "d.pdf"
    _make_pdf(src, 4)
    dst = tmp_path / "d-out.pdf"

    pdf_ops.delete(src, dst, "2,4")

    assert len(PdfReader(str(dst)).pages) == 2


def test_out_of_range_page_exits_with_message(tmp_path, capsys):
    src = tmp_path / "e.pdf"
    _make_pdf(src, 2)
    with pytest.raises(SystemExit):
        pdf_ops.delete(src, tmp_path / "e-out.pdf", "5")
    assert "超出范围" in capsys.readouterr().err


def test_watermark_keeps_page_count(tmp_path):
    src = tmp_path / "w.pdf"
    _make_pdf(src, 3)
    stamp = tmp_path / "stamp.pdf"
    _make_pdf(stamp, 1)
    dst = tmp_path / "w-out.pdf"

    pdf_ops.watermark(src, dst, stamp)

    assert len(PdfReader(str(dst)).pages) == 3
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_pdf_ops.py -v
```
Expected: FAIL，`ModuleNotFoundError: No module named 'pdf_ops'`

- [ ] **Step 3: 写实现**

`skills/doc-convert/scripts/pdf_ops.py`：

```python
#!/usr/bin/env python3
"""PDF 页级操作：合并 / 拆分 / 删页 / 加水印。

**页码一律 1 起、闭区间**，对内对外一致，只在调 pypdf 时减 1。理由：这是
唯一会被用户直接说出口的参数（"把第 3 页删掉"），内外不一致的话，中间任何
一层忘了换算就错一页，而且错得很安静——PDF 少一页没人会立刻发现。

拆分默认「一页一个文件」；给了 --ranges 就按区间切。两种模式共用一个子命令
而不是拆两个，是因为用户嘴里说的都是"拆开"，区别只是"怎么拆"。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter


def _parse_pages(spec: str, total: int) -> list[int]:
    """把 "1,3-5" 解析成 1 起的页码列表，去重并排序。越界即报错退出。"""
    pages: set[int] = set()
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            a, _, b = chunk.partition("-")
            try:
                start, end = int(a), int(b)
            except ValueError:
                print(f"[doc-convert] 错误：看不懂页码区间「{chunk}」", file=sys.stderr)
                raise SystemExit(2)
            if start > end:
                start, end = end, start
            pages.update(range(start, end + 1))
        else:
            try:
                pages.add(int(chunk))
            except ValueError:
                print(f"[doc-convert] 错误：看不懂页码「{chunk}」", file=sys.stderr)
                raise SystemExit(2)

    bad = [p for p in sorted(pages) if p < 1 or p > total]
    if bad:
        print(
            f"[doc-convert] 错误：页码 {bad} 超出范围，该文件共 {total} 页。",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return sorted(pages)


def _write(writer: PdfWriter, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("wb") as f:
        writer.write(f)


def merge(inputs: list[Path], dst: Path) -> None:
    writer = PdfWriter()
    for path in inputs:
        if not path.is_file():
            print(f"[doc-convert] 错误：找不到 {path}", file=sys.stderr)
            raise SystemExit(2)
        for page in PdfReader(str(path)).pages:
            writer.add_page(page)
    _write(writer, dst)


def split(src: Path, out_dir: Path, ranges: str | None = None) -> list[Path]:
    reader = PdfReader(str(src))
    total = len(reader.pages)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    if ranges is None:
        # 一页一个文件。序号补零到两位，保证文件管理器里按名排序＝按页排序
        # （不补零时 s_10.pdf 会排在 s_2.pdf 前面）。
        width = max(2, len(str(total)))
        for i in range(total):
            writer = PdfWriter()
            writer.add_page(reader.pages[i])
            dst = out_dir / f"{src.stem}_{str(i + 1).zfill(width)}.pdf"
            _write(writer, dst)
            written.append(dst)
        return written

    for idx, chunk in enumerate(ranges.split(","), start=1):
        pages = _parse_pages(chunk, total)
        writer = PdfWriter()
        for p in pages:
            writer.add_page(reader.pages[p - 1])
        dst = out_dir / f"{src.stem}_part{idx}.pdf"
        _write(writer, dst)
        written.append(dst)
    return written


def delete(src: Path, dst: Path, pages_spec: str) -> None:
    reader = PdfReader(str(src))
    total = len(reader.pages)
    drop = set(_parse_pages(pages_spec, total))
    writer = PdfWriter()
    for i in range(total):
        if i + 1 not in drop:
            writer.add_page(reader.pages[i])
    if not writer.pages:
        print("[doc-convert] 错误：删完就一页不剩了，拒绝生成空 PDF。", file=sys.stderr)
        raise SystemExit(2)
    _write(writer, dst)


def watermark(src: Path, dst: Path, stamp_pdf: Path) -> None:
    """把 stamp_pdf 的第一页叠加到 src 每一页上。

    水印用「另一份 PDF 的第一页」而不是让脚本自己画文字：画文字要处理中文
    字体、字号、旋转、透明度，是一整套排版活；而用户/模型完全可以先用别的
    方式做出一张水印页再叠上来，职责更干净。
    """
    stamp = PdfReader(str(stamp_pdf)).pages[0]
    reader = PdfReader(str(src))
    writer = PdfWriter()
    for page in reader.pages:
        page.merge_page(stamp)
        writer.add_page(page)
    _write(writer, dst)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="PDF 合并 / 拆分 / 删页 / 加水印")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("merge", help="按给定顺序合并多个 PDF")
    p.add_argument("inputs", nargs="+")
    p.add_argument("-o", "--output", required=True)

    p = sub.add_parser("split", help="拆分 PDF（默认一页一个文件）")
    p.add_argument("input")
    p.add_argument("-d", "--out-dir", required=True)
    p.add_argument("--ranges", default=None, help='如 "1-2,4-5"，每个区间一个文件')

    p = sub.add_parser("delete", help="删除指定页")
    p.add_argument("input")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--pages", required=True, help='如 "2,4-6"，页码 1 起')

    p = sub.add_parser("watermark", help="把一张水印页叠到每一页上")
    p.add_argument("input")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--stamp", required=True, help="水印 PDF（取其第一页）")

    args = ap.parse_args(argv)

    if args.cmd == "merge":
        merge([Path(x) for x in args.inputs], Path(args.output))
        print(f"[doc-convert] 已生成 {args.output}")
    elif args.cmd == "split":
        written = split(Path(args.input), Path(args.out_dir), args.ranges)
        print(f"[doc-convert] 已生成 {len(written)} 个文件于 {args.out_dir}")
    elif args.cmd == "delete":
        delete(Path(args.input), Path(args.output), args.pages)
        print(f"[doc-convert] 已生成 {args.output}")
    elif args.cmd == "watermark":
        watermark(Path(args.input), Path(args.output), Path(args.stamp))
        print(f"[doc-convert] 已生成 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_pdf_ops.py -v
```
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add skills/doc-convert/scripts/pdf_ops.py skills/doc-convert/tests/test_pdf_ops.py
git commit -m "feat(doc-convert): PDF 合并/拆分/删页/加水印，页码统一 1 起闭区间"
```

> **2026-08-10 执行期修订（本任务评审后）**：上面的代码经评审发现 4 处缺陷，
> **均源自本计划给出的原始代码而非转写失误**，人类伙伴裁决全部修复。因此
> `pdf_ops.py` 的最终形态比上面多三处护栏、测试多三条：
> ① `watermark` 遇 0 页水印源、② 四个函数遇加密 PDF、③ `merge([])` 空输入——
> 三者原本都抛裸 Python 异常或静默产出空 PDF 并报"已生成"，现统一转成
> `[doc-convert] 错误：…` + 非零退出（与文件里其它错误分支同风格）；
> ④ `test_delete_pages_is_one_based` 原用等大空白页，只能证明「删对了页数」
> 不能证明「删对了页」，已改为每页尺寸不同后断言剩余页宽度。
> **以 git 里的实际代码为准**，上面的代码块是修订前的原始计划。
>
> 为什么值得修：①②③ 同属「崩溃时给出的是程序员看的堆栈，而不是能转达给
> 用户的话」，与 Task 6 SKILL.md 里「不要吞掉脚本的报错，原样转达给用户」
> 的纪律直接打架——一段 Python 堆栈转达给用户等于没转达。

---

### Task 5: Word → PDF（LibreOffice 优先 + 纯文字兜底门禁）

**Files:**
- Create: `skills/doc-convert/scripts/docx_to_pdf.py`
- Test: `skills/doc-convert/tests/test_docx_to_pdf.py`

**Interfaces:**
- Consumes: Task 1 的 `$DOC_CONVERT_PY`
- Produces: `docx_to_pdf.find_soffice() -> str | None`、`docx_to_pdf.find_cjk_font() -> Path | None`、`docx_to_pdf.convert(src, dst, allow_textonly=False) -> str`（返回 `"soffice"` 或 `"textonly"`）；CLI `python docx_to_pdf.py <input.docx> -o <output.pdf> [--allow-textonly]`

**这个任务的核心不是转换，是那道门禁。** 没装 LibreOffice 时脚本**必须拒绝**默认输出，逼调用方显式传 `--allow-textonly`。理由：纯文字版 PDF 丢掉表格、图片、全部排版，用户拿去投标才发现，比"转不了"更糟。把告知做成一个必须显式打开的开关，而不是一行提示文字——提示会被模型和用户一起忽略，开关不会。

- [ ] **Step 1: 写失败的测试**

`skills/doc-convert/tests/test_docx_to_pdf.py`：

```python
"""docx_to_pdf 的行为契约。

重点全在「没装 LibreOffice 时会发生什么」——那是绝大多数用户的处境。
"""
import sys
from pathlib import Path

import pytest
from docx import Document
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import docx_to_pdf  # noqa: E402


def _make_docx(path: Path) -> None:
    doc = Document()
    doc.add_heading("季度汇报", level=1)
    doc.add_paragraph("这是一段中文正文，用来验证字体没有变成方块。")
    doc.save(str(path))


def test_refuses_textonly_without_explicit_flag(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: None)
    src = tmp_path / "a.docx"
    _make_docx(src)

    with pytest.raises(SystemExit) as e:
        docx_to_pdf.convert(src, tmp_path / "a.pdf", allow_textonly=False)

    assert e.value.code != 0
    err = capsys.readouterr().err
    # 报错必须同时说清：为什么不能转、装什么能解决、怎么强行继续
    assert "LibreOffice" in err
    assert "--allow-textonly" in err
    assert "排版" in err


def test_textonly_path_produces_pdf_when_allowed(tmp_path, monkeypatch):
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: None)
    src = tmp_path / "b.docx"
    _make_docx(src)
    dst = tmp_path / "b.pdf"

    mode = docx_to_pdf.convert(src, dst, allow_textonly=True)

    assert mode == "textonly"
    assert dst.is_file()
    assert len(PdfReader(str(dst)).pages) >= 1


def test_textonly_refuses_when_no_cjk_font(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: None)
    monkeypatch.setattr(docx_to_pdf, "find_cjk_font", lambda: None)
    src = tmp_path / "c.docx"
    _make_docx(src)

    with pytest.raises(SystemExit):
        docx_to_pdf.convert(src, tmp_path / "c.pdf", allow_textonly=True)

    # 没有中文字体时输出的是满纸方块，不如不给
    assert "中文字体" in capsys.readouterr().err


def test_find_cjk_font_returns_existing_file_or_none():
    font = docx_to_pdf.find_cjk_font()
    assert font is None or font.is_file()
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_docx_to_pdf.py -v
```
Expected: FAIL，`ModuleNotFoundError: No module named 'docx_to_pdf'`

- [ ] **Step 3: 写实现**

`skills/doc-convert/scripts/docx_to_pdf.py`：

```python
#!/usr/bin/env python3
"""Word（.docx）→ PDF。

**这条路没有"又快又准"的纯 Python 方案**，所以是两条路 + 一道门禁：

  路 1（首选）：本机装了 LibreOffice → 调它无头转换，保真度等同本机另存为。
  路 2（兜底）：没装 → 用 reportlab 重排成**纯文字 PDF**，表格 / 图片 /
                样式 / 分栏 全部丢失。

门禁：路 2 必须由调用方显式传 --allow-textonly 才走，否则直接报错退出。
为什么做成开关而不是"转完加一行提示"——提示会被模型和用户一起略过，
用户拿着丢了表格的标书去投标，发现时已经晚了。降级本身可以接受，
**不知情的降级不行**。

中文字体：reportlab 默认字体没有 CJK 字形，不注册字体的话中文全是方块。
所以兜底路会去系统字体目录找一个可用的中文字体；一个都找不到就同样拒绝
输出——满纸方块的 PDF 比没有 PDF 更糟。
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from docx import Document
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

# 候选中文字体，按「几乎一定存在」排在前面。.ttc 是字体集合，reportlab 需要
# subfontIndex 指定取其中第几个；.ttf 直接用。
_CJK_FONT_CANDIDATES: list[tuple[str, int]] = [
    # macOS
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
    ("/System/Library/Fonts/PingFang.ttc", 0),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    # Windows
    ("C:/Windows/Fonts/msyh.ttc", 0),
    ("C:/Windows/Fonts/simsun.ttc", 0),
    # Linux
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
]

_FONT_NAME = "DocConvertCJK"


def find_soffice() -> str | None:
    """找 LibreOffice 的无头可执行文件；没有返回 None。"""
    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    # macOS 装了 LibreOffice.app 但没把 soffice 加进 PATH 是常态
    mac_default = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    if Path(mac_default).is_file():
        return mac_default
    return None


def find_cjk_font() -> Path | None:
    """找一个能显示中文的字体文件；没有返回 None。"""
    for path, _idx in _CJK_FONT_CANDIDATES:
        p = Path(path)
        if p.is_file():
            return p
    return None


def _convert_with_soffice(soffice: str, src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    # soffice 只认「输出目录」，文件名由它按输入名决定，转完再改名到 dst
    subprocess.run(
        [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(dst.parent), str(src)],
        check=True,
        capture_output=True,
        timeout=300,
    )
    produced = dst.parent / (src.stem + ".pdf")
    if produced != dst:
        produced.replace(dst)


def _convert_textonly(src: Path, dst: Path) -> None:
    font_path = find_cjk_font()
    if font_path is None:
        print(
            "[doc-convert] 错误：本机找不到任何中文字体，纯文字兜底会输出满纸方块，"
            "已拒绝生成。请安装 LibreOffice（免费）后重试。",
            file=sys.stderr,
        )
        raise SystemExit(3)

    idx = next(i for p, i in _CJK_FONT_CANDIDATES if Path(p) == font_path)
    if font_path.suffix.lower() == ".ttc":
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path), subfontIndex=idx))
    else:
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path)))

    base = getSampleStyleSheet()
    body = ParagraphStyle(
        "Body", parent=base["Normal"], fontName=_FONT_NAME, fontSize=11, leading=18
    )
    head = ParagraphStyle(
        "Head", parent=base["Heading1"], fontName=_FONT_NAME, fontSize=16, leading=22
    )

    flow = []
    for para in Document(str(src)).paragraphs:
        text = para.text.strip()
        if not text:
            flow.append(Spacer(1, 6))
            continue
        style = head if para.style.name.startswith("Heading") else body
        # reportlab 的 Paragraph 会解析类 HTML 标记，正文里的 & < > 必须转义
        safe = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        flow.append(Paragraph(safe, style))
        flow.append(Spacer(1, 4))

    if not flow:
        print("[doc-convert] 错误：文档里没有可提取的文字。", file=sys.stderr)
        raise SystemExit(3)

    dst.parent.mkdir(parents=True, exist_ok=True)
    SimpleDocTemplate(
        str(dst), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=20 * mm, bottomMargin=20 * mm,
    ).build(flow)


def convert(src: Path, dst: Path, allow_textonly: bool = False) -> str:
    """转换并返回走的是哪条路：`"soffice"` 或 `"textonly"`。"""
    soffice = find_soffice()
    if soffice:
        _convert_with_soffice(soffice, src, dst)
        return "soffice"

    if not allow_textonly:
        print(
            "[doc-convert] 错误：本机没有 LibreOffice，无法保留原排版转换。\n"
            "  · 想保留排版：安装 LibreOffice（免费，https://www.libreoffice.org/），装完重试。\n"
            "  · 只要文字也行：重跑时加 --allow-textonly，将输出纯文字版 PDF，"
            "表格、图片和全部排版都会丢失。",
            file=sys.stderr,
        )
        raise SystemExit(4)

    _convert_textonly(src, dst)
    return "textonly"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Word 转 PDF")
    ap.add_argument("input", help="输入 .docx 文件")
    ap.add_argument("-o", "--output", required=True, help="输出 .pdf 文件")
    ap.add_argument(
        "--allow-textonly",
        action="store_true",
        help="没有 LibreOffice 时允许输出纯文字版 PDF（会丢失表格/图片/排版）",
    )
    args = ap.parse_args(argv)

    src = Path(args.input)
    if not src.is_file():
        print(f"[doc-convert] 错误：找不到输入文件 {src}", file=sys.stderr)
        raise SystemExit(2)

    mode = convert(src, Path(args.output), args.allow_textonly)
    if mode == "textonly":
        print(
            f"[doc-convert] 已生成 {args.output}（纯文字版：表格、图片与排版已丢失）"
        )
    else:
        print(f"[doc-convert] 已生成 {args.output}（保留原排版）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_docx_to_pdf.py -v
```
Expected: 4 passed

- [ ] **Step 5: 跑一次全量 Python 测试**

Run:
```bash
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/ -v
```
Expected: 18 passed（4 + 4 + 6 + 4）

- [ ] **Step 6: 提交**

```bash
git add skills/doc-convert/scripts/docx_to_pdf.py skills/doc-convert/tests/test_docx_to_pdf.py
git commit -m "feat(doc-convert): Word 转 PDF，LibreOffice 优先，纯文字兜底须显式开启"
```

---

### Task 6: SKILL.md（模型调度说明）

**Files:**
- Create: `skills/doc-convert/SKILL.md`

**Interfaces:**
- Consumes: Task 1~5 的全部脚本与 `$DOC_CONVERT_PY`
- Produces: 无代码接口。这是模型读的调度文档，决定它拿到用户需求后调哪个脚本、传什么参数

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: doc-convert
description: "Use this skill when a user requests to convert between document formats — Markdown to Word, Word to PDF, Excel to/from CSV, or PDF page operations (merge, split, delete pages, watermark). 文档处理：格式转换、PDF 页面操作。"
---

# 文档处理（Document Convert）

用户丢进一份文件、想要另一种格式时用这个技能。当前覆盖四类**确定性转换**——
每一类都有专用脚本，**一律调脚本，不要自己现写 Python**。脚本里已经处理了
中文编码、页码换算、字体缺失等一堆坑，现写必然踩回去。

## 运行环境（先读这一段）

所有 Python 工作走本技能专属 venv。每个会话开始时引导一次：

```bash
# macOS / Linux —— 必须用 `source`（脚本要把 $DOC_CONVERT_PY 导回你的 shell）
source ${SKILL_DIR}/bin/ensure-python.sh
"$DOC_CONVERT_PY" -c "import pypdf, docx, openpyxl; print('ok')"
```

> **Windows**：改跑 `${SKILL_DIR}\bin\ensure-python.cmd`，它末行打印
> `DOC_CONVERT_PY=<path>`，后续所有 python 命令用那个路径。

- 首次运行要下载依赖（约几分钟），之后靠哨兵文件秒过。**开始前告诉用户这次要等**。
- skill 目录在打包后的 app 里是**只读**的。永远不要往 `${SKILL_DIR}` 里写东西，
  也不要往自带 runtime 里 pip install。所有产物写到会话工作目录。

## 四条能力与对应脚本

### 1. Markdown → Word

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/md_to_docx.py 输入.md -o 输出.docx
```

支持 Markdown 常用子集（标题 / 段落 / 有序无序列表 / 粗斜体 / 行内代码 /
围栏代码块 / 分隔线）。**不支持表格、引用块、图片、链接语法**——遇到这些，
先把它们改写成受支持的形式再转，不要指望脚本处理。

### 2. Word → PDF

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/docx_to_pdf.py 输入.docx -o 输出.pdf
```

⛔ **这条有一道必须遵守的门禁。** 本机装了 LibreOffice 才能保留排版；没装时
脚本会**报错退出**，而不是悄悄降级。

收到这个报错时：**先把情况告诉用户，让他选，不要自作主张加 `--allow-textonly`。**
原话大意——

> 你电脑上没装 LibreOffice，我没法保留原来的排版。两个选择：
> ① 装一下 LibreOffice（免费）再转，排版能保住；
> ② 我直接转成纯文字版 PDF，但**表格、图片和所有排版都会丢**。
> 你要哪个？

用户明确选了②，才加 `--allow-textonly` 重跑。
用户没回答之前不要转。理由：纯文字版 PDF 看起来是个正常 PDF，用户很可能直接
拿去用（发客户、投标），发现丢了表格时已经晚了。

### 3. Excel ↔ CSV

```bash
# 方向按输入扩展名自动判定
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/excel_csv.py 输入.xlsx -o 输出.csv
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/excel_csv.py 输入.csv  -o 输出.xlsx
```

源文件有**多张工作表**时脚本会报错并列出表名，要求指定 `--sheet 表名`。
这时问用户要哪一张，或者按他的需求循环导出多次——**不要随便挑第一张**，
那等于让用户丢数据还不知道。

导出的 CSV 带 UTF-8 BOM，Excel 双击打开中文不乱码。这是刻意的，别去掉。

### 4. PDF 页面操作

```bash
# 合并（按给定顺序）
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py merge a.pdf b.pdf -o 合并.pdf

# 拆分：一页一个文件
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py split 输入.pdf -d 输出目录/

# 拆分：按区间，每个区间一个文件
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py split 输入.pdf -d 输出目录/ --ranges "1-3,4-8"

# 删页
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py delete 输入.pdf -o 输出.pdf --pages "2,5-7"

# 加水印（水印是另一份 PDF 的第一页）
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py watermark 输入.pdf -o 输出.pdf --stamp 水印.pdf
```

**页码一律 1 起、闭区间**，和用户嘴里说的一致（"删第 3 页"就是 `--pages 3`）。
越界会报错并告诉你总页数，不会静默截断。

## 通用纪律

- **产物路径**：默认写到会话工作目录，文件名用中文描述性名字（`季度汇报.pdf`
  好过 `output.pdf`），转完把完整路径告诉用户。
- **不要吞掉脚本的报错**。上面每个脚本的错误信息都写得很具体（缺什么、
  装什么能解决、怎么强行继续），原样转达给用户比你重新组织语言有用。
- **超出这四条的需求**（PDF 转 Word、图片提取文字、PDF 表格转 Excel……）
  不属于本技能当前范围，如实告诉用户做不了，不要用现写脚本硬凑。
```

- [ ] **Step 2: 验证技能能被 CLI 发现**

Run:
```bash
head -4 skills/doc-convert/SKILL.md
ls skills/doc-convert/
```
Expected: frontmatter 里 `name: doc-convert`；目录含 `SKILL.md bin requirements.txt requirements-dev.txt scripts tests .gitignore`

- [ ] **Step 3: 提交**

```bash
git add skills/doc-convert/SKILL.md
git commit -m "docs(doc-convert): SKILL.md 调度说明，Word 转 PDF 降级须先问用户"
```

---

### Task 7: 前端接入（图标 + chip 注册 + 场景目录）

**Files:**
- Create: `apps/studio/public/skill-icons/doc-convert.png`
- Modify: `apps/studio/src/chat/composer/skillChipRegistry.ts:174`（tender 两条之后）
- Modify: `apps/studio/src/chat/lib/scenarioCatalogDefaults.ts`
- Modify: `apps/studio/src/chat/lib/scenarioCatalogDefaults.test.ts`

**Interfaces:**
- Consumes: Task 6 的技能命令 `/claude-desktop:doc-convert`
- Produces: `DOC_CONVERT_PROMPTS: readonly ScenarioCatalogPrompt[]`（导出仅供本文件内使用，与既有 `TENDER_PROMPTS` 等同构）

- [ ] **Step 1: 产出图标**

**256×256** 透明底 PNG（RGBA），风格对齐现有切片（参考 `apps/studio/public/skill-icons/tender.png`，扁平多彩、圆角、无描边）。语义：文档 + 转换箭头。

> **2026-08-10 更正**：此处原写 128×128，是写计划时只核对了文件体积没核对分辨率。
> 实测 `skill-icons/` 下 11 张现有切片**全部是 256×256 RGBA**，新图标必须对齐。

可以用 `draw` 技能生成，或用设计工具切图。放到 `apps/studio/public/skill-icons/doc-convert.png`。

> **不要临时复用现成切片凑数**（比如借 `sheet.png`）——两个技能同图标在 rail 里并排出现时，用户分不清点哪个，而这种"回头再换"的临时方案历史上从没被换回来过。

Run 验证：
```bash
file apps/studio/public/skill-icons/doc-convert.png
```
Expected: `PNG image data, 256 x 256, 8-bit/color RGBA`——**RGBA 也要确认**，
丢了 alpha 通道会变成白底方块，深色主题下很难看。

- [ ] **Step 2: 注册 chip（两条）**

在 `skillChipRegistry.ts` 的 `/tender-review` 那条之后（`:174`）插入：

```ts
  // doc-convert — 文档处理。namespaced + 裸名双注册，理由同 ppt-creator：
  // 技能命令有时带命名空间前缀有时不带，只注册一份会让另一种写法退化成
  // 光秃秃的英文命令（无中文标签、无图标）。
  {
    match: '/claude-desktop:doc-convert',
    image: '/skill-icons/doc-convert.png',
    label: '文档处理',
    description: '格式转换、提取文字、批量整理'
  },
  {
    match: '/doc-convert',
    image: '/skill-icons/doc-convert.png',
    label: '文档处理',
    description: '格式转换、提取文字、批量整理'
  },
```

- [ ] **Step 3: 写 4 条话术并挂进 daily 分类**

在 `scenarioCatalogDefaults.ts` 里，`TENDER_PROMPTS` 之后新增：

```ts
const DOC_CONVERT_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    // 「【Markdown 文件】」命中 filePlaceholderPlugin 的 markdown 规则
    // → picker 限定 .md/.markdown。
    label: 'Markdown 转 Word',
    text: '把【Markdown 文件】转成 Word 文档，标题层级、列表和加粗都保留。'
  },
  {
    // 「【Word 文件】」命中 word 规则 → .doc/.docx。文案刻意提一句排版，
    // 因为这条在没装 LibreOffice 的机器上会走「先问用户」的门禁分支
    // （见 SKILL.md §2），提前把预期立在这里。
    label: 'Word 转 PDF',
    text: '把【Word 文件】转成 PDF，尽量保留原排版。'
  },
  {
    // 「【Excel 文件】」命中 excel 规则 → .xls/.xlsx/.csv，双向都能选。
    label: 'Excel 与 CSV 互转',
    text: '把【Excel 文件】转成另一种格式（xlsx 转 csv 或 csv 转 xlsx），中文不要乱码。'
  },
  {
    // 合并/拆分共用一条入口：用户嘴里说的都是「拆开/合起来」，
    // 具体怎么拆由对话里问清楚，不在这里拆成两个按钮稀释列表。
    label: 'PDF 合并拆分',
    text: '帮我处理【PDF 文件】：【说明要做什么，例如和另一份合并、按章节拆成多个文件、删掉第 2 和第 5 页、加个水印】。'
  }
]
```

然后在 `DEFAULT_SCENARIO_CATALOG` 的 `daily` 分类里，**spreadsheets 之后、proposal-writer 之前**插入：

```ts
        {
          kind: 'skill',
          value: '/claude-desktop:doc-convert',
          prompts: DOC_CONVERT_PROMPTS
        },
```

- [ ] **Step 4: 补 TS 测试**

在 `scenarioCatalogDefaults.test.ts` 末尾追加：

```ts
const DOC_CONVERT_VALUE = '/claude-desktop:doc-convert'

describe('内置场景目录 · 文档处理', () => {
  it('日常办公分类里有文档处理，且紧跟在处理表格之后', () => {
    const daily = DEFAULT_SCENARIO_CATALOG.categories.find((c) => c.id === 'daily')
    expect(daily).toBeDefined()
    const values = daily!.items.map((i) => i.value)
    const sheetsIdx = values.indexOf('/claude-desktop:spreadsheets')
    const docIdx = values.indexOf(DOC_CONVERT_VALUE)
    expect(sheetsIdx).toBeGreaterThanOrEqual(0)
    // 两者同属「处理已有文件」，摆放顺序即产品叙事
    expect(docIdx).toBe(sheetsIdx + 1)
  })

  it('PR1 首版恰好 4 条话术（B 类纯脚本），A 类 4 条属 PR2', () => {
    const item = allSkillItems().find((i) => i.value === DOC_CONVERT_VALUE)
    expect(item?.prompts?.length).toBe(4)
  })

  it('每条话术的文件槽都能选到它真正需要的格式', () => {
    // 槽关键词写错时 picker 会把正确格式置灰，用户以为功能坏了。
    // 这条断言把「关键词 → 格式」的映射钉死在测试里。
    expect(acceptForPlaceholder('Markdown 文件')).toContain('.md')
    expect(acceptForPlaceholder('Word 文件')).toContain('.docx')
    expect(acceptForPlaceholder('Excel 文件')).toContain('.csv')
    expect(acceptForPlaceholder('PDF 文件')).toContain('.pdf')
  })
})
```

> 已存在的「内置目录里每个技能条目都能查到 chip 外观 · 无一遗漏」那条测试会自动
> 覆盖新条目——Step 2 的 chip 注册漏了的话，它会当场失败。不用再写一条。

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
cd apps/studio && bun test src/chat/lib/scenarioCatalogDefaults.test.ts
```
Expected: 全部 passed（含既有的审标书用例）

- [ ] **Step 6: 跑类型检查**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```
Expected: 通过（daemon 侧长期存在的 2 个已知报错除外——它们与本改动无关，出现即忽略；除此之外任何报错都必须修掉）

- [ ] **Step 7: 提交**

```bash
git add apps/studio/public/skill-icons/doc-convert.png apps/studio/src/chat/composer/skillChipRegistry.ts apps/studio/src/chat/lib/scenarioCatalogDefaults.ts apps/studio/src/chat/lib/scenarioCatalogDefaults.test.ts
git commit -m "feat(doc-convert): 场景卡接入，日常办公新增文档处理入口"
```

---

### Task 8: 真机走查与收口

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md`（若走查发现与设计不符处）

**Interfaces:**
- Consumes: Task 1~7 全部产出
- Produces: 一份可合并的 PR

- [ ] **Step 1: 全量自动化验证**

Run:
```bash
cd apps/studio && bun test
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
source skills/doc-convert/bin/ensure-python.sh && "$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/ -q
```
Expected: 三条全绿（typecheck 除 daemon 侧 2 个已知报错）

- [ ] **Step 2: 起应用**

Run:
```bash
bun run dev
```

- [ ] **Step 3: 逐项走查（照着勾，别凭印象）**

在空态侧栏「日常办公」下确认：

- [ ] 「文档处理」卡片出现，位置在「处理表格」之后
- [ ] 图标正常显示，不是通用占位图标
- [ ] 点开后有 4 条话术
- [ ] 点「Markdown 转 Word」→ composer 里出现文件槽 → 点槽 → 选择器**只让选** .md/.markdown
- [ ] 点「Word 转 PDF」→ 选择器只让选 .doc/.docx
- [ ] 点「Excel 与 CSV 互转」→ 选择器能选 .xlsx **和** .csv
- [ ] 点「PDF 合并拆分」→ 选择器只让选 .pdf

- [ ] **Step 4: 端到端跑一次真转换**

准备一份含中文标题和列表的 `.md`，走「Markdown 转 Word」全流程发送，确认：

- [ ] 首次运行时界面上能看到依赖安装的进度/说明，不是无提示干等
- [ ] 转换成功，产物路径被告知
- [ ] 打开 .docx，中文正常、标题是标题样式、列表是列表

- [ ] **Step 5: 验证 Word→PDF 的门禁真的会挡**

本机若已装 LibreOffice，先临时让脚本找不到它再测：

```bash
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" - <<'PY'
import sys; sys.path.insert(0, "skills/doc-convert/scripts")
import docx_to_pdf
from pathlib import Path
from docx import Document
d = Document(); d.add_paragraph("测试"); d.save("/tmp/dc-test.docx")
docx_to_pdf.find_soffice = lambda: None
try:
    docx_to_pdf.convert(Path("/tmp/dc-test.docx"), Path("/tmp/dc-test.pdf"))
except SystemExit as e:
    print("门禁生效，退出码", e.code)
PY
```
Expected: 打印「门禁生效，退出码 4」，且 `/tmp/dc-test.pdf` **不存在**

- [ ] **Step 5b: 验证 LibreOffice 保真路径真的能转（Task 5 评审补充）**

Task 5 的 4 条自动化测试全部把 `find_soffice` mock 成 `None`——只测了兜底路径，
**保真路径一行测试都没覆盖**。不给它写自动化测试是刻意的：真调 LibreOffice 会让
测试依赖本机装没装它，换台机器就飘。所以这一条放在真机走查里手工验一次。

本机已装 LibreOffice。准备一份**含表格和中文标题**的 `.docx`（表格是关键——
它正是纯文字兜底会丢掉、而保真路径应该保住的东西），然后：

```bash
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" skills/doc-convert/scripts/docx_to_pdf.py <你的.docx> -o /tmp/dc-real.pdf
```

- [ ] 输出末行是「（保留原排版）」而不是「（纯文字版…）」
- [ ] 打开 `/tmp/dc-real.pdf`，**表格还在**、中文不是方块、排版与 Word 里看到的一致
- [ ] 产物落在 `-o` 指定的路径上（验证 soffice 产物改名逻辑：soffice 只认输出目录、
      文件名按输入名生成，脚本要把它改名到目标路径）

- [ ] **Step 6: 确认没有运行时产物混进技能目录**

Run:
```bash
git status --porcelain skills/doc-convert
ls -a skills/doc-convert
```
Expected: 无未跟踪的 `workspace/`、`__pycache__/`、`venv/`（`.gitignore` 应已挡住；真出现了说明 Task 1 Step 5 写漏了）

- [ ] **Step 7: 开 PR**

```bash
git push -u origin feat/doc-convert-skill
gh pr create --title "feat(doc-convert): 文档处理技能 PR1 —— B 类纯脚本转换 4 条" --body "$(cat <<'EOF'
## 做了什么

在「智能助手 · 日常办公」下新增第 5 个技能「文档处理」，首版交付 4 条
**确定性转换**（不经模型判断，直接跑脚本）：

- Markdown → Word
- Word → PDF（LibreOffice 优先，纯文字兜底须显式开启）
- Excel ↔ CSV（导出带 BOM，Excel 打开中文不乱码）
- PDF 合并 / 拆分 / 删页 / 加水印（页码 1 起闭区间）

A 类 4 条（OCR 提字、PDF 表格转 Excel、票据转台账、长文档提炼）走模型，
属 PR 2，不在本 PR 范围。

设计文档：`docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md`
实施计划：`docs/superpowers/plans/2026-08-10-doc-convert-skill-pr1.md`

## 三个值得单独看的决定

1. **Word→PDF 没装 LibreOffice 时脚本拒绝输出**，必须显式传
   `--allow-textonly` 才降级成纯文字版。降级可以接受，不知情的降级不行——
   用户拿着丢了表格的标书去投标，发现时已经晚了。
2. **不装 pandas**。唯一用得上它的 Excel↔CSV 用内置 csv + openpyxl 就够，
   pandas+numpy 约 84 MB，比其余依赖总和还大。
3. **engine.ts 的 `DOC_CONVERT_PYTHON_HOME` 改了两处**（bundled + system
   两个后端分支）。漏一处不报错，而是在那个后端下静默降级到系统 python，
   3.14 上 pip 会退化源码编译卡死。

## 体积影响

- 安装包：+约 0.2 MB（技能目录是纯文本，Python 库不打包）
- 用户硬盘：首次使用后 +约 XX MB（venv，实测值见设计文档）

## 验证

- `bun test`（apps/studio）全绿，新增 3 条场景目录断言
- `bun run typecheck` 通过（daemon 侧 2 个已知报错与本改动无关）
- `pytest skills/doc-convert/tests/` 18 passed
- 真机走查：4 条话术的文件槽格式限制逐条确认；Markdown→Word 端到端跑通；
  Word→PDF 门禁验证会挡

## 合并后待办（不在本 PR）

⚠️ **代码合了功能还没上线**：已登录用户看到的场景卡来自后台下发的配置，
不是代码里的默认表。需要在生产管理台 `/admin/scenario-catalog` 手动加这张卡
（**先读线上现有配置再在其上追加**，保存是整份覆盖；图标走文件上传）。
步骤照 `docs/tender-review-scenario-card-deploy.md`。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

> PR 描述里的 `+约 XX MB` 记得替换成 Task 1 Step 10 的实测值。

---

## 合并之后（不属于本计划的任务，但别忘）

1. **生产管理台加场景卡**——照 `docs/tender-review-scenario-card-deploy.md` 走。
   不做这一步，**已登录用户（即真实用户）看不到新功能**。
2. **PR 2 的计划另写**——A 类 4 条走模型，提示词要反复调，验收方式与本计划完全不同。
