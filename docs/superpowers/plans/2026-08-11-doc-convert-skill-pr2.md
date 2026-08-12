# 文档处理技能 PR 2 实施计划 —— A 类 4 条走模型的能力

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `skills/doc-convert` 补上「图片提取文字 / PDF 表格转 Excel / 票据批量转台账 / 长文档提炼」四条需要理解内容的能力，并把技能对外描述从「只会格式转换」扩回全量。

**Architecture:** 三段式流水线——取料（Python 脚本把文件变成模型能读的文字、表格候选、页面 PNG）→ 看懂（模型只输出 JSON）→ 装配（Python 脚本把 JSON 写成 xlsx / docx / md）。模型永远不直接生成二进制产物，所有确定性质检和「拒绝出文件」的门禁都落在装配脚本里。

**Tech Stack:** Python 3.12（app 自带 runtime，经 `DOC_CONVERT_PYTHON_HOME` 注入）、pdfplumber（含自带 pypdfium2 渲染）、pypdf、python-docx、openpyxl、Pillow、pillow-heif（仅 Windows）；前端 TypeScript + bun test。

**依据文档：** `docs/superpowers/specs/2026-08-11-doc-convert-skill-pr2-design.md`（本 PR 的设计）与 `docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md`（总设计）。**动手前先读这两份**，尤其总设计的「五个已拍板的决策」和两份文档各自的「实施前的事实核查结果」——那些数字都是实测过的，不要重新推测。

**分支：** `feat/doc-convert-skill-pr2`，从 `feat/doc-convert-skill`（PR #30）开出。**PR #30 尚未合并，本 PR 描述里必须注明依赖它。**

## Global Constraints

以下约束对**每一个** Task 都生效，不再逐条重复：

- **宁可不产出，也不产出一份看起来正常实则有缺陷的文件。** 任何拿不准的情况一律报错退出、不写文件，而不是硬憋一个半成品。
- **错误信息是写给用户看的中文**，格式 `[doc-convert] 错误：<说明>`，走 stderr，非零退出码，且必须告诉用户下一步该干什么。**不许让 Python 堆栈漏到用户面前。**
- **每个脚本的 `main()` 必须有一层兜底 `except Exception`**，把任何未预期的异常转成同格式的中文报错 + 非零退出。逐个函数自觉包 try 是不够的——2026-08-11 Task 2 评审实测：`img.save()` 遇到磁盘满/权限拒绝/路径被占用时会把裸 `Traceback` 打到用户面前，而那行代码本身看起来完全无辜。**兜底是承诺的防线，不能只靠每处调用自觉。** 同理，任何**写盘调用**（`save` / `write_text` / `unlink`）失败都要转成中文错误，不要裸抛。
- **不加 pandas**（它加 numpy 约 84 MB，比其余所有库加起来还大）。表格数据一律用 Python 原生 list of list，openpyxl 直接写。
- 新增依赖只有两个，**exact 写法**：
  ```
  pdfplumber>=0.11
  pillow-heif>=0.16; sys_platform == "win32"
  ```
- **【长文档提炼】的文件槽必须写「文稿文件」，不能写「文档文件」**——「文档」二字会被 `filePlaceholderPlugin` 的 word 规则抢先命中，只给 `.doc/.docx`，PDF 反而选不了，而 PDF 正是该场景的主力格式。
- 新脚本一律放 `skills/doc-convert/scripts/`，测试放 `skills/doc-convert/tests/`，文件名与被测脚本同名加 `test_` 前缀。
- 所有脚本顶部写「为什么这样而不是那样」的注释，沿用 PR 1 的高注释密度风格。
- 页码一律 **1 起、闭区间**，与用户口语一致。
- **每个 Task 结束提交一次**，commit message 用中文，尾部带：
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## 跑测试的前置动作（每个 Python Task 都要）

```bash
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" -m pip install -r skills/doc-convert/requirements-dev.txt
```

`requirements-dev.txt` 只含 pytest，刻意不进用户 venv（用户机器上没人跑单测）。

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `skills/doc-convert/requirements.txt` | 依赖清单 | 改（Task 1） |
| `skills/doc-convert/bin/ensure-python.sh` | macOS/Linux 引导 | 改（Task 1，哨兵失效修复） |
| `skills/doc-convert/bin/ensure-python.cmd` | Windows 引导 | 改（Task 1，同上） |
| `skills/doc-convert/scripts/img_prep.py` | 图片规格化：HEIC 解码 + 等比缩放 → JPG + 清单 | 新建（Task 2） |
| `skills/doc-convert/scripts/doc_text.py` | 统一取料：PDF/docx/txt/md → 带锚点文本 + 体检报告 | 新建（Task 3） |
| `skills/doc-convert/scripts/pdf_render.py` | PDF 指定页 → PNG；页码解析 | 新建（Task 4） |
| `skills/doc-convert/scripts/pdf_tables.py` | PDF 抽表格 → JSON（含扫描件判定） | 新建（Task 5） |
| `skills/doc-convert/scripts/rows_to_xlsx.py` | JSON/JSONL → Excel（含全部拒绝门禁与黄底标记） | 新建（Task 6） |
| `skills/doc-convert/scripts/docx_to_pdf.py` | PR1 遗留技术债清理 | 改（Task 7） |
| `skills/doc-convert/scripts/pdf_ops.py` | PR1 遗留技术债清理 | 改（Task 7） |
| `skills/doc-convert/SKILL.md` | 技能主文档 | 改（Task 7 局部、Task 8 主体） |
| `apps/studio/src/chat/composer/skillChipRegistry.ts` | chip 外观 | 改（Task 9） |
| `apps/studio/src/chat/lib/scenarioCatalogDefaults.ts` | 内置场景目录话术 | 改（Task 9） |
| `apps/studio/src/chat/lib/scenarioCatalogDefaults.test.ts` | 目录断言 | 改（Task 9） |
| `skills/doc-convert/tests/ACCEPTANCE.md` | 人工验收清单 | 新建（Task 10） |
| `docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md` | 总设计回填 | 改（Task 11） |

---

### Task 1: 依赖清单 + 修掉「加了依赖装不上」的哨兵失效

**为什么排第一：** `ensure-python.sh` 的快速通道只看 `.deps-ok` 这个哨兵文件**在不在**，不看 `requirements.txt` 变没变。PR 1 已经用过这个技能的老用户，venv 里躺着一个空的 `.deps-ok`；升级到 PR 2 后引导脚本会直接秒过，pdfplumber 永远装不上，后面所有 A 类脚本一 import 就炸一屏英文堆栈——正好违反「不许漏 Python 堆栈」这条铁律。**不先修这个，Task 2–6 在真实用户机器上全是坏的。**

修法：哨兵从「空文件」改成「requirements.txt 的一份副本」，快速通道用文件内容比对（`cmp` / `fc`）。老用户的空哨兵与新清单必然不等 → 自动触发一次补装 → 已装好的包 pip 会秒过，只下新增的两个。**自愈，不需要用户做任何事，也不需要额外的版本号维护。**

**Files:**
- Modify: `skills/doc-convert/requirements.txt`
- Modify: `skills/doc-convert/bin/ensure-python.sh:26-36`（快速通道）与 `:101-107`（写哨兵）
- Modify: `skills/doc-convert/bin/ensure-python.cmd:27-32`（快速通道）与 `:104`（写哨兵）

**Interfaces:**
- Produces: `$DOC_CONVERT_PY`（venv 解释器路径，语义不变）；venv 内可 `import pdfplumber`、`import pypdfium2`，Windows 上可 `import pillow_heif`

- [ ] **Step 1: 往 requirements.txt 追加两个依赖**

在文件末尾追加（沿用现有的「每个依赖上面写为什么」风格）：

```
# PDF 抽文字 / 抽表格（doc_text.py、pdf_tables.py）。
# 附带白赚一件事：pdfplumber>=0.11 自带 pypdfium2，PDF 页面渲染成 PNG
# （pdf_render.py）不需要再加任何依赖。2026-08-11 实测净增 32.9 MB，
# 其中 cryptography 13M（pdfminer.six 的硬依赖）+ pdfminer 9.3M + pypdfium2 8.0M。
pdfplumber>=0.11

# HEIC 解码，只在 Windows 装。iPhone 拍的照片默认是 HEIC，而模型读图只认
# PNG/JPG——「拍张照 → 提字」是本技能的门面场景，卡在这里等于门面塌了。
# macOS 用系统自带的 /usr/bin/sips 就能转（已实测存在），不让 mac 用户为
# Windows 的坑多付这 12 MB。分号后面是 pip 的「环境标记」语法，
# 不满足条件的平台会整行跳过，不是注释。
pillow-heif>=0.16; sys_platform == "win32"
```

- [ ] **Step 2: 先证明哨兵失效这个 bug 真实存在**

```bash
# 造一个「PR1 老用户」的现场：venv 在、空哨兵在、但没有 pdfplumber
export DOC_CONVERT_VENV_DIR=/tmp/dc-sentinel-test/venv
rm -rf /tmp/dc-sentinel-test && mkdir -p "$DOC_CONVERT_VENV_DIR"
python3 -m venv "$DOC_CONVERT_VENV_DIR"
: > "$DOC_CONVERT_VENV_DIR/.deps-ok"

source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" -c "import pdfplumber" 
```

Expected：引导脚本打印「Python 就绪」秒过（**没有安装任何东西**），最后一行 `import pdfplumber` 抛 `ModuleNotFoundError` —— 这就是要修的 bug。

- [ ] **Step 3: 改 ensure-python.sh 的快速通道**

把 `:29-36` 那段替换为：

```bash
# ── 1. 已就绪：venv 存在 + 哨兵内容与当前 requirements.txt 一致 → 秒过 ──
# 哨兵存的是 requirements.txt 的一份副本，不是空文件。理由：空文件只能回答
# 「以前装过吗」，回答不了「装的是不是现在这份清单」。PR 2 加 pdfplumber 时
# 踩到过——老用户 venv 里躺着 PR 1 留下的空哨兵，脚本秒过、新依赖永远装不上，
# 脚本一 import 就是一屏英文堆栈。改成内容比对后：清单变了 → 自动补装，
# 已装好的包 pip 会跳过，只下新增的；清单没变 → 照旧秒过。自愈，不需要
# 用户做任何事，也不需要额外维护一个版本号。
__dc_py="$DOC_CONVERT_VENV_DIR/bin/python"
if [ -x "$__dc_py" ] && cmp -s "$__dc_req" "$DOC_CONVERT_VENV_DIR/.deps-ok"; then
  export DOC_CONVERT_PY="$__dc_py"
  echo "[doc-convert] Python 就绪：$DOC_CONVERT_PY"
  unset __dc_py __dc_req
  return 0 2>/dev/null || exit 0
fi
```

注意 `__dc_py` 的赋值从原来的第 30 行挪进了注释之后——保持它在 `if` 之前赋值即可。

- [ ] **Step 4: 改 ensure-python.sh 的写哨兵处**

把 `:102` 的 `: > "$DOC_CONVERT_VENV_DIR/.deps-ok"` 改成：

```bash
  cp "$__dc_req" "$DOC_CONVERT_VENV_DIR/.deps-ok"
```

- [ ] **Step 5: 改 ensure-python.cmd 的快速通道**

把 `:27-32` 那段替换为（`fc /b` 是 Windows 自带的二进制比对，相等时 errorlevel 为 0）：

```bat
REM 1. 已就绪 -> 直接输出。哨兵存的是 requirements.txt 的副本而非空文件，
REM 理由与 ensure-python.sh 第 29 行的注释逐行对应：空文件回答不了「装的是不是
REM 现在这份清单」，加依赖后老用户会秒过且永远装不上新库。
if exist "%VENV_PY%" if exist "%DOC_CONVERT_VENV_DIR%\.deps-ok" (
  fc /b "%REQ%" "%DOC_CONVERT_VENV_DIR%\.deps-ok" >nul 2>&1
  if not errorlevel 1 (
    echo [doc-convert] Python 就绪：%VENV_PY%
    echo DOC_CONVERT_PY=%VENV_PY%
    exit /b 0
  )
)
```

