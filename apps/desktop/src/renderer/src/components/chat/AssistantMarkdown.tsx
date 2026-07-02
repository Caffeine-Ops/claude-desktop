import { isValidElement, memo, useCallback, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Root } from 'mdast'

import { useT } from '../../i18n'
import { toKbAssetUrl } from '../../lib/kbAssetUrl'
import { renderMermaid } from '../../lib/mermaidRender'
import { toProposalAssetUrl } from '../../lib/proposalAssetUrl'
import { isEmbeddableImagePath, normalizeImageMarkdown } from '@shared/proposal'
import { deriveImageOrigin } from '@shared/proposalAsset'

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

// 产出图来源角标文案，见下方 img override。
const originLabel = { generated: 'AI 生成', edited: '已编辑', uploaded: '用户上传' } as const

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

  // KB 本地图经 kbasset:// 协议加载，草稿产出图（改图/文生图/上传）经 proposalasset:// 协议加载
  // （绝对路径直接当 <img src> 会被当相对 URL、加载失败）。先试 kbasset，未命中再试 proposalasset，
  // 两者路径特征互斥、链式判定零歧义。
  img: ({ src, alt }) => {
    if (typeof src === 'string') {
      const kbUrl = toKbAssetUrl(src)
      const resolved = kbUrl === src ? toProposalAssetUrl(src) : kbUrl
      // 本地资产图（KB 或产出图）若非 docx 可嵌格式（webp/svg…），导出 Word 会降级为文字占位；
      // 预览此处同步降级，避免「预览有图、成品 Word 没图」的静默不一致——与 proposalDocx.
      // imageParagraphs 共用同一个 isEmbeddableImagePath 谓词（评审发现）。仅对 URL 被改写的本地
      // 资产图（resolved !== src）生效，不影响外链图。
      if (resolved !== src && !isEmbeddableImagePath(src)) {
        const caption = (alt && alt.trim()) || src.slice(src.lastIndexOf('/') + 1)
        return <span className="my-2 inline-block text-[13px] text-neutral-400">[图：{caption}]</span>
      }
      // data-raw-src：保留 markdown 里的原始（未转协议）绝对路径，供编辑态点图工具栏（Task 9）
      // 反查 sourcePath——react-markdown 解析时已代我们剥掉了 <> 包裹与 " title" 后缀，值与
      // shared/proposal.parseImages 抽出的 path 精确一致，点图无需再自行正则重新解析一遍。
      const imgEl = (
        <img
          src={resolved}
          alt={alt ?? ''}
          data-raw-src={src}
          className="my-2 max-h-[70vh] w-auto max-w-full rounded"
        />
      )
      // 产出图来源角标：纯渲染态提示，不进 markdown、不进 docx（导出侧直读绝对路径原文，
      // 天然不含角标）。仅对草稿产出图生效——deriveImageOrigin 对 KB 图/外链图恒返回 null。
      const origin = deriveImageOrigin(src)
      if (!origin) return imgEl
      return (
        <span className="relative inline-block">
          {imgEl}
          <span className="absolute right-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
            {originLabel[origin]}
          </span>
        </span>
      )
    }
    // 非 string 的 src（罕见，react-markdown 类型上允许 undefined）原样透传给 <img>。
    return <img src={src as string | undefined} alt={alt ?? ''} className="my-2 max-h-[70vh] w-auto max-w-full rounded" />
  },

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
    // mermaid 围栏块 → 渲成图（方案一二期），不进代码卡片。rawCode 是 reactNodeToText 拍平的
    // 原始 mermaid 源码（rehype-highlight 不识别 mermaid 语言、ignoreMissing 下原样透传）。
    if (language === 'mermaid') {
      return <MermaidBlock code={rawCode} />
    }
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

/* ─────────────── Mermaid diagram block (方案一二期) ─────────────── */

/**
 * 把 ```mermaid 代码块渲成图（编辑/聊天态可见）。渲染在 renderer 异步完成；流式未闭合或语法
 * 错误时降级显示源码（不报错打断阅读）。导出时另由 main 用 sharp 把同一份 SVG 位图化进 docx，
 * 故两端视觉同源。
 */
