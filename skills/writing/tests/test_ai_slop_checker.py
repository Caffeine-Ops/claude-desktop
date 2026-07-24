"""AI 味检测的行为测试。

启发式打分的标定常量会随真实样本调整，所以这里钉的是**相对行为**：
AI 腔文本必须比人话文本得分低、命中必须报出正确行号、总分必须在
0–50 之间。不钉死具体分值，否则每次微调常量都要改测试。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import ai_slop_checker as checker

# 典型 AI 腔：关联词套话齐全、句长整齐、全是形容词没有事实
AI_TEXT = """在这个信息爆炸的时代，内容创作变得非常重要。
首先，优秀的内容需要清晰的结构和深刻的洞察。
其次，高效的表达能够显著提升读者的阅读体验。
再次，创新的视角可以带来巨大的价值和广泛的影响。
综上所述，这不仅仅是技巧问题，更是思维方式的转变。"""

# 典型人话：句长参差、有具体数字和细节、没有套话
HUMAN_TEXT = """上周我改了 37 版标题。
最后用的那版是我在地铁上想出来的，只有 9 个字。
数据出来那天，打开率从 4.2% 涨到 11.8%，我盯着后台看了很久，
突然意识到前面 36 版全都在自说自话——我一直在讲产品多好，
从没讲过读者早上七点挤地铁时到底在想什么。
那天之后我改了写标题的顺序。先写读者，再写产品。"""


def test_report_total_within_range():
    report = checker.score_text(HUMAN_TEXT)
    assert 0 <= report.total <= 50
    assert len(report.dimensions) == 5
    for value in report.dimensions.values():
        assert 0 <= value <= 10


def test_ai_text_scores_lower_than_human_text():
    ai = checker.score_text(AI_TEXT)
    human = checker.score_text(HUMAN_TEXT)
    assert ai.total < human.total


def test_banned_words_reported_with_line_numbers():
    report = checker.score_text(AI_TEXT)
    banned = [h for h in report.hits if h.rule == "套话"]
    texts = {h.text for h in banned}
    assert "首先" in texts
    assert "其次" in texts
    assert "综上所述" in texts
    for hit in banned:
        assert hit.line >= 1


def test_ai_pattern_detected():
    report = checker.score_text("这不是一次改版，而是一次重生。")
    rules = {h.rule for h in report.hits}
    assert "反转对举句" in rules


def test_extra_banned_words_from_spec_lock_are_applied():
    text = "我们要拥抱变化，实现闭环。"
    base = checker.score_text(text)
    with_extra = checker.score_text(text, extra_banned=["拥抱变化"])
    assert len(with_extra.hits) > len(base.hits)
    assert any(h.text == "拥抱变化" for h in with_extra.hits)


def test_uniform_sentences_lower_structure_score():
    uniform = "他走进房间里去。\n她坐在椅子上面。\n风吹过窗帘边上。\n猫跳上桌子中央。"
    varied = "他进来了。\n她没抬头，手里那本翻了一半的书停在第三章，页角卷着，"\
        "像被人反复捏过很多次。\n风。\n猫跳上桌子，把水杯撞翻了，水顺着桌沿滴到她鞋上，她还是没动。"
    assert (
        checker.score_text(uniform).dimensions["结构均匀度"]
        < checker.score_text(varied).dimensions["结构均匀度"]
    )


def test_grade_levels():
    hit_banned = checker.wu.Hit(line=1, col=1, text="首先", rule="套话")
    hit_bookish = checker.wu.Hit(line=1, col=1, text="进行操作", rule="书面腔")
    assert checker.grade(hit_banned) == "🔴"
    assert checker.grade(hit_bookish) == "🟡"


def test_empty_text_does_not_crash():
    report = checker.score_text("")
    assert report.total >= 0
