import {
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useMessage } from '@assistant-ui/react'
import type { Root } from 'mdast'

import { useI18n, useT } from '../../i18n'
import { toKbAssetUrl } from '../../lib/kbAssetUrl'
import { isLocalAssetPath, safeDecodeUri } from '../../lib/localAssetPath'
import { renderMermaid } from '../../lib/mermaidRender'
import { toProposalAssetUrl } from '../../lib/proposalAssetUrl'
import {
  isEmbeddableImagePath,
  normalizeImageMarkdown
} from '@desktop-shared/proposal'
import { deriveImageOrigin } from '@desktop-shared/proposalAsset'

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
const originLabel = {
  generated: 'AI 生成',
  edited: '已编辑',
  uploaded: '用户上传'
} as const

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
  // GFM task-list items (`- [x]` / `- [ ]`) drop their disc marker — the
  // custom checkbox (see the `input` override) IS the marker. Plain items
  // keep the disc.
  li: ({ children, className }) =>
    className?.includes('task-list-item') ? (
      <li className="list-none pl-1">{children}</li>
    ) : (
      <li className="pl-1">{children}</li>
    ),

  // GFM checkbox → a drawn status dot instead of the disabled native
  // <input> (which renders as a greyed-out OS checkbox — reads as "broken
  // form control" to regular users). Checked = the same emerald disc +
  // white check the tool-status badges use; unchecked = a quiet hollow
  // circle ("still to do"). Same visual language as the rest of the app.
  input: ({ checked, type }) => {
    if (type !== 'checkbox') return <input type={type} />
    return (
      <span
        aria-hidden
        className="mr-1.5 inline-flex size-[14px] translate-y-[2px] items-center justify-center"
      >
        {checked ? (
          <svg viewBox="0 0 14 14" className="size-full">
            <circle cx="7" cy="7" r="7" className="fill-emerald-500" />
            <path
              d="M4.2 7.4l1.9 1.9 3.7-4.1"
              fill="none"
              stroke="#fff"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 14 14" className="size-full">
            <circle
              cx="7"
              cy="7"
              r="6.2"
              className="fill-none stroke-muted-foreground/50"
              strokeWidth="1.5"
            />
          </svg>
        )}
      </span>
    )
  },

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
      // react-markdown 会把 src 百分号编码（空格→%20、CJK→%E…，见 localAssetPath.ts 注释），
      // 而下游所有逻辑（协议转换/接地角标/data-raw-src 点图手术）都假设拿到的是 markdown 里的
      // 原始字节。本地资产路径在此解码一次还原；外链 http 图保持原 src 不动（解码外链会改变
      // 语义，如 query 里的合法 %26）。
      const decoded = safeDecodeUri(src)
      const path = isLocalAssetPath(decoded) ? decoded : src
      const kbUrl = toKbAssetUrl(path)
      const resolved = kbUrl === path ? toProposalAssetUrl(path) : kbUrl
      // 本地资产图（KB 或产出图）若非 docx 可嵌格式（webp/svg…），导出 Word 会降级为文字占位；
      // 预览此处同步降级，避免「预览有图、成品 Word 没图」的静默不一致——与 proposalDocx.
      // imageParagraphs 共用同一个 isEmbeddableImagePath 谓词。仅对 URL 被改写的本地
      // 资产图（resolved !== path）生效，不影响外链图。
      if (resolved !== path && !isEmbeddableImagePath(path)) {
        const caption = (alt && alt.trim()) || path.slice(path.lastIndexOf('/') + 1)
        return (
          <span className="my-2 inline-block text-[13px] text-neutral-400">
            [图：{caption}]
          </span>
        )
      }
      // data-raw-src：保留 markdown 里的原始（未转协议、已还原编码）绝对路径，供编辑态点图
      // 工具栏反查 sourcePath——react-markdown 解析时已剥掉 <> 包裹与 " title" 后缀，
      // 加上面的 safeDecodeUri 还原百分号编码后，值与 shared/proposal.parseImages 抽出的 path
      // 精确一致（不解码则 macOS 含空格路径三处全断），点图无需再自行正则解析。
      // 仅当 URL 被实际改写（resolved !== path，即本地 kb/草稿资产）才挂 data-raw-src——外链
      // http 图不改写，若仍挂上会让工具栏误以为它可点「改图」，点了却拿不到本地文件。
      const imgEl = (
        <img
          src={resolved}
          alt={alt ?? ''}
          {...(resolved !== path ? { 'data-raw-src': path } : {})}
          className="my-2 max-h-[70vh] w-auto max-w-full rounded"
        />
      )
      // 产出图来源角标：纯渲染态提示，不进 markdown、不进 docx（导出侧直读绝对路径原文，
      // 天然不含角标）。仅对草稿产出图生效——deriveImageOrigin 对 KB 图/外链图恒返回 null。
      const origin = deriveImageOrigin(path)
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
    return (
      <img
        src={src as string | undefined}
        alt={alt ?? ''}
        className="my-2 max-h-[70vh] w-auto max-w-full rounded"
      />
    )
  },

  // Tables live in a horizontal scroll shell so wide tables stay
  // usable inside the narrow chat bubble. `table-auto` lets the browser
  // size columns from content, and `[overflow-wrap:anywhere]` on cells
  // breaks long CamelCase / path / URL tokens that would otherwise
  // force an entire column to balloon (CJK text already breaks fine).
  // Card shell matches CodeBlockCard (rounded-lg + shadow-sm) so both
  // block types read as one visual family inside a reply.
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border/70 shadow-sm">
      <table className="w-full table-auto border-collapse text-[12.5px] leading-snug">
        {children}
      </table>
    </div>
  ),
  // Row styling lives on thead/tbody descendant selectors, NOT on the
  // tr override — react-markdown's tr renderer can't tell a header row
  // from a body row, and a hover wash on the header reads as a bug.
  thead: ({ children }) => (
    <thead className="bg-muted/40 text-foreground [&_tr]:border-b [&_tr]:border-border/70">
      {children}
    </thead>
  ),
  // Hairline separators + a whole-row hover wash. No zebra striping:
  // stripes on top of separators read as two competing rhythms, and
  // the hover wash needs a quiet base to be visible at all.
  tbody: ({ children }) => (
    <tbody className="[&_tr:hover]:bg-muted/30 [&_tr:last-child]:border-b-0 [&_tr]:border-b [&_tr]:border-border/50 [&_tr]:transition-colors">
      {children}
    </tbody>
  ),
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, style }) => (
    <th
      style={style}
      className="whitespace-nowrap px-3.5 py-[7px] text-left align-bottom text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={style}
      className="px-3.5 py-[9px] align-top text-foreground/85 [overflow-wrap:anywhere] [word-break:break-word]"
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
      <code className="rounded-[5px] border border-border/50 bg-muted/60 px-[5px] py-[1px] font-mono text-[12px] text-foreground">
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
    // ```markdown fences are NOT source code to the reader — the
    // assistant uses them for progress notes / checklists, and showing
    // raw `##` + `[x]` markup reads as gibberish to regular users.
    // Render the content as rich text inside a quiet note card instead
    // (streaming included: the note grows in place as the fence streams).
    if (language === 'markdown' || language === 'md') {
      return <MarkdownNoteCard rawCode={rawCode} />
    }
    // genimage 指令块（写方案配图）：编辑态由 ProposalPaper 拦成卡片，这里只兜聊天流里的显示
    // ——不渲染成代码卡（指令原文对用户是噪声），降级为一行提示。
    if (language === 'genimage') {
      return (
        <div className="my-2 rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
          已插入配图生成指令，将在右侧方案文档中自动生成并供你审阅。
        </div>
      )
    }
    // mermaid 围栏块 → 渲成图，不进代码卡片。rawCode 是 reactNodeToText 拍平的
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

/* ─────────────── Rendered-markdown note card ─────────────── */

/**
 * A ```markdown fence rendered AS markdown — an accent-washed "note
 * card" with a 小结 label, entry fade-rise (tc-row-in, 只在流式实时
 * 长出时播；历史恢复/切会话即时呈现), and the fence
 * body fed back through AssistantMarkdown so headings / bold /
 * task-lists all render for real. Copy still hands over the RAW
 * markdown source (that's what you'd paste elsewhere). Nested
 * ```markdown fences recurse into nested note cards — finite text,
 * finite depth, no guard needed.
 */
function MarkdownNoteCard({ rawCode }: { rawCode: string }): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  // 入场动画只给「流式中长出来」的卡：挂载瞬间所属消息还在 running = 实时；
  // 历史恢复/切会话重挂载时消息已 settled，不重播（与 ToolCallCard 同一
  // gate，2026-07-04 会话切换零动画方针）。optional：本组件也被 OutlinePanel
  // / WrittenFilesPanel 等消息上下文之外的面板复用，无上下文时返回 null →
  // 恒不播。useRef 捕获首渲染值，流式结束不摘类。
  const live = useMessage({
    optional: true,
    selector: (s: unknown) =>
      (s as { status?: { type?: string } }).status?.type === 'running'
  })
  const enteredLive = useRef(live === true).current

  return (
    <div
      className={
        (enteredLive ? 'tc-row-in ' : '') +
        'group/note my-3 overflow-hidden rounded-lg border border-accent/20 bg-accent/[0.04]'
      }
    >
      <div className="flex items-center justify-between border-b border-accent/15 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide text-accent">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 11.5l2 2 4-4.5M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
          </svg>
          {lang === 'zh' ? '小结' : 'Summary'}
        </span>
        <CopyButton
          rawText={rawCode}
          revealClass="group-hover/note:opacity-100"
        />
      </div>
      <div className="px-4 py-3 text-[13.5px]">
        <AssistantMarkdown text={rawCode} />
      </div>
    </div>
  )
}

