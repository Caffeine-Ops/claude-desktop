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
from docx.opc.exceptions import PackageNotFoundError
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

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

_FONT_NAME = "DocConvertCJK"


def _die(msg: str) -> None:
    """统一的中文报错出口，措辞与 doc_text.py / pdf_tables.py 等脚本对齐。"""
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


# which 落空后的默认安装路径候选表。macOS 装了 LibreOffice.app 但没把 soffice
# 加进 PATH 是常态；Windows 的安装器则**从不**写 PATH——只查 which 的话，
# Windows 用户装了 LibreOffice 也会被当成没装，永远走不到保排版路径、
# 只能被引导去纯文字兜底（2026-08-14 Windows CI 验证的后续发现）。
_SOFFICE_DEFAULTS = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]


def find_soffice() -> str | None:
    """找 LibreOffice 的无头可执行文件；没有返回 None。"""
    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    for cand in _SOFFICE_DEFAULTS:
        if Path(cand).is_file():
            return cand
    return None


def find_cjk_font() -> Path | None:
    """找一个能显示中文的字体文件；没有返回 None。"""
    for path in _CJK_FONT_CANDIDATES:
        p = Path(path)
        if p.is_file():
            return p
    return None


def _convert_with_soffice(soffice: str, src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    # soffice 只认「输出目录」，文件名由它按输入名决定，转完再改名到 dst
    try:
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(dst.parent), str(src)],
            check=True,
            capture_output=True,
            timeout=300,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        # 评审后加固：这里原本让 subprocess 的异常直接冒泡，出来的是一整屏英文
        # Python 堆栈。最常踩这条的场景恰恰是本技能的默认主路径——本机装了
        # LibreOffice、但用户桌面正开着它，无头模式 soffice 抢不到用户配置目录的
        # 锁就会启动失败或卡死超时。所以这里统一收口成中文错误，并把 soffice 自己
        # 的报错尾部带出来帮排查（stderr 可能很长，只截尾部几行，头部大多是版权信息）。
        detail = ""
        stderr = getattr(e, "stderr", None)
        if stderr:
            text = stderr.decode("utf-8", errors="replace") if isinstance(stderr, bytes) else str(stderr)
            tail = "\n".join(text.strip().splitlines()[-5:])
            if tail:
                detail = f"\n  LibreOffice 报错原文（最后几行）：\n  {tail}"
        timeout_hint = "（等待超过 300 秒仍未完成，多半是被卡住了）" if isinstance(e, subprocess.TimeoutExpired) else ""
        print(
            f"[doc-convert] 错误：调用 LibreOffice 转换失败{timeout_hint}。"
            "如果你电脑上正开着 LibreOffice（或 Word），无头转换经常会因为抢不到"
            f"配置文件锁而失败——请先把它关掉再重试。{detail}",
            file=sys.stderr,
        )
        raise SystemExit(2) from e

    # 评审实测：soffice 还有一类**「假成功」**——退出码 0、stderr 干净，但
    # 一个 PDF 都没写出来。上面那个 try 包不住它（它包的是「调用本身失败」，
    # 这里是「调用成功但没产物」），于是紧接着的 produced.replace(dst) 会抛
    # 一屏 FileNotFoundError 英文堆栈——正好是上面那段注释声称已经收口掉的
    # 失败形态。触发条件很日常：源文件扩展名是 .docx 但内容其实不是 Word
    # 文档（用户手动改过扩展名、或下载下来的是伪装成 docx 的别的格式），
    # 以及本机已经开着 LibreOffice 时它偶尔会静默 no-op。所以改名前必须
    # 先确认产物真的在磁盘上。
    produced = dst.parent / (src.stem + ".pdf")
    if not produced.is_file():
        print(
            f"[doc-convert] 错误：LibreOffice 报告转换完成，却没有生成 PDF。"
            f"最常见的原因是「{src.name}」并不是真正的 Word 文档"
            "（扩展名是 .docx，内容其实是别的格式）；其次是本机正开着 "
            "LibreOffice / Word 抢占了配置目录。请先确认文件能正常打开、"
            "并关掉 LibreOffice 后重试。",
            file=sys.stderr,
        )
        raise SystemExit(2)
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

    # .ttc 是字体集合，注册时要指定取第几个；候选表里我们要的都是第一个。
    if font_path.suffix.lower() == ".ttc":
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path), subfontIndex=0))
    else:
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path)))

    base = getSampleStyleSheet()
    body = ParagraphStyle(
        "Body", parent=base["Normal"], fontName=_FONT_NAME, fontSize=11, leading=18
    )
    head = ParagraphStyle(
        "Head", parent=base["Heading1"], fontName=_FONT_NAME, fontSize=16, leading=22
    )

    # 评审后加固：前端【Word 文件】槽放行 `.doc`（旧的二进制格式，不是 zip 容器）。
    # 装了 LibreOffice 时 `.doc` 走上面那条路转得好好的；但没装 LibreOffice 又落到
    # 这条纯文字兜底时，python-docx 拿旧格式当 zip 包打开会直接抛
    # PackageNotFoundError，冒泡出去又是一屏英文堆栈。这里统一收口成中文提示。
    try:
        paragraphs = Document(str(src)).paragraphs
    except PackageNotFoundError:
        print(
            f"[doc-convert] 错误：「{src.name}」不是 .docx 格式（.doc 是旧的二进制格式，"
            "本工具的纯文字兜底路径读不了）。请先在 Word 里用「另存为」转成 .docx，"
            "或者安装 LibreOffice 走保留排版的路径。",
            file=sys.stderr,
        )
        raise SystemExit(3)

    flow = []
    has_text = False  # 用来判断是否有实际文字，不能用 flow 的真假——全是 Spacer 的文档会误判
    for para in paragraphs:
        text = para.text.strip()
        if not text:
            flow.append(Spacer(1, 6))
            continue
        has_text = True  # 找到了至少一个有内容的段落
        style = head if para.style.name.startswith("Heading") else body
        # reportlab 的 Paragraph 会解析类 HTML 标记，正文里的 & < > 必须转义
        safe = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        flow.append(Paragraph(safe, style))
        flow.append(Spacer(1, 4))

    if not has_text:
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
    try:
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
            _die(f"找不到输入文件 {src}")

        mode = convert(src, Path(args.output), args.allow_textonly)
        if mode == "textonly":
            print(
                f"[doc-convert] 已生成 {args.output}（纯文字版：表格、图片与排版已丢失）"
            )
        else:
            print(f"[doc-convert] 已生成 {args.output}（保留原排版）")
        return 0
    except Exception as e:
        # 兜底：main() 必须有这一层，逐个函数自觉包 try 是不够的——任何未预期的
        # 异常（reportlab 写盘遇到只读目录、字体文件损坏……）都要转成中文错误，
        # 不能让裸 Traceback 打到用户面前。这是本 PR 的全局约束，同
        # doc_text.py / pdf_tables.py / img_prep.py 的纪律一致。
        # SystemExit 继承 BaseException 而不是 Exception，所以上面那些
        # 「主动中文报错后退出」不会被这里重新包一层。
        _die(f"处理过程中出错：{type(e).__name__}: {e}")
        return 2  # 不可达，只为类型完整


if __name__ == "__main__":
    raise SystemExit(main())
