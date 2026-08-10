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
