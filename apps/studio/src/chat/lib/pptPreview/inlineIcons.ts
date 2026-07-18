/**
 * PPT-master live preview — icon inlining.
 *
 * Port of skills/ppt-master/scripts/svg_finalize/embed_icons.py's element
 * extraction/geometry math plus svg_editor/server.py's `_inline_icons`
 * orchestration (both now gone — the Python side's offline equivalent lives
 * in skills/ppt-master/scripts/svg_editor/slide_preview.py, which
 * visual_review.py uses; this file is the renderer's copy of the SAME
 * algorithm, so a deck looks identical in the live preview and in a
 * visual-review screenshot).
 *
 * Icon SOURCE FILES (templates/icons/<lib>/<name>.svg) are read over the
 * pptasset:// protocol via `fetch()` — `iconsRoot` comes from
 * PPT_PREVIEW_LIST_SLIDES, resolved main-side so this module never has to
 * guess where the skill is installed.
 */

import { toPptAssetUrl } from '../pptAssetUrl'

export interface IconWarning {
  icon: string
  reason: string
}

type IconStyle = 'fill' | 'stroke' | 'preserve'
/** Square icons carry a single side length; `preserve-color` assets (which
 *  keep their own aspect ratio) carry a full [minX, minY, width, height]. */
type BaseGeometry = number | [number, number, number, number]

// ---------------------------------------------------------------------------
// Icon file loading (fetched over pptasset://, cached per relative path).
// ---------------------------------------------------------------------------

export type IconLoader = (relPath: string) => Promise<string | null>

/** Build a loader rooted at `iconsRoot` (the skill's templates/icons/
 *  absolute path). Caches by relative path for the lifetime of the loader —
 *  callers create one loader per slide-load pass. */
export function createIconLoader(iconsRoot: string): IconLoader {
  const cache = new Map<string, Promise<string | null>>()
  return (relPath: string): Promise<string | null> => {
    const cached = cache.get(relPath)
    if (cached) return cached
    const promise = fetch(toPptAssetUrl(`${iconsRoot}/${relPath}`))
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null)
    cache.set(relPath, promise)
    return promise
  }
}

// ---------------------------------------------------------------------------
// Icon name → candidate file resolution. Port of embed_icons.py's
// `_resolve_in_dir` (no `fallback_dir` support — the live preview never
// passes one; that parameter only matters to the offline finalize step).
// ---------------------------------------------------------------------------

const LIB_ALIASES: Record<string, string> = { chunk: 'chunk-filled' }
const ICON_BASE_SIZES: Record<string, number> = {
  'chunk-filled': 16,
  chunk: 16,
  'tabler-filled': 24,
  'tabler-outline': 24,
  'phosphor-duotone': 256,
  'simple-icons': 24
}

interface IconCandidate {
  relPath: string
  baseSize: number
}

function iconCandidates(iconName: string): IconCandidate[] {
  if (iconName.includes('/')) {
    const slash = iconName.indexOf('/')
    const libRaw = iconName.slice(0, slash)
    const name = iconName.slice(slash + 1)
    const lib = LIB_ALIASES[libRaw] ?? libRaw
    return [{ relPath: `${lib}/${name}.svg`, baseSize: ICON_BASE_SIZES[lib] ?? 24 }]
  }
  // Un-prefixed: chunk-filled/ first, then the legacy flat layout.
  return [
    { relPath: `chunk-filled/${iconName}.svg`, baseSize: 16 },
    { relPath: `${iconName}.svg`, baseSize: 16 }
  ]
}

interface ResolvedIcon {
  content: string
  baseSize: number
}

/**
 * Try each candidate path in order, returning the first one the loader can
 * fetch. Differs from Python's `resolve_icon_path` + `extract_paths_from_icon`
 * pairing in one small way: Python resolves to a single path (falling back
 * only for un-prefixed names) and THEN checks existence, producing a "no
 * renderable paths in icon" warning for a resolved-but-missing prefixed
 * path; here a missing file is indistinguishable from "no candidate
 * resolved", so it surfaces as "icon not found" instead. Cosmetic only —
 * the outcome (icon fails to render, a warning is surfaced) is identical.
 */
