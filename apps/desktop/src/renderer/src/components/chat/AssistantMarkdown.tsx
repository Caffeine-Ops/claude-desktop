import { isValidElement, memo, useCallback, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

import { useT } from '../../i18n'

/**
 * AssistantMarkdown
 * -----------------
 * Plugged into `<MessagePrimitive.Parts components={{ Text }} />` as the
 * Text renderer. Reads the text content from the `text` prop that
 * assistant-ui's MessagePart traversal hands in, feeds it through
 * `react-markdown` + `remark-gfm`, and renders each tag with its own
 * Tailwind styling.
 *
 * Why not @assistant-ui/react-markdown's MarkdownTextPrimitive?
 * ------------------------------------------------------------
 * We tried it first. It reads text via `useMessagePartText()` from an
 * assistant-ui context, and in our `useExternalStoreRuntime` setup
 * that hook did not surface the streaming text (the assistant bubble
 * rendered an empty shell while the store clearly had content). Using
 * the `text` prop that Parts passes down is one level closer to the
 * source of truth and sidesteps the context lookup entirely — the
 * same string we store in zustand flows straight in.
 *
 * Streaming-friendliness
 * ----------------------
 * react-markdown parses the whole string on every update, so when the
 * stream is mid-fence (e.g. `"```ts\nfunction foo("` with no closing
 * ``` yet) the parser still treats the tail as a code block. That's
 * the desired behavior — users see the code block grow in place. The
 * whole tree is diffed by React, so unchanged paragraphs upstream stay
 * mounted and only the affected block re-renders.
 *
 * Performance
 * -----------
 * The Text renderer is called once per text part, and during streaming
 * its `text` prop grows by a few characters per chunk. We wrap the
 * outer function component in `React.memo` so two consecutive renders
 * with the same text (e.g. after a tool result arrives on an unrelated
 * message) don't re-parse the markdown. GFM parse of a typical reply
 * is well under 1ms; the main cost during streaming is the React
 * reconciliation of the resulting tree, which React handles.
 */

/* ───────────────── Per-tag Tailwind overrides ───────────────── */

const components: Components = {
  p: ({ children }) => (
    <p className="mb-3 last:mb-0 text-[14px] leading-relaxed text-foreground">
      {children}
    </p>
  ),

  h1: ({ children }) => (
    <h1 className="mb-3 mt-5 text-[19px] font-bold text-foreground">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-5 text-[17px] font-semibold text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-4 text-[15px] font-semibold text-foreground">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-3 text-[14px] font-semibold text-foreground">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-3 text-[13px] font-semibold text-foreground">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-2 text-[12.5px] font-semibold text-foreground/80">
      {children}
    </h6>
  ),

  ul: ({ children }) => (
    <ul className="mb-3 ml-5 list-disc space-y-1 text-[14px] leading-relaxed text-foreground marker:text-muted-foreground/60">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 ml-5 list-decimal space-y-1 text-[14px] leading-relaxed text-foreground marker:text-muted-foreground/60">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,

  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-foreground">{children}</em>,
  del: ({ children }) => (
    <del className="text-muted-foreground/80 line-through">{children}</del>
  ),

  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-input pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-4 border-border" />,

  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline decoration-blue-400/40 underline-offset-2 transition hover:decoration-blue-400"
    >
      {children}
    </a>
  ),

  // Tables live in a horizontal scroll shell so wide tables stay
  // usable inside the narrow chat bubble. `table-auto` lets the browser
  // size columns from content, and `[overflow-wrap:anywhere]` on cells
  // breaks long CamelCase / path / URL tokens that would otherwise
  // force an entire column to balloon (CJK text already breaks fine).
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-border">
      <table className="w-full table-auto border-collapse text-[12.5px] leading-snug">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-muted/50 text-foreground">{children}</thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr className="border-b border-border/60 last:border-b-0 even:bg-muted/20">
      {children}
    </tr>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="whitespace-nowrap px-3 py-2 text-left align-bottom text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={style}
      className="px-3 py-2 align-top text-foreground/85 [overflow-wrap:anywhere] [word-break:break-word]"
    >
      {children}
    </td>
  ),

  // react-markdown v10: the `code` override receives BOTH inline code
  // AND fenced code blocks (the latter wrapped in a <pre>). We detect
  // fenced blocks by looking for `className="language-xxx"` — the GFM
  // parser always puts the info string there. Inline code gets a
  // compact pill; fenced blocks are delegated to <CodeBlockCard>.
  code: ({ className, children, ...rest }) => {
    const languageMatch = /language-(\w+)/.exec(className ?? '')
    if (languageMatch) {
      // This is a fenced block — return just the children string to
      // the outer <pre> override. The <pre> will see our wrapper.
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      )
    }
    return (
      <code className="rounded bg-muted px-[5px] py-[1px] font-mono text-[12.5px] text-foreground">
        {children}
      </code>
    )
  },

  // Fenced code blocks. react-markdown passes us <pre><code class="language-xxx hljs">...</code></pre>,
  // where the inner <code>'s children have already been tokenized into
  // `<span class="hljs-*">` by rehype-highlight. We preserve those
  // children for rendering (so highlighting survives) and separately
  // flatten them to raw text for the clipboard button.
  pre: ({ children }) => {
    const codeEl = firstElement(children)
    const codeProps =
      isValidElement<{ className?: string; children?: ReactNode }>(codeEl)
        ? codeEl.props
        : undefined
    const className = codeProps?.className ?? ''
    const match = /language-(\w+)/.exec(className)
    const language = match?.[1]
    const highlighted = codeProps?.children ?? children
    const rawCode = reactNodeToText(highlighted)
    return (
      <CodeBlockCard
        language={language}
        rawCode={rawCode}
        codeClassName={className}
      >
        {highlighted}
      </CodeBlockCard>
    )
  }
}

