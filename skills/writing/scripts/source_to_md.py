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
