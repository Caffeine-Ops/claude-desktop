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
    try:
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
        try:
            outdir.mkdir(parents=True, exist_ok=True)
        except Exception:
            # 写盘调用单独兜底，不能让磁盘满/权限拒绝这类系统层异常
            # 裸露成 Traceback——同 img_prep.py 的纪律。
            _die(f"无法创建输出目录 {outdir}，请检查目录权限或磁盘空间。")

        text_file = outdir / (src.stem + ".text.txt")
        try:
            text_file.write_text(render_anchored(units, kind), encoding="utf-8")
        except Exception:
            _die(f"写入文本文件 {text_file} 失败，请检查目标目录权限或磁盘空间。")

        report["source"] = src.name
        report["text_file"] = str(text_file)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        # 兜底：main() 必须有这一层，逐个函数自觉包 try 是不够的——任何未
        # 预期的异常（哪怕来自看起来无辜的一行代码）都要转成中文错误，
        # 不能让裸 Traceback 打到用户面前。这是本 PR 的全局约束，
        # 同 img_prep.py / md_to_docx.py 等脚本的纪律保持一致。
        _die(f"处理过程中出错：{type(e).__name__}: {e}")


if __name__ == "__main__":
    raise SystemExit(main())
