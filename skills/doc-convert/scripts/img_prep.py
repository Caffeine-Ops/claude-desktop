#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""img_prep.py — 把用户丢进来的图片规格化成模型能读的 JPG。

注意：本文件中使用中文弯引号"（U+201C/U+201D）和直角引号「」（U+300C/U+300D）
但这些字符在字符串字面量中可能导致 Python 词法分析错误，所以用 chr() 定义。


为什么需要这一步（两个都不是可选项）：
  1. iPhone 拍的照片默认是 HEIC，而模型读图只认 PNG/JPG 这类常见格式。
     「拍张照 → 提字」「拍一堆发票 → 出台账」正是本技能的门面场景，
     卡在这里等于门面塌了。
  2. 手机原图动辄 4000px 宽。模型看图前会把长边压到约 1568px，
     多出来的像素只多花 token，一个字也不多认。先压掉是纯赚。

HEIC 解码走两条路，理由见设计文档「依赖与体积」：
  - pillow-heif 能 import 就用它（requirements.txt 里只在 Windows 装）
  - 否则用 macOS 系统自带的 /usr/bin/sips（已实测存在）
  - 两条都没有 → 明确报错让用户自己导出，不硬撑
这样 mac 用户不用为 Windows 的坑多付 12 MB。

单张失败抛 PrepError 而不是直接退出进程：批量场景一次几十张，
中间夹一个非图片文件很正常，整批崩掉比漏掉一张糟得多。是否「全军覆没
才算失败」由 main() 决定。
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

MAX_EDGE_DEFAULT = 1600  # 略高于模型内部约 1568px 的长边上限，留一点余量
HEIC_SUFFIXES = {".heic", ".heif"}

# 中文排版用的特殊引号，避免在字符串字面量中引起词法错误
_LEFT_CURLY_QUOTE = chr(0x201c)   # "
_RIGHT_CURLY_QUOTE = chr(0x201d)  # "
_LEFT_ANGLE_QUOTE = chr(0x300c)   # 「
_RIGHT_ANGLE_QUOTE = chr(0x300d)  # 」

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


class PrepError(Exception):
    """单张图处理失败。消息是给用户看的中文。"""


def _die(msg: str) -> None:
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


def _heif_ready() -> bool:
    """pillow-heif 可用则注册进 Pillow，返回是否可用。"""
    try:
        import pillow_heif
    except ImportError:
        return False
    pillow_heif.register_heif_opener()
    return True


def _sips_convert(src: Path, dst: Path) -> bool:
    """macOS 自带 sips 转 HEIC → JPEG。成功返回 True。"""
    sips = shutil.which("sips")
    if not sips:
        return False
    try:
        subprocess.run(
            [sips, "-s", "format", "jpeg", str(src), "--out", str(dst)],
            check=True, capture_output=True, timeout=60,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False
    return dst.is_file()


def prepare_one(src: Path, outdir: Path, max_edge: int = MAX_EDGE_DEFAULT) -> Path:
    """规格化一张图，返回产物路径。失败抛 PrepError（消息是中文）。"""
    src = Path(src)
    outdir = Path(outdir)
    try:
        outdir.mkdir(parents=True, exist_ok=True)
    except Exception:
        raise PrepError(
            f"无法创建输出目录 {outdir}，请检查权限或磁盘空间。"
        )
    dst = outdir / (src.stem + ".jpg")

    work = src
    tmp: Path | None = None
    try:
        if src.suffix.lower() in HEIC_SUFFIXES and not _heif_ready():
            tmp = outdir / (src.stem + ".sips-tmp.jpg")
            if not _sips_convert(src, tmp):
                msg = (f"{src.name} 是 HEIC 格式，本机没有可用的解码器。"
                       "请先把它导出成 JPG 或 PNG 再试"
                       f"（iPhone 相册{_LEFT_ANGLE_QUOTE}共享 → 存储到文件{_RIGHT_ANGLE_QUOTE}"
                       f"时选{_LEFT_CURLY_QUOTE}最兼容{_RIGHT_CURLY_QUOTE}即可）。")
                raise PrepError(msg)
            work = tmp

        try:
            img = Image.open(work)
            img.load()
        except Exception:
            raise PrepError(
                f"{src.name} 打不开，可能不是图片文件或已损坏。请确认后重试。"
            )

        img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > max_edge:
            scale = max_edge / max(w, h)
            img = img.resize(
                (max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS
            )

        try:
            img.save(dst, "JPEG", quality=90)
        except Exception:
            raise PrepError(
                f"{src.name} 保存失败，请检查目标目录权限或磁盘空间。"
            )

        return dst
    finally:
        # sips 中转文件用完就删——产物目录里不留半成品，同 PR 1 的纪律
        # finally 保证所有退出路径（包括异常）都会清理
        if tmp is not None and tmp.is_file():
            tmp.unlink()


def main(argv: list[str] | None = None) -> int:
    try:
        ap = argparse.ArgumentParser(description="把图片规格化成模型能读的 JPG")
        ap.add_argument("inputs", nargs="+", help="输入图片，可多张")
        ap.add_argument("-d", "--outdir", required=True, help="产物目录")
        ap.add_argument("--max-edge", type=int, default=MAX_EDGE_DEFAULT,
                        help=f"长边上限像素，默认 {MAX_EDGE_DEFAULT}")
        args = ap.parse_args(argv)

        outdir = Path(args.outdir)
        items, failed = [], []
        for raw in args.inputs:
            src = Path(raw)
            if not src.is_file():
                failed.append({"source": src.name, "reason": "文件不存在"})
                continue
            try:
                out = prepare_one(src, outdir, args.max_edge)
            except PrepError as e:
                failed.append({"source": src.name, "reason": str(e)})
                continue
            items.append({"source": src.name, "output": str(out)})

        if not items:
            reasons = "；".join(f["reason"] for f in failed) or "没有可处理的输入"
            _die(f"这批图片一张也没能处理成功。{reasons}")

        print(json.dumps({"outdir": str(outdir), "items": items, "failed": failed},
                         ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        # 兜底：任何未预期异常都转成格式化的中文错误消息
        # 这是本 PR 的全局约束：不能让 Python 堆栈泄漏到用户面前
        _die(f"处理过程中出错：{type(e).__name__}: {e}")


if __name__ == "__main__":
    raise SystemExit(main())