- [ ] **Step 6: 改 ensure-python.cmd 的写哨兵处**

把 `:104` 的 `break > "%DOC_CONVERT_VENV_DIR%\.deps-ok"` 改成：

```bat
copy /y "%REQ%" "%DOC_CONVERT_VENV_DIR%\.deps-ok" >nul
```

- [ ] **Step 7: 重跑 Step 2 的现场，验证已修复**

```bash
export DOC_CONVERT_VENV_DIR=/tmp/dc-sentinel-test/venv
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" -c "import pdfplumber, pypdfium2, pypdf, docx, openpyxl, reportlab; print('ok')"
```

Expected：这次脚本打印「安装依赖…」并真的装，最后打印 `ok`。

- [ ] **Step 8: 验证第二次调用恢复秒过（哨兵生效）**

```bash
source skills/doc-convert/bin/ensure-python.sh
```

Expected：直接打印「Python 就绪」，**没有**「安装依赖…」那行。

- [ ] **Step 9: 清理测试现场并确认真实 venv 也补上了新依赖**

```bash
rm -rf /tmp/dc-sentinel-test
unset DOC_CONVERT_VENV_DIR
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" -c "import pdfplumber, pypdfium2; print('真实 venv ok')"
```

- [ ] **Step 10: Commit**

```bash
git add skills/doc-convert/requirements.txt skills/doc-convert/bin/
git commit -m "$(cat <<'EOF'
fix(doc-convert): 依赖哨兵改内容比对，加 pdfplumber 与条件依赖 pillow-heif

.deps-ok 原来是空文件，快速通道只判断它在不在，回答不了「装的是不是现在
这份清单」。PR 1 的老用户升级后会秒过、新依赖永远装不上，A 类脚本一 import
就漏一屏英文堆栈。改成存 requirements.txt 副本 + cmp/fc 比对后自愈。

pillow-heif 用 pip 环境标记只在 Windows 装，mac 走系统自带 sips。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `img_prep.py` —— 图片规格化

**Files:**
- Create: `skills/doc-convert/scripts/img_prep.py`
- Test: `skills/doc-convert/tests/test_img_prep.py`

**Interfaces:**
- Produces:
  - `class PrepError(Exception)` —— 单张图失败用它，**不要**在这里直接退出进程（批量场景一张坏图不该拖垮整批）
  - `prepare_one(src: Path, outdir: Path, max_edge: int = 1600) -> Path`
  - `MAX_EDGE_DEFAULT: int = 1600`
  - CLI：`img_prep.py <图...> -d OUTDIR [--max-edge 1600]`，stdout 打印清单 JSON

- [ ] **Step 1: 写失败的测试**

```python
"""img_prep 的行为契约。

两条最要紧的：
  1. 大图必须被缩到 max_edge 以内——模型看图前会把长边压到约 1568px，
     再大只多花 token 不多认字，这是纯浪费。
  2. 一张坏图不能拖垮整批——票据场景一次几十张，中间夹一个非图片文件
     很正常，整批崩掉比漏掉一张糟得多。
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import img_prep  # noqa: E402


def _png(path: Path, size=(3000, 2000)) -> Path:
    Image.new("RGB", size, (200, 30, 30)).save(path)
    return path


def test_large_image_is_downscaled(tmp_path):
    src = _png(tmp_path / "big.png")
    out = img_prep.prepare_one(src, tmp_path / "out")
    assert out.suffix == ".jpg"
    assert max(Image.open(out).size) == img_prep.MAX_EDGE_DEFAULT


def test_small_image_is_not_upscaled(tmp_path):
    src = _png(tmp_path / "small.png", size=(400, 300))
    out = img_prep.prepare_one(src, tmp_path / "out")
    assert Image.open(out).size == (400, 300)


def test_non_image_raises_prep_error_not_systemexit(tmp_path):
    bad = tmp_path / "notreally.jpg"
    bad.write_text("我不是图片", encoding="utf-8")
    with pytest.raises(img_prep.PrepError):
        img_prep.prepare_one(bad, tmp_path / "out")


def test_cli_manifest_records_original_name(tmp_path):
    src = _png(tmp_path / "IMG_0012.png", size=(800, 600))
    outdir = tmp_path / "out"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(src), "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    manifest = json.loads(proc.stdout)
    assert manifest["items"][0]["source"] == "IMG_0012.png"
    assert Path(manifest["items"][0]["output"]).name == "IMG_0012.jpg"
    assert manifest["failed"] == []


def test_cli_all_failed_exits_nonzero_in_chinese(tmp_path):
    bad = tmp_path / "x.jpg"
    bad.write_text("不是图片", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(bad), "-d", str(tmp_path / "out")],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "[doc-convert] 错误：" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_partial_failure_still_succeeds(tmp_path):
    good = _png(tmp_path / "good.png", size=(500, 500))
    bad = tmp_path / "bad.jpg"
    bad.write_text("不是图片", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(good), str(bad),
         "-d", str(tmp_path / "out")],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    manifest = json.loads(proc.stdout)
    assert len(manifest["items"]) == 1
    assert manifest["failed"][0]["source"] == "bad.jpg"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_img_prep.py -v`
Expected: FAIL —— `ModuleNotFoundError: No module named 'img_prep'`

- [ ] **Step 3: 写实现**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""img_prep.py — 把用户丢进来的图片规格化成模型能读的 JPG。

为什么需要这一步（两个都不是可选项）：
  1. iPhone 拍的照片默认是 HEIC，而模型读图只认 PNG/JPG 这类常见格式。
     「拍张照 → 提字」「拍一堆发票 → 出台账」正是本技能的门面场景，
     卡在这里等于门面塌了。
  2. 手机原图动辄 4000px 宽。模型看图前会把长边压到约 1568px，
     多出来的像素只多花 token，一个字也不多认。先压掉是纯赚。

HEIC 解码走两条路，理由见设计文档「依赖与体积」：
  - pillow-heif 能 import 就用它（requirements.txt 里只在 Windows 装）
  - 否则用 macOS 系统自带的 /usr/bin/sips（已实测存在）
  - 两条都没有 → 明确报错让用户自己导出，不硬撑
这样 mac 用户不用为 Windows 的坑多付 12 MB。

单张失败抛 PrepError 而不是直接退出进程：批量场景一次几十张，
中间夹一个非图片文件很正常，整批崩掉比漏掉一张糟得多。是否「全军覆没
才算失败」由 main() 决定。
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

MAX_EDGE_DEFAULT = 1600  # 略高于模型内部约 1568px 的长边上限，留一点余量
HEIC_SUFFIXES = {".heic", ".heif"}

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


class PrepError(Exception):
    """单张图处理失败。消息是给用户看的中文。"""


def _die(msg: str) -> None:
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


def _heif_ready() -> bool:
    """pillow-heif 可用则注册进 Pillow，返回是否可用。"""
    try:
        import pillow_heif
    except ImportError:
        return False
    pillow_heif.register_heif_opener()
    return True


def _sips_convert(src: Path, dst: Path) -> bool:
    """macOS 自带 sips 转 HEIC → JPEG。成功返回 True。"""
    sips = shutil.which("sips")
    if not sips:
        return False
    try:
        subprocess.run(
            [sips, "-s", "format", "jpeg", str(src), "--out", str(dst)],
            check=True, capture_output=True, timeout=60,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False
    return dst.is_file()


def prepare_one(src: Path, outdir: Path, max_edge: int = MAX_EDGE_DEFAULT) -> Path:
    """规格化一张图，返回产物路径。失败抛 PrepError（消息是中文）。"""
    src = Path(src)
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    dst = outdir / (src.stem + ".jpg")

    work = src
    tmp: Path | None = None
    if src.suffix.lower() in HEIC_SUFFIXES and not _heif_ready():
        tmp = outdir / (src.stem + ".sips-tmp.jpg")
        if not _sips_convert(src, tmp):
            raise PrepError(
                f"{src.name} 是 HEIC 格式，本机没有可用的解码器。"
                "请先把它导出成 JPG 或 PNG 再试"
                "（iPhone 相册「共享 → 存储到文件」时选“最兼容”即可）。"
            )
        work = tmp

    try:
        img = Image.open(work)
        img.load()
    except Exception:
        raise PrepError(f"{src.name} 打不开，可能不是图片文件或已损坏。请确认后重试。")

    img = img.convert("RGB")
    w, h = img.size
    if max(w, h) > max_edge:
        scale = max_edge / max(w, h)
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    img.save(dst, "JPEG", quality=90)

    # sips 中转文件用完就删——产物目录里不留半成品，同 PR 1 的纪律
    if tmp is not None and tmp.is_file():
        tmp.unlink()
    return dst


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把图片规格化成模型能读的 JPG")
    ap.add_argument("inputs", nargs="+", help="输入图片，可多张")
    ap.add_argument("-d", "--outdir", required=True, help="产物目录")
    ap.add_argument("--max-edge", type=int, default=MAX_EDGE_DEFAULT,
                    help=f"长边上限像素，默认 {MAX_EDGE_DEFAULT}")
    args = ap.parse_args(argv)

    outdir = Path(args.outdir)
    items, failed = [], []
    for raw in args.inputs:
        src = Path(raw)
        if not src.is_file():
            failed.append({"source": src.name, "reason": "文件不存在"})
            continue
        try:
            out = prepare_one(src, outdir, args.max_edge)
        except PrepError as e:
            failed.append({"source": src.name, "reason": str(e)})
            continue
        items.append({"source": src.name, "output": str(out)})

    if not items:
        reasons = "；".join(f["reason"] for f in failed) or "没有可处理的输入"
        _die(f"这批图片一张也没能处理成功。{reasons}")

    print(json.dumps({"outdir": str(outdir), "items": items, "failed": failed},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_img_prep.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add skills/doc-convert/scripts/img_prep.py skills/doc-convert/tests/test_img_prep.py
git commit -m "$(cat <<'EOF'
feat(doc-convert): img_prep.py —— 图片规格化（HEIC 解码 + 等比缩放）

HEIC 双路径：pillow-heif（仅 Windows 装）→ macOS 系统 sips → 明确报错。
长边默认压到 1600px：模型看图前会压到约 1568px，再大只多花 token。
单张失败抛 PrepError 不退出进程，批量场景一张坏图不拖垮整批。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `doc_text.py` —— 统一取料 + 体检

**Files:**
- Create: `skills/doc-convert/scripts/doc_text.py`
- Test: `skills/doc-convert/tests/test_doc_text.py`

**Interfaces:**
- Produces:
  - `SCANNED_CHARS_PER_PAGE: int = 50`
  - `extract(path: Path) -> tuple[list[str], str]` —— 返回 `(分段文本列表, kind)`，`kind` ∈ `{"pdf","docx","plain"}`；PDF 一项一页，其余一项一段
  - `checkup(units: list[str], kind: str) -> dict` —— 体检报告
  - CLI：`doc_text.py <文件> [--outdir DIR]`，写 `<stem>.text.txt`，stdout 打印体检 JSON

体检 JSON 形状（后续 Task 的 SKILL.md 会引用，字段名不要改）：

```json
{ "source": "年报.pdf", "kind": "pdf", "units": 58, "chars": 41230,
  "chars_per_unit": [812, 903, 0, ...], "scanned": false, "scanned_units": [3, 4],
  "text_file": "年报.text.txt" }
```

- [ ] **Step 1: 写失败的测试**

```python
"""doc_text 的行为契约。

