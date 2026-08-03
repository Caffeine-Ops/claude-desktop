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


def test_asterisk_as_multiplication_not_italicized():
    # 「长*宽*高」里的星号是乘号 —— 收尾星号后紧跟汉字，不能被当斜体吞掉
    plain = export.md_to_plain("面积是 长*宽*高 的乘积")
    assert "长*宽*高" in plain
    html = export.md_to_wechat_html("面积是 长*宽*高 的乘积", STYLE)
    assert "<em" not in html


def test_real_italic_still_rendered():
    # 收尾星号后跟标点/结尾的，仍是正常斜体（现有用法不能被误伤）
    html = export.md_to_wechat_html("这里*有点意思*。", STYLE)
    assert '<em style="font-style:italic;">有点意思</em>' in html


def test_h4_to_h6_headings_not_leaked():
    # 4–6 级标题不能把 #### 原样漏进读者可见输出
    html = export.md_to_wechat_html("#### 四级标题", STYLE)
    assert "####" not in html
    assert "四级标题" in html
    plain = export.md_to_plain("##### 五级标题")
    assert "#" not in plain
    assert "五级标题" in plain


def test_parse_images_extracts_caption_src_and_line():
    md = "开头。\n\n![深夜的便利店](../images/gen-1.png)\n\n结尾。"
    refs = export.parse_images(md)
    assert len(refs) == 1
    assert refs[0].caption == "深夜的便利店"
    assert refs[0].src == "../images/gen-1.png"
    assert refs[0].line == 3


def test_parse_images_ignores_normal_links():
    assert export.parse_images("详见[报告](https://example.com/a)。") == []


def test_parse_images_skips_fenced_blocks():
    """mermaid / 代码块里出现的图片语法是示例文本，不是真配图。
    当成真配图会导致导出闸报「缺图」，卡住一次本该成功的导出。"""
    md = "正文。\n\n```markdown\n![示例](../images/nope.png)\n```\n"
    assert export.parse_images(md) == []


def test_resolve_image_path_is_relative_to_markdown_file(tmp_path):
    """正文在 drafts/、图在 images/，相对路径必须按 md 文件所在目录解析，
    不是按当前工作目录——否则从别处跑导出脚本就全找不到图。"""
    md_path = tmp_path / "drafts" / "01.md"
    resolved = export.resolve_image_path("../images/a.png", md_path)
    assert resolved == tmp_path / "images" / "a.png"


def test_resolve_image_path_passes_absolute_through(tmp_path):
    abs_src = str(tmp_path / "images" / "a.png")
    assert export.resolve_image_path(abs_src, tmp_path / "drafts" / "01.md") == Path(abs_src)


def test_missing_images_reports_only_absent_files(tmp_path):
    (tmp_path / "images").mkdir()
    (tmp_path / "images" / "there.png").write_bytes(b"x")
    (tmp_path / "drafts").mkdir()
    md_path = tmp_path / "drafts" / "01.md"
    md = "![在的](../images/there.png)\n\n![不在的](../images/gone.png)"
    md_path.write_text(md, encoding="utf-8")
    missing = export.missing_images(md, md_path)
    assert [r.src for r in missing] == ["../images/gone.png"]


def test_main_blocks_export_when_image_missing(tmp_path, capsys):
    """缺图必须停下报清单，而不是导出一份引用损坏的稿。
    下游（公众号编辑器 / Word）不会在这一层报错，带着缺口跑完
    只会产出一份看着成功、打开全是碎图的成品。"""
    (tmp_path / "drafts").mkdir()
    md_path = tmp_path / "drafts" / "01.md"
    md_path.write_text("正文。\n\n![缺的](../images/gone.png)\n", encoding="utf-8")
    code = export.main([str(md_path), "--format", "plain", "--out", str(tmp_path / "o.txt")])
    assert code == 1
    assert "gone.png" in capsys.readouterr().out
    assert not (tmp_path / "o.txt").exists()