async function resolveIcon(iconName: string, loader: IconLoader): Promise<ResolvedIcon | null> {
  for (const candidate of iconCandidates(iconName)) {
    const content = await loader(candidate.relPath)
    if (content !== null) return { content, baseSize: candidate.baseSize }
  }
  return null
}

// ---------------------------------------------------------------------------
// Icon file → drawable elements. Port of embed_icons.py's geometry/shape
// extraction functions.
// ---------------------------------------------------------------------------

function getViewBoxSize(content: string): number {
  const m = /viewBox=["']0 0 ([\d.]+)/.exec(content)
  return m ? parseFloat(m[1]) : 0
}

function getViewBoxGeometry(content: string): [number, number, number, number] | null {
  const m = /viewBox=["']([^"']+)["']/.exec(content)
  if (!m) return null
  const parts = m[1].trim().split(/[\s,]+/)
  if (parts.length < 4) return null
  const nums = parts.slice(0, 4).map(Number)
  if (nums.some((n) => Number.isNaN(n))) return null
  const [minX, minY, width, height] = nums as [number, number, number, number]
  if (width <= 0 || height <= 0) return null
  return [minX, minY, width, height]
}

function baseGeometry(baseSize: BaseGeometry): [number, number, number, number] {
  return Array.isArray(baseSize) ? baseSize : [0, 0, baseSize, baseSize]
}

/** Project illustrations are vector assets, not recolorable monochrome
 *  icons — the `data-icon-style="preserve-color"` marker (stamped by
 *  extract_svg_assets.py) is the single source of truth, mirrored here. */
function isPreserveColorAsset(content: string): boolean {
  return content.includes('data-icon-style="preserve-color"')
}

function detectIconStyle(content: string): 'fill' | 'stroke' {
  return content.includes('stroke="currentColor"') && content.includes('fill="none"')
    ? 'stroke'
    : 'fill'
}

function extractSvgBody(content: string): string[] {
  const m = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/.exec(content)
  if (!m) return []
  const body = m[1].trim()
  return body ? [body] : []
}

const SHAPE_TAGS = ['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']
const SHAPE_ELEMENT_RE = new RegExp(
  `<(${SHAPE_TAGS.join('|')})(\\s[^>]*)?(?:/>|></\\1>)`,
  'gs'
)

/** Extract all drawable shape elements from an icon SVG, stripping
 *  fill/stroke/stroke-width so the outer `<g>` (generateIconGroup) controls
 *  color and weight instead. */
function extractShapeElements(content: string): string[] {
  const elements: string[] = []
  for (const m of content.matchAll(SHAPE_ELEMENT_RE)) {
    const tag = m[1]
    let attrs = m[2] ?? ''
    attrs = attrs.replace(/\s*fill="(?:currentColor|#[0-9a-fA-F]{3,6}|none)"/g, '')
    attrs = attrs.replace(/\s*stroke="(?:currentColor|#[0-9a-fA-F]{3,6}|none)"/g, '')
    attrs = attrs.replace(/\s*stroke-width="[^"]*"/g, '')
    elements.push(`<${tag}${attrs}/>`)
  }
  return elements
}

interface ExtractedIcon {
  elements: string[]
  style: IconStyle
  baseSize: BaseGeometry
}

function extractPathsFromIcon(content: string): ExtractedIcon {
  if (isPreserveColorAsset(content)) {
    const geometry = getViewBoxGeometry(content) ?? [0, 0, 24, 24]
    return { elements: extractSvgBody(content), style: 'preserve', baseSize: geometry }
  }
  const style = detectIconStyle(content)
  const baseSize = getViewBoxSize(content) || 16
  return { elements: extractShapeElements(content), style, baseSize }
}

// ---------------------------------------------------------------------------
// <use data-icon="..."> parsing + <g> generation. Port of embed_icons.py's
// `parse_use_element` / `resolve_icon_color` / `generate_icon_group`.
// ---------------------------------------------------------------------------

interface UseAttrs {
  id?: string
  icon?: string
  x?: number
  y?: number
  width?: number
  height?: number
  fill?: string
  stroke?: string
  transform?: string
  strokeWidth?: string
}

function parseUseElement(useStr: string): UseAttrs {
  const attrs: UseAttrs = {}
  const idMatch = /\bid="([^"]+)"/.exec(useStr)
  if (idMatch) attrs.id = idMatch[1]
  const iconMatch = /data-icon="([^"]+)"/.exec(useStr)
  if (iconMatch) attrs.icon = iconMatch[1]
  const xMatch = /\bx="([^"]+)"/.exec(useStr)
  if (xMatch) attrs.x = parseFloat(xMatch[1])
  const yMatch = /\by="([^"]+)"/.exec(useStr)
  if (yMatch) attrs.y = parseFloat(yMatch[1])
  const widthMatch = /\bwidth="([^"]+)"/.exec(useStr)
  if (widthMatch) attrs.width = parseFloat(widthMatch[1])
  const heightMatch = /\bheight="([^"]+)"/.exec(useStr)
  if (heightMatch) attrs.height = parseFloat(heightMatch[1])
  const fillMatch = /\bfill="([^"]+)"/.exec(useStr)
  if (fillMatch) attrs.fill = fillMatch[1]
  const strokeMatch = /\bstroke="([^"]+)"/.exec(useStr)
  if (strokeMatch) attrs.stroke = strokeMatch[1]
  const transformMatch = /\btransform="([^"]+)"/.exec(useStr)
  if (transformMatch) attrs.transform = transformMatch[1]
  const strokeWidthMatch = /\bstroke-width="([^"]+)"/.exec(useStr)
  if (strokeWidthMatch) attrs.strokeWidth = strokeWidthMatch[1]
  return attrs
}

