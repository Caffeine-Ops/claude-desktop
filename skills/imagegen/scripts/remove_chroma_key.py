#!/usr/bin/env python3
"""Remove a solid chroma-key background from an image.

This helper supports the imagegen skill's transparent workflow:
generate an image on a flat key color, then convert that key color to alpha.

claude-desktop fork: rewritten to be PURE STANDARD LIBRARY. The upstream
version required Pillow for image I/O and the two alpha filters; the app's
bundled Python runtime ships no third-party packages, so this fork replaces:

  - Image.open / image.save        → hand-rolled PNG decoder/encoder
                                     (zlib + struct + CRC, 8-bit only)
  - ImageFilter.MinFilter(3)       → separable 3x3 erosion on the alpha plane
  - ImageFilter.GaussianBlur       → 3-pass box blur approximation

The keying algorithm itself (border sampling, soft matte, dominance alpha,
despill) is preserved 1:1 from upstream. Constraints introduced by the
rewrite: input and output must both be PNG (the workflow's input is always
our own generated PNG; the stdlib cannot encode WEBP), 8-bit non-interlaced.
"""

from __future__ import annotations

import argparse
import re
import struct
import sys
import zlib
from pathlib import Path
from statistics import median
from typing import Tuple

Color = Tuple[int, int, int]
KEY_DOMINANCE_THRESHOLD = 16.0
ALPHA_NOISE_FLOOR = 8

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _die(message: str, code: int = 1) -> None:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(code)


# ─────────────────────────── PNG codec (stdlib) ───────────────────────────
#
# Minimal but correct 8-bit PNG support. Decoder handles color types
# 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha), 6 (RGBA) with optional
# tRNS, non-interlaced only — everything an image API returns in practice.
# Encoder always writes color type 6 (RGBA) with filter 0 rows: simplest
# correct output, and alpha is the whole point of this tool.


