#!/usr/bin/env python3
"""
PPT Master - Offline Slide Preview Builder

Renders a single svg_output/<name>.svg the same way the desktop app's native
live preview shows it — icon placeholders inlined — without any server. This
is the offline equivalent of the old svg_editor/server.py's
``GET /api/slide/<name>`` (minus the annotation / staged-edit merge, which
only matters to the interactive editor — that state now lives in the
renderer's own store, not here).

``visual_review.py`` is the sole consumer: it needs a rendered, icon-inlined
SVG to hand to a browser for screenshotting, and used to get that by fetching
the live-preview HTTP server; this module gives it the same bytes directly
from disk, so visual review no longer requires a running server.

Usage:
    (library module — imported by visual_review.py)

Dependencies:
    None (standard library only)
"""

import html
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_FINALIZE_DIR = _SCRIPTS_DIR.parent / 'svg_finalize'
if str(_FINALIZE_DIR) not in sys.path:
    sys.path.insert(0, str(_FINALIZE_DIR))

from annotations import assign_temp_ids  # noqa: E402
from embed_icons import (  # noqa: E402
    extract_paths_from_icon,
    generate_icon_group,
    parse_use_element,
    resolve_icon_path,
)

_ICONS_DIR = _SCRIPTS_DIR.parent.parent / 'templates' / 'icons'
_USE_ICON_PATTERN = re.compile(r'<use\s+[^>]*data-icon="[^"]*"[^>]*/>')

# Matches `href="../images/foo.png"` / `xlink:href="../assets/bar.png"` — the
# two prefixes svg_output SVGs use to reach project-local media (mirrors the
# old server's /images/<path> and /assets/<path> routes).
_ASSET_HREF_RE = re.compile(r'((?:xlink:)?href)="(\.\./images/|\.\./assets/)([^"]+)"')
# Matches a bare (no `../` prefix) image href — mirror templates copy hrefs
# verbatim, so a bare filename like `href="cover_bg.png"` needs resolving
# against images/ then assets/ (mirrors the old server's bare-asset fallback
# route). Restricted to image extensions so `href="#gradient1"` (an SVG
# internal fragment reference) is never touched.
_BARE_HREF_RE = re.compile(
    r'((?:xlink:)?href)="([^"/][^":]*\.(?:png|jpe?g|gif|webp|svg))"', re.IGNORECASE,
)


def _xml_attr(value: object) -> str:
    """Escape a value for safe insertion into generated preview SVG markup."""
    return html.escape(str(value), quote=True)


def inline_icons(content: str, icons_dir: Path = _ICONS_DIR) -> tuple[str, list[dict]]:
    """Replace ``<use data-icon="..."/>`` with a rendered ``<g>`` for preview.

    Returns ``(rewritten_content, warnings)``. Each warning is
    ``{"icon": <name>, "reason": <str>}``. Ported verbatim from the old
    ``svg_editor/server.py._inline_icons`` — this is the single source of
    truth for icon inlining now (the desktop app's TS port lives in
    src/chat/lib/pptPreview/inlineIcons.ts and must stay behaviorally
    equivalent to this function).
    """
    warnings: list[dict] = []
    matches = list(_USE_ICON_PATTERN.finditer(content))
    if not matches:
        return content, warnings
    new_content = content
    for match in reversed(matches):
        use_str = match.group(0)
        icon_name: str = ''
        try:
            attrs = parse_use_element(use_str)
            icon_name = str(attrs.get('icon') or '')
            if not icon_name:
                warnings.append({'icon': '', 'reason': 'missing data-icon attribute'})
                continue
            icon_path, _ = resolve_icon_path(icon_name, icons_dir)
            color = str(attrs.get('fill', '#000000'))
            elements, style, base_size = extract_paths_from_icon(icon_path, color)
        except Exception as exc:
            warnings.append({'icon': icon_name, 'reason': f'{type(exc).__name__}: {exc}'})
            continue
        if not elements:
            warnings.append({'icon': icon_name, 'reason': 'no renderable paths in icon'})
            continue
        replacement = generate_icon_group(attrs, elements, style, base_size)
        id_match = re.search(r'\bid="([^"]+)"', use_str)
        if id_match:
            preview_attrs = [
                f'id="{_xml_attr(id_match.group(1))}"',
                f'data-icon="{_xml_attr(icon_name)}"',
            ]
            for key in ('x', 'y', 'width', 'height'):
                if key in attrs:
                    preview_attrs.append(f'data-use-{key}="{_xml_attr(attrs[key])}"')
            if 'transform' in attrs:
                preview_attrs.append('data-use-has-transform="1"')
            replacement = replacement.replace('<g ', f'<g {" ".join(preview_attrs)} ', 1)
        new_content = new_content[:match.start()] + replacement + new_content[match.end():]
    return new_content, warnings


def _safe_svg_path(svg_dir: Path, name: str) -> Optional[Path]:
    """Validate a slide name and return its safe path, or None if invalid.

    Mirrors the old server's ``_safe_svg_path`` traversal guard.
    """
    if '/' in name or '\\' in name or '..' in name:
        return None
    svg_file = (svg_dir / name).resolve()
    if not str(svg_file).startswith(str(svg_dir.resolve())):
        return None
    return svg_file


def build_preview_svg(
    project_path: Path, name: str, icons_dir: Path = _ICONS_DIR,
) -> tuple[str, list[dict]]:
    """Read ``svg_output/<name>.svg``, assign stable temp ids (parity with
    the desktop live preview's element numbering), inline icon placeholders,
    and return the rendered markup plus any icon warnings.

    Raises ``FileNotFoundError`` for a missing/invalid slide name and
    ``xml.etree.ElementTree.ParseError`` for malformed SVG — the caller
    decides how to report that (``visual_review.py`` turns both into a
    per-page failure record).
    """
    svg_dir = project_path / 'svg_output'
    svg_file = _safe_svg_path(svg_dir, name)
    if svg_file is None or not svg_file.exists():
        raise FileNotFoundError(f'slide not found: {name}')
    tree = ET.parse(str(svg_file))
    root = tree.getroot()
    assign_temp_ids(root)
    content = ET.tostring(root, encoding='unicode', xml_declaration=False)
    return inline_icons(content, icons_dir)


def absolutize_for_file(content: str, project_path: Path) -> str:
    """Rewrite ``../images/*``, ``../assets/*``, and bare image hrefs to
    absolute ``file://`` URLs, so a browser given this markup as a standalone
    file can resolve sub-resources without the ``/images/<path>`` and
    ``/assets/<path>`` HTTP routes the old server used to serve them from.
    Unresolvable bare hrefs are left as-is (the caller's icon warnings cover
    missing icons only; a missing background image just renders blank, which
    is the same degradation the old server had for a 404'd image).
    """
    images_dir = (project_path / 'images').resolve()
    assets_dir = (project_path / 'assets').resolve()

    def _asset_sub(m: 're.Match[str]') -> str:
        attr, prefix, rel = m.group(1), m.group(2), m.group(3)
        base = images_dir if prefix == '../images/' else assets_dir
        target = (base / rel).resolve()
        return f'{attr}="file://{target}"'

    content = _ASSET_HREF_RE.sub(_asset_sub, content)

    def _bare_sub(m: 're.Match[str]') -> str:
        attr, rel = m.group(1), m.group(2)
        for base in (images_dir, assets_dir):
            target = (base / rel).resolve()
            if target.exists():
                return f'{attr}="file://{target}"'
        return m.group(0)

    return _BARE_HREF_RE.sub(_bare_sub, content)
