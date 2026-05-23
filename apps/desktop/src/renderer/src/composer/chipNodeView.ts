import type { Node as PMNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'

import { fileTypeIconPaths } from '../components/chat/FileTypeIcon'

/**
 * NodeView for the `slash` / `mention` atom nodes. Renders the same pill
 * the old React `<Chip>` drew (SVG icon + rounded background + CSS-var
 * palette), but as plain imperative DOM — ProseMirror NodeViews live
 * outside React, and keeping them React-free sidesteps the monorepo's
 * dual `@types/react` (18/19) cross-talk entirely (no `createRoot` into
 * a PM-owned DOM node).
 *
 * The leading `/` or `@` is stripped from the visible label — the icon
 * stands in for it — but the node's `value` attr still carries the raw
 * `/cmd` / `@path`, which is what `serializeDoc` emits to fusion-code.
 *
 * Because the underlying nodes are `atom: true`, the browser treats the
 * pill as a single indivisible glyph: caret stops at its boundaries,
 * backspace removes it whole. No selection-snapping or pixel measuring
 * (the old `findAtomicTokenContaining` / overlay caret) is needed.
 */

const SLASH_ICON_PATHS = [
  'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
  'm3.27 6.96 8.73 5.05 8.73-5.05',
  'M12 22.08V12'
]
const NS = 'http://www.w3.org/2000/svg'

/**
 * Slash-command chip glyph: a single-colour Lucide stroke icon tinted
 * with the accent `stroke`. (Mentions use a different builder below
 * because they now draw multi-colour Icons8 fills, not strokes.)
 */
function buildSlashIcon(stroke: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', '11')
  svg.setAttribute('height', '11')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', stroke)
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.flexShrink = '0'
  for (const d of SLASH_ICON_PATHS) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

/**
 * File-mention chip glyph: the per-type coloured Icons8 icon picked
 * from the mentioned path's extension, shared with the React chips/
 * cards via `fileTypeIconPaths`. Each path carries its own `fill`, so
 * unlike the slash glyph this is a self-coloured 48×48 SVG (no stroke,
 * no accent tint). `value` is the `@path` (or `@"path"`) attr.
 */
function buildMentionIcon(value: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.flexShrink = '0'
  for (const spec of fileTypeIconPaths(value.replace(/^@"?|"$/g, ''))) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', spec.d)
    p.setAttribute('fill', spec.fill)
    svg.appendChild(p)
  }
  return svg
}

/**
 * NodeView factory shared by both atom types. `variant` selects the
 * palette + icon; the raw value comes from `node.attrs.value`.
 */
export function createChipNodeView(variant: 'slash' | 'mention') {
  return (node: PMNode): NodeView => {
    // Slash chips follow the accent token; mention chips use the
    // dedicated `--chip-mention` token — same split the old <Chip> used
    // so files stay visually distinct from commands and both re-skin
    // with the theme picker.
    const colorVar = variant === 'slash' ? '--accent' : '--chip-mention'
    const text = `hsl(var(${colorVar}))`
    const background = `hsl(var(${colorVar}) / 0.16)`

    const dom = document.createElement('span')
    dom.setAttribute(variant === 'slash' ? 'data-pm-slash' : 'data-pm-mention', node.attrs.value as string)
    Object.assign(dom.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '1px 8px 1px 7px',
      background,
      color: text,
      fontWeight: '600',
      borderRadius: '9999px',
      verticalAlign: 'baseline',
      lineHeight: '1.35',
      // The PM caret can sit on either side of an atom; a subtle
      // user-select:none keeps double-click from selecting the inner
      // text instead of the node.
      userSelect: 'none'
    } satisfies Partial<CSSStyleDeclaration>)

    const raw = (node.attrs.value as string) ?? ''
    dom.appendChild(
      variant === 'slash' ? buildSlashIcon(text) : buildMentionIcon(raw)
    )
    // Strip the leading `/` or `@` — the icon replaces it visually.
    const label = document.createElement('span')
    label.textContent = raw.slice(1)
    dom.appendChild(label)

    return {
      dom,
      // Atom nodes have no editable content; returning no contentDOM
      // tells PM this is a leaf rendered entirely by us.
      ignoreMutation: () => true,
      // The value can't change in place (selection replaces the whole
      // node), so a same-type update just confirms the node matches.
      update: (updated) => updated.type === node.type
    }
  }
}
