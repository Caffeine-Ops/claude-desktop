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
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
STYLES_DIR = SKILL_DIR / "templates" / "export_styles"

# #{1,6}：h1–h6 全收。只匹配 1–3 会让 #### 原样漏进读者可见输出，
# 且与 strip_markdown / readability 的 #{1,6} 口径不一致。
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_QUOTE = re.compile(r"^>\s?(.*)$")
_LIST_ITEM = re.compile(r"^[-*]\s+(.*)$")
_HR = re.compile(r"^\s*(-{3,}|\*{3,})\s*$")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
# 收尾星号后不能紧跟「词字」（汉字/字母/数字）——这一条把「长*宽*高」这种
# 用星号当乘号/脚注的写法排除掉（它的收尾 * 后跟着汉字），避免被当斜体吞掉星号；
# 正常斜体的收尾 * 后面是标点/空格/行尾（如「*有点意思*。」），照常识别。
# 内容不含 *（[^*]+?）以免跨过下一个星号误配。
_ITALIC = re.compile(r"(?<!\*)\*(?!\*)([^*]+?)\*(?![\w*])")

# 图片语法。前导 ! 是与普通链接的唯一区别；路径部分排除空白与右括号，
# 后面可选一个 markdown 标题后缀 `"..."`（`![图](路径 "标题")`）。
# 与 writing_utils._IMAGE_SYNTAX 是两份正则、口径刻意不同：那边只需要
# 「整体删掉」，这边要**分组取出** caption 与 src，合并成一份反而两头别扭。
_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


@dataclass
class ImageRef:
    """正文里的一处配图引用。line 是 1-based 行号——缺图报告要能让人直接跳过去。"""

    caption: str
    src: str
    line: int


def parse_images(markdown: str) -> list[ImageRef]:
    """抽出正文里的全部配图引用。

    **围栏代码块内的图片语法一律跳过**：那是示例文本（mermaid 块、
    教程里贴的 markdown 片段），不是真配图。当成真配图会让导出闸误报
    「缺图」，卡住一次本该成功的导出。
    """
    refs: list[ImageRef] = []
    in_fence = False
    for idx, raw in enumerate(markdown.splitlines(), start=1):
        if raw.lstrip().startswith("```"):
            # 单纯取反、不配对校验：一个孤立/不成对的 ``` 会让 in_fence
            # 从此再翻不回来，后面所有图片引用都被当成围栏内容漏检。
            # 接受这个代价——格式坏掉的围栏本来就会把全文渲染带歪，
            # 真去配对纠错（找下一个 ``` 收口、处理嵌套）比这道闸该担的事重得多。
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in _IMAGE.finditer(raw):
            refs.append(ImageRef(caption=m.group(1).strip(), src=m.group(2), line=idx))
    return refs


def resolve_image_path(src: str, md_path: Path) -> Path:
    """相对路径按**正文文件所在目录**解析，不是按 cwd。

    正文在 `<项目>/drafts/`、图在 `<项目>/images/`，相对路径恒为
    `../images/x.png`。若按 cwd 解析，从项目外任何地方跑导出都会找不到图，
    而且报的错是「文件不存在」而非「路径基准错了」，极难排查。
    """
    p = Path(src)
    return p if p.is_absolute() else (md_path.parent / p).resolve()


def missing_images(markdown: str, md_path: Path) -> list[ImageRef]:
    """返回磁盘上找不到的配图引用，保持正文中的出现顺序。"""
    return [r for r in parse_images(markdown) if not resolve_image_path(r.src, md_path).is_file()]


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


def copy_images(refs: list[ImageRef], md_path: Path, out_dir: Path) -> list[tuple[ImageRef, str]]:
    """把正文用到的图复制进 `<out_dir>/images/`，按正文出现顺序编号。

    为什么要复制而不是让 HTML 指回项目里的原图：导出产物是**要交出去的一包**
    （发给自己手机、发给同事代发），指回项目路径的 HTML 换台机器就全断。
    为什么要重编号：原始文件名（gen-1754…png）对人零顺序信息，而公众号
    必须由人按顺序手工插图——序号就是那份操作顺序。
    """
    dest_dir = out_dir / "images"
    dest_dir.mkdir(parents=True, exist_ok=True)
    pairs: list[tuple[ImageRef, str]] = []
    for i, ref in enumerate(refs, start=1):
        source = resolve_image_path(ref.src, md_path)
        name = f"{i:02d}-{source.name}"
        shutil.copyfile(source, dest_dir / name)
        pairs.append((ref, name))
    return pairs


