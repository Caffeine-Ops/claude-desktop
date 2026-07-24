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