最要紧的是体检报告，尤其 scanned 判定：长文档提炼最大的风险不是总结得不好，
是模型只读了前面一小截就开始总结、而且它不会告诉你。取料时就把「多少页、
多少字、哪几页是扫描的」摊在台面上，agent 才有依据决定分不分块、走不走 OCR。
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import doc_text  # noqa: E402


def _text_pdf(path: Path, pages: int = 2) -> Path:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    c = canvas.Canvas(str(path), pagesize=A4)
    for i in range(pages):
        c.drawString(72, 720, f"This is page {i + 1} with enough text to look real. " * 4)
        c.showPage()
    c.save()
    return path


def _image_only_pdf(path: Path, tmp_path: Path) -> Path:
    """造一份「扫描件」：整页只有一张图，没有任何文字层。"""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    img = tmp_path / "blank.png"
    Image.new("RGB", (800, 1100), (240, 240, 240)).save(img)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawImage(str(img), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()
    return path


def _docx(path: Path) -> Path:
    from docx import Document
    d = Document()
    d.add_paragraph("第一段内容")
    d.add_paragraph("第二段内容")
    d.save(str(path))
    return path


def test_text_pdf_is_not_scanned(tmp_path):
    units, kind = doc_text.extract(_text_pdf(tmp_path / "a.pdf"))
    report = doc_text.checkup(units, kind)
    assert kind == "pdf"
    assert report["units"] == 2
    assert report["scanned"] is False
    assert report["scanned_units"] == []


def test_image_only_pdf_is_flagged_scanned(tmp_path):
    units, kind = doc_text.extract(_image_only_pdf(tmp_path / "s.pdf", tmp_path))
    report = doc_text.checkup(units, kind)
    assert report["scanned"] is True
    assert report["scanned_units"] == [1]


def test_docx_units_are_paragraphs(tmp_path):
    units, kind = doc_text.extract(_docx(tmp_path / "a.docx"))
    assert kind == "docx"
    assert units == ["第一段内容", "第二段内容"]


def test_legacy_doc_is_refused_in_chinese(tmp_path):
    old = tmp_path / "old.doc"
    old.write_bytes(b"\xd0\xcf\x11\xe0")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "doc_text.py"), str(old), "--outdir", str(tmp_path)],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "另存为" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_writes_text_file_with_page_anchors(tmp_path):
    src = _text_pdf(tmp_path / "b.pdf", pages=3)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "doc_text.py"), str(src), "--outdir", str(tmp_path)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    body = Path(report["text_file"]).read_text(encoding="utf-8")
    assert "[P1]" in body and "[P3]" in body


def test_cli_docx_uses_paragraph_anchors(tmp_path):
    src = _docx(tmp_path / "c.docx")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "doc_text.py"), str(src), "--outdir", str(tmp_path)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    body = Path(json.loads(proc.stdout)["text_file"]).read_text(encoding="utf-8")
    assert "[§1] 第一段内容" in body
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_doc_text.py -v`
Expected: FAIL —— `ModuleNotFoundError: No module named 'doc_text'`

- [ ] **Step 3: 写实现**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""doc_text.py — 统一取料 + 体检：PDF / Word(.docx) / txt / md → 带锚点纯文本。

体检报告才是这个脚本存在的主要理由。长文档提炼最大的风险不是总结得不好，
是模型只读了前面一小截就开始总结——而且它不会告诉你。所以取料这一步就得把
「这份文档多少页、多少字、哪几页根本没有文字层」摊在台面上，让 agent 据此
决定分不分块、要不要改走 OCR 路线，而不是闷头读完开头就下结论。

锚点是提取后自编的定位坐标（PDF 用页号 [P3]，其余用段号 [§12]），
文件本身没有。摘要里的结论要带出处，靠的就是它。
做法与 skills/tender-review/scripts/extract_text.py 的行号锚点同源。
"""
import argparse
import json
import sys
from pathlib import Path

SCANNED_CHARS_PER_PAGE = 50  # 平均每页可提取字符低于此值 → 判定扫描件

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _die(msg: str) -> None:
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


def _extract_pdf(path: Path) -> list[str]:
    import pdfplumber
    try:
        with pdfplumber.open(str(path)) as pdf:
            return [(p.extract_text() or "") for p in pdf.pages]
    except Exception as e:
        low = str(e).lower()
        if "password" in low or "encrypt" in low:
            _die(f"PDF「{path.name}」被密码保护，本工具无法处理。请先用阅读器去掉密码再试。")
        _die(f"打开 PDF「{path.name}」失败，文件可能已损坏。请确认后重试。")
        return []  # 不可达，只为类型完整


def _extract_docx(path: Path) -> list[str]:
    """按文档顺序遍历段落和表格。

    python-docx 默认把 doc.paragraphs 和 doc.tables 分开返回，丢失原文顺序；
    这里手动遍历 body 的子元素，保持正文与表格的真实先后——同 tender-review
    的 extract_text.py。摘要引用位置时顺序错了，出处就是错的。
    """
    from docx import Document
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    try:
        doc = Document(str(path))
    except Exception:
        _die(f"打开 Word 文档「{path.name}」失败，文件可能已损坏。请确认后重试。")
    units: list[str] = []
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            txt = Paragraph(child, doc).text.strip()
            if txt:
                units.append(txt)
        elif child.tag == qn("w:tbl"):
            for row in Table(child, doc).rows:
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                units.append(" | ".join(cells))
    return units


def _extract_plain(path: Path) -> list[str]:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        _die(f"读取「{path.name}」失败。请确认文件没有损坏。")
    return [ln.strip() for ln in raw.splitlines() if ln.strip()]


def extract(path: Path) -> tuple[list[str], str]:
    """返回 (分段文本, kind)。PDF 一项一页，其余一项一段。"""
    path = Path(path)
    if not path.is_file():
        _die(f"找不到文件「{path}」。请确认路径。")
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(path), "pdf"
    if suffix == ".docx":
        return _extract_docx(path), "docx"
    if suffix == ".doc":
        _die("这是旧的 .doc 二进制格式，本工具打不开。请先在 Word 里另存为 .docx 或 PDF 再试。")
    if suffix in {".txt", ".md", ".markdown"}:
        return _extract_plain(path), "plain"
    _die(f"不支持的格式「{suffix}」。本能力只吃 PDF / .docx / .txt / .md。")
    return [], ""  # 不可达


def checkup(units: list[str], kind: str) -> dict:
    """体检报告。scanned 只对 PDF 有意义——其余格式没有「文字层」这回事。"""
    per_unit = [len(u) for u in units]
    total = sum(per_unit)
    scanned_units: list[int] = []
    scanned = False
    if kind == "pdf" and units:
        # 按页给明细而不是一刀切：混合型文档（前半电子版、后半扫描插页）
        # 很常见，只报一个 true/false 会让 agent 对整份文档做错决定。
        scanned_units = [i + 1 for i, n in enumerate(per_unit) if n < SCANNED_CHARS_PER_PAGE]
        scanned = (total / len(units)) < SCANNED_CHARS_PER_PAGE
    return {
        "kind": kind,
        "units": len(units),
        "chars": total,
        "chars_per_unit": per_unit,
        "scanned": scanned,
        "scanned_units": scanned_units,
    }


def render_anchored(units: list[str], kind: str) -> str:
    tag = "P" if kind == "pdf" else "§"
    return "\n\n".join(f"[{tag}{i}] {u}" for i, u in enumerate(units, start=1))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="统一取料：文档 → 带锚点纯文本 + 体检报告")
    ap.add_argument("input", help="PDF / .docx / .txt / .md")
    ap.add_argument("--outdir", default=".", help="文本产物目录，默认当前目录")
    args = ap.parse_args(argv)

    src = Path(args.input)
    units, kind = extract(src)
    if not units:
        # 一个字都提不出来又不是扫描件判定能解释的，属于「给不了任何有用产物」
        if kind != "pdf":
            _die(f"「{src.name}」里提不出任何文字。请确认文件内容是否正确。")

    report = checkup(units, kind)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    text_file = outdir / (src.stem + ".text.txt")
    text_file.write_text(render_anchored(units, kind), encoding="utf-8")

    report["source"] = src.name
    report["text_file"] = str(text_file)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_doc_text.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add skills/doc-convert/scripts/doc_text.py skills/doc-convert/tests/test_doc_text.py
git commit -m "$(cat <<'EOF'
feat(doc-convert): doc_text.py —— 统一取料 + 体检报告

PDF/docx/txt/md 转成带锚点（[P3] / [§12]）的纯文本，并给出页数、字数、
每页字数、是否扫描件。扫描件按页给明细而非一刀切：混合型文档很常见。
体检报告是长文档提炼防「只读开头就总结」的依据。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `pdf_render.py` —— PDF 页面渲染成 PNG

**Files:**
- Create: `skills/doc-convert/scripts/pdf_render.py`
- Test: `skills/doc-convert/tests/test_pdf_render.py`

**Interfaces:**
- Produces:
  - `SCALE_DEFAULT: float = 2.0`、`SCALE_MAX: float = 4.0`
  - `parse_pages(spec: str, total: int) -> list[int]` —— 1 起闭区间，越界即中文报错退出（**Task 5 会 import 它**）
  - `render(src: Path, pages: list[int], outdir: Path, scale: float) -> list[Path]`
  - CLI：`pdf_render.py <pdf> --pages "1-3,7" -d OUTDIR [--scale 2]`

- [ ] **Step 1: 写失败的测试**

```python
"""pdf_render 的行为契约。

页码语义必须和 PR 1 的 pdf_ops.py 完全一致（1 起、闭区间、越界报总页数），
否则同一个技能里两套页码规则，用户说「第 3 页」会得到两种结果。
"""
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import pdf_render  # noqa: E402


def _pdf(path: Path, pages: int = 3) -> Path:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    c = canvas.Canvas(str(path), pagesize=A4)
    for i in range(pages):
        c.drawString(72, 720, f"page {i + 1}")
        c.showPage()
    c.save()
    return path


def test_parse_pages_is_one_based_and_inclusive():
    assert pdf_render.parse_pages("1,3-5", 10) == [1, 3, 4, 5]


def test_parse_pages_rejects_out_of_range_with_total(capsys):
    with pytest.raises(SystemExit):
        pdf_render.parse_pages("1-5", 3)
    err = capsys.readouterr().err
    assert "共 3 页" in err


def test_render_writes_one_png_per_page(tmp_path):
    src = _pdf(tmp_path / "a.pdf")
    outs = pdf_render.render(src, [1, 3], tmp_path / "png", pdf_render.SCALE_DEFAULT)
    assert [p.name for p in outs] == ["page-0001.png", "page-0003.png"]
    assert all(p.stat().st_size > 0 for p in outs)