def _read_png(path: Path) -> tuple[bytearray, int, int]:
    """Decode a PNG file → (RGBA bytearray, width, height)."""
    data = path.read_bytes()
    if data[:8] != PNG_SIGNATURE:
        _die(f"Not a PNG file: {path} (this tool only reads PNG input)")

    width = height = bit_depth = color_type = interlace = 0
    palette = b""
    trns = b""
    idat = bytearray()
    pos = 8
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length  # len + type + data + crc
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, _comp, _filt, interlace = (
                struct.unpack(">IIBBBBB", body)
            )
        elif ctype == b"PLTE":
            palette = body
        elif ctype == b"tRNS":
            trns = body
        elif ctype == b"IDAT":
            idat.extend(body)
        elif ctype == b"IEND":
            break

    if width == 0 or height == 0:
        _die("Corrupt PNG: missing IHDR.")
    if bit_depth != 8:
        _die(f"Unsupported PNG bit depth {bit_depth} (only 8-bit is supported).")
    if interlace != 0:
        _die("Interlaced (Adam7) PNG is not supported.")
    channels_by_type = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    if color_type not in channels_by_type:
        _die(f"Unsupported PNG color type {color_type}.")
    channels = channels_by_type[color_type]

    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    if len(raw) < (stride + 1) * height:
        _die("Corrupt PNG: pixel data shorter than expected.")

    # Un-filter scanlines (spec filters 0-4). prev = reconstructed prior row.
    recon = bytearray(stride * height)
    prev_start = -1
    bpp = channels
    src = 0
    for y in range(height):
        ftype = raw[src]
        src += 1
        line = bytearray(raw[src : src + stride])
        src += stride
        if ftype == 0:
            pass
        elif ftype == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:  # Up
            if prev_start >= 0:
                for i in range(stride):
                    line[i] = (line[i] + recon[prev_start + i]) & 0xFF
        elif ftype == 3:  # Average
            if prev_start >= 0:
                for i in range(stride):
                    left = line[i - bpp] if i >= bpp else 0
                    line[i] = (line[i] + ((left + recon[prev_start + i]) >> 1)) & 0xFF
            else:
                for i in range(bpp, stride):
                    line[i] = (line[i] + (line[i - bpp] >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = recon[prev_start + i] if prev_start >= 0 else 0
                c = (
                    recon[prev_start + i - bpp]
                    if prev_start >= 0 and i >= bpp
                    else 0
                )
                p = a + b - c
                pa = abs(p - a)
                pb = abs(p - b)
                pc = abs(p - c)
                if pa <= pb and pa <= pc:
                    pred = a
                elif pb <= pc:
                    pred = b
                else:
                    pred = c
                line[i] = (line[i] + pred) & 0xFF
        else:
            _die(f"Corrupt PNG: unknown filter type {ftype}.")
        recon[y * stride : (y + 1) * stride] = line
        prev_start = y * stride

    # Expand every color type to flat RGBA.
    n = width * height
    rgba = bytearray(n * 4)
    if color_type == 6:
        rgba[:] = recon
    elif color_type == 2:
        rgba[3::4] = b"\xff" * n
        rgba[0::4] = recon[0::3]
        rgba[1::4] = recon[1::3]
        rgba[2::4] = recon[2::3]
    elif color_type == 0:
        rgba[0::4] = recon
        rgba[1::4] = recon
        rgba[2::4] = recon
        rgba[3::4] = b"\xff" * n
    elif color_type == 4:
        rgba[0::4] = recon[0::2]
        rgba[1::4] = recon[0::2]
        rgba[2::4] = recon[0::2]
        rgba[3::4] = recon[1::2]
    elif color_type == 3:
        for i in range(n):
            idx = recon[i]
            base = idx * 3
            j = i * 4
            rgba[j] = palette[base]
            rgba[j + 1] = palette[base + 1]
            rgba[j + 2] = palette[base + 2]
            rgba[j + 3] = trns[idx] if idx < len(trns) else 255
    return rgba, width, height


def _png_chunk(ctype: bytes, body: bytes) -> bytes:
    return (
        struct.pack(">I", len(body))
        + ctype
        + body
        + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF)
    )


def _write_png(path: Path, rgba: bytearray, width: int, height: int) -> None:
    """Encode a flat RGBA buffer as an 8-bit RGBA PNG (filter 0 rows)."""
    stride = width * 4
    raw = bytearray((stride + 1) * height)
    for y in range(height):
        dst = y * (stride + 1)
        raw[dst] = 0  # filter type 0 (None)
        raw[dst + 1 : dst + 1 + stride] = rgba[y * stride : (y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        PNG_SIGNATURE
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + _png_chunk(b"IEND", b"")
    )


# ────────────────────────── keying (upstream 1:1) ──────────────────────────


def _parse_key_color(raw: str) -> Color:
    value = raw.strip()
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", value)
    if not match:
        _die("key color must be a hex RGB value like #00ff00.")
    hex_value = match.group(1)
    return (
        int(hex_value[0:2], 16),
        int(hex_value[2:4], 16),
        int(hex_value[4:6], 16),
    )


def _validate_args(args: argparse.Namespace) -> None:
    if args.tolerance < 0 or args.tolerance > 255:
        _die("--tolerance must be between 0 and 255.")
    if args.transparent_threshold < 0 or args.transparent_threshold > 255:
        _die("--transparent-threshold must be between 0 and 255.")
    if args.opaque_threshold < 0 or args.opaque_threshold > 255:
        _die("--opaque-threshold must be between 0 and 255.")
    if args.soft_matte and args.transparent_threshold >= args.opaque_threshold:
        _die("--transparent-threshold must be lower than --opaque-threshold.")
    if args.edge_feather < 0 or args.edge_feather > 64:
        _die("--edge-feather must be between 0 and 64.")
    if args.edge_contract < 0 or args.edge_contract > 16:
        _die("--edge-contract must be between 0 and 16.")

    src = Path(args.input)
    if not src.exists():
        _die(f"Input image not found: {src}")
    if src.suffix.lower() != ".png":
        _die(
            "--input must be a .png (stdlib fork reads PNG only; generate the "
            "flat-background source as PNG, which is the default output format)."
        )

    out = Path(args.out)
    if out.exists() and not args.force:
        _die(f"Output already exists: {out} (use --force to overwrite)")
    if out.suffix.lower() != ".png":
        _die(
            "--out must end in .png (stdlib fork cannot encode WEBP; "
            "PNG preserves the alpha channel)."
        )


def _clamp_channel(value: float) -> int:
    return max(0, min(255, int(round(value))))


def _smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def _soft_alpha(distance: int, transparent_threshold: float, opaque_threshold: float) -> int:
    if distance <= transparent_threshold:
        return 0
    if distance >= opaque_threshold:
        return 255
    ratio = (float(distance) - transparent_threshold) / (
        opaque_threshold - transparent_threshold
    )
    return _clamp_channel(255.0 * _smoothstep(ratio))


def _spill_channels(key: Color) -> list[int]:
    key_max = max(key)
    if key_max < 128:
        return []
    return [idx for idx, value in enumerate(key) if value >= key_max - 16 and value >= 128]


def _key_channel_dominance(rgb: Color, key: Color, spill_channels: list[int]) -> float:
    if not spill_channels:
        return 0.0
    channels = [float(value) for value in rgb]
    non_spill = [idx for idx in range(3) if idx not in spill_channels]
    key_strength = (
        min(channels[idx] for idx in spill_channels)
        if len(spill_channels) > 1
        else channels[spill_channels[0]]
    )
    non_key_strength = max((channels[idx] for idx in non_spill), default=0.0)
    return key_strength - non_key_strength


def _dominance_alpha(rgb: Color, key: Color, spill_channels: list[int]) -> int:
    if not spill_channels:
        return 255
    channels = [float(value) for value in rgb]
    non_spill = [idx for idx in range(3) if idx not in spill_channels]
    key_strength = (
        min(channels[idx] for idx in spill_channels)
        if len(spill_channels) > 1
        else channels[spill_channels[0]]
    )
    non_key_strength = max((channels[idx] for idx in non_spill), default=0.0)
    dominance = key_strength - non_key_strength
    if dominance <= 0:
        return 255
    denominator = max(1.0, float(max(key)) - non_key_strength)
    alpha = 1.0 - min(1.0, dominance / denominator)
    return _clamp_channel(alpha * 255.0)


def _cleanup_spill(rgb: Color, key: Color, spill_channels: list[int], alpha: int = 255) -> Color:
    if alpha >= 252:
        return rgb
    if not spill_channels:
        return rgb
    channels = [float(value) for value in rgb]
    non_spill = [idx for idx in range(3) if idx not in spill_channels]
    if non_spill:
        anchor = max(channels[idx] for idx in non_spill)
        cap = max(0.0, anchor - 1.0)
        for idx in spill_channels:
            if channels[idx] > cap:
                channels[idx] = cap
    return (
        _clamp_channel(channels[0]),
        _clamp_channel(channels[1]),
        _clamp_channel(channels[2]),
    )


def _apply_alpha_to_buf(
    buf: bytearray,
    width: int,
    height: int,
    *,
    key: Color,
    tolerance: int,
    spill_cleanup: bool,
    soft_matte: bool,
    transparent_threshold: float,
    opaque_threshold: float,
) -> int:
    """Upstream _apply_alpha_to_image, ported from PIL pixel access to a flat
    RGBA bytearray. The per-pixel decision tree is identical; the max-abs-diff
    distance is inlined because it runs a million times on a 1024² image."""
    kr, kg, kb = key
    spill = _spill_channels(key)
    transparent = 0
    total_bytes = width * height * 4

    for i in range(0, total_bytes, 4):
        r = buf[i]
        g = buf[i + 1]
        b = buf[i + 2]
        a = buf[i + 3]
        # distance = max(|Δr|, |Δg|, |Δb|)  (upstream _channel_distance)
        d = r - kr
        if d < 0:
            d = -d
        t = g - kg
        if t < 0:
            t = -t
        if t > d:
            d = t
        t = b - kb
        if t < 0:
            t = -t
        if t > d:
            d = t

        # upstream _looks_key_colored
        if d <= 32 or not spill:
            key_like = True
        else:
            key_like = (
                _key_channel_dominance((r, g, b), key, spill)
                >= KEY_DOMINANCE_THRESHOLD
            )

        if soft_matte and key_like:
            output_alpha = min(
                _soft_alpha(d, transparent_threshold, opaque_threshold),
                _dominance_alpha((r, g, b), key, spill),
            )
        else:
            output_alpha = 0 if d <= tolerance else 255
        if a != 255:
            output_alpha = int(round(output_alpha * (a / 255.0)))
        if 0 < output_alpha <= ALPHA_NOISE_FLOOR:
            output_alpha = 0

        if output_alpha == 0:
            buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0
            transparent += 1
            continue

        if spill_cleanup and key_like:
            r2, g2, b2 = _cleanup_spill((r, g, b), key, spill, output_alpha)
            buf[i] = r2
            buf[i + 1] = g2
            buf[i + 2] = b2
        buf[i + 3] = output_alpha

    return transparent


# ─────────────────── alpha-plane filters (PIL replacements) ───────────────────


def _erode_alpha_once(alpha: bytearray, width: int, height: int) -> bytearray:
    """One 3x3 min-filter pass == PIL ImageFilter.MinFilter(3). Separable:
    horizontal 3-min then vertical 3-min gives the same square erosion."""
    tmp = bytearray(len(alpha))
    for y in range(height):
        row = y * width
        for x in range(width):
            lo = alpha[row + x]
            if x > 0 and alpha[row + x - 1] < lo:
                lo = alpha[row + x - 1]
            if x + 1 < width and alpha[row + x + 1] < lo:
                lo = alpha[row + x + 1]
            tmp[row + x] = lo
    out = bytearray(len(alpha))
    for y in range(height):
        row = y * width
        for x in range(width):
            lo = tmp[row + x]
            if y > 0 and tmp[row - width + x] < lo:
                lo = tmp[row - width + x]
            if y + 1 < height and tmp[row + width + x] < lo:
                lo = tmp[row + width + x]
            out[row + x] = lo
    return out


def _box_blur_alpha(alpha: bytearray, width: int, height: int, radius: int) -> bytearray:
    """One separable box blur pass with a running-sum window (O(n))."""
    if radius <= 0:
        return alpha
    window = 2 * radius + 1
    tmp = bytearray(len(alpha))
    # horizontal
    for y in range(height):
        row = y * width
        acc = alpha[row] * (radius + 1)
        for x in range(1, radius + 1):
            acc += alpha[row + min(x, width - 1)]
        for x in range(width):
            tmp[row + x] = acc // window
            acc += alpha[row + min(x + radius + 1, width - 1)]
            acc -= alpha[row + max(x - radius, 0)]
    # vertical
    out = bytearray(len(alpha))
    for x in range(width):
        acc = tmp[x] * (radius + 1)
        for y in range(1, radius + 1):
            acc += tmp[min(y, height - 1) * width + x]
        for y in range(height):
            out[y * width + x] = acc // window
            acc += tmp[min(y + radius + 1, height - 1) * width + x]
            acc -= tmp[max(y - radius, 0) * width + x]
    return out


def _gaussian_blur_alpha(
    alpha: bytearray, width: int, height: int, sigma: float
) -> bytearray:
    """3-pass box blur ≈ Gaussian (classic approximation; PIL's GaussianBlur
    radius parameter is the standard deviation). Visually indistinguishable
    for feathering purposes."""
    # Ideal box width for 3 passes (W. Wells): sqrt(12σ²/3 + 1)
    ideal = (12.0 * sigma * sigma / 3.0 + 1.0) ** 0.5
    radius = max(1, int((ideal - 1) / 2))
    for _ in range(3):
        alpha = _box_blur_alpha(alpha, width, height, radius)
    return alpha


def _contract_alpha(buf: bytearray, width: int, height: int, pixels: int) -> None:
    if pixels == 0:
        return
    alpha = bytearray(buf[3::4])
    for _ in range(pixels):
        alpha = _erode_alpha_once(alpha, width, height)
    buf[3::4] = alpha


def _apply_edge_feather(buf: bytearray, width: int, height: int, radius: float) -> None:
    if radius == 0:
        return
    alpha = bytearray(buf[3::4])
    alpha = _gaussian_blur_alpha(alpha, width, height, radius)
    buf[3::4] = alpha


# ──────────────────────────── sampling / stats ────────────────────────────


def _alpha_counts(buf: bytearray) -> tuple[int, int, int]:
    total = len(buf) // 4
    transparent = 0
    partial = 0
    for i in range(3, len(buf), 4):
        a = buf[i]
        if a == 0:
            transparent += 1
        elif a < 255:
            partial += 1
    return total, transparent, partial


def _sample_border_key(buf: bytearray, width: int, height: int, mode: str) -> Color:
    samples_r: list[int] = []
    samples_g: list[int] = []
    samples_b: list[int] = []

    def sample(x: int, y: int) -> None:
        i = (y * width + x) * 4
        samples_r.append(buf[i])
        samples_g.append(buf[i + 1])
        samples_b.append(buf[i + 2])

    if mode == "corners":
        patch = max(1, min(width, height, 12))
        boxes = [
            (0, 0, patch, patch),
            (width - patch, 0, width, patch),
            (0, height - patch, patch, height),
            (width - patch, height - patch, width, height),
        ]
        for left, top, right, bottom in boxes:
            for y in range(top, bottom):
                for x in range(left, right):
                    sample(x, y)
    else:
        band = max(1, min(width, height, 6))
        step = max(1, min(width, height) // 256)
        for x in range(0, width, step):
            for y in range(band):
                sample(x, y)
                sample(x, height - 1 - y)
        for y in range(0, height, step):
            for x in range(band):
                sample(x, y)
                sample(width - 1 - x, y)

    if not samples_r:
        _die("Could not sample background key color from image border.")

    return (
        int(round(median(samples_r))),
        int(round(median(samples_g))),
        int(round(median(samples_b))),
    )


# ─────────────────────────────── entrypoint ───────────────────────────────


def _remove_chroma_key(args: argparse.Namespace) -> None:
    src = Path(args.input)
    out = Path(args.out)

    rgba, width, height = _read_png(src)
    key = (
        _sample_border_key(rgba, width, height, args.auto_key)
        if args.auto_key != "none"
        else _parse_key_color(args.key_color)
    )

    transparent = _apply_alpha_to_buf(
        rgba,
        width,
        height,
        key=key,
        tolerance=args.tolerance,
        spill_cleanup=args.spill_cleanup,
        soft_matte=args.soft_matte,
        transparent_threshold=args.transparent_threshold,
        opaque_threshold=args.opaque_threshold,
    )
    _contract_alpha(rgba, width, height, args.edge_contract)
    _apply_edge_feather(rgba, width, height, args.edge_feather)

    total, transparent_after, partial_after = _alpha_counts(rgba)

    out.parent.mkdir(parents=True, exist_ok=True)
    _write_png(out, rgba, width, height)

    print(f"Wrote {out}")
    print(f"Key color: #{key[0]:02x}{key[1]:02x}{key[2]:02x}")
    print(f"Transparent pixels: {transparent_after}/{total}")
    print(f"Partially transparent pixels: {partial_after}/{total}")
    if transparent == 0:
        print("Warning: no pixels matched the key color before feathering.", file=sys.stderr)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Remove a solid chroma-key background and write a PNG with alpha."
    )
    parser.add_argument("--input", required=True, help="Input .png path.")
    parser.add_argument("--out", required=True, help="Output .png path.")
    parser.add_argument(
        "--key-color",
        default="#00ff00",
        help="Hex RGB key color to remove, for example #00ff00.",
    )
    parser.add_argument(
        "--tolerance",
        type=int,
        default=12,
        help="Hard-key per-channel tolerance for matching the key color, 0-255.",
    )
    parser.add_argument(
        "--auto-key",
        choices=["none", "corners", "border"],
        default="none",
        help="Sample the key color from image corners or border instead of --key-color.",
    )
    parser.add_argument(
        "--soft-matte",
        action="store_true",
        help="Use a smooth alpha ramp between transparent and opaque thresholds.",
    )
    parser.add_argument(
        "--transparent-threshold",
        type=float,
        default=12.0,
        help="Soft-matte distance at or below which pixels become fully transparent.",
    )
    parser.add_argument(
        "--opaque-threshold",
        type=float,
        default=96.0,
        help="Soft-matte distance at or above which pixels become fully opaque.",
    )
    parser.add_argument(
        "--edge-feather",
        type=float,
        default=0.0,
        help="Optional alpha blur radius for softened edges, 0-64.",
    )
    parser.add_argument(
        "--edge-contract",
        type=int,
        default=0,
        help="Shrink the visible alpha matte by this many pixels before feathering.",
    )
    parser.add_argument(
        "--spill-cleanup",
        dest="spill_cleanup",
        action="store_true",
        help="Reduce obvious key-color spill on opaque pixels.",
    )
    parser.add_argument(
        "--despill",
        dest="spill_cleanup",
        action="store_true",
        help="Alias for --spill-cleanup; decontaminate key-color edge spill.",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite an existing output file.")
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    _validate_args(args)
    _remove_chroma_key(args)


if __name__ == "__main__":
    main()
