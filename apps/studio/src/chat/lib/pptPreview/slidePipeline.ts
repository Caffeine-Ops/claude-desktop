/**
 * PPT-master live preview — SVG DOM pipeline.
 *
 * Everything the deleted svg_editor Flask server used to do to a slide
 * before sending it to the browser (assign stable ids, parse/merge
 * annotations, rewrite asset hrefs to something loadable) now happens here,
 * in the renderer, using the REAL SVG DOM instead of Python's
 * xml.etree.ElementTree. `assignTempIds` is the one function that must stay
 * byte-for-byte equivalent to its Python twin
 * (skills/ppt-master/scripts/svg_editor/annotations.py) — that file's own
 * docstring says as much, and the two are meant to be diffed against each
 * other's output (`python3 -c '...'` one-liner vs this function) whenever
 * either changes.
 *
 * Icon inlining lives in the sibling module inlineIcons.ts (it's async —
 * fetches icon source files over the pptasset:// protocol — so it doesn't
 * belong in this synchronous, DOM-only file).
 */

export interface SlideAnnotation {
  element_id: string
  tag: string
  annotation: string
}

/**
 * Assign deterministic temp ids (`_edit_0`, `_edit_1`, …) to elements
 * without one, in document order. Clears any leftover `_edit_N` ids first,
 * to avoid shifted numbering when elements are added/removed between
 * sessions — port of annotations.py's `assign_temp_ids`.
 *
 * `querySelectorAll('*')` returns every DESCENDANT in document order, never
 * the root itself — exactly the Python version's `root.iter()` minus its
 * explicit `if elem is root: continue` skip, so no equivalent guard is
 * needed here.
 */
export function assignTempIds(svg: Element): void {
  const all = Array.from(svg.querySelectorAll('*'))
  for (const el of all) {
    const id = el.getAttribute('id')
    if (id && id.startsWith('_edit_')) el.removeAttribute('id')
  }
  let counter = 0
  for (const el of all) {
    if (el.getAttribute('id') === null) {
      el.setAttribute('id', `_edit_${counter}`)
      counter += 1
    }
  }
}

/** Extract every annotated element from a slide — port of annotations.py's
 *  `parse_annotations`. */
export function parseAnnotations(svg: Element): SlideAnnotation[] {
  const out: SlideAnnotation[] = []
  svg.querySelectorAll('[data-edit-target="true"]').forEach((el) => {
    out.push({
      element_id: el.getAttribute('id') ?? '',
      tag: el.tagName.toLowerCase(),
      annotation: el.getAttribute('data-edit-annotation') ?? ''
    })
  })
  return out
}

/** Mark one element as annotated. Returns false if the id isn't present in
 *  this document — port of annotations.py's `set_annotation`. */
export function setAnnotation(svg: Element, elementId: string, annotation: string): boolean {
  const el = svg.querySelector(`[id="${CSS.escape(elementId)}"]`)
  if (!el) return false
  el.setAttribute('data-edit-target', 'true')
  el.setAttribute('data-edit-annotation', annotation)
  return true
}

/** Strip every `data-edit-target`/`data-edit-annotation` pair from the whole
 *  document — the save-all step's "clear everything, then rewrite current
 *  state" pass (mirrors the old server's save_all loop start). */
export function clearAllAnnotations(svg: Element): void {
  svg.querySelectorAll('[data-edit-target]').forEach((el) => {
    el.removeAttribute('data-edit-target')
    el.removeAttribute('data-edit-annotation')
  })
}

/**
 * Drop transient `_edit_N` ids except those in `keepIds` and any element
 * still carrying a submitted annotation (its id is the AI's locator) — port
 * of annotations.py's `strip_unused_temp_ids`, called at save time so
 * on-disk SVGs don't accumulate id pollution from elements nobody annotated.
 */