def test_scale_above_max_is_refused_in_chinese(tmp_path):
    src = _pdf(tmp_path / "b.pdf", pages=1)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_render.py"), str(src),
         "--pages", "1", "-d", str(tmp_path / "out"), "--scale", "9"],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "[doc-convert] 错误：" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_default_renders_all_pages(tmp_path):
    src = _pdf(tmp_path / "c.pdf", pages=2)
    outdir = tmp_path / "out"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_render.py"), str(src), "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert sorted(p.name for p in outdir.glob("*.png")) == ["page-0001.png", "page-0002.png"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_pdf_render.py -v`
Expected: FAIL —— `ModuleNotFoundError: No module named 'pdf_render'`

- [ ] **Step 3: 写实现**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf_render.py — 把 PDF 指定页渲染成 PNG，供模型看图核对。

渲染引擎用 pypdfium2：它是 pdfplumber>=0.11 的自带依赖，**不额外增加体积**
（2026-08-11 实测确认）。别为这件事去装 PyMuPDF——它体积更大，且是 AGPL。

scale 默认 2：A4 @2 倍约 1191×1684 px，与模型内部约 1568px 的长边上限对齐，
再高只多花 token 不多认字。某页认不清时可单独提高 scale 重渲那一页。
SCALE_MAX 卡 4 是防手滑：scale=20 会渲出几十 MB 的图，喂进模型既慢又贵。

parse_pages 刻意在本文件重写一份，没有去 import pdf_ops.py 里那个私有的
_parse_pages：两个脚本的报错措辞各自独立演进更安全，为省 12 行去耦合两个
脚本的错误信息不划算。但**页码语义必须和 pdf_ops 完全一致**（1 起、闭区间、
越界报总页数），否则同一个技能里两套规则，用户说「第 3 页」会得到两种结果。
"""
import argparse
import sys
from pathlib import Path

SCALE_DEFAULT = 2.0
SCALE_MAX = 4.0

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _die(msg: str) -> None:
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


def parse_pages(spec: str, total: int) -> list[int]:
    """把 "1,3-5" 解析成 1 起的页码列表，去重排序。越界即报错退出。"""
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
                _die(f"看不懂页码区间「{chunk}」。写法示例：1,3-5")
            if start > end:
                start, end = end, start
            pages.update(range(start, end + 1))
        else:
            try:
                pages.add(int(chunk))
            except ValueError:
                _die(f"看不懂页码「{chunk}」。写法示例：1,3-5")
    bad = [p for p in sorted(pages) if p < 1 or p > total]
    if bad:
        _die(f"页码 {bad} 超出范围，该文件共 {total} 页。请改正页码后重试。")
    return sorted(pages)


def open_document(src: Path):
    """打开 PDF，加密/损坏都转成中文报错。措辞与 pdf_ops.py 对齐。"""
    import pypdfium2
    try:
        return pypdfium2.PdfDocument(str(src))
    except Exception as e:
        low = str(e).lower()
        if "password" in low or "encrypt" in low:
            _die(f"PDF「{src.name}」被密码保护，本工具无法处理。请先用阅读器去掉密码再试。")
        _die(f"打开 PDF「{src.name}」失败，文件可能已损坏。请确认后重试。")


def render(src: Path, pages: list[int], outdir: Path, scale: float) -> list[Path]:
    src, outdir = Path(src), Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    doc = open_document(src)
    written: list[Path] = []
    for p in pages:
        bitmap = doc[p - 1].render(scale=scale)
        dst = outdir / f"page-{p:04d}.png"
        bitmap.to_pil().save(dst)
        written.append(dst)
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把 PDF 页面渲染成 PNG 供模型看图")
    ap.add_argument("input", help="输入 PDF")
    ap.add_argument("--pages", help='页码，如 "1,3-5"；不给则全部页')
    ap.add_argument("-d", "--outdir", required=True, help="产物目录")
    ap.add_argument("--scale", type=float, default=SCALE_DEFAULT,
                    help=f"渲染倍率，默认 {SCALE_DEFAULT}，上限 {SCALE_MAX}")
    args = ap.parse_args(argv)

    if not (0 < args.scale <= SCALE_MAX):
        _die(f"渲染倍率 {args.scale} 不合法，必须在 0 到 {SCALE_MAX} 之间。"
             f"倍率过高会渲出几十 MB 的图，模型读起来又慢又贵。")

    src = Path(args.input)
    if not src.is_file():
        _die(f"找不到文件「{src}」。请确认路径。")

    doc = open_document(src)
    total = len(doc)
    pages = parse_pages(args.pages, total) if args.pages else list(range(1, total + 1))

    written = render(src, pages, Path(args.outdir), args.scale)
    for p in written:
        print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_pdf_render.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add skills/doc-convert/scripts/pdf_render.py skills/doc-convert/tests/test_pdf_render.py
git commit -m "$(cat <<'EOF'
feat(doc-convert): pdf_render.py —— PDF 页面渲染成 PNG

用 pdfplumber 自带的 pypdfium2，零额外体积。scale 默认 2（A4 约 1684px，
对齐模型 ~1568px 长边上限），上限 4 防手滑渲出几十 MB。页码语义与
pdf_ops.py 严格一致：1 起、闭区间、越界报总页数。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `pdf_tables.py` —— 抽表格 + 扫描件判定

**Files:**
- Create: `skills/doc-convert/scripts/pdf_tables.py`
- Test: `skills/doc-convert/tests/test_pdf_tables.py`

**Interfaces:**
- Consumes: `pdf_render.parse_pages`（同目录 import）
- Produces: CLI `pdf_tables.py <pdf> [--pages "1-3"] -o tables.json`，输出 JSON：

```json
{ "source": "报价单.pdf", "total_pages": 12, "scanned": false,
  "tables": [ { "table_id": 1, "page": 3, "n_rows": 8, "n_cols": 5,
                "rows": [["项目","单价","数量","金额","备注"]] } ] }
```

- [ ] **Step 1: 写失败的测试**

```python
"""pdf_tables 的行为契约。

最要紧的一条：脚本抽出来的数字必须与源文件逐字一致。这是整条「PDF 表格转
Excel」路线的立身之本——模型只准改结构不准改数字，前提就是脚本读的数字是
从文件坐标里直接读出来的、不是认出来的。这条断言一旦松掉，整条纪律就空了。
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import pdf_tables  # noqa: E402


def _table_pdf(path: Path) -> Path:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle
    data = [["Item", "Q1", "Q2"],
            ["Revenue", "1200.50", "1310.25"],
            ["Cost", "800.00", "910.10"]]
    t = Table(data)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
    SimpleDocTemplate(str(path), pagesize=A4).build([t])
    return path


def _no_table_pdf(path: Path) -> Path:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawString(72, 720, "Just a paragraph of prose, no tables here at all. " * 3)
    c.showPage()
    c.save()
    return path


def _scanned_pdf(path: Path, tmp_path: Path) -> Path:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    img = tmp_path / "page.png"
    Image.new("RGB", (800, 1100), (245, 245, 245)).save(img)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawImage(str(img), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()
    return path


def test_numbers_are_extracted_verbatim(tmp_path):
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"), str(_table_pdf(tmp_path / "a.pdf")),
         "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    rows = data["tables"][0]["rows"]
    assert rows[1] == ["Revenue", "1200.50", "1310.25"]
    assert data["scanned"] is False


def test_no_table_in_text_pdf_is_refused(tmp_path):
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"),
         str(_no_table_pdf(tmp_path / "b.pdf")), "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "没找到表格" in proc.stderr
    assert not out.exists(), "拒绝时不能留下半成品 JSON"
    assert "Traceback" not in proc.stderr


def test_scanned_pdf_exits_zero_and_flags_scanned(tmp_path):
    """扫描件没有文字层不是错误，是需要 agent 改走看图路线的信号。"""
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"),
         str(_scanned_pdf(tmp_path / "c.pdf", tmp_path)), "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["scanned"] is True
    assert data["tables"] == []


def test_page_filter_is_honoured(tmp_path):
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"), str(_table_pdf(tmp_path / "d.pdf")),
         "--pages", "1", "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(out.read_text(encoding="utf-8"))["tables"][0]["page"] == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_pdf_tables.py -v`
Expected: FAIL —— `ModuleNotFoundError: No module named 'pdf_tables'`

- [ ] **Step 3: 写实现**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf_tables.py — 从 PDF 抽表格 → JSON，并判定这份 PDF 是不是扫描件。

这个脚本是「PDF 表格转 Excel」这条能力的立身之本：它抽出来的数字是按坐标
从文件里**直接读**的，不是认出来的，逐字准确（2026-08-11 实测）。
正因如此，SKILL.md 才敢立那条纪律——模型只准改结构（合并跨页表头、拆开挤在
一起的两张表、剔除混进来的页眉页脚行），**不准改数字**。这条纪律一旦松掉，
就等于把本来 100% 准确的财务数字交给一个会看错小数点的读者。

扫描件（没有文字层）**不算错误**，退出码 0 并把 scanned 标成 true——
这是给 agent 的信号：改走「模型看图读表」那条分支，并套上严格的无法识别标记。
真正的错误只有一种：不是扫描件却一张表都没找到，那时拒绝产出，不留空 JSON。
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_render import parse_pages  # noqa: E402

SCANNED_CHARS_PER_PAGE = 50  # 与 doc_text.py 同值；两处都改才算改

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _die(msg: str) -> None:
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


def _open(src: Path):
    import pdfplumber
    try:
        return pdfplumber.open(str(src))
    except Exception as e:
        low = str(e).lower()
        if "password" in low or "encrypt" in low:
            _die(f"PDF「{src.name}」被密码保护，本工具无法处理。请先用阅读器去掉密码再试。")
        _die(f"打开 PDF「{src.name}」失败，文件可能已损坏。请确认后重试。")


def extract(src: Path, pages_spec: str | None) -> dict:
    with _open(src) as pdf:
        total = len(pdf.pages)
        wanted = parse_pages(pages_spec, total) if pages_spec else list(range(1, total + 1))

        chars_total = 0
        tables: list[dict] = []
        tid = 0
        for pno in wanted:
            page = pdf.pages[pno - 1]
            chars_total += len(page.extract_text() or "")
            for raw in page.extract_tables():
                # pdfplumber 对空单元格给 None，统一成空串：下游要写进 Excel，
                # None 和 "" 在 JSON 里是两种东西，留着会让装配脚本多一层判断。
                rows = [["" if c is None else str(c).strip() for c in row] for row in raw]
                if not rows:
                    continue
                tid += 1
                tables.append({
                    "table_id": tid,
                    "page": pno,
                    "n_rows": len(rows),
                    "n_cols": max(len(r) for r in rows),
                    "rows": rows,
                })

    scanned = bool(wanted) and (chars_total / len(wanted)) < SCANNED_CHARS_PER_PAGE
    return {"source": src.name, "total_pages": total, "scanned": scanned, "tables": tables}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="从 PDF 抽表格 → JSON")
    ap.add_argument("input", help="输入 PDF")
    ap.add_argument("--pages", help='只看这些页，如 "1,3-5"；不给则全部')
    ap.add_argument("-o", "--output", required=True, help="输出 JSON 路径")
    args = ap.parse_args(argv)

    src = Path(args.input)
    if not src.is_file():
        _die(f"找不到文件「{src}」。请确认路径。")

    result = extract(src, args.pages)

    if not result["tables"] and not result["scanned"]:
        # 有文字层却一张表都没有 = 这份 PDF 里确实没有表格。不产出空 JSON，
        # 免得下游拿着一份「结构完整但内容为空」的文件继续往下走。
        _die(f"「{src.name}」里没找到表格。请确认这份 PDF 是不是真的含表格，"
             "或者告诉我要抽第几页。")

    dst = Path(args.output)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"表格 {len(result['tables'])} 张 → {dst}")
    if result["scanned"]:
        print("提示：这份 PDF 没有文字层（扫描件），抽不到表格数据，请改走看图识别路线。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_pdf_tables.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add skills/doc-convert/scripts/pdf_tables.py skills/doc-convert/tests/test_pdf_tables.py
git commit -m "$(cat <<'EOF'
feat(doc-convert): pdf_tables.py —— PDF 抽表格 + 扫描件判定

按坐标直接读，数字逐字准确——这是「模型只准改结构不准改数字」那条纪律的
前提。扫描件退出码 0 并标 scanned=true（给 agent 改走看图路线的信号），
有文字层却零表格才算错误，且拒绝时不留空 JSON。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `rows_to_xlsx.py` —— JSON/JSONL 装配成 Excel（全部门禁在这里）

**这是本 PR 最核心的一个脚本**：「宁可不产出」的纪律、「无法识别」的呈现、
「50% 识别率门禁」全部落在这里。「PDF 表格转 Excel」和「票据批量转台账」共用它。

**Files:**
- Create: `skills/doc-convert/scripts/rows_to_xlsx.py`
- Test: `skills/doc-convert/tests/test_rows_to_xlsx.py`

**Interfaces:**
- Produces:
  - `UNREADABLE_TEXT: str = "⚠ 无法识别"`
  - `YELLOW_HEX: str = "FFF2CC"`
  - `MAX_UNCERTAIN_RATIO_DEFAULT: float = 0.5`
  - `load(path: Path, headers_arg: list[str] | None) -> tuple[list[str], list[dict], dict]` → `(headers, rows, meta)`
  - `validate(headers, rows, max_ratio) -> None` —— 违规即中文报错退出
  - `build(headers, rows, meta, sheet_name) -> Workbook`
  - CLI：`rows_to_xlsx.py <rows.json|rows.jsonl> -o out.xlsx [--headers 日期 金额 ...] [--sheet 台账] [--max-uncertain-ratio 0.5]`
- 输入 JSON 形状（**SKILL.md 会原样引用，字段名不许改**）：

```json
{ "headers": ["日期", "票据类型", "金额", "来源文件"],
  "meta": { "标题": "2026年3月报销台账" },
  "rows": [ { "日期": "2026-03-01", "金额": 128.5,
              "_存疑": [{ "字段": "金额", "原因": "折痕遮挡" }],
              "_来源": "IMG_0012.jpg" } ] }
```

- [ ] **Step 1: 写失败的测试**

```python
"""rows_to_xlsx 的行为契约 —— 本 PR 全部质量门禁的落点。

四条最要紧的：
  1. 数字要写成真数值，不然用户 =SUM() 得 0（PR 1 的 csv→xlsx 已经踩过一次，
     那次只能靠文档提醒补救；这次是我们自己生成，没有借口）。
  2. 「看不清」和「本来就没有」必须区分：都标成无法识别会制造大量假警报，
     用户三天就学会无视所有黄格子，标记随之失效。
  3. 模型偷偷加列要当场拒绝——表头是跟用户确认过的契约。
  4. 识别率不到一半直接拒绝出文件：一份一半是问号的台账，用户核对的工夫
     比自己录还多。
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from openpyxl import load_workbook

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import rows_to_xlsx  # noqa: E402


def _write_json(path: Path, payload: dict) -> Path:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def _run(src: Path, out: Path, *extra: str):
    return subprocess.run(
        [sys.executable, str(SCRIPTS / "rows_to_xlsx.py"), str(src), "-o", str(out), *extra],
        capture_output=True, text=True,
    )


def test_numbers_are_written_as_numbers(tmp_path):
    src = _write_json(tmp_path / "a.json", {
        "headers": ["项目", "金额"],
        "rows": [{"项目": "差旅", "金额": 128.5}],
    })
    out = tmp_path / "a.xlsx"
    assert _run(src, out).returncode == 0
    ws = load_workbook(out).active
    assert ws["B2"].value == 128.5
    assert ws["B2"].data_type == "n", "写成文本的话用户 =SUM() 会得 0"


def test_uncertain_cell_is_marked_and_filled_yellow(tmp_path):
    src = _write_json(tmp_path / "b.json", {
        "headers": ["项目", "金额"],
        "rows": [{"项目": "餐饮", "金额": None,
                  "_存疑": [{"字段": "金额", "原因": "折痕遮挡"}],
                  "_来源": "IMG_1.jpg"}],
    })
    out = tmp_path / "b.xlsx"
    assert _run(src, out).returncode == 0
    wb = load_workbook(out)
    ws = wb.active
    assert ws["B2"].value == rows_to_xlsx.UNREADABLE_TEXT
    assert rows_to_xlsx.YELLOW_HEX in str(ws["B2"].fill.start_color.rgb)
    review = wb["待核对"]
    assert [c.value for c in review[2]] == ["IMG_1.jpg", "金额", "折痕遮挡"]


def test_missing_but_not_uncertain_stays_empty(tmp_path):
    """票据上本来就没有税额 ≠ 看不清税额。混为一谈会制造假警报。"""
    src = _write_json(tmp_path / "c.json", {
        "headers": ["项目", "税额"],
        "rows": [{"项目": "打车", "税额": None}],
    })
    out = tmp_path / "c.xlsx"
    assert _run(src, out).returncode == 0
    wb = load_workbook(out)
    assert wb.active["B2"].value is None
    assert "待核对" not in wb.sheetnames, "一个存疑都没有时不该多出一张空表"


def test_unknown_field_is_refused_with_row_number(tmp_path):
    src = _write_json(tmp_path / "d.json", {
        "headers": ["项目"],
        "rows": [{"项目": "住宿"}, {"项目": "机票", "偷加的列": "x"}],
    })
    out = tmp_path / "d.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert "第 2 行" in proc.stderr and "偷加的列" in proc.stderr
    assert not out.exists()


def test_over_half_uncertain_is_refused(tmp_path):
    src = _write_json(tmp_path / "e.json", {
        "headers": ["日期", "金额"],
        "rows": [{"日期": None, "金额": None,
                  "_存疑": [{"字段": "日期", "原因": "模糊"},
                            {"字段": "金额", "原因": "模糊"}]}],
    })
    out = tmp_path / "e.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert "超过一半" in proc.stderr
    assert not out.exists()


def test_empty_rows_is_refused(tmp_path):
    src = _write_json(tmp_path / "f.json", {"headers": ["项目"], "rows": []})
    out = tmp_path / "f.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert not out.exists()


def test_jsonl_without_headers_is_refused(tmp_path):
    src = tmp_path / "g.jsonl"
    src.write_text('{"项目": "住宿"}\n', encoding="utf-8")
    out = tmp_path / "g.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert "--headers" in proc.stderr
    assert not out.exists()


def test_jsonl_with_headers_works(tmp_path):
    src = tmp_path / "h.jsonl"
    src.write_text('{"项目": "住宿", "金额": 300}\n{"项目": "机票", "金额": 1200}\n',
                   encoding="utf-8")
    out = tmp_path / "h.xlsx"
    assert _run(src, out, "--headers", "项目", "金额").returncode == 0
    ws = load_workbook(out).active
    assert ws["A3"].value == "机票"


def test_boolean_is_written_as_text_not_number(tmp_path):
    """Python 里 bool 是 int 的子类，不特判会把 True 写成 1。"""
    src = _write_json(tmp_path / "i.json", {
        "headers": ["项目", "已报销"],
        "rows": [{"项目": "打车", "已报销": True}],
    })
    out = tmp_path / "i.xlsx"
    assert _run(src, out).returncode == 0
    assert load_workbook(out).active["B2"].value == "True"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_rows_to_xlsx.py -v`
Expected: FAIL —— `ModuleNotFoundError: No module named 'rows_to_xlsx'`

- [ ] **Step 3: 写实现**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rows_to_xlsx.py — 把模型产出的 JSON/JSONL 装配成 Excel。

本 PR 全部质量门禁的落点。「PDF 表格转 Excel」和「票据批量转台账」共用它。

为什么装配一定要由脚本做、不能让模型直接写文件：
  1. 模型现写 Python 每次写得不一样，输出不稳定（总设计决策 #3 排除
     「零技能」方案的同一理由）。
  2. 更重要的是——确定性质检需要一个落点。「行列对不齐」「偷偷加了一列」
     「一半字段都没认出来」这些判断必须由代码执行，让模型自查等于没查。

「看不清」和「本来就没有」严格区分（这是本文件最容易被改坏的地方）：
  - 字段出现在 _存疑 里 → 写「⚠ 无法识别」+ 染黄底
  - 值是 null 但不在 _存疑 里 → 留空，什么都不写（票据上本来就没这项）
  混为一谈会制造大量假警报，用户三天就学会无视所有黄格子，标记随之失效。

数值靠 JSON 的类型区分：模型输出 128.5（number）就写成数值，输出 "128.5"
（string）就写成文本。「这是不是一个数」的判断交给看得懂上下文的模型，
写不写成数值的执行交给脚本——只有真数值才能被 =SUM() 算进去。
"""
import argparse
import json
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

UNREADABLE_TEXT = "⚠ 无法识别"
YELLOW_HEX = "FFF2CC"
MAX_UNCERTAIN_RATIO_DEFAULT = 0.5
REVIEW_SHEET = "待核对"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _die(msg: str) -> None:
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


def load(path: Path, headers_arg: list[str] | None) -> tuple[list[str], list[dict], dict]:
    path = Path(path)
    if not path.is_file():
        _die(f"找不到输入文件「{path}」。请确认路径。")
    raw = path.read_text(encoding="utf-8")

    if path.suffix.lower() == ".jsonl":
        # JSONL 各行字段可能不齐（这正是它适合断点续跑的原因），靠首行推断
        # 表头会静默漏列——漏掉的那一列用户根本不会发现。所以强制显式指定。
        if not headers_arg:
            _die("读 .jsonl 必须用 --headers 显式给出表头。"
                 "各行字段可能不齐，靠第一行猜会静默漏列。")
        rows = []
        for i, line in enumerate(raw.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                _die(f"中间文件第 {i} 行不是合法 JSON，可能是上次跑到一半被打断了。"
                     "删掉这一行后重试即可，前面已识别的内容不会丢。")
        return list(headers_arg), rows, {}

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        _die(f"「{path.name}」不是合法的 JSON。")
    headers = headers_arg or payload.get("headers") or []
    return list(headers), payload.get("rows") or [], payload.get("meta") or {}


def _uncertain_fields(row: dict) -> set[str]:
    return {str(d.get("字段")) for d in (row.get("_存疑") or []) if d.get("字段")}


def validate(headers: list[str], rows: list[dict], max_ratio: float) -> None:
    if not headers:
        _die("没有表头，出不了表。请先确定这张表要哪几列。")
    if not rows:
        _die("一行数据都没有，不生成空表格。请确认输入内容。")

    known = set(headers)
    for i, row in enumerate(rows, start=1):
        extra = [k for k in row if not k.startswith("_") and k not in known]
        if extra:
            _die(f"第 {i} 行出现了表头里没有的字段：{'、'.join(extra)}。"
                 "表头是跟用户确认过的，不能中途加列。请把它并进已有列，"
                 "或者先跟用户确认要不要加这一列。")

    uncertain = sum(len(_uncertain_fields(r) & known) for r in rows)
    total = len(rows) * len(headers)
    if total and uncertain / total > max_ratio:
        pct = round(uncertain / total * 100)
        _die(f"这批内容有 {pct}% 的字段没能认出来，超过一半，不生成表格。"
             "一份大半是问号的表，核对的工夫比重新录还多。"
             "建议把图片拍清楚些（光线充足、正对、别有折痕），或改用扫描件重试。")


def build(headers: list[str], rows: list[dict], meta: dict, sheet_name: str) -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name

    ws.append(list(headers))
    for c in ws[1]:
        c.font = Font(bold=True)
        c.alignment = Alignment(vertical="center")
    ws.freeze_panes = "A2"  # 滚动时表头不跑掉

    fill = PatternFill("solid", fgColor=YELLOW_HEX)
    review: list[tuple[str, str, str]] = []

    for row in rows:
        unc = _uncertain_fields(row)
        ws.append([None] * len(headers))
        r = ws.max_row
        for col, name in enumerate(headers, start=1):
            cell = ws.cell(row=r, column=col)
            if name in unc:
                # 染黄底不是装饰：用户拿到 Excel 是拖着滚动条扫的，不会逐格看，
                # 颜色是唯一能在扫视中被捕捉到的信号。
                cell.value = UNREADABLE_TEXT
                cell.fill = fill
                continue
            v = row.get(name)
            if v is None:
                continue  # 本来就没有 → 留空，与「看不清」严格区分
            if isinstance(v, bool):
                cell.value = str(v)  # bool 是 int 的子类，不特判会写成 1
            elif isinstance(v, (int, float)):
                cell.value = v
            else:
                cell.value = str(v)
        for d in row.get("_存疑") or []:
            review.append((str(row.get("_来源") or ""), str(d.get("字段") or ""),
                           str(d.get("原因") or "")))

    for col, name in enumerate(headers, start=1):
        # 收进列表再取 max：用 max(x, *generator) 的写法在只有表头行时
        # 会退化成 max(int) 抛 TypeError。这里虽然已经校验过 rows 非空，
        # 但别把正确性押在别处的校验上。
        lengths = [len(str(name)) * 2 + 2]
        lengths += [len(str(ws.cell(row=r, column=col).value or "")) + 2
                    for r in range(2, ws.max_row + 1)]
        ws.column_dimensions[get_column_letter(col)].width = min(max(lengths), 48)

    # 一个存疑都没有时不建这张表：一张空的「待核对」是噪音，
    # 会让用户以为有东西要核对。
    if review:
        rs = wb.create_sheet(REVIEW_SHEET)
        rs.append(["来源", "字段", "原因"])
        for c in rs[1]:
            c.font = Font(bold=True)
        for item in review:
            rs.append(list(item))
        for col, w in ((1, 32), (2, 16), (3, 60)):
            rs.column_dimensions[get_column_letter(col)].width = w

    if meta.get("标题"):
        wb.properties.title = str(meta["标题"])
    return wb


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把模型产出的 JSON/JSONL 装配成 Excel")
    ap.add_argument("input", help="rows.json 或 rows.jsonl")
    ap.add_argument("-o", "--output", required=True, help="输出 .xlsx")
    ap.add_argument("--headers", nargs="+", help="表头（.jsonl 必填）")
    ap.add_argument("--sheet", default="数据", help="工作表名，默认「数据」")
    ap.add_argument("--max-uncertain-ratio", type=float,
                    default=MAX_UNCERTAIN_RATIO_DEFAULT,
                    help=f"存疑字段占比上限，默认 {MAX_UNCERTAIN_RATIO_DEFAULT}")
    args = ap.parse_args(argv)

    headers, rows, meta = load(Path(args.input), args.headers)
    # 先全部校验通过再写盘：任何一条不合格都整体不落盘，绝不留半成品文件
    # （同 PR 1 pdf_ops.py split 的两阶段做法）。
    validate(headers, rows, args.max_uncertain_ratio)

    wb = build(headers, rows, meta, args.sheet)
    dst = Path(args.output)
    dst.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(dst))
    print(f"已生成 {dst}（{len(rows)} 行 × {len(headers)} 列）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_rows_to_xlsx.py -v`
Expected: 9 passed

- [ ] **Step 5: 跑一遍全部 Python 测试，确认没碰坏 PR 1**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/ -q`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add skills/doc-convert/scripts/rows_to_xlsx.py skills/doc-convert/tests/test_rows_to_xlsx.py
git commit -m "$(cat <<'EOF'
feat(doc-convert): rows_to_xlsx.py —— JSON 装配成 Excel，全部质量门禁在此

四条门禁：零行/空表头拒绝、偷加列拒绝并报第几行、存疑占比超 50% 拒绝、
校验全过才落盘不留半成品。「看不清」染黄底 +「待核对」工作表，
「本来就没有」留空——两者严格区分，否则假警报会让标记整体失效。
数值靠 JSON 类型区分，真数值才能被 =SUM() 算进去。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 清 PR 1 遗留的两处技术债（脚本与文档必须同改）

**注意：** `SKILL.md:145` 的水印示例代码**抄了** `docx_to_pdf.py` 里那行要删的假查找。只改脚本不改文档，文档就在教一个已经不存在的写法。

**Files:**
- Modify: `skills/doc-convert/scripts/docx_to_pdf.py:38-49`（常量）、`:66-72`（find_cjk_font）、`:123`（registerFont）
- Modify: `skills/doc-convert/scripts/pdf_ops.py:132`
- Modify: `skills/doc-convert/SKILL.md:127-149`（水印示例）
- Test: 复用现有 `skills/doc-convert/tests/test_docx_to_pdf.py` 与 `test_pdf_ops.py`

- [ ] **Step 1: 先跑一遍现有测试，记下基线**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_docx_to_pdf.py skills/doc-convert/tests/test_pdf_ops.py -q`
Expected: 全绿（这是重构前的基线，重构后必须还是这个结果）

- [ ] **Step 2: 把 `_CJK_FONT_CANDIDATES` 从 (路径, 索引) 二元组改成纯路径**

`docx_to_pdf.py:38-49` 替换为：

```python
# 候选中文字体路径。原来这里是 (路径, subfontIndex) 的二元组，但 7 个候选的
# index 全是 0，配套的「按路径反查 index」写法（next(i for p, i in ...)）纯属
# 仪式，还埋了一个生产路径不可达的 StopIteration。.ttc 是字体集合，注册时
# 需要 subfontIndex 指定取第几个——我们要的都是集合里的第一个，直接传 0。
_CJK_FONT_CANDIDATES: list[str] = [
    # macOS
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    # Windows
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
    # Linux
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]
```

- [ ] **Step 3: 改 `find_cjk_font` 的遍历**

`docx_to_pdf.py:66-72` 里的循环改为：

```python
    for path in _CJK_FONT_CANDIDATES:
        p = Path(path)
        if p.is_file():
            return p
    return None
```

- [ ] **Step 4: 改 registerFont 处，直接传 0**

`docx_to_pdf.py:121-123` 这三行：

```python
    idx = next(i for p, i in _CJK_FONT_CANDIDATES if Path(p) == font_path)
    if font_path.suffix.lower() == ".ttc":
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path), subfontIndex=idx))
```

替换为（`idx` 那行整行删掉）：

```python
    # .ttc 是字体集合，注册时要指定取第几个；候选表里我们要的都是第一个。
    if font_path.suffix.lower() == ".ttc":
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path), subfontIndex=0))
```

改完跑 `grep -n "idx" skills/doc-convert/scripts/docx_to_pdf.py` 确认无残留。

- [ ] **Step 5: 简化 pdf_ops.py 的多余列表推导**

`pdf_ops.py:132-133` 的两行：

```python
    chunks = [c for c in ranges.split(",")]
    all_pages = [_parse_pages(chunk, total) for chunk in chunks]
```

改为一行（保留上方那段解释「为什么先全校验再写盘」的注释，别删）：

```python
    all_pages = [_parse_pages(chunk, total) for chunk in ranges.split(",")]
```

- [ ] **Step 6: 同步改 SKILL.md 的水印示例**

`SKILL.md:127-149` 的代码块里，把这三行：

```python
from docx_to_pdf import find_cjk_font, _CJK_FONT_CANDIDATES
...
idx = next(i for p, i in _CJK_FONT_CANDIDATES if __import__("pathlib").Path(p) == font_path)
if font_path.suffix.lower() == ".ttc":
    pdfmetrics.registerFont(TTFont(FONT_NAME, str(font_path), subfontIndex=idx))
```

改为：

```python
from docx_to_pdf import find_cjk_font
...
# .ttc 是字体集合，注册时要指定取第几个；我们要的都是第一个，直接传 0。
# .ttf 是单个字体，不用传这个参数。
if font_path.suffix.lower() == ".ttc":
    pdfmetrics.registerFont(TTFont(FONT_NAME, str(font_path), subfontIndex=0))
```

（`import` 那行只留 `find_cjk_font`，`_CJK_FONT_CANDIDATES` 不再需要。）

- [ ] **Step 7: 跑测试确认与基线一致**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/ -q`
Expected: 全绿，条数与 Step 1 + 前面几个 Task 新增的相符

- [ ] **Step 8: Commit**

```bash
git add skills/doc-convert/scripts/docx_to_pdf.py skills/doc-convert/scripts/pdf_ops.py skills/doc-convert/SKILL.md
git commit -m "$(cat <<'EOF'
refactor(doc-convert): 清 PR1 评审记录的两处技术债

_CJK_FONT_CANDIDATES 的 subfontIndex 七个候选全是 0，配套的按路径反查
写法纯属仪式，还埋了个生产路径不可达的 StopIteration——改成纯路径列表，
注册时直接传 0。pdf_ops 的 [c for c in ranges.split(",")] 合并成一行。

SKILL.md 的水印示例抄了那行反查写法，同步改掉——否则文档在教一个
已经不存在的 API。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: SKILL.md 补 A 类四节 + 反幻觉规范

**Files:**
- Modify: `skills/doc-convert/SKILL.md`（frontmatter、正文新增、末尾那句删掉）

**Interfaces:**
- Consumes: Task 2–6 的全部脚本 CLI 与 JSON 形状（**必须与实现逐字一致**，写文档前先 `--help` 跑一遍每个脚本核对参数名）

- [ ] **Step 1: 改 frontmatter 的英文触发词**

`description` 改为（一行，别换行）：

```
Use this skill for document work — converting formats (Markdown to Word, Word to PDF, Excel to/from CSV, PDF merge/split/delete/watermark), extracting text from images and scans (OCR), pulling tables out of PDFs into Excel, turning batches of receipts or invoices into a structured spreadsheet, and summarizing or outlining long documents. 文档处理：提取文字、表格台账、格式转换。
```

- [ ] **Step 2: 改开头那段「当前覆盖四类确定性转换」**

把 `SKILL.md:8-10` 改为：

```markdown
用户丢进一份文件、想要另一种格式或想要里面的内容时用这个技能。能力分两类，
走的路子完全不同，**先分清自己在哪一类**：

- **B 类 · 确定性转换**（格式互转、PDF 页面操作）——**一律调脚本，不要自己现写
  Python**。脚本里已经处理了中文编码、页码换算、字体缺失等一堆坑，现写必然踩回去。
- **A 类 · 需要看懂内容**（提取文字、抽表格、票据台账、长文档提炼）——脚本负责
  取料和装配，**你负责看懂**，中间用 JSON 交接。你**永远不直接生成 xlsx/docx**，
  一律产出 JSON 交给装配脚本写盘。
```

- [ ] **Step 3: 在「四条能力与对应脚本」之前插入 A 类总纲**

新增一节（放在现有 B 类四条之前，因为 A 类是本技能的重心）：

````markdown
## A 类 · 需要看懂内容（走模型）

### 铁律一：你只输出 JSON，装配交给脚本

不要自己写 openpyxl、不要自己拼 docx。理由有两条，第二条更重要：

1. 你每次现写的代码都不一样，输出不稳定。
2. **确定性质检需要一个落点。**「行列对不齐」「偷偷加了一列」「一半字段没认出来」
   这些判断必须由代码执行——让你自查等于没查。

### 铁律二：拿不准就留空，绝不猜

拿不准的字段**留空**，另在 `_存疑` 里写清字段名和原因：

```json
{ "日期": "2026-03-01", "金额": null, "开票方": "某某科技有限公司",
  "_存疑": [{ "字段": "金额", "原因": "折痕遮挡，只能看到 1?8.50" }],
  "_来源": "IMG_0012.jpg" }
```

**`null` 且不在 `_存疑` 里 = 票据上本来就没这项**，与「看不清」严格区分。
把「本来就没有」也标成看不清会制造大量假警报，用户三天就学会无视所有黄格子，
标记随之失效。

数值型字段用 JSON number（`128.5`）而不是字符串（`"128.5"`）——
装配脚本据此决定写数值还是写文本，**只有真数值才能被 Excel 的 `=SUM()` 算进去**。

### 铁律三：批量任务边跑边落盘

一次超过约 20 张图 / 60 页，**先告诉用户大概要多久、征得同意再开工**。
识别一条就往中间文件追加一条（`.jsonl`，一行一条 JSON），别攒到最后一次性写——
中途被打断时前面的成果才不会白费，重跑只补没做完的。
````

- [ ] **Step 4: 写 A 类四条能力的操作说明**

紧接上一节添加四小节。**每条命令都用 `"$DOC_CONVERT_PY"` 开头**，与 B 类一致：

````markdown
### A1. 图片提取文字

```bash
# 先规格化（HEIC 解码 + 缩到模型能高效读的尺寸）
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/img_prep.py 照片.HEIC -d 处理后/
```

然后**你自己读**处理后目录里的 JPG，输出 **Markdown**。

⛔ **只还原图上肉眼可见的结构**（标题、列表、简单表格）。
**不新增层级、不改写措辞、不补全句子。** 版面还原和内容创作只隔一层窗户纸，
越界就成了另一种幻觉——用户拿到的会是一份「读起来很顺、但不是原文」的东西。

看不清的字用 `【无法识别】` 占位，文末附「待核对」小节标明位置。

用户要 Word 时，把这份 Markdown 交给已有的 `md_to_docx.py`，**不要另想办法**：

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/md_to_docx.py 提取结果.md -o 提取结果.docx
```

整张图一个字都认不出、或根本不是文字图片时，**不产出文件**，直接告诉用户。

### A2. PDF 表格转 Excel

```bash
# 1. 抽表 + 体检（有没有文字层）
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_tables.py 报价单.pdf -o 表格.json

# 2. 把相关页渲染成图，供你核对
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_render.py 报价单.pdf --pages "3-4" -d 页图/
```

看 `表格.json` 的 `scanned` 字段分两条路：

**`scanned: false`（有文字层）——你只准改结构，不准改数字。**
脚本抽出来的数字是按坐标从文件里直接读的，逐字准确；你是看图认字，会看错小数点。
你负责的是：合并跨页表头、把挤在一起的两张表拆开、剔除混进表里的页眉页脚行。
**你若觉得某个数字抽错了，不许自己改，记进 `_存疑` 交给人看。**

**`scanned: true`（扫描件）——只能看图读数**，此时全套「拿不准就留空」生效，
并且**交付时必须显眼地告诉用户**：「这份是扫描件，数字是认出来的不是读出来的，
请务必核对，财务用途请以原件为准。」

最后装配：

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/rows_to_xlsx.py 整理后.json -o 表格.xlsx --sheet 明细
```

### A3. 票据批量转台账

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/img_prep.py 票据/*.jpg 票据/*.HEIC -d 处理后/
```

**顺序不能颠倒：**

1. 先认 **1–2 张**做样本，把你打算出的列摊给用户确认一次。默认列是
   **日期 / 票据类型 / 开票方 / 金额 / 税额 / 发票号 / 摘要 / 来源文件**，
   原话大意——「我打算出这几列，火车票的车次要单独一列吗？」
   最后那列「来源文件」是刚需，**不许省**：用户核对时必须知道这行来自哪张图。
2. 用户确认后逐张认，**每认完一张立刻追加一行**到 `台账.jsonl`。
3. 全部完成后装配：

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/rows_to_xlsx.py 台账.jsonl -o 台账.xlsx \
  --headers 日期 票据类型 开票方 金额 税额 发票号 摘要 来源文件 --sheet 台账
```

读 `.jsonl` **必须**带 `--headers`（各行字段可能不齐，靠首行猜会静默漏列）。

某张图根本不是票据：那一行照样写进去，把情况写进 `_存疑`，**不要中断整批**。

### A4. 长文档提炼

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/doc_text.py 年报.pdf --outdir 取料/
```

stdout 会给一份体检报告：`units`（页数/段数）、`chars`（字数）、
`scanned`（是不是扫描件）、`scanned_units`（哪几页没有文字层）。

**开工前先问用户要哪一档**，用人话给选项：

> 你想要哪种？① **摘要**——几段话讲清这份文件说了什么；
> ② **大纲**——章节目录式的结构，方便你定位；
> ③ **完整 Markdown**——全文一字不落转成可编辑的格式。

然后按体检报告分流：

- `scanned: true` → 告诉用户这份没有文字层（扫描件），提炼不了，
  建议改走「图片提取文字」。
- `chars > 30000` → **必须分块逐块读**（每块约 8000 字，块间重叠约 200 字防切断
  句子），每块出小结，最后合并。
- 其余 → 直接读取料文件。

⛔ **两条硬规矩：**

1. 产出开头必须写明覆盖范围，例如「本摘要基于第 1–58 页全文」。
   长文档最大的风险不是总结得不好，是只读了前面一小截就开始总结——
   写明范围是在逼自己确认真的读完了。
2. 关键数字与结论**必须带出处**（取料文件里的 `[P12]` / `[§34]` 锚点就是为此存在）。
   **原文没有的数字一个都不许出现。**

要 Word 时同 A1，走 `md_to_docx.py`。
````

- [ ] **Step 5: 把新脚本的拒绝条件补进「脚本会拒绝干活的几种情况」那张表**

在现有表格末尾追加这些行（保持原有列结构：情况 / 触发脚本 / 脚本怎么反应 / agent 该怎么办）：

| 情况 | 触发脚本 | 脚本怎么反应 | agent 该怎么办 |
| --- | --- | --- | --- |
| 一批图片一张也没处理成功 | `img_prep.py` | 报错退出 | 转达原因（多半是 HEIC 无解码器或根本不是图片），让用户确认文件 |
| HEIC 且本机无解码器 | `img_prep.py` | 该张记进 failed，不中断整批 | 告诉用户把这几张导出成 JPG 再试，别自己找别的办法转 |
| 文档是旧的 `.doc` 格式 | `doc_text.py` | 报错退出 | 让用户在 Word 里另存为 `.docx` 或 PDF |
| 渲染倍率超过 4 | `pdf_render.py` | 报错退出 | 用默认的 2；某页认不清才对**那一页**调高，别整份提高 |
| 有文字层却一张表都没找到 | `pdf_tables.py` | 报错退出，不留空 JSON | 告诉用户这份 PDF 里没有表格，或问他要抽第几页 |
| 一行数据都没有 / 表头为空 | `rows_to_xlsx.py` | 拒绝生成空表格 | 回头检查自己产出的 JSON 是不是空的 |
| 出现表头里没有的字段 | `rows_to_xlsx.py` | 报错并指出第几行、多了哪列 | **不要偷偷加列**。并进已有列，或先跟用户确认要不要加 |
| 存疑字段超过一半 | `rows_to_xlsx.py` | 拒绝生成 | 原样转达：建议重拍（光线充足、正对、别有折痕）或改用扫描件 |
| 读 `.jsonl` 没带 `--headers` | `rows_to_xlsx.py` | 报错退出 | 补上 `--headers`，别改用 `.json` 绕过去 |

- [ ] **Step 6: 删掉末尾那句已经说反的话**

`SKILL.md` 最后一条：

```markdown
- **超出这四条的需求**（PDF 转 Word、图片提取文字、PDF 表格转 Excel……）
  不属于本技能当前范围，如实告诉用户做不了，不要用现写脚本硬凑。
```

替换为：

```markdown
- **超出这八条的需求**（PDF 转 Word 高保真版式还原、PPT 与 PDF 互转、手写体识别……）
  不属于本技能范围，如实告诉用户做不了，不要用现写脚本硬凑。
```

- [ ] **Step 7: 核对文档里每条命令都真能跑**

逐条把 SKILL.md 里新增的命令复制出来实跑一遍（用 `tests/` 里造的样本或临时文件），
确认参数名、短选项、必填项与实现完全一致。**文档写错参数名比没有文档更糟**——
agent 会照着错的敲，然后拿到一屏 argparse 报错。

- [ ] **Step 8: Commit**

```bash
git add skills/doc-convert/SKILL.md
git commit -m "$(cat <<'EOF'
docs(doc-convert): SKILL.md 补 A 类四条能力与反幻觉三条铁律

三条铁律：只输出 JSON 不直接写文件、拿不准就留空且区分「本来就没有」、
批量边跑边落盘。四条能力各给完整命令与分流规则，扫描件路线强制显眼告知。
拒绝清单补九行。末尾那句「图片提取文字不属于本技能范围」删掉——
PR 2 之后它说反了。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 前端三处 —— chip 描述、话术、测试

**Files:**
- Modify: `apps/studio/src/chat/composer/skillChipRegistry.ts:182` 与 `:188`
- Modify: `apps/studio/src/chat/lib/scenarioCatalogDefaults.ts:158`（`DOC_CONVERT_PROMPTS`）
- Modify: `apps/studio/src/chat/lib/scenarioCatalogDefaults.test.ts:54-57` 与 `:59-67`

- [ ] **Step 1: 先改测试，让它红**

`scenarioCatalogDefaults.test.ts` 里把「PR1 首版恰好 4 条话术」那条替换为：

```typescript
  it('八条话术：A 类 4 条（走模型）+ B 类 4 条（走脚本）', () => {
    const item = allSkillItems().find((i) => i.value === DOC_CONVERT_VALUE)
    expect(item?.prompts?.length).toBe(8)
  })

  it('A 类 4 条排在 B 类之前', () => {
    // 列表前几条决定用户对这个技能的第一印象：先看到「AI 真正打得过传统
    // 工具」的那几条，而不是到处都有的「PDF 转 Word」。顺序即产品叙事，
    // 同上面「文档处理紧跟处理表格之后」那条断言的立场。
    const item = allSkillItems().find((i) => i.value === DOC_CONVERT_VALUE)
    const labels = (item?.prompts ?? []).map((p) => p.label)
    expect(labels.slice(0, 4)).toEqual([
      '图片提取文字',
      'PDF 表格转 Excel',
      '票据批量转台账',
      '长文档提炼'
    ])
  })
```

并在「每条话术的文件槽都能选到它真正需要的格式」那条里追加三行断言：

```typescript
    // A 类新增的三个槽。「文稿文件」这条尤其要守：写成「文档文件」会被 word
    // 规则抢先命中，只给 .doc/.docx，PDF 反而选不了——而 PDF 正是长文档提炼
    // 的主力格式。
    expect(acceptForPlaceholder('图片文件')).toBe('image/*')
    expect(acceptForPlaceholder('票据图片')).toBe('image/*')
    expect(acceptForPlaceholder('文稿文件')).toContain('.pdf')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test src/chat/lib/scenarioCatalogDefaults.test.ts`
Expected: FAIL —— 期望 8 条实际 4 条

- [ ] **Step 3: 加 A 类 4 条话术**

`scenarioCatalogDefaults.ts` 的 `DOC_CONVERT_PROMPTS` 数组**开头**插入（放在现有 4 条之前）：

```typescript
  {
    // 「【图片文件】」命中 filePlaceholderPlugin 的 image 规则 → image/*。
    // 文案里点一句「看不清的别猜」，是把技能的反幻觉纪律前置到用户预期里：
    // 用户看到空格子时才知道那是设计而不是 bug。
    label: '图片提取文字',
    text: '把【图片文件】里的文字提取出来，排版结构尽量保留，看不清的地方标出来别猜。'
  },
  {
    // 「【PDF 文件】」命中 pdf 规则 → .pdf。刻意提「能直接算」——
    // 数字必须写成真数值是这条能力和「截个图自己抄」的分界线。
    label: 'PDF 表格转 Excel',
    text: '把【PDF 文件】里的表格提取成 Excel，数字要能直接参与计算。'
  },
  {
    // 「【票据图片】」——「票据」二字不含 台账/表格，不会被前面的 excel 规则
    // 抢跑，落到 image 规则 → image/*（2026-08-11 逐条核对过匹配顺序）。
    label: '票据批量转台账',
    text: '把这些【票据图片】整理成一张 Excel 台账，日期、金额、开票方分列。'
  },
  {
    // 槽必须是「文稿文件」不能是「文档文件」：后者命中 word 规则只给
    // .doc/.docx，PDF 选不了，而 PDF 正是这个场景的主力格式（总设计事实核查 #10）。
    label: '长文档提炼',
    text: '帮我提炼【文稿文件】的要点，先问我要摘要、大纲还是完整 Markdown。'
  },
```

- [ ] **Step 4: 扩写两条 chip 的 description**

`skillChipRegistry.ts:182` 和 `:188` 的 `description: '格式转换、PDF 页面操作'`
**两处都**改为：

```typescript
    description: '提取文字、表格台账、格式转换'
```

并把上方注释里「本版只有 B 类脚本能力」相关的措辞更新掉（如果有）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/studio && bun test src/chat/lib/scenarioCatalogDefaults.test.ts`
Expected: 全绿

- [ ] **Step 6: 跑全量测试与类型检查**

```bash
cd apps/studio && bun test
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```

Expected: bun test 全绿；typecheck 无新增错误（daemon 的 2 个已知红不算）

- [ ] **Step 7: Commit**

```bash
git add apps/studio/src/chat/composer/skillChipRegistry.ts \
        apps/studio/src/chat/lib/scenarioCatalogDefaults.ts \
        apps/studio/src/chat/lib/scenarioCatalogDefaults.test.ts
git commit -m "$(cat <<'EOF'
feat(doc-convert): 话术 4 条扩到 8 条，chip 描述扩回全量能力

A 类 4 条排在 B 类之前：列表前几条决定第一印象，先给「AI 打得过传统工具」
的那几条。两条 chip 的 description 从「格式转换、PDF 页面操作」扩为
「提取文字、表格台账、格式转换」——PR 1 收窄它是为了不 over-promise，
现在能力到位了扩回去。

测试补三个新槽的格式断言，尤其「文稿文件」必须能选 PDF。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 人工验收清单与样本

模型侧的质量没法自动测。这个 Task 交付的是**一张照着对答案的单子**，
不是又一批自动化测试。

**Files:**
- Create: `skills/doc-convert/tests/ACCEPTANCE.md`
- Create: `skills/doc-convert/tests/make_fixtures.py`

**Interfaces:**
- Produces: `make_fixtures.py` 现造三份答案已知的样本到指定目录（**不往仓库塞二进制大文件**）

- [ ] **Step 1: 写造样本的脚本**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_fixtures.py — 现造人工验收用的样本，答案写在 ACCEPTANCE.md 里。

刻意「现造」而不是往仓库里塞几个 PDF/JPG：二进制样本会让仓库越滚越大，
而且真实发票涉及隐私。用法：

    "$DOC_CONVERT_PY" skills/doc-convert/tests/make_fixtures.py -d /tmp/dc-fixtures
"""
import argparse
from pathlib import Path


def make_table_pdf(dst: Path) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle
    data = [
        ["项目", "第一季度", "第二季度", "合计"],
        ["营业收入", "1200.50", "1310.25", "2510.75"],
        ["营业成本", "800.00", "910.10", "1710.10"],
        ["毛利", "400.50", "400.15", "800.65"],
    ]
    t = Table(data)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
    SimpleDocTemplate(str(dst), pagesize=A4).build([t])


def make_receipt_image(dst: Path) -> None:
    """一张字段已知的假票据。刻意把「税额」印得很淡，用来验证存疑标记。"""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (900, 600), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.text((40, 40), "DEMO INVOICE / 测试发票（非真实票据）", fill=(0, 0, 0))
    d.text((40, 120), "Date 2026-03-01", fill=(0, 0, 0))
    d.text((40, 170), "Seller: DEMO TECH CO LTD", fill=(0, 0, 0))
    d.text((40, 220), "No. 12345678", fill=(0, 0, 0))
    d.text((40, 270), "Amount 1280.00", fill=(0, 0, 0))
    d.text((40, 320), "Tax 76.80", fill=(232, 232, 232))  # 极淡 → 应被标存疑
    img.save(dst)


def make_long_pdf(dst: Path, pages: int = 12) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(dst), pagesize=A4)
    for i in range(1, pages + 1):
        c.drawString(72, 760, f"Chapter {i}")
        for line in range(20):
            c.drawString(72, 730 - line * 24,
                         f"Section {i}.{line}: demo body text for acceptance run.")
        c.showPage()
    c.save()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-d", "--outdir", required=True)
    args = ap.parse_args()
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    make_table_pdf(out / "财务表.pdf")
    make_receipt_image(out / "假发票.png")
    make_long_pdf(out / "长文档.pdf")
    print(f"样本已生成到 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: 跑一次确认三份样本都造得出来**

```bash
"$DOC_CONVERT_PY" skills/doc-convert/tests/make_fixtures.py -d /tmp/dc-fixtures
ls -la /tmp/dc-fixtures
```

Expected: 三个文件都在，且都不是 0 字节

- [ ] **Step 3: 写验收清单**

`skills/doc-convert/tests/ACCEPTANCE.md`：

````markdown
# 文档处理技能 · A 类人工验收清单

模型侧的质量没法自动测。这张单子是**照着对答案**用的：先有答案、再看产出。
反过来拿模型的产出当标准答案，等于自己给自己打分。

跑之前先造样本：

```bash
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" skills/doc-convert/tests/make_fixtures.py -d /tmp/dc-fixtures
```

然后在 app 里逐条点场景卡话术，把 `/tmp/dc-fixtures` 里的文件丢进去。

## A1 图片提取文字（用 `假发票.png`）

| 检查项 | 合格 | 不合格 |
|---|---|---|
| 输出格式 | Markdown，结构与图上一致 | 输出了一段散文 |
| 淡到几乎看不见的 `Tax 76.80` | 标成 `【无法识别】` 或明确说不确定 | **直接写了 76.80**（这是幻觉，必须判不合格） |
| 措辞 | 与图上文字一致 | 自行润色、补全了图上没有的句子 |
| 要 Word 时 | 调 `md_to_docx.py` | 自己现写 python-docx |

## A2 PDF 表格转 Excel（用 `财务表.pdf`）

| 检查项 | 合格 | 不合格 |
|---|---|---|
| 数字 | 与 PDF 逐字一致（2510.75 / 1710.10 / 800.65） | 任何一个数字对不上 |
| 单元格类型 | 数字列能直接 `=SUM()` 出结果 | 求和得 0（说明写成了文本） |
| 走的路径 | 调了 `pdf_tables.py` | 自己看图把数字抄出来 |
| 交付说明 | 说清这是有文字层的 PDF、数字是读出来的 | 只丢一个文件路径 |

## A3 票据批量转台账（用 `假发票.png`，可复制几份改名模拟批量）

| 检查项 | 合格 | 不合格 |
|---|---|---|
| 开工顺序 | 先认样本 → 把列摊给用户确认 → 再批量 | 不打招呼直接跑完 |
| 「来源文件」列 | 在，且填的是原始文件名 | 缺这一列 |
| 淡色的税额 | 黄底 + `⚠ 无法识别`，且「待核对」表里有一行 | 猜了一个数字填上 |
| 中间文件 | 有 `.jsonl`，逐条追加 | 一次性攒到最后才写 |

## A4 长文档提炼（用 `长文档.pdf`）

| 检查项 | 合格 | 不合格 |
|---|---|---|
| 开工前 | 先问要摘要 / 大纲 / 完整 Markdown | 自己挑一档就开始 |
| 覆盖范围 | 产出开头写明「基于第 1–12 页全文」 | 没写，或写了但明显只读了前几页 |
| 出处 | 关键结论带 `[P7]` 之类的锚点 | 没有出处 |
| 数字 | 只出现原文有的数字 | 出现了原文没有的数字（判不合格） |

## 兜底检查（四条都要看）

- 任何报错都是中文的 `[doc-convert] 错误：…`，**没有一行 Python 堆栈**
- 被拒绝时**没有留下任何半成品文件**
- 首次使用时提前告知了「要装依赖，需要等几分钟」
````

- [ ] **Step 4: Commit**

```bash
git add skills/doc-convert/tests/ACCEPTANCE.md skills/doc-convert/tests/make_fixtures.py
git commit -m "$(cat <<'EOF'
test(doc-convert): A 类人工验收清单与现造样本脚本

模型侧质量没法自动测，交付一张照着对答案的单子。样本现造不入库：
二进制样本会让仓库越滚越大，真实发票还涉及隐私。假发票刻意把税额印得
极淡，用来验证「拿不准就留空」有没有真的生效。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: 总设计回填 + 开 PR

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md`

- [ ] **Step 1: 回填体积账**

「体积与磁盘代价」一节的表格，把「用户硬盘 实测 66 MB」那行改为：

```markdown
| **用户硬盘** | **mac 约 99 MB / Windows 约 111 MB** | PR 1 后为 66 MB；PR 2 加 pdfplumber（+32.9 MB，含 cryptography 13M / pdfminer 9.3M / pypdfium2 8.0M）与仅 Windows 装的 pillow-heif（+12 MB）。均为 2026-08-11 实测 |
```

- [ ] **Step 2: 撤掉 chip 描述那段「PR 2 别沿用」的警告**

「功能清单」一节里那段「本版只有 B 类脚本能力……PR 2 落地后再把描述扩回去」
改为：

```markdown
描述「提取文字、表格台账、格式转换」（PR 1 时曾临时收窄为「格式转换、PDF
页面操作」以免 over-promise 尚未实现的 A 类；PR 2 落地后已扩回，见
`2026-08-11-doc-convert-skill-pr2-design.md`），
```

- [ ] **Step 3: 撤掉依赖清单那段「PR 2 别忘了加 pdfplumber」的提醒**

「依赖清单」下方那段引用块改为一句：

```markdown
> `pdfplumber` 已于 PR 2 加入（PR 1 刻意未装，因为 B 类脚本用不上它）。
> `pillow-heif` 是 PR 2 新增的，只在 Windows 安装。
```

- [ ] **Step 4: 更新交付顺序一节**

把「后台场景卡配置（改动清单 #8）在 PR 2 合并后统一做一次」保留，
并在 PR 2 那条后面补一句：

```markdown
   PR 2 的详细设计见 `2026-08-11-doc-convert-skill-pr2-design.md`。
```

- [ ] **Step 5: 最后一次全量验证**

```bash
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/ -q
cd apps/studio && bun test
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```

Expected: 三条全过（typecheck 只剩 daemon 的 2 个已知红）

- [ ] **Step 6: Commit 并开 PR**

```bash
git add docs/superpowers/specs/2026-08-10-doc-convert-skill-design.md
git commit -m "$(cat <<'EOF'
docs(doc-convert): 总设计回填 PR2 实测结果

体积账更新为 mac 99MB / Win 111MB；撤掉「PR2 别忘了加 pdfplumber」和
「chip 描述别沿用」两处给未来的提醒——它们已经兑现了。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"

git push -u origin feat/doc-convert-skill-pr2
```

PR 描述里**必须**包含：

- 一行醒目的「**依赖 #30，请先合并那个**」，并把 base 分支设成 `feat/doc-convert-skill`
- 用户硬盘从 66 MB 涨到 99/111 MB 这件事要写出来，别藏在 diff 里
- 「哨兵失效」那个修复要单独说：它影响的是**已经用过 PR 1 的老用户**，
  不修的话他们升级后这个技能是坏的
- 提醒合并后要去生产管理台把场景卡从 4 条话术改成 8 条（先读线上配置再整表覆盖）

---

## 收尾：合并后要做的事（不在本 PR 的 diff 里）

1. **生产管理台配置场景卡**：话术从 4 条改 8 条。**先读线上现有配置，在其上修改后整表 PUT**——后台是整份覆盖不是追加，直接提交会把别的技能配置抹掉。
2. **真机走查**：`bun run dev` 起应用，照 `tests/ACCEPTANCE.md` 把四条能力各跑一遍。
3. **登录态验收**：用真实登录账号再看一遍 8 条话术在不在——已登录用户读的是远端目录，不读代码里的默认表。