function resolveIconColor(attrs: UseAttrs, style: IconStyle): string {
  if (style === 'preserve') return 'preserve'
  const fill = (attrs.fill ?? '').trim()
  const stroke = (attrs.stroke ?? '').trim()
  if (style === 'stroke') {
    if (fill && fill !== 'none') return fill
    if (stroke && stroke !== 'none') return stroke
    return '#000000'
  }
  if (fill) return fill
  if (stroke && stroke !== 'none') return stroke
  return '#000000'
}

/**
 * Format a number the way Python's `f'{value:g}'` would — up to 6
 * significant digits, trailing zeros trimmed. Approximate (JS has no exact
 * `%g` equivalent): only affects the cosmetic precision of generated
 * `transform` strings, never rendering correctness at the values icon
 * geometry actually produces (small integers and simple ratios).
 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return parseFloat(value.toPrecision(6)).toString()
}

function generateIconGroup(
  attrs: UseAttrs,
  elements: string[],
  style: IconStyle,
  baseSize: BaseGeometry
): string {
  const [minX, minY, baseWidth, baseHeight] = baseGeometry(baseSize)
  const x = attrs.x ?? 0
  const y = attrs.y ?? 0
  const width = attrs.width ?? baseWidth
  const height = attrs.height ?? baseHeight
  const color = resolveIconColor(attrs, style)
  const iconName = attrs.icon ?? 'unknown'

  const scaleX = width / baseWidth
  const scaleY = height / baseHeight

  let transform: string
  if (attrs.transform) {
    // Authoritative: the editor computed this from the expanded <g>: this is
    // the geometry the annotation/staged-edit layer must repaint to.
    transform = attrs.transform
  } else if (Math.abs(scaleX - 1) < 1e-6 && Math.abs(scaleY - 1) < 1e-6) {
    transform = `translate(${formatNumber(x)}, ${formatNumber(y)})`
  } else if (Math.abs(scaleX - scaleY) < 1e-6) {
    transform = `translate(${formatNumber(x)}, ${formatNumber(y)}) scale(${formatNumber(scaleX)})`
  } else {
    transform =
      `translate(${formatNumber(x)}, ${formatNumber(y)}) ` +
      `scale(${formatNumber(scaleX)}, ${formatNumber(scaleY)})`
  }

  const elementsStr = elements.join('\n    ')

  if (style === 'preserve') {
    let inner = elementsStr
    if (minX || minY) {
      inner =
        `<g transform="translate(${formatNumber(-minX)}, ${formatNumber(-minY)})">\n    ` +
        `${elementsStr}\n    </g>`
    }
    return `<!-- icon: ${iconName} -->\n  <g transform="${transform}">\n    ${inner}\n  </g>`
  }

  const colorAttrs =
    style === 'stroke'
      ? `fill="none" stroke="${color}" stroke-width="${attrs.strokeWidth ?? '2'}"`
      : `fill="${color}"`
  return `<!-- icon: ${iconName} -->\n  <g transform="${transform}" ${colorAttrs}>\n    ${elementsStr}\n  </g>`
}

function xmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Orchestration — port of svg_editor/server.py's `_inline_icons`.
// ---------------------------------------------------------------------------

const USE_ICON_PATTERN = /<use\s+[^>]*data-icon="[^"]*"[^>]*\/>/g

/**
 * Replace every `<use data-icon="..."/>` placeholder in `content` with a
 * rendered `<g>`, using `loader` to fetch icon source files. Returns the
 * rewritten markup plus a warning per placeholder that couldn't be resolved
 * (missing library, missing icon, or an icon with no renderable paths) — the
 * caller surfaces these the same way the old server's `warnings` array did.
 *
 * `loader === null` means the skill's icon library couldn't be located
 * (PPT_PREVIEW_LIST_SLIDES returned `iconsRoot: null`) — every placeholder
 * is reported as a warning without attempting a fetch, rather than letting
 * each one time out against a protocol that will 403/404 every request.
 */
