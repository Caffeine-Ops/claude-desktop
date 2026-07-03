import { Schema, type Node as PMNode } from 'prosemirror-model'

/**
 * ProseMirror schema for the chat composer — deliberately minimal,
 * mirroring how ChatGPT runs ProseMirror: doc / paragraph / text plus
 * two inline *atom* nodes (`slash`, `mention`). **No marks.** The
 * composer never carries bold / italic / links / code — it submits a
 * plain string to fusion-code, so any rich formatting would be dead
 * weight that we'd only have to strip on serialize anyway.
 *
 * Why atom nodes for slash / mention instead of plain text + an
 * overlay (the old approach)?
 *
 *   - An atom node is rendered by a NodeView (see `chipNodeView.ts`)
 *     as a single, indivisible pill. The browser draws the caret at
 *     real DOM boundaries between nodes, so we no longer measure pixel
 *     positions or snap the selection out of a chip interior — the
 *     "atomicity" the old `findAtomicTokenContaining` / `onSelect`
 *     dance simulated is now a free property of `atom: true`.
 *   - Backspace deletes the whole chip in one keypress (atom nodes are
 *     deleted as a unit), which `iterAtomicTokens` used to hand-roll.
 *
 * The crucial invariant: **serialization is lossless to plain text.**
 * `serializeDoc` walks the doc and emits exactly the string the old
 * textarea held (`/cmd`, `@path`), because fusion-code's CLI parses
 * that raw text downstream (`matchSlashCommand`, `extractAtMentionedFiles`).
 * The chip is purely a *visual* layer; the wire format is unchanged.
 */
export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      // Each paragraph round-trips to one '\n' on serialize. The old
      // textarea used '\n' for soft breaks (Shift+Enter); ProseMirror
      // models those as paragraph splits, matching what ChatGPT does.
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0]
    },
    text: { group: 'inline' },

    // ---- slash command atom (e.g. `/skill`) -------------------------
    // `value` holds the literal text to serialize back (`/skill`), so
    // the wire format is preserved even though the NodeView renders a
    // pill that hides the leading `/`.
    slash: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { value: { default: '' } },
      // We persist enough to reconstruct the node from a pasted/copied
      // HTML fragment, but in practice the editor is the only producer.
      parseDOM: [
        {
          tag: 'span[data-pm-slash]',
          getAttrs: (dom) => ({
            value: (dom as HTMLElement).getAttribute('data-pm-slash') ?? ''
          })
        }
      ],
      toDOM: (node) => [
        'span',
        { 'data-pm-slash': node.attrs.value as string },
        node.attrs.value as string
      ]
    },

    // ---- file mention atom (e.g. `@src/foo.ts` or `@"a b.ts"`) ------
    mention: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { value: { default: '' } },
      parseDOM: [
        {
          tag: 'span[data-pm-mention]',
          getAttrs: (dom) => ({
            value: (dom as HTMLElement).getAttribute('data-pm-mention') ?? ''
          })
        }
      ],
      toDOM: (node) => [
        'span',
        { 'data-pm-mention': node.attrs.value as string },
        node.attrs.value as string
      ]
    }
  }
  // marks: intentionally omitted — see header.
})

/**
 * Walk the doc and emit the plain-text string the composer submits.
 * Paragraphs join with '\n'. slash/mention atoms emit their `value`
 * attr verbatim (already includes the `/` or `@` and any quoting).
 *
 * This is the single source of truth for "what fusion-code receives".
 * It MUST stay byte-for-byte compatible with what the user typed, or
 * `extractAtMentionedFiles` / `matchSlashCommand` break.
 */
export function serializeDoc(doc: PMNode): string {
  const lines: string[] = []
  doc.forEach((block) => {
    let line = ''
    block.forEach((inline) => {
      if (inline.isText) {
        line += inline.text ?? ''
      } else if (inline.type.name === 'slash' || inline.type.name === 'mention') {
        line += (inline.attrs.value as string) ?? ''
      }
    })
    lines.push(line)
  })
  return lines.join('\n')
}

