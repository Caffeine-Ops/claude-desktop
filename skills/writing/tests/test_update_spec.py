import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import update_spec as us

SPEC_TEXT = """## 体裁
- genre: short-story
- sub: 悬疑推理

## 文风锁定
- voice: 冷峻克制
- person: 第三人称限知

## 禁用清单
- 禁用词: 首先, 其次
"""


def _spec_file(tmp_path):
    p = tmp_path / "spec_lock.md"
    p.write_text(SPEC_TEXT, encoding="utf-8")
    return p


def test_set_field_replaces_value_in_place(tmp_path):
    p = _spec_file(tmp_path)
    us.set_field(p, "文风锁定", "voice", "市井烟火")
    content = p.read_text(encoding="utf-8")
    assert "- voice: 市井烟火" in content
    assert "- voice: 冷峻克制" not in content
    # 其余内容原样保留
    assert "- person: 第三人称限知" in content
    assert "- genre: short-story" in content


def test_set_field_appends_when_key_absent(tmp_path):
    p = _spec_file(tmp_path)
    us.set_field(p, "文风锁定", "colloquial_level", "3/5")
    lines = p.read_text(encoding="utf-8").splitlines()
    idx_section = lines.index("## 文风锁定")
    idx_new = lines.index("- colloquial_level: 3/5")
    # 新键必须落在本段内，不能跑到文件末尾
    assert idx_new > idx_section
    assert "## 禁用清单" in lines[idx_new:]


def test_set_field_creates_section_when_absent(tmp_path):
    p = _spec_file(tmp_path)
    us.set_field(p, "平台格式", "platform", "公众号")
    content = p.read_text(encoding="utf-8")
    assert "## 平台格式" in content
    assert "- platform: 公众号" in content


def test_affected_drafts_lists_all_when_voice_changes(tmp_path):
    project = tmp_path / "proj"
    (project / "drafts").mkdir(parents=True)
    (project / "drafts" / "01.md").write_text("第一节", encoding="utf-8")
    (project / "drafts" / "02.md").write_text("第二节", encoding="utf-8")
    affected = us.affected_drafts(project, "文风锁定")
    assert len(affected) == 2


def test_impact_map_covers_known_sections():
    for section in ("文风锁定", "禁用清单", "人物档案", "平台格式"):
        assert section in us.IMPACT_MAP


def test_set_field_preserves_pipe_layout(tmp_path):
    # 人物档案/伏笔表是竖线记录，改字段要保留竖线排版，
    # 不能重写成 `- 张明: …` 冒号格式（破坏人读的对齐、且逼调用方传整串）
    p = tmp_path / "spec_lock.md"
    p.write_text("## 人物档案\n- 张明 | want:找到妹妹 | need:原谅自己\n", encoding="utf-8")
    us.set_field(p, "人物档案", "张明", "want:救出妹妹 | need:放下愧疚")
    content = p.read_text(encoding="utf-8")
    assert "- 张明 | want:救出妹妹 | need:放下愧疚" in content
    assert "- 张明: " not in content


def test_set_field_keeps_colon_for_simple_kv(tmp_path):
    # 简单键值记录仍用冒号，别被竖线逻辑带偏
    p = _spec_file(tmp_path)
    us.set_field(p, "文风锁定", "voice", "市井烟火")
    assert "- voice: 市井烟火" in p.read_text(encoding="utf-8")