def build_image_manifest(pairs: list[tuple[ImageRef, str]], cover_first: bool) -> str:
    """贴在导出 HTML 顶部的插图说明块。

    为什么必须有这块东西：**微信编辑器会丢弃所有指向本地文件的图**
    （它只认已上传到微信服务器的图），也不支持 data URI。也就是说
    「粘一次全带图」在这个平台上做不到——这是平台限制，不是实现偷懒。
    能做的只有把手工步骤压到最低：图按序号命名、逐张列出该插在哪。
    样式内联，理由同全篇（公众号会剥掉 <style> 与 class）。
    """
    if not pairs:
        return ""
    rows: list[str] = []
    for idx, (ref, name) in enumerate(pairs):
        role = "封面（在编辑器的封面位单独上传，不要插进正文）" if (cover_first and idx == 0) else f"正文第 {ref.line} 行"
        cap = html.escape(ref.caption or "无图说", quote=False)
        rows.append(f"<li style=\"margin:0.3em 0;\">「{cap}」 → <code>output/images/{html.escape(name, quote=False)}</code>　·　{role}</li>")
    return (
        '<div style="border:1px dashed #cccccc;background:#fafafa;padding:1em 1.2em;margin:0 0 1.6em 0;'
        'font-size:14px;color:#666666;line-height:1.7;">'
        f'<strong style="color:#333333;">本文共 {len(pairs)} 张配图，需在公众号编辑器里手工插入</strong>'
        '<br />（微信会丢弃指向本地文件的图，这一步无法自动化）'
        f'<ol style="margin:0.6em 0 0 0;padding-left:1.4em;">{"".join(rows)}</ol>'
        '</div>'
    )


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

        # 图独占一行 → 图 + 图说，不包进 <p>（公众号里 <p> 的 margin 会把
        # 图和图说撑开成两块不相干的东西）。样式键用 .get 兜底：用户可能自带
        # 一份没有 img/figcaption 键的样式 JSON，KeyError 会让整次导出崩掉。
        m = _IMAGE.fullmatch(line.strip())
        if m:
            close_list()
            caption, src = m.group(1).strip(), m.group(2)
            img_style = style.get("img", "display:block;max-width:100%;height:auto;margin:1.4em auto 0.4em auto;")
            out.append(f'<img src="{html.escape(src, quote=True)}" alt="{html.escape(caption, quote=True)}" style="{img_style}" />')
            if caption:
                cap_style = style.get("figcaption", "display:block;text-align:center;font-size:13px;color:#999999;")
                out.append(f'<figcaption style="{cap_style}">{html.escape(caption, quote=False)}</figcaption>')
            continue

        if _HR.match(line):
            close_list()
            out.append(f'<hr style="{style["hr"]}" />')
            continue

        m = _HEADING.match(line)
        if m:
            close_list()
            # 样式表只到 h3；4–6 级钳到 h3 渲染——公众号正文极少用到 h4+，
            # 用 h3 样式呈现远好过让 #### 泄漏，也不会 KeyError。
            level = min(len(m.group(1)), 3)
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
        # 纯文本没法放图，退化成人能看懂的占位标记——把 markdown 语法
        # 原样漏给读者（朋友圈/私域话术会被直接复制粘贴）是最糟的结果。
        line = _IMAGE.sub(lambda m: f"［图：{m.group(1).strip() or '配图'}］", line)
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


def md_to_docx(markdown: str, out_path: Path, md_path: Path) -> None:
    """导出 Word。依赖 python-docx（requirements.txt 已列）。

    多收一个 md_path：图片在正文里是相对路径（../images/x.png），
    要按**正文文件所在目录**解析才找得到——见 resolve_image_path 的注释。
    """
    try:
        from docx import Document
        from docx.shared import Inches
    except ImportError:
        raise SystemExit("[writing] 错误：导出 docx 需要 python-docx，请先跑 bin/ensure-python.sh 装依赖")

    doc = Document()
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line or _HR.match(line):
            continue
        # 图独占一行 → 嵌图 + 图说段。宽度钉 5.5 英寸（A4 正文宽度），
        # 不钉会按图片像素尺寸铺开，大图直接溢出页面。
        m = _IMAGE.fullmatch(line)
        if m:
            caption, src = m.group(1).strip(), m.group(2)
            doc.add_picture(str(resolve_image_path(src, md_path)), width=Inches(5.5))
            if caption:
                doc.add_paragraph(caption, style="Caption")
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

    # 图片就位闸：缺图停下报清单，绝不导出一份引用损坏的稿。
    # 下游导出器（公众号编辑器 / python-docx）不在这一层检测缺失，
    # 带着缺口跑完只会产出一份「看着成功、打开全是碎图」的成品。
    # 同源做法见 ppt-master 的 Image readiness GATE。
    missing = missing_images(markdown, src)
    if missing:
        print(f"[writing] ✗ 有 {len(missing)} 张配图找不到文件，导出已中止：")
        for ref in missing:
            print(f"  - 第 {ref.line} 行「{ref.caption or '无图说'}」→ {ref.src}")
        print("[writing] 请先把缺的图放到上述路径，或从正文里删掉这些引用，再重跑导出。")
        return 1

    suffix = {"wechat": ".html", "plain": ".txt", "docx": ".docx"}[args.format]
    out_path = Path(args.out) if args.out else src.with_suffix(suffix)

    if args.format == "wechat":
        style = load_style(args.style)
        body = md_to_wechat_html(markdown, style)
        refs = parse_images(markdown)
        # cover_first：有图就把第一张当封面。**刻意不去读契约的 image_plan**——
        # export.py 收的是一个 md 文件路径，不是项目路径，正文可能来自
        # `<cwd>/写作/` 这类没有契约的单文件场景，为此反推项目根既脆弱又多余。
        # 代价可控：判错时只是多提示一句「第一张是封面」，而漏提示会让用户
        # 把封面当正文图插错位——两种错的代价不对称，取宁可多提示的那边。
        cover_first = bool(refs)
        pairs = copy_images(refs, src, out_path.parent) if refs else []
        out_path.write_text(build_image_manifest(pairs, cover_first) + body, encoding="utf-8")
        if pairs:
            print(f"[writing] 已复制 {len(pairs)} 张配图到：{out_path.parent / 'images'}")
    elif args.format == "plain":
        out_path.write_text(md_to_plain(markdown), encoding="utf-8")
    else:
        md_to_docx(markdown, out_path, src)

    print(f"[writing] 已导出：{out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
