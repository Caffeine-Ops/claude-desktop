"""img_prep 的行为契约。

两条最要紧的：
  1. 大图必须被缩到 max_edge 以内——模型看图前会把长边压到约 1568px，
     再大只多花 token 不多认字，这是纯浪费。
  2. 一张坏图不能拖垮整批——票据场景一次几十张，中间夹一个非图片文件
     很正常，整批崩掉比漏掉一张糟得多。
"""
import json
import os
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


# --- 补充：整分支最终评审（2026-08-11）挖出的三条 Important + 一条 Minor，
# 都是跨文件接缝问题——单任务评审看不到，必须在合并前补测试钉死。


def test_duplicate_stem_different_suffix_both_survive(tmp_path):
    """Important 1 回归测试：`dst` 旧实现只看主干名（stem），两个不同内容的
    IMG_0012.png 与 IMG_0012.jpg 进同一个 outdir 会算出同一个产物路径，
    后处理的静默覆盖前一张——exit 0，无任何提示，一张票据凭空消失。
    SKILL.md 的 A3 恰好教模型分两批跑（先 *.jpg 再 *.HEIC）进同一个
    处理后/，iPhone「共享 → 存储到文件 → 最兼容」导出的正是这种同名对。
    两张的产物必须都在磁盘上，且 items 里的 output 与实际文件一一对应。
    """
    png = _png(tmp_path / "IMG_0012.png", size=(300, 200))
    jpg = tmp_path / "IMG_0012.jpg"
    Image.new("RGB", (500, 400), (10, 200, 10)).save(jpg)
    outdir = tmp_path / "out"

    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(png), str(jpg),
         "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    manifest = json.loads(proc.stdout)
    assert len(manifest["items"]) == 2
    assert manifest["failed"] == []

    outputs = [Path(it["output"]) for it in manifest["items"]]
    assert len(set(outputs)) == 2, "两张的产物路径必须不同，不能互相覆盖"
    for p in outputs:
        assert p.is_file(), f"{p} 应该真实存在于磁盘上，items 里的 output 必须与磁盘一一对应"

    # 两张源图尺寸不同，产物尺寸各自不同——证明不是同一份文件被写了两次
    sizes = {Image.open(p).size for p in outputs}
    assert len(sizes) == 2


def test_outdir_equal_to_source_dir_is_refused_and_original_untouched(tmp_path):
    """Important 2 回归测试：输入是 .jpg 且 -d 就是它所在目录时 dst == src，
    旧实现会把用户手机里的原图就地覆盖成缩略图——不可逆，丢的是原始照片。
    必须在真正读/写图片之前拒绝，且原图字节和尺寸都不能被改动。
    """
    src = tmp_path / "orig.jpg"
    Image.new("RGB", (4000, 3000), (80, 120, 200)).save(src, "JPEG", quality=95)
    size_before = src.stat().st_size
    dims_before = Image.open(src).size

    with pytest.raises(img_prep.PrepError) as exc_info:
        img_prep.prepare_one(src, tmp_path)  # outdir 就是 src 所在目录

    assert "覆盖它自己" in str(exc_info.value)
    assert "-d" in str(exc_info.value), "错误信息要指导用户怎么自救"
    assert src.stat().st_size == size_before, "原图字节不能被改动"
    assert Image.open(src).size == dims_before, "原图尺寸不能被改动（说明没被当成产物重写）"


def test_missing_file_cli_message_names_file_and_hints_wildcard(tmp_path):
    """Important 3 回归测试：旧文案「文件不存在」既不含文件名也不给下一步。
    SKILL.md 自己教了一条一定会走到这里的路——zsh 下通配符没匹配到，
    bash 会把 `票据/*.HEIC` 字面量原样传给脚本，脚本再把它当"文件不存在"。
    全部输入都命中这条时，错误信息必须报出具体路径并提示通配符的可能性。
    """
    missing = tmp_path / "票据" / "*.HEIC"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(missing),
         "-d", str(tmp_path / "out")],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert proc.stderr.startswith("[doc-convert] 错误：")
    assert "*.HEIC" in proc.stderr
    assert "通配符" in proc.stderr, "错误信息要指导用户怎么自救"


def test_all_failed_reasons_are_deduplicated_and_capped(tmp_path):
    """Minor 2 回归测试：一批文件失败原因相同时（比如清一色不是图片），
    旧实现把每条原因原样拼接，60 张票据能拼出约 5 KB 的重复文本甩给用户。
    去重后同一句话只应出现一次，错误信息长度不能随失败文件数线性增长。
    """
    bad_files = []
    for i in range(12):
        p = tmp_path / f"bad{i}.jpg"
        p.write_text("不是图片", encoding="utf-8")
        bad_files.append(str(p))

    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), *bad_files,
         "-d", str(tmp_path / "out")],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert proc.stderr.count("打不开，可能不是图片文件或已损坏") == 1, (
        "12 个文件同一个失败原因，不应该被重复拼接 12 次"
    )
    assert len(proc.stderr) < 500, f"错误信息应该被去重压缩，实际 {len(proc.stderr)} 字符"
    # 复审实测：旧版 remaining 算的是"模板不在前 3 个已展示里的条数"，12 张
    # 全同因时唯一的模板本来就在已展示集合里，算出来是 0，"另有 N 张同样
    # 原因"这句话根本不会打印——用户只看到 1 条文案、1 个文件名，对这批
    # 到底炸了多少张毫无概念。去重不能把"规模"这个信息也一起去掉。
    assert "另有 11 张未逐条列出" in proc.stderr, (
        f"去重后完全看不到规模信息，用户不知道这批实际有 12 张失败，stderr: {proc.stderr}"
    )


