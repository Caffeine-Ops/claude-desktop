#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""img_prep.py — 把用户丢进来的图片规格化成模型能读的 JPG。

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


def prepare_one(src: Path, outdir: Path, max_edge: int = MAX_EDGE_DEFAULT,
                 used_names: set[str] | None = None) -> Path:
    """规格化一张图，返回产物路径。失败抛 PrepError（消息是中文）。

    `used_names`：本次运行（跨多次 prepare_one 调用）已经产出过的文件名集合，
    由调用方（main() 的批量循环）在多张图之间共享。不传时新建一个空集合，
    行为等同「只处理这一张」——单测直接调 prepare_one 时不受影响。

    为什么需要它（评审实测 Important 1）：`dst` 只看主干名（stem），
    两个不同内容的 `IMG_0012.png` 与 `IMG_0012.jpg` 进同一个 outdir 会算出
    同一个产物路径，后处理的静默覆盖前一张——exit 0，无任何提示，一张票据
    凭空消失。SKILL.md 的 A3 恰好教模型分两批跑（先 *.jpg 再 *.HEIC）进同一个
    处理后/，iPhone「共享 → 存储到文件 → 最兼容」导出的正是这种同名对，
    这条护栏因此不是理论风险。撞名时换成 `stem-2.jpg`、`stem-3.jpg`……
    保证 `items` 里的 output 与磁盘上真实存在的文件一一对应。
    """
    src = Path(src)
    outdir = Path(outdir)
    if used_names is None:
        used_names = set()
    try:
        outdir.mkdir(parents=True, exist_ok=True)
    except Exception:
        raise PrepError(
            f"无法创建输出目录 {outdir}，请检查权限或磁盘空间。"
        )

    name = src.stem + ".jpg"
    n = 2
    while name in used_names:
        name = f"{src.stem}-{n}.jpg"
        n += 1
    used_names.add(name)
    dst = outdir / name

    # 评审实测 Important 2：输入是 .jpg 且 -d 就是它所在目录时 dst == src，
    # 脚本会把用户手机里的原图就地覆盖成 1600px 缩略图——不可逆，丢的是
    # 原始照片而不是产物。这条检查必须在真正读/写图片之前做。
    if dst.resolve() == src.resolve():
        raise PrepError(
            f"{src.name} 的产物会覆盖它自己，请把 -d 指到另一个目录。"
        )

    work = src
    tmp: Path | None = None
    try:
        if src.suffix.lower() in HEIC_SUFFIXES and not _heif_ready():
            tmp = outdir / (src.stem + ".sips-tmp.jpg")
            if not _sips_convert(src, tmp):
                raise PrepError(
                    f"{src.name} 是 HEIC 格式，本机没有可用的解码器。"
                    "请先把它导出成 JPG 或 PNG 再试"
                    "（iPhone 相册「共享 → 存储到文件」时选“最兼容”即可）。"
                )
            work = tmp

        try:
            img = Image.open(work)
            img.load()
        except Exception:
            raise PrepError(
                f"{src.name} 打不开，可能不是图片文件或已损坏。请确认后重试。"
            )

        try:
            img = img.convert("RGB")
            w, h = img.size
            if max(w, h) > max_edge:
                scale = max_edge / max(w, h)
                img = img.resize(
                    (max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS
                )
        except Exception:
            # 能被 Image.open + load() 打开，不代表 convert/resize 一定能扛住
            # （例如截断的调色板数据）——同样只拖垮这一张，不拖垮整批
            raise PrepError(
                f"{src.name} 处理失败，图片数据可能已损坏。请确认后重试。"
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
        used_names: set[str] = set()
        for raw in args.inputs:
            src = Path(raw)
            if not src.is_file():
                # 评审实测 Important 3：SKILL.md 自己教了一条一定会走到这里的路——
                # zsh 通配符没匹配到时 bash 会把 `票据/*.HEIC` 字面量原样传进来，
                # 脚本再把它当"文件不存在"记进 failed。旧文案「文件不存在」不含
                # 文件名也不给下一步，全军覆没时终端上只剩这四个字，等于没说。
                failed.append({
                    "source": src.name,
                    "reason": (
                        f"找不到「{src}」。请确认路径；如果你用了通配符，"
                        "可能是这批文件里没有这种扩展名。"
                    ),
                })
                continue
            try:
                out = prepare_one(src, outdir, args.max_edge, used_names)
            except PrepError as e:
                failed.append({"source": src.name, "reason": str(e)})
                continue
            items.append({"source": src.name, "output": str(out)})

        if not items:
            if not failed:
                reasons_text = "没有可处理的输入"
            else:
                # Minor 2：60 张票据同一个原因（比如清一色 HEIC 无解码器）会
                # 拼出几千字符的重复句甩给用户。但每条 reason 大多形如
                # 「{文件名} 具体原因」，文件名不同会让本来相同的原因被当成
                # 「不同」文本——去重前先把文件名从文案里抠掉，得到用来比较
                # 的"模板"，模板相同的只保留第一条完整文案，其余只计数。
                def _reason_key(entry: dict) -> str:
                    name = entry.get("source", "")
                    reason = entry.get("reason", "")
                    return reason.replace(name, "", 1) if name else reason

                seen_keys: list[str] = []
                shown: list[str] = []
                for f in failed:
                    key = _reason_key(f)
                    if key not in seen_keys:
                        seen_keys.append(key)
                        shown.append(f["reason"])
                shown = shown[:3]
                shown_keys = set(seen_keys[:3])
                remaining = sum(1 for f in failed if _reason_key(f) not in shown_keys)
                reasons_text = "；".join(shown)
                if remaining:
                    reasons_text += f"；另有 {remaining} 张同样原因，不逐条列出"
            _die(f"这批图片一张也没能处理成功。{reasons_text}")

        print(json.dumps({"outdir": str(outdir), "items": items, "failed": failed},
                         ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        # 兜底：任何未预期异常都转成格式化的中文错误消息
        # 这是本 PR 的全局约束：不能让 Python 堆栈泄漏到用户面前
        _die(f"处理过程中出错：{type(e).__name__}: {e}")


if __name__ == "__main__":
    raise SystemExit(main())