/* ─────────────── Code block card with header + copy ─────────────── */

/**
 * Language → status-dot tint. A per-language dot gives the header a
 * point of recognition without resorting to full logo icons (heavy,
 * incomplete coverage). Values are Tailwind bg classes; anything not
 * listed falls back to a neutral dot.
 */
const LANG_DOT: Record<string, string> = {
  bash: 'bg-emerald-500/80',
  sh: 'bg-emerald-500/80',
  shell: 'bg-emerald-500/80',
  zsh: 'bg-emerald-500/80',
  js: 'bg-yellow-500/80',
  javascript: 'bg-yellow-500/80',
  jsx: 'bg-yellow-500/80',
  ts: 'bg-blue-500/80',
  typescript: 'bg-blue-500/80',
  tsx: 'bg-blue-500/80',
  python: 'bg-sky-500/80',
  py: 'bg-sky-500/80',
  json: 'bg-amber-500/80',
  html: 'bg-orange-500/80',
  xml: 'bg-orange-500/80',
  css: 'bg-violet-500/80',
  scss: 'bg-violet-500/80',
  sql: 'bg-cyan-600/80',
  go: 'bg-cyan-500/80',
  rust: 'bg-orange-600/80',
  yaml: 'bg-fuchsia-500/70',
  yml: 'bg-fuchsia-500/70',
  diff: 'bg-rose-500/80'
}

