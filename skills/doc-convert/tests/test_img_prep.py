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

    # 反绕行测试：直接读源码文本，断言原文字面量真的写在代码里，而不是
    # 靠 chr() 之类的间接手段拼出来的。以后谁想绕开这个约束会被这条断
    # 言当场拦住——它不是在测运行结果，是在测源码的写法本身。
    source_text = (
        Path(img_prep.__file__).read_text(encoding="utf-8")
    )
    assert (
        "（iPhone 相册「共享 → 存储到文件」时选“最兼容”即可）。" in source_text
    ), "HEIC 错误文案必须以字面量形式出现在源码中，不能用 chr() 等方式绕行"


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


def test_convert_or_resize_failure_does_not_abort_batch(tmp_path, monkeypatch, capsys):
    """回归测试：convert/resize 阶段抛出的异常必须转成 PrepError 被
    main() 的批量循环吃掉、记进 failed[]，而不是绕过 `except PrepError`
    直接冒到 main() 最外层的兜底 except——那样一张坏图会提前结束整批，
    同批里排在它后面的好图就一张也出不来了，违反「单张坏图不拖垮整批」
    的核心契约。

    用一个能被 Image.open + load() 正常打开、但 convert() 会抛异常的
    伪图片对象模拟"图片数据部分损坏"的场景（比如截断的调色板）。
    """
    good = _png(tmp_path / "good.png", size=(500, 500))
    bad = _png(tmp_path / "bad.png", size=(500, 500))
    outdir = tmp_path / "out"

    real_open = img_prep.Image.open

    class _OpensButConvertBoom:
        """load() 正常放行，convert() 抛异常——模拟能打开但处理不了的图。"""

        def __init__(self, real_img):
            self._real_img = real_img

        def load(self):
            return self._real_img.load()

        def convert(self, mode):
            raise OSError("模拟的调色板数据损坏")

    def fake_open(path):
        img = real_open(path)
        if Path(path).name == "bad.png":
            return _OpensButConvertBoom(img)
        return img

    monkeypatch.setattr(img_prep.Image, "open", fake_open)

    rc = img_prep.main([str(good), str(bad), "-d", str(outdir)])
    captured = capsys.readouterr()

    # 整批仍然成功退出（exit 0），不是被坏图拖垮的非零退出
    assert rc == 0, f"Expected exit 0, got {rc}. stderr: {captured.err}"

    manifest = json.loads(captured.out)
    assert manifest["failed"][0]["source"] == "bad.png"
    assert len(manifest["items"]) == 1
    assert manifest["items"][0]["source"] == "good.png"

    # 同批的好图照常产出
    assert (outdir / "good.jpg").is_file()
