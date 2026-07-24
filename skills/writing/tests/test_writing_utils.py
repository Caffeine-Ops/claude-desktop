"""writing_utils 的行为测试。

启发式打分的阈值是可调常量，所以这里钉的是**行为**（切分正确、
均匀文本的变异系数低于参差文本），不钉具体数值。
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import writing_utils as wu


def test_split_sentences_handles_chinese_punctuation():
    text = "他走了。你为什么不拦？真可惜！"
    assert wu.split_sentences(text) == ["他走了。", "你为什么不拦？", "真可惜！"]


def test_split_sentences_absorbs_closing_quote():
    text = "他说：“我不去。”她没回答。"
    assert wu.split_sentences(text) == ["他说：“我不去。”", "她没回答。"]


def test_split_sentences_keeps_tail_without_punctuation():
    assert wu.split_sentences("没有句号的结尾") == ["没有句号的结尾"]


def test_split_paragraphs_drops_blank_lines():
    text = "第一段\n\n第二段\n   \n第三段"
    assert wu.split_paragraphs(text) == ["第一段", "第二段", "第三段"]


def test_strip_markdown_removes_headings_and_fences():
    text = "# 标题\n正文一\n```py\ncode()\n```\n> 引用内容\n正文二"
    assert wu.strip_markdown(text) == "正文一\n引用内容\n正文二"


def test_cv_uniform_lower_than_varied():
    uniform = [20, 21, 20, 19, 20]
    varied = [4, 38, 12, 51, 7]
    assert wu.coefficient_of_variation(uniform) < wu.coefficient_of_variation(varied)


def test_cv_single_value_is_zero():
    assert wu.coefficient_of_variation([10]) == 0.0


def test_find_hits_reports_line_and_column():
    text = "首先我们来看\n第二行没有\n其次再说一点"
    hits = wu.find_hits(text, re.compile("首先|其次"), rule="套话")
    assert [(h.line, h.text) for h in hits] == [(1, "首先"), (3, "其次")]
    assert hits[0].col == 1
    assert hits[0].rule == "套话"


def test_load_wordlist_skips_comments_and_blanks(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "demo.txt").write_text("# 注释\n首先\n\n其次\n", encoding="utf-8")
    monkeypatch.setattr(wu, "DATA_DIR", data_dir)
    assert wu.load_wordlist("demo") == ["首先", "其次"]


def test_parse_spec_lock_reads_sections(tmp_path):
    p = tmp_path / "spec_lock.md"
    p.write_text(
        "## 体裁\n- genre: short-story\n- sub: 悬疑推理\n\n"
        "## 禁用清单\n- 禁用词: 首先, 其次\n- 禁用句式: 三段式排比\n",
        encoding="utf-8",
    )
    spec = wu.parse_spec_lock(p)
    assert spec["体裁"]["genre"] == "short-story"
    assert spec["体裁"]["sub"] == "悬疑推理"
    assert spec["禁用清单"]["禁用词"] == "首先, 其次"


def test_split_data_line_simple_key_value():
    assert wu.split_data_line("voice: 冷峻克制") == ("voice", "冷峻克制")


def test_split_data_line_pipe_record_splits_on_pipe_not_colon():
    # 竖线记录里的冒号在竖线之后 —— 按冒号切会得到废键「张明 | want」
    key, value = wu.split_data_line("张明 | want:找到妹妹 | need:原谅自己")
    assert key == "张明"
    assert value == "want:找到妹妹 | need:原谅自己"


def test_split_data_line_returns_none_for_plain_text():
    assert wu.split_data_line("这行没有分隔符") is None


def test_parse_spec_lock_handles_character_and_foreshadow_rows(tmp_path):
    p = tmp_path / "spec_lock.md"
    p.write_text(
        "## 人物档案\n- 张明 | want:找到妹妹 | wound:车祸中独自生还\n\n"
        "## 伏笔表\n- 001 | 埋点:第2节 钥匙 | 回收:第5节 | 状态:已埋未收\n",
        encoding="utf-8",
    )
    spec = wu.parse_spec_lock(p)
    assert "张明" in spec["人物档案"]
    assert "001" in spec["伏笔表"]
    assert spec["伏笔表"]["001"].endswith("状态:已埋未收")
