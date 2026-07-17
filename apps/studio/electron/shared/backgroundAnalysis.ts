/**
 * Background-image adaptive analysis — mean luminance, dominant accent
 * color, visual focus point, and which side has the least visual
 * information (safe for UI content to sit over). Ported from
 * Codex-Dream-Skin's renderer-inject.js Canvas algorithm; here it runs in
 * the main process against a nativeImage-downsampled raw bitmap instead of
 * a browser Canvas, so this file stays a pure function with zero electron
 * import (bun-test-safe, matching the project's shared-module convention).
 *
 * Runs exactly once, at import time (electron/main/services/backgroundThemes.ts);
 * the result is persisted to meta.json and never recomputed on boot.
 */

export interface RawBitmap {
  data: Uint8Array
  width: number
  height: number
  /** Byte order of each 4-byte pixel. Electron's nativeImage.toBitmap() is BGRA. */
  format: 'bgra' | 'rgba'
}

export interface BackgroundAnalysis {
  /** Rec. 709 mean, 0-1. Only nudges scrim alpha at apply time — never overrides theme mode. */
  luminance: number
  /** Normalized focus point for background-position, clamped to keep the subject off-edge. */
  focus: { x: number; y: number }
  /** Which side has less visual information — the side UI content can safely sit over. */
  safeSide: 'left' | 'right' | 'none'
  palette: { accent: string; secondary: string; highlight: string }
}

interface Hsl {
  h: number
  s: number
  l: number
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: h * 60, s, l }
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = (((h % 360) + 360) % 360) / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return {
    r: Math.round(channel(hue + 1 / 3) * 255),
    g: Math.round(channel(hue) * 255),
    b: Math.round(channel(hue - 1 / 3) * 255)
  }
}