# --- 合并前最后一轮复审（2026-08-12）挖出的三个换名护栏漏网变体 + 一条
# Minor：都是同一个根因——旧版只查内存里的 used_names、且自我覆盖检查只做
# 字符串比较。这四条测试专门验证「查磁盘实况 + os.path.samefile」这个修法
# 真的堵住了每一个变体，而不是只堵住了最初报告的那一种。


def test_cross_process_calls_do_not_silently_overwrite_different_content(tmp_path):
    """变体 B 回归测试：`used_names` 只在进程内共享，从不看 outdir 里已经
    存在的文件。这正是 SKILL.md A3 自己教的用法——先跑一批 `*.jpg`，这批里
    如果还有 HEIC，再单独跑一次 `*.HEIC`，两次都写进同一个 处理后/。

    这里必须用两个真实的、先后独立启动的子进程（而不是同一进程内两次调用
    prepare_one 共享一个 used_names），因为 used_names 天生就活在进程内存
    里——问题只有在真的跨进程、跨调用时才会暴露，同进程内测不出这个根因。
    """
    outdir = tmp_path / "处理后"
    jpg = tmp_path / "IMG_0012.jpg"
    png = tmp_path / "IMG_0012.png"
    Image.new("RGB", (500, 400), (10, 200, 10)).save(jpg, "JPEG", quality=95)
    Image.new("RGB", (300, 200), (200, 30, 30)).save(png)

    proc1 = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(jpg), "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc1.returncode == 0, proc1.stderr
    out1 = Path(json.loads(proc1.stdout)["items"][0]["output"])
    assert out1.is_file()
    size1 = out1.stat().st_size

    proc2 = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(png), "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc2.returncode == 0, proc2.stderr
    out2 = Path(json.loads(proc2.stdout)["items"][0]["output"])
    assert out2.is_file()

    # 两次调用的产物必须都在磁盘上、路径不同——第一张不能被第二次调用悄悄顶掉
    assert out1.is_file(), "第一次调用产出的文件在第二次调用之后不能消失"
    assert out2.resolve() != out1.resolve()
    assert out1.stat().st_size == size1, "第一次调用的产物内容不能被第二次调用改写"
    assert Image.open(out1).size != Image.open(out2).size, "两张源图尺寸不同，产物也该不同"


def test_uppercase_extension_is_refused_when_it_aliases_source(tmp_path):
    """变体 A 回归测试（三个漏网变体里最严重的一个）：iPhone 导出常见
    `IMG_0012.JPG`（大写），脚本算出的产物名是小写的 `IMG_0012.jpg`——
    字符串比较判定"不相等"从而放行，但 APFS 默认大小写不敏感，两个不同
    大小写的名字其实指向同一个 inode，写下去等于把用户手机里的原图原地
    换成 1600px 缩略图，不可逆，且没有任何报错（exit 0，stderr 空）。

    本机跑测试的文件系统不一定大小写不敏感（比如 CI 用的 Linux ext4 就是
    大小写敏感的），没法保证"大写路径字符串"和"小写路径字符串"在测试机上
    真的会解析到同一个 inode，靠真实大小写碰撞的话这条测试在部分机器上
    会静默测不出问题。改用 os.link 手动构造："IMG_0012.jpg" 这个名字直接
    硬链接到 src（IMG_0012.JPG）——这正是大小写不敏感文件系统会自动发生
    的事（两个名字、同一个 inode），用硬链接可以在任何文件系统上稳定复现
    同样的处境，不用赌本机 FS 的大小写敏感性。
    """
    src = tmp_path / "IMG_0012.JPG"
    Image.new("RGB", (4000, 3000), (80, 120, 200)).save(src, "JPEG", quality=95)
    size_before = src.stat().st_size
    dims_before = Image.open(src).size

    # 手动构造"同一个 inode、两个大小写不同的名字"，模拟大小写不敏感文件
    # 系统的效果，不依赖本机文件系统是否真的大小写不敏感
    alias = tmp_path / "IMG_0012.jpg"
    try:
        os.link(src, alias)
    except FileExistsError:
        # 本机文件系统本身就是大小写不敏感的（实测：macOS 默认的 APFS 就是
        # 这样）——"IMG_0012.jpg" 这个路径字符串本来就已经解析到 src 那个
        # inode，os.link 会直接报"目标已存在"。这恰好就是变体 A 要复现的
        # 真实处境本身，不需要再手动构造别名，直接放行即可。
        pass

    with pytest.raises(img_prep.PrepError) as exc_info:
        img_prep.prepare_one(src, tmp_path)

    assert "覆盖它自己" in str(exc_info.value)
    assert src.stat().st_size == size_before, "原图字节不能被改动"
    assert Image.open(src).size == dims_before, "原图尺寸不能被改动（说明没被当成产物重写）"


