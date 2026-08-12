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
import os
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

    换名判断为什么查磁盘实况而不是只查 `used_names`（复审实测又挖出三个
    漏网变体，其中一个会不可逆删掉用户手机里的原始照片）：
      - 变体 A（大写扩展名，最严重）：iPhone 导出常见 `IMG_0012.JPG`，算出的
        产物名是小写的 `IMG_0012.jpg`——字符串不相等，但 APFS 默认大小写
        不敏感，两者其实是同一个 inode。旧版 `dst.resolve() == src.resolve()`
        是字符串/路径比较，在这种文件系统上判定"不相等"从而放行，实测
        exit 0、stderr 一个字都没有，原图就那么没了。
      - 变体 B（跨两次调用）：`used_names` 只在进程内共享，SKILL.md 的 A3
        教的是分两次调用（先 `*.jpg` 再 `*.HEIC`），第二次调用是全新进程，
        `used_names` 是空集合，看不到上一次已经写进 outdir 的文件，会直接
        覆盖第一次的产物。
      - 变体 C（同 stem 兄弟文件互毁）：批量输入里另一张源文件本身就叫这个
        名字（比如 `IMG_0012.png` 和 `IMG_0012.jpg` 一起传、`-d` 又指到它们
        所在目录），旧版只比较"自己的 src"，看不到"别人的 src"，会把别人的
        原图当成可覆盖的产物写坏。
    统一解法：候选名对应的路径如果已经在磁盘上存在，用 `os.path.samefile`
    精确区分"存在的就是我自己"（拒绝——写下去就是删了原图）还是"存在的是
    别人"（换下一个候选名，不算事故）。`used_names` 仍然保留、只是从判断
    依据降级成兜底加速——磁盘状态才是唯一真相源。
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
    while True:
        dst = outdir / name
        if name not in used_names and not dst.exists():
            break
        if dst.exists() and os.path.samefile(dst, src):
            # 评审实测 Important 2 + 变体 A：这个候选名磁盘上已经有文件，
            # 而且就是 src 自己（要么真是同一路径，要么是大小写不敏感文件
            # 系统把不同大小写的名字解析到了同一个 inode）。写下去就是把
            # 用户手机里的原图覆盖成缩略图，不可逆，必须直接拒绝，不能
            # 换个名字了事——换名只对"撞到别人"有效，撞到自己无解。
            raise PrepError(
                f"{src.name} 的产物会覆盖它自己，请把 -d 指到另一个目录。"
            )
        # 撞到的是别人（另一张源文件，或上一次调用留下的产物）——换名重试
        name = f"{src.stem}-{n}.jpg"
        n += 1

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

        # Minor 1：这一行必须在保存成功之后才登记，不能挪到函数开头算完
        # name 就立刻占用。旧实现在任何读写图片之前就 add(name)，一张
        # 失败的图（比如损坏文件）也会白白烧掉一个名额——同批里唯一成功
        # 的那张会被挤成 `stem-2.jpg`，而它本该拿到的 `stem.jpg` 却始终
        # 空着没人用。名额只该属于真正落盘成功的产物。
        used_names.add(name)
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
                # 复审实测：旧版 `remaining` 统计的是"模板不在已展示前 3 个
                # 里的条数"——12 个文件全是同一个原因时，唯一的模板本来就在
                # 已展示集合里，算出来是 0，「另有 N 张同样原因」这句话根本
                # 不会打印，用户看到的只有 1 条文案、1 个文件名，完全不知道
                # 这批实际失败了 12 张。真正想表达的是「总数减去已经完整
                # 展示过的条数」：每个展示出来的模板只占用 1 条名额，同模板
                # 剩下的、以及模板本身超过前 3 个上限被砍掉的，都该算进
                # remaining——用 `len(failed) - len(shown)` 一次性覆盖两种
                # 情况，不用再分场景讨论。
                remaining = len(failed) - len(shown)
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
