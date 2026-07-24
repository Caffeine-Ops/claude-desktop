import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import style_profile as sp

SAMPLE_A = """我不太喜欢讲大道理。
说白了，就是把事情做完。
上周改了 37 版标题，最后用的是地铁上想出来的那版，9 个字。
说白了，写东西这件事没什么捷径。"""

SAMPLE_B = """周三下午开了三个小时的会。
说白了，没人真的在听。
我数了数，全程有 14 次有人在看手机。"""


def test_build_returns_expected_keys():
    profile = sp.build([SAMPLE_A, SAMPLE_B])
    for key in ("样本数", "总字数", "平均句长", "句长变异系数", "平均段长", "高频短语", "标点偏好"):
        assert key in profile


def test_frequent_phrase_detected():
    profile = sp.build([SAMPLE_A, SAMPLE_B])
    phrases = [p["短语"] for p in profile["高频短语"]]
    assert "说白了" in phrases


def test_frequent_phrase_requires_repetition():
    # 只出现一次的短语不该进高频表
    profile = sp.build(["这句话只说一次而已。"])
    phrases = [p["短语"] for p in profile["高频短语"]]
    assert "只说一次" not in phrases


def test_average_sentence_length_is_positive():
    profile = sp.build([SAMPLE_A])
    assert profile["平均句长"] > 0


def test_punctuation_preference_counts_question_marks():
    profile = sp.build(["真的吗？为什么呢？我不信。"])
    assert profile["标点偏好"]["？"] == 2


def test_render_markdown_contains_sections():
    md = sp.render_markdown(sp.build([SAMPLE_A, SAMPLE_B]))
    assert "# 个人文风档案" in md
    assert "## 统计特征" in md
    assert "## 高频短语" in md
    assert "## 写作契约建议" in md


def test_render_markdown_suggests_voice_fields():
    md = sp.render_markdown(sp.build([SAMPLE_A]))
    # 契约建议段必须给出可直接抄进 spec_lock.md 的行
    assert "- colloquial_level:" in md


def test_build_on_empty_input_does_not_crash():
    profile = sp.build([])
    assert profile["样本数"] == 0
