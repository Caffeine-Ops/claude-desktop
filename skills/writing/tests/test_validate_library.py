import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import validate_library as vl


def _make_lib(tmp_path, *, index_lists_all=True, with_required_sections=True):
    refs = tmp_path / "references" / "voices"
    refs.mkdir(parents=True)
    body = ""
    if with_required_sections:
        body = "\n".join(
            f"## {s}" for s in vl.REQUIRED_SECTIONS["voices"]
        )
    (refs / "leng-jun-ke-zhi.md").write_text(f"# 冷峻克制\n{body}\n", encoding="utf-8")
    (refs / "shi-jing-yan-huo.md").write_text(f"# 市井烟火\n{body}\n", encoding="utf-8")
    listed = ["leng-jun-ke-zhi.md"]
    if index_lists_all:
        listed.append("shi-jing-yan-huo.md")
    index = "# 文风库索引\n" + "\n".join(f"- [{n}](./{n})" for n in listed)
    (refs / "_index.md").write_text(index, encoding="utf-8")
    return tmp_path


def test_valid_library_passes(tmp_path):
    lib = _make_lib(tmp_path)
    assert vl.validate(lib) == []


def test_index_missing_sibling_reported(tmp_path):
    lib = _make_lib(tmp_path, index_lists_all=False)
    problems = vl.validate(lib)
    assert any("shi-jing-yan-huo.md" in p and "索引" in p for p in problems)


def test_missing_required_section_reported(tmp_path):
    lib = _make_lib(tmp_path, with_required_sections=False)
    problems = vl.validate(lib)
    assert any("缺少章节" in p for p in problems)


def test_missing_index_file_reported(tmp_path):
    lib = _make_lib(tmp_path)
    (lib / "references" / "voices" / "_index.md").unlink()
    problems = vl.validate(lib)
    assert any("_index.md" in p for p in problems)


def test_dangling_index_link_reported(tmp_path):
    # 索引里链了一个已删/改名的文件（断链）—— 校验必须报出来，
    # 否则 SKILL.md 会让模型去读一个不存在的文件（脚本自己声称要防的静默失败）
    lib = _make_lib(tmp_path)
    idx = lib / "references" / "voices" / "_index.md"
    idx.write_text(idx.read_text(encoding="utf-8") + "\n- [幽灵手册](./ghost.md)\n", encoding="utf-8")
    problems = vl.validate(lib)
    assert any("ghost.md" in p for p in problems)


def _make_workplace_lib(tmp_path, *, index_lists_all=True, with_required_sections=True):
    refs = tmp_path / "references" / "workplace"
    refs.mkdir(parents=True)
    body = ""
    if with_required_sections:
        body = "\n".join(f"## {s}" for s in vl.REQUIRED_SECTIONS["workplace"])
    (refs / "hui-bao.md").write_text(f"# 汇报骨架\n{body}\n", encoding="utf-8")
    (refs / "dao-qian.md").write_text(f"# 道歉骨架\n{body}\n", encoding="utf-8")
    listed = ["hui-bao.md"]
    if index_lists_all:
        listed.append("dao-qian.md")
    index = "# 职场骨架卡索引\n" + "\n".join(f"- [{n}](./{n})" for n in listed)
    (refs / "_index.md").write_text(index, encoding="utf-8")
    return tmp_path


def test_workplace_group_validated_when_complete(tmp_path):
    # workplace 组结构完整（索引列全 + 章节齐）应零问题
    assert vl.validate(_make_workplace_lib(tmp_path)) == []


def test_workplace_index_missing_sibling_reported(tmp_path):
    # 漏登记进 _index.md 的骨架卡必须被揪出（改动前脚本根本不扫 workplace，报不出来）
    problems = vl.validate(_make_workplace_lib(tmp_path, index_lists_all=False))
    assert any("dao-qian.md" in p and "索引" in p for p in problems)


def test_workplace_missing_required_section_reported(tmp_path):
    problems = vl.validate(_make_workplace_lib(tmp_path, with_required_sections=False))
    assert any("缺少章节" in p for p in problems)