/**
 * Copy affordance shared by CodeBlockCard / MarkdownNoteCard: hidden
 * until the card is hovered (`revealClass` carries the group-hover
 * variant, since the two cards use different group names), clipboard
 * glyph + label, flips to a check + emerald on success.
 */
function CopyButton({
  rawText,
  revealClass
}: {
  rawText: string
  revealClass: string
}): React.JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(rawText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('[AssistantMarkdown] clipboard copy failed', err)
    }
  }, [rawText])

  return (
    <button
      type="button"
      onClick={onCopy}
      className={
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] transition ' +
        (copied
          ? 'text-emerald-500'
          : `text-muted-foreground/70 opacity-0 hover:text-foreground focus-visible:opacity-100 ${revealClass}`)
      }
      aria-label={t('codeBlockCopy')}
    >
      {copied ? (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {copied ? t('codeBlockCopied') : t('codeBlockCopy')}
    </button>
  )
}

/**
 * Strip blank lines from the edges of a highlighted code tree. Models
 * often open a fence with an empty line; rendered inside the padded
 * card that reads as a hole between header and code. Only the common
 * shapes are handled (leading/trailing string nodes) — token spans in
 * the middle are untouched.
 */
function trimCodeEdges(node: ReactNode): ReactNode {
  if (typeof node === 'string') {
    return node.replace(/^\s*\n/, '').replace(/\s+$/, '')
  }
  if (Array.isArray(node)) {
    const arr = [...node]
    if (typeof arr[0] === 'string') {
      arr[0] = (arr[0] as string).replace(/^\s*\n/, '')
    }
    const last = arr.length - 1
    if (typeof arr[last] === 'string') {
      arr[last] = (arr[last] as string).replace(/\s+$/, '')
    }
    return arr
  }
  return node
}

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
  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border/70 bg-muted/30 shadow-sm">
      {/* Header: language chip on the left, copy affordance on the
          right. Kept compact so it reads as a chrome strip, not a
          second block competing with the code body. */}
      <div className="flex items-center justify-between border-b border-border/50 px-3.5 py-1.5">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium lowercase tracking-wide text-muted-foreground">
          <span
            className={
              'size-1.5 rounded-full ' +
              (LANG_DOT[language ?? ''] ?? 'bg-muted-foreground/40')
            }
            aria-hidden
          />
          {language || 'text'}
        </span>
        <CopyButton
          rawText={rawCode.replace(/^\s*\n/, '').replace(/\s+$/, '')}
          revealClass="group-hover/code:opacity-100"
        />
      </div>
      {/* Body: slightly tighter leading, a proper mono stack with
          tabular numerics, and `hyphens-none` so long identifiers in
          CJK-mixed content don't get soft-hyphenated by the browser. */}
      <pre className="overflow-x-auto px-3.5 py-3 text-[12.5px] leading-[1.55] text-foreground [font-feature-settings:'calt','ss01','tnum'] [font-family:ui-monospace,'SFMono-Regular','JetBrains_Mono','Fira_Code',Menlo,Consolas,monospace] [hyphens:none] [tab-size:2]">
        <code className={codeClassName}>{trimCodeEdges(children)}</code>
      </pre>
    </div>
  )
}