def test_wechat_html_renders_image_with_caption():
    """公众号里图和图说是一体的：<img> 后跟一行居中小字图说。
    图说为空时不产出空的说明行（留着是一条视觉上莫名其妙的空隙）。"""
    style = export.load_style("wechat-default")
    html_out = export.md_to_wechat_html("![深夜的便利店](../images/gen-1.png)", style)
    assert 'src="../images/gen-1.png"' in html_out
    assert "深夜的便利店" in html_out
    assert "<p" not in html_out.split("<img")[0]  # 图不该被包成普通段落


def test_wechat_html_image_without_caption_has_no_caption_line():
    style = export.load_style("wechat-default")
    html_out = export.md_to_wechat_html("![](../images/gen-1.png)", style)
    assert "<img" in html_out
    assert "figcaption" not in html_out


def test_wechat_html_escapes_caption():
    """图说来自 AI 生成的文本，可能含 < >，不转义就把 HTML 结构打坏了。"""
    style = export.load_style("wechat-default")
    html_out = export.md_to_wechat_html('![a<b>c](../images/x.png)', style)
    assert "<b>" not in html_out
    assert "&lt;b&gt;" in html_out


def test_plain_export_renders_image_as_caption_marker():
    """纯文本没法放图，退化成一个人能看懂的占位标记，
    而不是把 markdown 语法原样漏给读者。"""
    out = export.md_to_plain("![深夜的便利店](../images/gen-1.png)")
    assert out == "［图：深夜的便利店］"


def test_docx_embeds_existing_image(tmp_path):
    import base64

    from docx import Document

    (tmp_path / "images").mkdir()
    (tmp_path / "drafts").mkdir()
    # 1x1 透明 PNG。用 base64 而不是手打 hex：hex 串抄错一个字符，
    # python-docx 报的是「无法识别的图片格式」，会被误当成实现有 bug。
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    )
    (tmp_path / "images" / "a.png").write_bytes(png)
    md_path = tmp_path / "drafts" / "01.md"
    out = tmp_path / "o.docx"
    export.md_to_docx("正文。\n\n![图说](../images/a.png)\n", out, md_path)
    doc = Document(str(out))
    assert len(doc.inline_shapes) == 1


def test_copy_images_numbers_files_in_document_order(tmp_path):
    """文件名带序号，是为了让人在公众号编辑器里能按顺序对着插——
    原始文件名（gen-1754…png）对人没有任何顺序信息。"""
    (tmp_path / "images").mkdir()
    (tmp_path / "drafts").mkdir()
    for name in ("b.png", "a.png"):
        (tmp_path / "images" / name).write_bytes(b"x")
    md_path = tmp_path / "drafts" / "01.md"
    refs = export.parse_images("![二](../images/b.png)\n\n![一](../images/a.png)")
    out_dir = tmp_path / "output"
    pairs = export.copy_images(refs, md_path, out_dir)
    assert [name for _, name in pairs] == ["01-b.png", "02-a.png"]
    assert (out_dir / "images" / "01-b.png").is_file()
    assert (out_dir / "images" / "02-a.png").is_file()


def test_build_image_manifest_marks_cover_separately():
    """公众号封面在编辑器里是独立上传项、不进正文。
    不单独标出来，用户会把封面当成正文第一张图插进去。"""
    refs = export.parse_images("![封面](../images/a.png)\n\n![流程](../images/b.png)")
    pairs = [(refs[0], "01-a.png"), (refs[1], "02-b.png")]
    text = export.build_image_manifest(pairs, cover_first=True)
    assert "封面" in text
    assert "01-a.png" in text and "02-b.png" in text
    assert "output/images/" in text


def test_build_image_manifest_without_cover_lists_all_inline():
    refs = export.parse_images("![流程](../images/b.png)")
    text = export.build_image_manifest([(refs[0], "01-b.png")], cover_first=False)
    assert "封面" not in text


def test_build_image_manifest_is_empty_without_images():
    assert export.build_image_manifest([], cover_first=False) == ""
