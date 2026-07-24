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