/* ─────────────── Mermaid diagram block（写方案配图） ─────────────── */

/**
 * 把 ```mermaid 代码块渲成图（编辑/聊天态可见）。渲染在 renderer 异步完成；流式未闭合或语法
 * 错误时降级显示源码（不报错打断阅读）。导出时由 renderer 把同一份 SVG 栅格化进 docx
 * （renderMermaidImageMap），故两端视觉同源。
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

/* ───────────────── 来源标注上色（写方案编辑态专用） ───────────────── */

// 段末「（据《X》）」来源标注的内联匹配（与 shared/proposal 的 stripCitations 同模式）。
const CITATION_INLINE_RE = /（据[^）]*）/g

/**
 * remark transform：把文本节点里的「（据《X》）」切出来，包成带 class 的内联节点，供编辑态上色
 * （CSS `.proposal-citation`）。让作者一眼看到每段引了哪些来源、便于逐句溯源。
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
    const child = children[i] as {
      type?: string
      value?: string
      children?: unknown[]
    }
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

// defaultUrlTransform 会把 win32 盘符路径（C:\… / C:/…）当未知协议清空成 ''，
// 图片 src 直接消失、点图链全断——Windows 是 CI 出包目标，不能靠它兜。本地资产路径（KB 图/
// 草稿产出图，特征前缀足够收敛）跳过 sanitize 原样放行；其余 URL 照走默认，保住
// javascript:/data: 注入防护。判定前先解码：sanitize 收到的是 normalizeUri 编码后的串。
function assetAwareUrlTransform(url: string): string {
  if (isLocalAssetPath(safeDecodeUri(url))) return url
  return defaultUrlTransform(url)
}

function AssistantMarkdownImpl({
  text,
  // 编辑态（ProposalPaper）传 true：高亮段末来源标注。聊天气泡不传 → 走默认，无任何 span 注入。
  highlightCitations = false
}: {
  text: string
  highlightCitations?: boolean
}): React.JSX.Element {
  // tracking-normal cancels the global -0.022em Apple tracking that
  // :root sets for SF Pro. That negative tracking is tuned for Latin
  // glyphs (which carry side-bearing); CJK ideographs are full-width
  // and already dense, so the same negative value crushes Chinese text
  // and makes it look cramped. Resetting to normal here gives the
  // roomy, breathing rhythm of reference chat UIs (ChatGPT/Codex)
  // WITHOUT touching the Latin tracking on buttons/headings elsewhere.
  // 给含空格的图片目标补 `<>`，否则 CommonMark 不解析成图片、KB 配图退化成一行纯文字（`![…](…)`
  // 原样可见）。与导出侧 proposalDocx 共用同一个 normalizeImageMarkdown，保「预览=导出一致」。
  const normalized = normalizeImageMarkdown(text)
  return (
    // data-selectable：.chat-app 全局 user-select:none 之上放开 AI 正文——
    // 表格 / inline code / fenced 代码块都是后代，一处覆盖（见 main.css）。
    <div
      data-selectable="true"
      className="break-words text-[14px] font-medium leading-relaxed tracking-normal text-foreground"
    >
      <ReactMarkdown
        remarkPlugins={
          highlightCitations ? [remarkGfm, remarkHighlightCitations] : [remarkGfm]
        }
        // detect:false（默认）——只对标注了语言的 fence 高亮。自动探测是
        // highlight.js 最贵的路径（把全部语法库对文本逐一打分），而未标语言
        // 的 fence 多半是命令输出/纯文本，探测纯属浪费；切会话时历史消息
        // 全量 mount，每个 fence 的探测成本按条数放大，是切换卡顿的主要
        // 成本之一。代价只是「模型偷懒没写语言标注的真代码」不上色。
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={components}
        urlTransform={assetAwareUrlTransform}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

export const AssistantMarkdown = memo(AssistantMarkdownImpl)
