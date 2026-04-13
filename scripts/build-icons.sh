#!/usr/bin/env bash
# Generate build-resource icons (.icns / .ico / .png) from resources/icon@1024.png.
# electron-builder reads them automatically from the `build/` directory.
#
# Requires: sips + iconutil (both shipped with macOS). On Linux/Windows the
# .icns step is skipped.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/resources/icon@1024.png"
BUILD="$ROOT/build"

if [[ ! -f "$SRC" ]]; then
  echo "error: $SRC not found" >&2
  exit 1
fi

mkdir -p "$BUILD"

# ---- macOS .icns ----
if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/icon.iconset"
  mkdir -p "$ICONSET"
  # (size, @suffix) pairs iconutil expects
  declare -a specs=(
    "16   icon_16x16.png"
    "32   icon_16x16@2x.png"
    "32   icon_32x32.png"
    "64   icon_32x32@2x.png"
    "128  icon_128x128.png"
    "256  icon_128x128@2x.png"
    "256  icon_256x256.png"
    "512  icon_256x256@2x.png"
    "512  icon_512x512.png"
    "1024 icon_512x512@2x.png"
  )
  for spec in "${specs[@]}"; do
    size="${spec%% *}"
    name="${spec##* }"
    sips -z "$size" "$size" "$SRC" --out "$ICONSET/$name" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUILD/icon.icns"
  rm -rf "$(dirname "$ICONSET")"
  echo "✓ build/icon.icns"
else
  echo "skip .icns (iconutil/sips not available — run on macOS)"
fi

# ---- Windows .ico + Linux .png ----
cp "$ROOT/resources/icon.ico" "$BUILD/icon.ico"
echo "✓ build/icon.ico"

cp "$ROOT/resources/icon.png" "$BUILD/icon.png"
echo "✓ build/icon.png"
