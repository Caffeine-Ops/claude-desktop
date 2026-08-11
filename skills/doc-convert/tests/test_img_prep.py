"""img_prep 的行为契约。

两条最要紧的：
  1. 大图必须被缩到 max_edge 以内——模型看图前会把长边压到约 1568px，
     再大只多花 token 不多认字，这是纯浪费。
  2. 一张坏图不能拖垮整批——票据场景一次几十张，中间夹一个非图片文件
     很正常，整批崩掉比漏掉一张糟得多。
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import img_prep  # noqa: E402


def _png(path: Path, size=(3000, 2000)) -> Path:
    Image.new("RGB", size, (200, 30, 30)).save(path)
    return path


def test_large_image_is_downscaled(tmp_path):
    src = _png(tmp_path / "big.png")
    out = img_prep.prepare_one(src, tmp_path / "out")
    assert out.suffix == ".jpg"
    assert max(Image.open(out).size) == img_prep.MAX_EDGE_DEFAULT


def test_small_image_is_not_upscaled(tmp_path):
    src = _png(tmp_path / "small.png", size=(400, 300))
    out = img_prep.prepare_one(src, tmp_path / "out")
    assert Image.open(out).size == (400, 300)


def test_non_image_raises_prep_error_not_systemexit(tmp_path):
    bad = tmp_path / "notreally.jpg"
    bad.write_text("我不是图片", encoding="utf-8")
    with pytest.raises(img_prep.PrepError):
        img_prep.prepare_one(bad, tmp_path / "out")


def test_cli_manifest_records_original_name(tmp_path):
    src = _png(tmp_path / "IMG_0012.png", size=(800, 600))
    outdir = tmp_path / "out"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(src), "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    manifest = json.loads(proc.stdout)
    assert manifest["items"][0]["source"] == "IMG_0012.png"
    assert Path(manifest["items"][0]["output"]).name == "IMG_0012.jpg"
    assert manifest["failed"] == []


def test_cli_all_failed_exits_nonzero_in_chinese(tmp_path):
    bad = tmp_path / "x.jpg"
    bad.write_text("不是图片", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(bad), "-d", str(tmp_path / "out")],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "[doc-convert] 错误：" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_partial_failure_still_succeeds(tmp_path):
    good = _png(tmp_path / "good.png", size=(500, 500))
    bad = tmp_path / "bad.jpg"
    bad.write_text("不是图片", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(good), str(bad),
         "-d", str(tmp_path / "out")],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    manifest = json.loads(proc.stdout)
    assert len(manifest["items"]) == 1
    assert manifest["failed"][0]["source"] == "bad.jpg"


def test_heic_error_message_contains_original_text(tmp_path):
    """Critical 1 回归测试：HEIC 错误消息要保留原文中文标点和「最兼容」。"""
    # 模拟 HEIC 文件
    heic_file = tmp_path / "photo.heic"
    heic_file.write_bytes(b"not a real heic")

    # prepare_one 会报错，错误消息应含「最兼容」
    with pytest.raises(img_prep.PrepError) as exc_info:
        img_prep.prepare_one(heic_file, tmp_path / "out")

    error_msg = str(exc_info.value)
    assert "最兼容" in error_msg, f"Expected '最兼容' in error message, got: {error_msg}"


def test_save_failure_raises_prep_error_not_system_error(tmp_path):
    """Critical 2 回归测试：写盘失败时抛 PrepError 而不是 IsADirectoryError。"""
    src = _png(tmp_path / "test.png", size=(500, 500))
    # 把 outdir 占用成一个文件（而不是目录），导致 mkdir 或 save 失败
    outdir = tmp_path / "notadir"
    outdir.write_text("I am a file, not a directory")

    # prepare_one 应该抛 PrepError，不是 IsADirectoryError
    with pytest.raises(img_prep.PrepError):
        img_prep.prepare_one(src, outdir)


def test_save_failure_cli_no_traceback(tmp_path):
    """Critical 2 回归测试：CLI 层面写盘失败也要格式化成中文错误，不泄漏堆栈。"""
    src = _png(tmp_path / "test.png", size=(500, 500))
    outdir = tmp_path / "notadir"
    outdir.write_text("I am a file, not a directory")

    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(src), "-d", str(str(outdir))],
        capture_output=True, text=True,
    )

    # 应该失败
    assert proc.returncode != 0, f"Expected non-zero exit code, stderr: {proc.stderr}"
    # 错误消息格式化，没有堆栈
    assert "[doc-convert] 错误：" in proc.stderr
    assert "Traceback" not in proc.stderr, f"Python traceback leaked: {proc.stderr}"
    assert "IsADirectoryError" not in proc.stderr


def test_heic_sips_tmp_cleaned_up_on_image_open_failure(tmp_path, monkeypatch):
    """Important 3 回归测试：sips 成功但 Pillow 打不开时，tmp 文件要清理。"""
    # 模拟 HEIC 文件
    heic_file = tmp_path / "photo.heic"
    heic_file.write_bytes(b"not a real heic")
    outdir = tmp_path / "out"

    # 模拟 _sips_convert 成功生成了一个"tmp"文件，但该文件无法被 Pillow 打开
    def mock_sips_convert(src, dst):
        # 生成一个 sips tmp 文件，但内容是垃圾数据
        dst.write_bytes(b"not a real jpeg")
        return True

    def mock_heif_ready():
        return False

    monkeypatch.setattr(img_prep, "_sips_convert", mock_sips_convert)
    monkeypatch.setattr(img_prep, "_heif_ready", mock_heif_ready)

    # prepare_one 会因为 Image.open 失败而抛 PrepError
    with pytest.raises(img_prep.PrepError):
        img_prep.prepare_one(heic_file, outdir)

    # 重要：sips tmp 文件应该被清理掉
    tmp_files = list(outdir.glob("*.sips-tmp.jpg"))
    assert len(tmp_files) == 0, f"Expected no sips tmp files, but found: {tmp_files}"