export async function inlineIcons(
  content: string,
  loader: IconLoader | null
): Promise<{ content: string; warnings: IconWarning[] }> {
  const warnings: IconWarning[] = []
  const matches = Array.from(content.matchAll(USE_ICON_PATTERN))
  if (matches.length === 0) return { content, warnings }

  if (!loader) {
    for (const m of matches) {
      warnings.push({ icon: parseUseElement(m[0]).icon ?? '', reason: 'icon library not found' })
    }
    return { content, warnings }
  }

  let out = content
  // Process in reverse so earlier matches' string offsets stay valid as we
  // splice replacements in (mirrors the Python `for match in reversed(...)`).
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const useStr = m[0]
    const start = m.index ?? out.lastIndexOf(useStr)
    const attrs = parseUseElement(useStr)
    const iconName = attrs.icon ?? ''
    if (!iconName) {
      warnings.push({ icon: '', reason: 'missing data-icon attribute' })
      continue
    }
    const resolved = await resolveIcon(iconName, loader)
    if (!resolved) {
      warnings.push({ icon: iconName, reason: 'icon not found' })
      continue
    }
    const { elements, style, baseSize } = extractPathsFromIcon(resolved.content)
    if (elements.length === 0) {
      warnings.push({ icon: iconName, reason: 'no renderable paths in icon' })
      continue
    }
    let replacement = generateIconGroup(attrs, elements, style, baseSize)
    if (attrs.id) {
      const previewAttrs = [`id="${xmlAttr(attrs.id)}"`, `data-icon="${xmlAttr(iconName)}"`]
      if (attrs.x !== undefined) previewAttrs.push(`data-use-x="${xmlAttr(String(attrs.x))}"`)
      if (attrs.y !== undefined) previewAttrs.push(`data-use-y="${xmlAttr(String(attrs.y))}"`)
      if (attrs.width !== undefined) previewAttrs.push(`data-use-width="${xmlAttr(String(attrs.width))}"`)
      if (attrs.height !== undefined) previewAttrs.push(`data-use-height="${xmlAttr(String(attrs.height))}"`)
      if (attrs.transform) previewAttrs.push('data-use-has-transform="1"')
      replacement = replacement.replace('<g ', `<g ${previewAttrs.join(' ')} `)
    }
    out = out.slice(0, start) + replacement + out.slice(start + useStr.length)
  }
  return { content: out, warnings }
}