/**
 * Parse a plain-text string into a doc, re-detecting slash / mention
 * tokens so an externally-set `composer.text` (e.g. EmptyState shoving
 * a prompt in, or a draft restore) renders with chips. Mirrors the old
 * `tokenizeComposer` rules:
 *
 *   - slash:   `/` + word chars, anchored at start-of-line or after WS,
 *              so `http://x` doesn't light up.
 *   - mention: `@` + non-whitespace run (or `@"quoted path"`), same
 *              anchoring.
 *
 * Each text line becomes one paragraph; tokens become atom nodes.
 */
// ---- parse 区块（来自 web 版分叉，desktop 版的超集）----
// web 版在 desktop 的 parseText 之上加了 parseTextWithEntities / knownTokens
// 感知的 tokenizeLine / matchKnownTokenAt（多词 @token 如 `@Slack MCP` 的
// 最长匹配优先）。knownTokens=[] 时行为与 desktop 原版等价。
export function parseText(text: string): PMNode {
  return parseTextWithEntities(text, []);
}

/**
 * Like `parseText`, but also recognizes known multi-word mention tokens
 * (e.g. `@Slack MCP`) so they render as chips. `knownTokens` is the set
 * of literal token strings (`@<label>`) the composer currently knows
 * about; the longest matching token at a boundary wins, mirroring the
 * web overlay's `buildInlineMentionParts` longest-match rule.
 */
export function parseTextWithEntities(text: string, knownTokens: string[]): PMNode {
  const paragraphs = (text.length ? text : '').split('\n');
  // Longest token first so `@Slack MCP` beats a hypothetical `@Slack`.
  const tokens = [...knownTokens]
    .filter((t) => t.length > 1 && t.startsWith('@'))
    .sort((a, b) => b.length - a.length);
  const blockNodes: PMNode[] = paragraphs.map((lineText) => {
    const inlines = tokenizeLine(lineText, tokens);
    return composerSchema.nodes.paragraph!.create(null, inlines);
  });
  if (blockNodes.length === 0) {
    blockNodes.push(composerSchema.nodes.paragraph!.create());
  }
  return composerSchema.nodes.doc!.create(null, blockNodes);
}

// Anchored bare-token regex: (start | whitespace)(token). Token is a
// slash command, a quoted mention, or a bare (whitespace-free) mention.
const TOKEN_RE = /(^|\s)(\/[A-Za-z0-9_-]+|@"[^"]+"|@\S+)/g;

function tokenizeLine(line: string, knownTokens: string[]): PMNode[] {
  if (!line) return [];
  const out: PMNode[] = [];
  let pos = 0;
  while (pos < line.length) {
    // 1) Try a known multi-word token at a word boundary first.
    const known = matchKnownTokenAt(line, pos, knownTokens);
    if (known) {
      // Emit any text before the token's start (the boundary char is
      // already part of the preceding text run).
      out.push(composerSchema.nodes.mention!.create({ value: known }));
      pos += known.length;
      continue;
    }
    // 2) Fall back to the anchored bare-token regex from `pos`.
    TOKEN_RE.lastIndex = pos === 0 ? 0 : pos - 1;
    const m = TOKEN_RE.exec(line);
    if (m && m.index + m[1]!.length >= pos) {
      const tokenStart = m.index + m[1]!.length;
      if (tokenStart > pos) {
        out.push(composerSchema.text(line.slice(pos, tokenStart)));
      }
      const value = m[2]!;
      const nodeType = value.startsWith('/') ? 'slash' : 'mention';
      out.push(composerSchema.nodes[nodeType]!.create({ value }));
      pos = tokenStart + value.length;
      continue;
    }
    // 3) No token ahead — emit the rest as text.
    out.push(composerSchema.text(line.slice(pos)));
    break;
  }
  return out;
}

/**
 * If a known token starts exactly at `pos` AND `pos` is a word boundary
 * (start of line or preceded by whitespace), return that token.
 */
function matchKnownTokenAt(line: string, pos: number, knownTokens: string[]): string | null {
  const boundary = pos === 0 || /\s/.test(line[pos - 1] ?? '');
  if (!boundary) return null;
  for (const token of knownTokens) {
    if (line.startsWith(token, pos)) {
      // The char right after the token must be a boundary too, so
      // `@Slack` doesn't swallow into `@SlackBot`.
      const after = line[pos + token.length];
      if (after === undefined || /\s/.test(after)) return token;
    }
  }
  return null;
}