function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setFailed(false)
    renderMermaid(code)
      .then((s) => {
        if (alive) setSvg(s)
      })
      .catch(() => {
        // 流式未闭合 / 语法错误：降级源码。边流式边解析时半截 mermaid 报错属预期，不打断阅读。
        if (alive) {
          setSvg(null)
          setFailed(true)
        }
      })
    return () => {
      alive = false
    }
  }, [code])

  if (svg && !failed) {
    // dangerouslySetInnerHTML：mermaid 以 securityLevel:'strict' 渲染并消毒过 SVG，来源是
    // KB 接地文本，可信。白底容器让 neutral 主题在深色聊天界面里也清晰。
    return (
      <div
        className="my-3 flex justify-center overflow-x-auto rounded-lg border border-border/60 bg-white p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }
  return (
    <pre className="my-3 overflow-x-auto rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-[12.5px] leading-[1.55] text-muted-foreground [font-family:ui-monospace,Menlo,Consolas,monospace]">
      <code>{code}</code>
    </pre>
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

/* ───────────────── 来源标注上色（编辑态专用） ───────────────── */

// 段末「（据《X》）」来源标注的内联匹配（与 shared/proposal 的 stripCitations 同模式）。
const CITATION_INLINE_RE = /（据[^）]*）/g

/**
 * remark transform：把文本节点里的「（据《X》）」切出来，包成带 class 的内联节点，供编辑态上色
 * （CSS `.proposal-citation`，见 index.css）。让作者一眼看到每段引了哪些来源、便于逐句溯源。
 *
 * 实现取舍：用 `emphasis` 作载体节点 + `data.hName='span'`——mdast-util-to-hast 的 applyData 会用
 * hName 覆盖最终元素的 tagName，故渲染成 `<span class="proposal-citation">` 而非 `<em>`（不带斜体），
 * 也不必给 react-markdown 注册一个会误伤其它内容的全局 `span` 组件。仅当 highlightCitations 开启时
 * 才挂这个插件，故普通聊天气泡不产出任何 span、零影响。
 *
 * 项目未装 unist-util-visit，故手写递归遍历 mdast。只切 type==='text' 的节点：code / inlineCode 的
 * 文本在 'code'/'inlineCode' 节点里（无 children），不会被误染。
 */
function remarkHighlightCitations() {
  return (tree: Root): void => {
    walkCitations(tree as { children?: unknown[] })
  }
}

function walkCitations(node: { children?: unknown[] }): void {
  const children = node.children
  if (!Array.isArray(children)) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as { type?: string; value?: string; children?: unknown[] }
    if (child.type === 'text' && typeof child.value === 'string') {
      const split = splitCitationText(child.value)
      if (split) {
        children.splice(i, 1, ...split)
        i += split.length - 1 // 跳过刚插入的片段，避免重复处理
      }
    } else {
      walkCitations(child)
    }
  }
}

// 把一段文本按引用组切成 [普通文本 | 引用 span | 普通文本 …]；无引用 → null（保持原节点不变）。
function splitCitationText(value: string): unknown[] | null {
  CITATION_INLINE_RE.lastIndex = 0
  if (!CITATION_INLINE_RE.test(value)) return null
  CITATION_INLINE_RE.lastIndex = 0
  const out: unknown[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = CITATION_INLINE_RE.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({
      type: 'emphasis',
      children: [{ type: 'text', value: m[0] }],
      data: { hName: 'span', hProperties: { className: ['proposal-citation'] } }
    })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

/* ───────────────── Exported Text renderer ───────────────── */

function AssistantMarkdownImpl({
  text,
  // 编辑态（ProposalPaper）传 true：高亮段末来源标注。聊天气泡不传 → 走默认，无任何 span 注入。
  highlightCitations = false
}: {
  text: string
  highlightCitations?: boolean
}): React.JSX.Element {
  const remarkPlugins = highlightCitations
    ? [remarkGfm, remarkHighlightCitations]
    : [remarkGfm]
  // 给含空格的图片目标补 `<>`，否则 CommonMark 不解析成图片、KB 配图退化成一行纯文字（`![…](…)`
  // 原样可见）。与导出侧 proposalDocx 共用同一个 normalizeImageMarkdown，保「预览=导出一致」。
  const normalized = normalizeImageMarkdown(text)
  return (
    <div className="break-words text-[14px] leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

export const AssistantMarkdown = memo(AssistantMarkdownImpl)