def test_sibling_same_stem_source_is_not_overwritten(tmp_path):
    """变体 C 回归测试：两张同 stem 的源文件（`IMG_0012.png` 与
    `IMG_0012.jpg`）一起传，`-d` 又指到它们所在的目录。处理 png 时算出的
    候选名恰好是另一张源文件的名字——旧实现只比较"自己的 src"，看不到
    "别人的 src"，会把 IMG_0012.jpg 这张完全不相干的原图当成"产物"覆盖掉；
    随后处理 jpg 时读到的已经是被 png 写坏的内容，另存成 IMG_0012-2.jpg。
    exit 0，manifest 报告"两条 items、两个文件都在"——看起来一切正常，
    实际上用户的原始照片已经没了，这是本技能纪律里最严重的那种违反：
    产出了一份看起来正常、实则有缺陷的东西。

    修复后 png 的候选名 IMG_0012.jpg 一旦发现磁盘上已经存在且不是 png
    自己（`os.path.samefile` 为假），会换名到 IMG_0012-2.jpg，不会碰
    jpg 一根汗毛。jpg 自己随后处理时，它的天然候选名就是它自己（`-d`
    指向自身所在目录，这与 Important 2 是同一种自引用，无法通过换名
    绕开），会被正确拒绝而不是被静默接受——但无论 jpg 自己成功与否，
    它作为"另一张源文件"这件事任何时候都不该被改动，这才是本测试要
    钉死的核心不变量。
    """
    png = tmp_path / "IMG_0012.png"
    jpg = tmp_path / "IMG_0012.jpg"
    Image.new("RGB", (300, 200), (200, 30, 30)).save(png)
    Image.new("RGB", (4000, 3000), (10, 200, 10)).save(jpg, "JPEG", quality=95)
    jpg_size_before = jpg.stat().st_size
    jpg_dims_before = Image.open(jpg).size

    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(png), str(jpg),
         "-d", str(tmp_path)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr  # png 那张仍要成功，一张自引用不能拖垮整批
    manifest = json.loads(proc.stdout)

    # 核心不变量：jpg 是"别人的原始输入"，任何时候都不该被 png 的产物覆盖，
    # 不管 jpg 自己最终处理成功还是失败
    assert jpg.stat().st_size == jpg_size_before, "IMG_0012.jpg 原图字节不能被改动"
    assert Image.open(jpg).size == jpg_dims_before, "IMG_0012.jpg 原图尺寸不能被改动"

    # png 的产物必须存在，且不能占用 IMG_0012.jpg 这个名字（那是别人的名字）
    png_items = [it for it in manifest["items"] if it["source"] == "IMG_0012.png"]
    assert len(png_items) == 1
    png_output = Path(png_items[0]["output"])
    assert png_output.is_file()
    assert png_output.resolve() != jpg.resolve()

    # jpg 自己的候选名就是它本身（-d 指向自身所在目录），这与 Important 2
    # 是同一种无法换名绕开的自引用，预期会被拒绝、记进 failed 而不是静默
    # "成功"——静默成功、内容却已经是坏的，正是变体 C 最初被举报的样子
    jpg_failed = [f for f in manifest["failed"] if f["source"] == "IMG_0012.jpg"]
    assert len(jpg_failed) == 1, "IMG_0012.jpg 的天然产物名就是它自己，应该被拒绝而不是静默处理"
    assert "覆盖它自己" in jpg_failed[0]["reason"]


def test_failed_image_does_not_consume_a_name_slot(tmp_path):
    """Minor 1 回归测试：旧实现在检查/读写图片之前就 `used_names.add(name)`，
    一张失败的图也会白白烧掉一个名额。`坏.png 坏.jpg -d out/` 这个组合下，
    唯一处理成功的 坏.jpg 会莫名其妙被挤成 `坏-2.jpg`，而它本该拿到的
    `坏.jpg` 这个名字始终空着没人用。修复后名额只在真正保存成功之后才登记。
    """
    bad_png = tmp_path / "坏.png"
    bad_png.write_text("我不是图片", encoding="utf-8")
    good_jpg = tmp_path / "坏.jpg"
    Image.new("RGB", (400, 300), (50, 60, 70)).save(good_jpg, "JPEG", quality=90)
    outdir = tmp_path / "out"

    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "img_prep.py"), str(bad_png), str(good_jpg),
         "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    manifest = json.loads(proc.stdout)
    assert manifest["failed"][0]["source"] == "坏.png"
    assert len(manifest["items"]) == 1
    assert manifest["items"][0]["output"] == str(outdir / "坏.jpg"), (
        "唯一成功的那张应该拿到它本该拿到的名字 坏.jpg，而不是因为失败的那张"
        "提前烧掉名额被挤成 坏-2.jpg"
    )
    assert (outdir / "坏.jpg").is_file()
