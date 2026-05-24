import type { Node as PMNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';

/**
 * NodeView for the `slash` / `mention` atom nodes — the web port of the
 * desktop chip. Renders an inline pill as plain imperative DOM (PM
 * NodeViews live outside React).
 *
 * Unlike desktop (which draws per-file-type Icons8 glyphs), web keeps the
 * pill text-only and reuses the existing `.composer-inline-mention`
 * visual language: the leading `/` or `@` stays visible (matching what
 * the old overlay showed) so labels like `@Slack MCP` read the same. The
 * node's `value` attr carries the raw `/cmd` / `@label`, which is what
 * `serializeDoc` emits to the daemon.
 *
 * Because the underlying nodes are `atom: true`, the browser treats the
 * pill as a single indivisible glyph: caret stops at its boundaries,
 * backspace removes it whole.
 */
export function createChipNodeView(variant: 'slash' | 'mention') {
  return (node: PMNode): NodeView => {
    const raw = (node.attrs.value as string) ?? '';
    const dom = document.createElement('span');
    dom.setAttribute(
      variant === 'slash' ? 'data-pm-slash' : 'data-pm-mention',
      raw,
    );
    // Reuse the web composer's mention pill styling (accent fill + ring),
    // defined in index.css. The `--pm` modifier lets index.css tune the
    // geometry for a real inline-block pill (padding/radius) without
    // touching the legacy overlay `.composer-inline-mention` rule.
    dom.className = `pm-composer-chip pm-composer-chip--${variant}`;
    dom.textContent = raw;

    return {
      dom,
      // Atom nodes have no editable content; no contentDOM = leaf.
      ignoreMutation: () => true,
      // The value can't change in place (selection replaces the whole
      // node), so a same-type update just confirms the node matches.
      update: (updated) => updated.type === node.type,
    };
  };
}
