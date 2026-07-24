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