function toHex(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

// Fully-transparent/degenerate images (e.g. a blank canvas slipped through
// the format filter) get an inert neutral result instead of NaN — the
// caller still has real pixel bytes on disk even when analysis can't make
// sense of them, and a neutral fallback beats a corrupt meta.json.
const FALLBACK: BackgroundAnalysis = {
  luminance: 0.5,
  focus: { x: 0.5, y: 0.5 },
  safeSide: 'none',
  palette: { accent: '#8298a3', secondary: '#8da397', highlight: '#9d94a3' }
}

export function analyzeBackground(bitmap: RawBitmap): BackgroundAnalysis {
  const { data, width, height, format } = bitmap
  if (width <= 0 || height <= 0) return FALLBACK
  const rOff = format === 'bgra' ? 2 : 0
  const bOff = format === 'bgra' ? 0 : 2

  const light = new Float32Array(width * height)
  const sat = new Float32Array(width * height)
  const seen = new Uint8Array(width * height)
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }))
  let lightTotal = 0
  let rSum = 0
  let gSum = 0
  let bSum = 0
  let count = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x
      const offset = idx * 4
      const a = data[offset + 3]
      if (a === undefined || a < 32) continue
      const r = data[offset + rOff]!
      const g = data[offset + 1]!
      const b = data[offset + bOff]!
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const hsl = rgbToHsl(r, g, b)
      light[idx] = l
      sat[idx] = hsl.s
      seen[idx] = 1
      lightTotal += l
      rSum += r
      gSum += g
      bSum += b
      count += 1
      if (hsl.s >= 0.16 && hsl.l >= 0.16 && hsl.l <= 0.86) {
        const bin = bins[Math.min(23, Math.floor(hsl.h / 15))]!
        const weight = hsl.s * (1 - Math.abs(hsl.l - 0.52) * 0.85)
        bin.weight += weight
        bin.r += r * weight
        bin.g += g * weight
        bin.b += b * weight
      }
    }
  }

  if (count === 0) return FALLBACK

  const luminance = lightTotal / count

  const informationOf = (start: number, end: number): number => {
    let total = 0
    let totalSquared = 0
    let edges = 0
    let edgeCount = 0
    let pixels = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = start; x < end; x += 1) {
        const idx = y * width + x
        if (!seen[idx]) continue
        const l = light[idx]!
        total += l
        totalSquared += l * l
        pixels += 1
        if (x > start && seen[idx - 1]) {
          edges += Math.abs(l - light[idx - 1]!)
          edgeCount += 1
        }
        if (y > 0 && seen[idx - width]) {
          edges += Math.abs(l - light[idx - width]!)
          edgeCount += 1
        }
      }
    }
    const mean = pixels ? total / pixels : 0
    const variance = pixels ? Math.max(0, totalSquared / pixels - mean * mean) : 1
    return Math.sqrt(variance) * 0.58 + (edgeCount ? edges / edgeCount : 1) * 0.42
  }

  const zoneWidth = Math.max(1, Math.floor(width * 0.38))
  const leftInfo = informationOf(0, zoneWidth)
  const rightInfo = informationOf(width - zoneWidth, width)
  let safeSide: BackgroundAnalysis['safeSide'] = 'none'
  if (leftInfo < rightInfo * 0.86) safeSide = 'left'
  else if (rightInfo < leftInfo * 0.86) safeSide = 'right'

  let saliencyTotal = 0
  let saliencyX = 0
  let saliencyY = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x
      if (!seen[idx]) continue
      const l = light[idx]!
      const edge =
        (x > 0 && seen[idx - 1] ? Math.abs(l - light[idx - 1]!) : 0) +
        (y > 0 && seen[idx - width] ? Math.abs(l - light[idx - width]!) : 0)
      const weight = 0.01 + Math.abs(l - luminance) * 0.48 + sat[idx]! * 0.34 + edge * 0.28
      saliencyTotal += weight
      saliencyX += ((x + 0.5) / width) * weight
      saliencyY += ((y + 0.5) / height) * weight
    }
  }
  let focusX = saliencyTotal ? saliencyX / saliencyTotal : 0.5
  let focusY = saliencyTotal ? saliencyY / saliencyTotal : 0.5
  // Push the focus toward the high-information side so the picked point
  // (and background-position derived from it) never centers on the side
  // we just determined is safe for UI content to overlap.
  if (safeSide === 'left') focusX = Math.max(0.64, focusX)
  if (safeSide === 'right') focusX = Math.min(0.36, focusX)
  focusX = clamp(focusX, 0.12, 0.88)
  focusY = clamp(focusY, 0.18, 0.82)

  const dominant = bins.reduce(
    (best, candidate) => (candidate.weight > best.weight ? candidate : best),
    bins[0]!
  )
  const accentRgb = dominant.weight > 0
    ? { r: dominant.r / dominant.weight, g: dominant.g / dominant.weight, b: dominant.b / dominant.weight }
    : { r: rSum / count, g: gSum / count, b: bSum / count }
  const accentHsl = rgbToHsl(accentRgb.r, accentRgb.g, accentRgb.b)
  // +-24 deg hue rotation gives a triadic-ish secondary/highlight without
  // needing light/dark "shell" context — this is a one-click accent
  // suggestion in Settings, not a per-mode hero palette.
  const secondaryRgb = hslToRgb(accentHsl.h - 24, accentHsl.s * 0.85, clamp(accentHsl.l, 0.32, 0.68))
  const highlightRgb = hslToRgb(accentHsl.h + 24, accentHsl.s * 0.9, clamp(accentHsl.l, 0.28, 0.62))

  return {
    luminance,
    focus: { x: focusX, y: focusY },
    safeSide,
    palette: {
      accent: rgbToHex(accentRgb.r, accentRgb.g, accentRgb.b),
      secondary: rgbToHex(secondaryRgb.r, secondaryRgb.g, secondaryRgb.b),
      highlight: rgbToHex(highlightRgb.r, highlightRgb.g, highlightRgb.b)
    }
  }
}
