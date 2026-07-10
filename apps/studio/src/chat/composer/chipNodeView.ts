import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'

import { fileIconPathsByKey, fileTypeIconPaths, type IconPath } from '../components/chat/FileTypeIcon'
import { findSkillChipSpec } from './skillChipRegistry'

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

/** Generic "skill/command" glyph — same sparkle the composer's 技能 toolbar
 * button draws, so an unregistered slash chip and the entry point that
 * inserts registered ones read as the same visual language. */
const SPARKLE_ICON_PATHS = [
  'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  'M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4Z'
]
/** × glyph shown in place of the icon on hover — the click target that
 * deletes the chip. */
const CLOSE_ICON_PATHS = ['M18 6 6 18M6 6l12 12']
const NS = 'http://www.w3.org/2000/svg'

function buildStrokeIcon(paths: readonly string[], size: number, strokeWidth: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', strokeWidth)
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

/**
 * Coloured Icons8 glyph builder, shared by file mentions and registered
 * slash skills. Each path carries its own `fill`, so this is a
 * self-coloured 48×48 SVG (no stroke, no accent tint) that looks the
 * same on any surface. File mentions pass the per-extension table; a
 * registered skill (see `skillChipRegistry.ts`) passes the table for
 * its `icon` key — e.g. `/ppt-master` reuses the PowerPoint glyph.
 */
function buildColorIcon(paths: readonly IconPath[], size = 14): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  for (const spec of paths) {
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
  return (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    const raw = (node.attrs.value as string) ?? ''

    // A known slash skill (e.g. `/ppt-master`) swaps the glyph for its
    // coloured Icons8 icon and gives the pill a friendly label. Everything
    // else — and all mentions — keeps the neutral sparkle/file glyph.
    // Lookup is by the verbatim `value`, so this is purely visual;
    // serialization is untouched.
    const skill = variant === 'slash' ? findSkillChipSpec(raw) : null

    const dom = document.createElement('span')
    dom.setAttribute(variant === 'slash' ? 'data-pm-slash' : 'data-pm-mention', node.attrs.value as string)

    // Unified bordered-pill chrome for BOTH variants: a plain outline
    // pill (no accent fill) with an icon slot + label. Slash chips used
    // to split into a flat accent-tint pill vs. a bespoke gradient card
    // per skill (`appearance: 'gradient'`) — retired in favour of one
    // consistent look, with delete-on-hover added (see iconSlot below).
    Object.assign(dom.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '3px 10px 3px 7px',
      border: '1px solid hsl(var(--border))',
      borderRadius: '9999px',
      background: 'hsl(var(--card))',
      color: 'hsl(var(--foreground))',
      fontWeight: '500',
      fontSize: '13px',
      lineHeight: '1.35',
      verticalAlign: 'middle',
      userSelect: 'none',
      transition: 'background 0.15s ease, border-color 0.15s ease'
    } satisfies Partial<CSSStyleDeclaration>)

    // Icon slot: holds the real glyph by default, swaps to a × delete
    // button on hover. A registered skill shows its coloured Icons8 glyph
    // (kept as its own multi-fill SVG, untouched by hover); a file
    // mention shows its per-extension coloured glyph; a plain/unknown
    // slash command shows the neutral sparkle.
    const iconSlot = document.createElement('span')
    Object.assign(iconSlot.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: '0'
    } satisfies Partial<CSSStyleDeclaration>)

    const buildRestingIcon = (): SVGSVGElement => {
      if (skill) return buildColorIcon(fileIconPathsByKey(skill.icon))
      if (variant === 'mention') return buildColorIcon(fileTypeIconPaths(raw.replace(/^@"?|"$/g, '')))
      return buildStrokeIcon(SPARKLE_ICON_PATHS, 13, '1.9')
    }
    iconSlot.appendChild(buildRestingIcon())
    dom.appendChild(iconSlot)

    // Strip the leading `/` or `@` — the icon replaces it visually. A
    // registered skill supplies its own friendly label instead.
    const label = document.createElement('span')
    label.textContent = skill?.label ?? raw.slice(1)
    dom.appendChild(label)

    // Delete-on-hover: mouseenter swaps the icon slot for a × (click
    // removes this atom node from the doc); mouseleave restores the
    // resting icon. The click handler is only meaningful while hovering
    // (`hovering` guard) — desktop pointer events always fire
    // mouseenter→click→mouseleave in that order, so this is a belt-and-
    // braces guard, not load-bearing.
    let hovering = false
    dom.addEventListener('mouseenter', () => {
      hovering = true
      dom.style.background = 'hsl(var(--muted))'
      dom.style.borderColor = 'hsl(var(--border))'
      iconSlot.replaceChildren(buildStrokeIcon(CLOSE_ICON_PATHS, 12, '2'))
      iconSlot.style.cursor = 'pointer'
      iconSlot.style.color = 'hsl(var(--muted-foreground))'
    })
    dom.addEventListener('mouseleave', () => {
      hovering = false
      dom.style.background = 'hsl(var(--card))'
      iconSlot.replaceChildren(buildRestingIcon())
      iconSlot.style.cursor = ''
      iconSlot.style.color = ''
    })
    iconSlot.addEventListener('mousedown', (e) => {
      if (!hovering) return
      // mousedown (not click): fires before the editor would otherwise
      // move focus/selection on click, matching insertSuggestion's own
      // mousedown-based picks elsewhere in the composer.
      e.preventDefault()
      e.stopPropagation()
      const pos = getPos()
      if (pos === undefined) return
      const tr = view.state.tr.delete(pos, pos + node.nodeSize)
      view.dispatch(tr.scrollIntoView())
      view.focus()
    })

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
