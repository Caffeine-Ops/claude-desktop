import { isValidElement, memo, useCallback, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
    <p className="mb-3 last:mb-0 text-[14px] leading-relaxed text-zinc-200">
      {children}
    </p>
  ),

  h1: ({ children }) => (
    <h1 className="mb-3 mt-5 text-[19px] font-bold text-zinc-100">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-5 text-[17px] font-semibold text-zinc-100">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-4 text-[15px] font-semibold text-zinc-100">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-3 text-[14px] font-semibold text-zinc-200">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-3 text-[13px] font-semibold text-zinc-200">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-2 text-[12.5px] font-semibold text-zinc-300">
      {children}
    </h6>
  ),

  ul: ({ children }) => (
    <ul className="mb-3 ml-5 list-disc space-y-1 text-[14px] leading-relaxed text-zinc-200 marker:text-zinc-600">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 ml-5 list-decimal space-y-1 text-[14px] leading-relaxed text-zinc-200 marker:text-zinc-600">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,

  strong: ({ children }) => (
    <strong className="font-semibold text-zinc-100">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
  del: ({ children }) => (
    <del className="text-zinc-500 line-through">{children}</del>
  ),

  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-zinc-700 pl-3 italic text-zinc-400">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-4 border-zinc-800" />,

  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 underline decoration-blue-400/40 underline-offset-2 transition hover:decoration-blue-400"
    >
      {children}
    </a>
  ),

  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="min-w-full border-collapse border border-zinc-800 text-[13px]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-zinc-900/60">{children}</thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr className="border-b border-zinc-800 last:border-b-0">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-3 py-1.5 text-left font-semibold text-zinc-100">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-1.5 align-top text-zinc-300">{children}</td>
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
      <code className="rounded bg-zinc-800 px-[5px] py-[1px] font-mono text-[12.5px] text-zinc-100">
        {children}
      </code>
    )
  },

  // Fenced code blocks. react-markdown passes us <pre><code class="language-xxx">...</code></pre>.
  // We rip out the language + raw text from the child <code> element
  // and render a nicer card with a language header + copy button.
  pre: ({ children }) => {
    const codeEl = firstElement(children)
    const codeProps =
      isValidElement<{ className?: string; children?: ReactNode }>(codeEl)
        ? codeEl.props
        : undefined
    const className = codeProps?.className ?? ''
    const match = /language-(\w+)/.exec(className)
    const language = match?.[1]
    const code = reactNodeToText(codeProps?.children ?? children)
    return <CodeBlockCard language={language} code={code} />
  }
}

/* ─────────────── Code block card with header + copy ─────────────── */

function CodeBlockCard({
  language,
  code
}: {
  language: string | undefined
  code: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('[AssistantMarkdown] clipboard copy failed', err)
    }
  }, [code])

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-4 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-zinc-500">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="font-mono text-[10.5px] text-zinc-500 transition hover:text-zinc-300"
          aria-label="Copy code block"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-zinc-100">
        <code>{code}</code>
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
  return (
    <div className="break-words text-[14px] leading-relaxed text-zinc-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export const AssistantMarkdown = memo(AssistantMarkdownImpl)
