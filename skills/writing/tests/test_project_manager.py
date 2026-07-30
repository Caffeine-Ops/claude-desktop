import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import project_manager as pm


def test_slugify_keeps_chinese_and_compresses_symbols():
    assert pm.slugify("我的 公众号-文案!!") == "我的_公众号_文案"


def test_init_creates_all_subdirs(tmp_path):
    project = pm.init_project("测试项目", tmp_path, "20260724")
    assert project.name == "测试项目_20260724"
    for sub in pm.SUBDIRS:
        assert (project / sub).is_dir()
    assert (project / "README.md").exists()


def test_validate_flags_missing_spec_lock(tmp_path):
    project = pm.init_project("测试项目", tmp_path, "20260724")
    problems = pm.validate_project(project)
    assert any("spec_lock.md" in p for p in problems)


def test_validate_passes_when_complete(tmp_path):
    project = pm.init_project("测试项目", tmp_path, "20260724")
    (project / "spec_lock.md").write_text("## 体裁\n- genre: article\n", encoding="utf-8")
    assert pm.validate_project(project) == []


def test_init_prints_project_marker(tmp_path, capsys):
    """init 必须在 stdout 打印 WRITING_PROJECT=<绝对路径>。

    桌面端据此接管右栏工作区——目录名是 <slug>_<日期>，slug 规则在本文件里
    （中文保留、其余压下划线），前端复刻一份必然漂移，所以由脚本自己报数。
    """
    pm.main(["init", "我的小说", "--dir", str(tmp_path)])
    out = capsys.readouterr().out
    marker_lines = [ln for ln in out.splitlines() if ln.startswith("WRITING_PROJECT=")]
    assert len(marker_lines) == 1
    path = Path(marker_lines[0].split("=", 1)[1])
    assert path.is_absolute()
    assert path.is_dir()
