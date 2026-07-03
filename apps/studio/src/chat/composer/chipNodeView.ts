import type { Node as PMNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'

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

const SLASH_ICON_PATHS = [
  'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
  'm3.27 6.96 8.73 5.05 8.73-5.05',
  'M12 22.08V12'
]
const NS = 'http://www.w3.org/2000/svg'

/**
 * The `gradient` skill-chip appearance (the larger card the user picked
 * for `/ppt-master`) needs a `::before` pseudo-element for its
 * accent-gradient border — a 1.5px gradient frame masked into a ring
 * with `mask-composite: exclude`. A pseudo-element can't be expressed
 * via inline `style` on an imperative-DOM node, so we inject one shared
 * stylesheet the first time such a chip mounts. Idempotent: a module
 * flag plus an id check means repeated mounts (and HMR) never duplicate
 * it.
 *
 * The gradient runs `--accent` → a same-hue darker stop derived with
 * `color-mix` (the same technique the design-tokens sheet already uses),
 * so it re-skins with the theme picker and introduces no new token.
 */
const GRADIENT_CHIP_STYLE_ID = 'skill-chip-gradient-style'
let gradientChipStyleInjected = false
function ensureGradientChipStyle(): void {
  if (gradientChipStyleInjected || document.getElementById(GRADIENT_CHIP_STYLE_ID)) {
    gradientChipStyleInjected = true
    return
  }
  const style = document.createElement('style')
  style.id = GRADIENT_CHIP_STYLE_ID
  style.textContent = `
.skill-chip-gradient {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px 7px 11px;
  border-radius: 13px;
  background: hsl(var(--card));
  color: hsl(var(--accent));
  font-weight: 600;
  font-size: 14px;
  letter-spacing: -0.01em;
  line-height: 1.3;
  vertical-align: middle;
  user-select: none;
  box-shadow: 0 1px 3px hsl(220 40% 2% / 0.08);
  transition: background 0.18s ease;
}
.skill-chip-gradient::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1.5px;
  background: linear-gradient(120deg,
    hsl(var(--accent)),
    color-mix(in oklch, hsl(var(--accent)) 62%, hsl(240 30% 12%)));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
.skill-chip-gradient:hover { background: hsl(var(--accent) / 0.05); }
.skill-chip-gradient svg { flex-shrink: 0; display: block; }
`
  document.head.appendChild(style)
  gradientChipStyleInjected = true
}

/**
 * Slash-command chip glyph: a single-colour Lucide stroke icon tinted
 * with the accent `stroke`. (Mentions — and registered skills — use the
 * coloured builder below because they draw multi-colour Icons8 fills,
 * not strokes.)
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
 * Coloured Icons8 glyph builder, shared by file mentions and registered
 * slash skills. Each path carries its own `fill`, so this is a
 * self-coloured 48×48 SVG (no stroke, no accent tint) that looks the
 * same on any surface. File mentions pass the per-extension table; a
 * registered skill (see `skillChipRegistry.ts`) passes the table for
 * its `icon` key — e.g. `/ppt-master` reuses the PowerPoint glyph.
 */
function buildColorIcon(paths: readonly IconPath[], size = 12): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.flexShrink = '0'
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
  return (node: PMNode): NodeView => {
    const raw = (node.attrs.value as string) ?? ''

    // A known slash skill (e.g. `/ppt-master`) swaps the glyph for its
    // coloured Icons8 icon and gives the pill a friendly label. The pill
    // itself keeps the default accent palette — the coloured icon
    // already carries the brand cue, so tinting the pill too would
    // over-saturate it. Everything else — and all mentions — keeps the
    // default token-driven look. Lookup is by the verbatim `value`, so
    // this is purely visual; serialization is untouched.
    const skill = variant === 'slash' ? findSkillChipSpec(raw) : null

    const dom = document.createElement('span')
    dom.setAttribute(variant === 'slash' ? 'data-pm-slash' : 'data-pm-mention', node.attrs.value as string)

    // ── Gradient-border appearance (the larger card the user picked for
    // `/ppt-master`). A class drives the look because the gradient frame
    // needs a `::before` pseudo (see `ensureGradientChipStyle`); the
    // bigger 22px coloured glyph + label go inside. Everything that
    // serializes is untouched — purely visual.
    if (skill?.appearance === 'gradient') {
      ensureGradientChipStyle()
      dom.className = 'skill-chip-gradient'
      dom.appendChild(buildColorIcon(fileIconPathsByKey(skill.icon), 22))
      const gLabel = document.createElement('span')
      gLabel.textContent = skill.label ?? raw.slice(1)
      dom.appendChild(gLabel)
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => updated.type === node.type
      }
    }

    // Slash chips follow the accent token; mention chips use the
    // dedicated `--chip-mention` token — same split the old <Chip> used
    // so files stay visually distinct from commands and both re-skin
    // with the theme picker.
    const colorVar = variant === 'slash' ? '--accent' : '--chip-mention'
    const text = `hsl(var(${colorVar}))`
    const background = `hsl(var(${colorVar}) / 0.16)`

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

    // Icon: a registered skill → its coloured Icons8 glyph; a file
    // mention → the per-extension coloured glyph; everything else → the
    // accent-tinted Lucide box.
    let icon: SVGSVGElement
    if (skill) {
      icon = buildColorIcon(fileIconPathsByKey(skill.icon))
    } else if (variant === 'mention') {
      icon = buildColorIcon(fileTypeIconPaths(raw.replace(/^@"?|"$/g, '')))
    } else {
      icon = buildSlashIcon(text)
    }
    dom.appendChild(icon)

    // Strip the leading `/` or `@` — the icon replaces it visually. A
    // registered skill supplies its own friendly label instead.
    const label = document.createElement('span')
    label.textContent = skill?.label ?? raw.slice(1)
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