/* ─────────────── Code block card with header + copy ─────────────── */

function CodeBlockCard({
  language,
  rawCode,
  codeClassName,
  children
}: {
  language: string | undefined
  rawCode: string
  codeClassName: string
  children: ReactNode
}): React.JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(rawCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('[AssistantMarkdown] clipboard copy failed', err)
    }
  }, [rawCode])

  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border/70 bg-muted/30 shadow-sm">
      {/* Header: language chip on the left, copy affordance on the
          right. Kept compact (py-1) so it reads as a chrome strip, not
          a second block competing with the code body. */}
      <div className="flex items-center justify-between border-b border-border/60 bg-card/40 px-3 py-1">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium lowercase tracking-wide text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className={
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] transition ' +
            (copied
              ? 'text-emerald-500'
              : 'text-muted-foreground/70 opacity-0 hover:text-foreground group-hover/code:opacity-100 focus-visible:opacity-100')
          }
          aria-label={t('codeBlockCopy')}
        >
          {copied ? t('codeBlockCopied') : t('codeBlockCopy')}
        </button>
      </div>
      {/* Body: slightly tighter leading, a proper mono stack with
          tabular numerics, and `hyphens-none` so long identifiers in
          CJK-mixed content don't get soft-hyphenated by the browser. */}
      <pre className="overflow-x-auto px-4 py-3 text-[12.5px] leading-[1.55] text-foreground [font-feature-settings:'calt','ss01','tnum'] [font-family:ui-monospace,'SFMono-Regular','JetBrains_Mono','Fira_Code',Menlo,Consolas,monospace] [hyphens:none]">
        <code className={codeClassName}>{children}</code>
      </pre>
    </div>
  )
}

/* ─────────────── helpers ─────────────── */

function firstElement(children: ReactNode): ReactNode {
  if (Array.isArray(children)) return children[0]
  return children
}

/**
 * Recursively flatten a React node into plain text. Used by the `pre`
 * override to grab the raw source of a fenced code block so we can
 * copy it to the clipboard. react-markdown usually hands us a single
 * string child, but hardened for the case where remark plugins split
 * the block into multiple children.
 */
function reactNodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeToText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return reactNodeToText(node.props.children)
  }
  return ''
}

/* ───────────────── Exported Text renderer ───────────────── */

function AssistantMarkdownImpl({ text }: { text: string }): React.JSX.Element {
  // tracking-normal cancels the global -0.022em Apple tracking that
  // :root sets for SF Pro. That negative tracking is tuned for Latin
  // glyphs (which carry side-bearing); CJK ideographs are full-width
  // and already dense, so the same negative value crushes Chinese text
  // and makes it look cramped. Resetting to normal here gives the
  // roomy, breathing rhythm of reference chat UIs (ChatGPT/Codex)
  // WITHOUT touching the Latin tracking on buttons/headings elsewhere.
  return (
    <div className="break-words text-[14px] font-medium leading-relaxed tracking-normal text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export const AssistantMarkdown = memo(AssistantMarkdownImpl)