export function stripUnusedTempIds(svg: Element, keepIds: ReadonlySet<string>): void {
  const protectedIds = new Set(keepIds)
  svg.querySelectorAll('[data-edit-target="true"]').forEach((el) => {
    const id = el.getAttribute('id')
    if (id) protectedIds.add(id)
  })
  svg.querySelectorAll('*').forEach((el) => {
    const id = el.getAttribute('id') ?? ''
    if (id.startsWith('_edit_') && !protectedIds.has(id)) el.removeAttribute('id')
  })
}

/**
 * Parse raw SVG text into a live `<svg>` element, or null if the markup is
 * malformed. `DOMParser` surfaces XML errors as an in-document
 * `<parsererror>` node rather than throwing — checking for it is the
 * standard way to detect a failed parse (the equivalent of Python's
 * `xml.etree.ElementTree.ParseError`).
 */
export function parseSvgDocument(text: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (doc.querySelector('parsererror')) return null
  const root = doc.documentElement
  return root && root.tagName.toLowerCase() === 'svg' ? (root as unknown as SVGSVGElement) : null
}

/** Serialize an SVG element back to markup. Serializing an ELEMENT (not the
 *  owning Document) never emits an `<?xml ?>` prolog, so — unlike the old
 *  Python `ET.tostring(root, xml_declaration=False)` — there is nothing to
 *  strip before this can be written to disk or injected via innerHTML. */
export function serializeSvg(root: Element): string {
  return new XMLSerializer().serializeToString(root)
}

// ---------------------------------------------------------------------------
// Asset href rewriting — replaces the old server's /images/<path> and
// /assets/<path> HTTP routes with pptasset:// URLs the renderer can load
// directly (see pptAssetUrl.ts / electron/main/services/pptAssetProtocol.ts).
// ---------------------------------------------------------------------------

import { toPptAssetUrl } from '../pptAssetUrl'

// `href="../images/foo.png"` / `xlink:href="../assets/bar.png"` — the two
// prefixes svg_output SVGs use to reach project-local media.
const ASSET_HREF_RE = /((?:xlink:)?href)=(["'])(\.\.\/images\/|\.\.\/assets\/)([^"']+)\2/g
// A bare (no `../` prefix) image href — mirror templates copy hrefs
// verbatim, so `href="cover_bg.png"` needs resolving against images/.
// Restricted to image extensions so `href="#gradient1"` (an SVG internal
// fragment reference) is never touched.
const BARE_HREF_RE = /((?:xlink:)?href)=(["'])([^"'/][^"':]*\.(?:png|jpe?g|gif|webp|svg))\2/gi

/**
 * Rewrite `../images/*`, `../assets/*`, and bare image hrefs to
 * `pptasset://` URLs so the renderer (which has no filesystem access and no
 * server to fetch relative paths from) can load them directly.
 *
 * Bare hrefs always resolve against `images/` — the renderer can't
 * synchronously check whether the file is actually in `assets/` instead
 * (the old server tried images/ then assets/ server-side; there is no
 * equivalent existence check available client-side without an extra IPC
 * round-trip per href). A wrong guess just 404s the `<image>`, which the
 * existing failedImagesRef retry loop in LivePreviewEditor already handles
 * as a missing/generating-in-background image — this is a known, accepted
 * simplification, not a silent failure mode.
 */
export function rewriteAssetHrefs(svg: string, projectDir: string): string {
  const imagesDir = `${projectDir}/images`
  const assetsDir = `${projectDir}/assets`
  let out = svg.replace(ASSET_HREF_RE, (_whole, attr, quote, prefix, rel) => {
    const base = prefix === '../images/' ? imagesDir : assetsDir
    return `${attr}=${quote}${toPptAssetUrl(`${base}/${rel}`)}${quote}`
  })
  out = out.replace(BARE_HREF_RE, (_whole, attr, quote, rel) => {
    return `${attr}=${quote}${toPptAssetUrl(`${imagesDir}/${rel}`)}${quote}`
  })
  return out
}
