import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionBarPrimitive, MessagePrimitive, useMessage } from '@assistant-ui/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Copy, ThumbsDown, ThumbsUp } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/src/components/ui/tooltip'
import { cn } from '@/src/lib/utils'
import { useI18n } from '../../../i18n'
import { REASONING_PLACEHOLDER, useChatStore } from '../../../stores/chat'
import {
  useImageEditStore,
  useSheetPreviewStore,
  useSplitWorkspaceBusy
} from '../../../stores/filePreview'
import { ThinkingSpinner } from '../ThinkingSpinner'
import { AssistantMarkdown } from '../AssistantMarkdown'
import { ToolCallCard } from './ToolCallCard'
import {
  FoldRegion,
  TurnActivityProvider,
  TurnStatusRow,
  useTurnActivityCtx
} from './TurnActivity'
import { useProposalStore } from '../../../stores/proposal'
import { continueProposalSectionBlocks } from '../../../lib/sendProposalSectionRevision'
import { triggerProposalCitationVerification } from '../../../lib/proposalVerification'
import { autoFireProposalGenImages } from '../../../lib/proposalGenImageFire'
import { addFileToKb } from '../../../lib/addFileToKb'
import { diffChars } from '@desktop-shared/textDiff'
import { spliceBlocks } from '@desktop-shared/proposalBlocks'

/* ───────────────────── Assistant message ───────────────────── */

/**
 * Free-code-style assistant message: no avatar column. The visual
 * vocabulary is per-part gutter glyphs instead — each text segment
 * gets a `●`, each tool call gets a `⎿`, each thinking segment gets
 * a `∴`. This matches how the fusion-code CLI renders an assistant
 * turn in the terminal: every content block stands on its own row,
 * with its own gutter character on the left.
 *
 * The actual glyph rendering lives inside each per-part component
 * (AssistantTextRow, ToolCallCard, ThinkingSpinner) so a turn that
 * mixes text + tool + text reads as three vertically stacked rows
 * with three different gutter characters, exactly like the terminal.
 */
/* ─────────────────── deliverable file cards ─────────────────── */

/**
 * File paths worth surfacing as openable cards at the end of an assistant
 * turn: absolute or `~/`-prefixed, ending in a "deliverable" extension.
 * Source artifacts the pipeline churns through (`.svg` pages, `.html`
 * prototypes, `.json` manifests…) are deliberately NOT matched — a
 * ppt-master deck would otherwise spam 15 svg cards under every report.
 * Bracket/quote characters are excluded so a markdown link `[x](/a/b.pptx)`
 * or a quoted path scrapes to just the path.
 */
export const DELIVERABLE_PATH_RE =
  /(?:~\/|\/)[^\s"'`«»<>|()[\]{}]*\.(?:pptx?|pdf|docx?|xlsx?|csv|zip|key|mp3|mp4|mov|wav|m4a|jpe?g|png|gif|webp)\b/gi

/**
 * 文档折角家族图标——Material Design Icons（Pictogrammers/Templarian，
 * Apache 2.0，github.com/Templarian/MaterialDesign-SVG），不是微软/Adobe
 * 官方商标 logo 的复刻，纯白单色描边填充，叠在下面 badgeClass 的彩色圆角
 * 方块上（配色沿用本文件已有的行业惯例色）。PDF 用双色镂空写法——第二个
 * path 的 fill 直接写 PDF 徽标色的字面值（不能用 currentColor，镂空字是
 * 叠在白色文档壳之上露出背景色的视觉技巧）。四个之外的类型（zip/音频/
 * 视频/未知文件/Keynote）先留字母徽标，没找到同一家族的对应图标。
 * docs/ui-prototype-outputs-panel.html 是这批图标最初验证观感的原型。
 */
const ICON_DOC_SHELL =
  'M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M13,9V3.5L18.5,9H13Z'
/** className 承载具体尺寸——两处调用方的徽标大小不同（消息卡片 40px 徽标
 *  用更大图标，输出面板 24px 徽标用更小图标），图标本身按同一比例缩放。 */
function DocIcon({ d, className }: { d: string; className: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="white" className={className} aria-hidden>
      <path d={d} />
    </svg>
  )
}
function PdfIcon({ className }: { className: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="white" d={ICON_DOC_SHELL} />
      <path
        fill="#E5252A"
        d="M9.5 11.5C9.5 12.3 8.8 13 8 13H7V15H5.5V9H8C8.8 9 9.5 9.7 9.5 10.5V11.5M14.5 13.5C14.5 14.3 13.8 15 13 15H10.5V9H13C13.8 9 14.5 9.7 14.5 10.5V13.5M18.5 10.5H17V11.5H18.5V13H17V15H15.5V9H18.5V10.5M12 10.5H13V13.5H12V10.5M7 10.5H8V11.5H7V10.5"
      />
    </svg>
  )
}
const PPTX_PATH =
  'M12.6,12.3H10.6V15.5H12.7C13.3,15.5 13.6,15.3 13.9,15C14.2,14.7 14.3,14.4 14.3,13.9C14.3,13.4 14.2,13.1 13.9,12.8C13.6,12.5 13.2,12.3 12.6,12.3M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M15.2,16C14.6,16.5 14.1,16.7 12.8,16.7H10.6V20H9V11H12.8C14.1,11 14.7,11.3 15.2,11.8C15.8,12.4 16,13 16,13.9C16,14.8 15.8,15.5 15.2,16M13,9V3.5L18.5,9H13Z'
const DOCX_PATH =
  'M15.2,20H13.8L12,13.2L10.2,20H8.8L6.6,11H8.1L9.5,17.8L11.3,11H12.6L14.4,17.8L15.8,11H17.3L15.2,20M13,9V3.5L18.5,9H13M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2Z'
const XLSX_PATH =
  'M15.8,20H14L12,16.6L10,20H8.2L11.1,15.5L8.2,11H10L12,14.4L14,11H15.8L12.9,15.5L15.8,20M13,9V3.5L18.5,9H13M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2Z'

/** Per-extension card presentation: type label (zh/en), icon-badge text and
 *  badge color. Image types render a glyph instead of badge text. Exported
 *  for OutputsPanel — the session-wide outputs popover reuses the same
 *  type→badge mapping so a file reads identically there and inline. */
export function deliverableKind(ext: string): {
  zh: string
  en: string
  badge: string
  badgeClass: string
  isImage?: boolean
  /** 按调用方需要的尺寸渲染图标（className 传 size-* 工具类）；未定义
   *  的类型没有对应的真实图标，调用方回退渲染 badge 字母。 */
  icon?: (className: string) => React.ReactNode
} {
  switch (ext) {
    case 'ppt':
    case 'pptx':
      return {
        zh: '幻灯片',
        en: 'Slides',
        badge: 'P',
        badgeClass: 'bg-[#D24726]',
        icon: (className) => <DocIcon d={PPTX_PATH} className={className} />
      }
    case 'key':
      return { zh: '幻灯片', en: 'Slides', badge: 'K', badgeClass: 'bg-sky-600' }
    case 'pdf':
      return {
        zh: '文档',
        en: 'Document',
        badge: 'PDF',
        badgeClass: 'bg-[#E5252A]',
        icon: (className) => <PdfIcon className={className} />
      }
    case 'doc':
    case 'docx':
      return {
        zh: '文档',
        en: 'Document',
        badge: 'W',
        badgeClass: 'bg-[#2B579A]',
        icon: (className) => <DocIcon d={DOCX_PATH} className={className} />
      }
    case 'xls':
    case 'xlsx':
    case 'csv':
      return {
        zh: '表格',
        en: 'Spreadsheet',
        badge: 'X',
        badgeClass: 'bg-[#217346]',
        icon: (className) => <DocIcon d={XLSX_PATH} className={className} />
      }
    case 'zip':
      return { zh: '压缩包', en: 'Archive', badge: 'ZIP', badgeClass: 'bg-amber-500' }
    case 'mp3':
    case 'wav':
    case 'm4a':
      return { zh: '音频', en: 'Audio', badge: '♪', badgeClass: 'bg-violet-500' }
    case 'mp4':
    case 'mov':
      return { zh: '视频', en: 'Video', badge: '▶', badgeClass: 'bg-violet-600' }
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'webp':
      return {
        zh: '图像',
        en: 'Image',
        badge: '',
        badgeClass: 'border border-border bg-background',
        isImage: true
      }
    default:
      return {
        zh: '文件',
        en: 'File',
        badge: ext.slice(0, 3).toUpperCase() || '?',
        badgeClass: 'bg-muted-foreground'
      }
  }
}

/**
 * One deliverable row: type icon + filename + kind label, with the whole
 * row opening the file and a 打开方式 menu offering open / reveal-in-Finder
 * / copy-path. Paths arrive pre-verified (statFiles) and absolute.
 */
function DeliverableCard({
  path
}: {
  path: string
}): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  const name = path.split('/').pop() ?? path
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const kind = deliverableKind(ext)
  // 表格文件点击 → 应用内预览面板（分割右栏，见 SpreadsheetPreviewPanel）。
  // slides/proposal 分栏时右栏被工作区占用、预览面板让位，此时降级回
  // 系统应用打开——点了必须有反应。外部打开始终留在打开方式菜单里。
  const previewableSheet = ext === 'xlsx' || ext === 'xls' || ext === 'csv'
  // 图片文件点击 → 标记编辑面板（同一右栏，见 ImageEditPanel）。只放
  // edit API 认的格式——gif 只能看不能改，仍走系统应用打开。
  const editableImage = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp'
  const splitBusy = useSplitWorkspaceBusy()

  const openExternal = (): void => {
    void window.chatApi.openPath({ absPath: path })
  }

  const open = (): void => {
    if (previewableSheet && !splitBusy) {
      useSheetPreviewStore.getState().openPreview(path)
      return
    }
    if (editableImage && !splitBusy) {
      useImageEditStore.getState().openEditor(path)
      return
    }
    openExternal()
  }

  return (
    // Apple-style segmented row: the whole row is a rounded pill that fills the
    // parent's p-1 inset edge-to-edge, so the hover wash reads as a full block
    // (not a gapped stripe). `group/card` scopes hover so badge + pill react
    // together without leaking into sibling rows.
    <div className="group/card flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors duration-200 hover:bg-hover/50">
      {/* File zone: icon + names. Clicking opens the file — the card IS the
          affordance; the pill is for the alternatives. */}
      <button
        type="button"
        onClick={open}
        title={path}
        className="group/file flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span
          aria-hidden
          className={
            // Rounded, slightly larger badge with a top-light gradient sheen
            // (the ::after in the HTML mock → an overlaid gradient span) and a
            // colored drop shadow, so the flat office-icon block gains depth.
            // Springs a touch on card hover.
            'relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl text-[13px] font-bold text-white shadow-[0_2px_8px_-2px_rgba(0,0,0,0.25)] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover/card:scale-[1.05] ' +
            kind.badgeClass
          }
        >
          {kind.isImage ? (
            <svg
              viewBox="0 0 20 20"
              className="size-[18px] text-muted-foreground"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
              <circle cx="7.2" cy="8" r="1.4" fill="currentColor" stroke="none" />
              <path d="M4 14.5l4-4 3 3 2.5-2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/25 to-transparent"
              />
              <span className="relative">
                {kind.icon ? kind.icon('size-[22px]') : kind.badge}
              </span>
            </>
          )}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-medium text-foreground group-hover/file:underline">
            {name}
          </span>
          <span className="truncate text-[11.5px] text-muted-foreground">
            {(zh ? kind.zh : kind.en) + ' · ' + ext.toUpperCase()}
          </span>
        </span>
      </button>
      {/* 打开方式 pill —— 菜单走 ui/dropdown-menu 基件（2026-07-08 用户
          定稿：全项目下拉菜单统一基件样式，替换掉这里的自绘 popover）。
          换基件顺带治好两个历史坑，不再需要手工代码：
           · overflow-hidden 裁剪 —— 基件 Content 自带 body portal + 自动
             锚定/避让（旧版手算 fixed anchor + scroll/resize 监听关闭）；
           · canvas 裸 button reset 泄漏 —— radix Item 是 div 且基件带
             data-slot，portal 出 .chat-app 也不会被填成描边卡片
             （2026-07-04「菜单每行一个框」事故）。 */}
      <div className="shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="group/owb inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background/60 pl-3 pr-2.5 text-[12px] font-medium text-foreground transition-colors duration-150 hover:bg-hover"
            >
              {zh ? '打开方式' : 'Open with'}
              <svg
                viewBox="0 0 10 10"
                className="size-2.5 text-muted-foreground transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[state=open]/owb:rotate-180"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path d="M2 3.5l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {/* 表格卡片的主点击已被应用内预览接管，菜单里这一项就是
                「还是想用 Excel/Numbers 开」的出口，label 说清楚去向。 */}
            <DropdownMenuItem onSelect={openExternal}>
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path
                  d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16h12"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {previewableSheet
                ? zh
                  ? '用系统应用打开'
                  : 'Open in default app'
                : zh
                  ? '打开'
                  : 'Open'}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void window.chatApi.revealPath({ absPath: path })
              }}
            >
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path
                  d="M3 5.5h5l1.5 2h7.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11z"
                  strokeLinejoin="round"
                />
              </svg>
              {zh ? '在 Finder 中显示' : 'Reveal in Finder'}
            </DropdownMenuItem>
            {/* 添加到本地知识库：走对话让 local-kb skill 增量索引这个文件（见
                lib/addFileToKb —— 没有独立于对话的后台建索引通道，增量＝发一条 prompt）。 */}
            <DropdownMenuItem
              onSelect={() => {
                void addFileToKb(path)
              }}
            >
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path
                  d="M10 4v12M4 10h12"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {zh ? '添加到知识库' : 'Add to knowledge base'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * Deliverable file cards appended to an assistant message: scrape file-like
 * paths from the message's text parts, verify them against the real disk
 * via SHELL_STAT_FILES (paths the model merely *mentioned* get no card),
 * and render the survivors as openable cards — the "here are your files"
 * moment a ppt-master run ends on.
 *
 * Runs only once the message stops streaming: a half-streamed path would
 * stat as missing and flicker in later. Historical messages (no status)
 * count as complete, so cards restore with the session.
 */
function AssistantDeliverables(): React.JSX.Element | null {
  const message = useMessage()
  const reduce = useReducedMotion()
  const running =
    (message as { status?: { type?: string } }).status?.type === 'running'
  // 入场动画只给「实时长出」的成果块：挂载瞬间消息还在 running = 流式实时
  //（stat 后卡片落地播上浮）；挂载即已 settled = 历史恢复/切会话——卡片
  // 即时呈现（与 ToolCallCard 同一 gate，2026-07-04 会话切换零动画方针）。
  const enteredLive = useRef(running).current
  const text = useMemo(() => {
    const content = (message as { content?: readonly unknown[] }).content
    if (!Array.isArray(content)) return ''
    let out = ''
    for (const part of content) {
      const p = part as { type?: string; text?: string }
      if (p.type === 'text' && typeof p.text === 'string') {
        out += (out ? '\n' : '') + p.text
      }
    }
    return out
  }, [message])
  // Dedup + cap, joined into a single string so the stat effect's dep is a
  // stable primitive (a fresh array every render would re-fire it).
  const candidatesKey = useMemo(() => {
    if (!text.includes('/')) return ''
    const seen = new Set<string>()
    for (const m of text.matchAll(DELIVERABLE_PATH_RE)) seen.add(m[0])
    return [...seen].slice(0, 12).join('\n')
  }, [text])
  const [files, setFiles] = useState<readonly string[]>([])
  useEffect(() => {
    if (running || !candidatesKey) {
      setFiles([])
      return
    }
    let cancelled = false
    void window.chatApi
      .statFiles({ paths: candidatesKey.split('\n') })
      .then((r) => {
        if (!cancelled) setFiles(r.files.slice(0, 8))
      })
      .catch(() => {
        /* transient IPC failure — no cards this round */
      })
    return () => {
      cancelled = true
    }
  }, [running, candidatesKey])
  if (files.length === 0) return null
  return (
    // pl-[18px] = the text rows' 6px gutter dot + gap-3, so the card block
    // left-aligns with the assistant prose above it.
    <div className="pl-[18px]">
      {/* The "here are your files" reveal: a soft rise+fade on the whole block
          (matches the deck's easeOutExpo entrance language). p-1.5 gives each
          rounded row a matched inset so its hover wash meets the container edge
          cleanly; space-y-0.5 separates rows without a divider line. The 打开
          方式 menu escapes any clip via a body portal, so no overflow-hidden
          is needed here. */}
      <motion.div
        // initial={false}：非实时挂载（历史恢复/切会话）直接以终态呈现。
        initial={
          !enteredLive
            ? false
            : reduce
              ? { opacity: 0 }
              : { opacity: 0, y: 8, scale: 0.99 }
        }
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={
          reduce
            ? { duration: 0.2 }
            : { duration: 0.32, ease: [0.22, 1, 0.36, 1] }
        }
        className="space-y-0.5 rounded-2xl border border-border/60 bg-gradient-to-b from-card to-card/60 p-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-16px_rgba(0,0,0,0.3)]"
      >
        {files.map((f) => (
          <DeliverableCard key={f} path={f} />
        ))}
      </motion.div>
    </div>
  )
}

export function AssistantMessage(): React.JSX.Element {
  return (
    // group/msg：给下面的 AssistantActionBar 用——复制/喜欢/不喜欢默认
    // 隐去，鼠标移到本条消息任意位置才淡入（同 ChatGPT/Claude.ai 的
    // hover-reveal 惯例，避免一堆图标常驻抢戏）。
    //
    // am-parts（2026-07-17 回合叙事重设计）：兄弟间距从 gap-3 迁到
    // main.css 的 `.am-parts > * + *` 规则——flex gap 是刚性的，阶段组
    // 内的工具行要紧排（2px，拼连续竖线）、digest 折叠块要间距归零，
    // 只有 margin 方案能按 data-stack / data-folded 分档。视觉默认档
    // 与原 gap-3 等值（12px）。
    <MessagePrimitive.Root className="group/msg am-parts mb-6 flex w-full flex-col">
      <TurnActivityProvider>
        {/* 回合总状态行（"正在处理 · 1分24秒" → "已处理 4分32秒"）：
            可见工具行 ≥ 2 时出现，点击折叠全部过程块只看结论。 */}
        <TurnStatusRow />
        {/* unstable_showEmptyOnNonTextEnd={false}: without this, Empty
            (= ThinkingSpinner) fires after every part whose type isn't
            text — i.e. after every tool-call. A turn that's [Bash, Grep,
            Glob, Read, ...] would then render a Thinking row between
            every pair of tools, all reading the same elapsed seconds
            because they share the global turnStartedAt. We only want
            the spinner to appear in the genuine "no parts yet" gap. */}
        <MessagePrimitive.Parts
          unstable_showEmptyOnNonTextEnd={false}
          components={{
            Text: AssistantTextRow,
            // Reasoning (extended-thinking) parts. assistant-ui's
            // default for this slot is `() => null`, which is why
            // thinking blocks were invisible before. Our custom card
            // makes them collapsible so they don't overwhelm the chat
            // when the model thinks for a long time.
            Reasoning: ReasoningCard,
            tools: {
              Fallback: ToolCallCard
            },
            // Empty fires when the assistant message has no content
            // parts yet — typically the runtime-injected optimistic
            // placeholder during the pre-text gap of a new turn.
            // ThinkingSpinner already renders its own animated glyph
            // in the gutter, so it slots right in next to text rows.
            Empty: ThinkingSpinner
          }}
        />
        {/* Deliverable file cards: real on-disk files this message's text
            points at, rendered as openable cards once the message settles. */}
        <AssistantDeliverables />
        {/* 写方案·选区即改待审阅对照 + [应用/放弃/继续改]。仅当本条助手消息是一轮
            选区改写的产出（store.blockReviews[messageId] 存在）时渲染，挂在消息体下方。 */}
        <ProposalRevisionReview />
        {/* 复制 / 喜欢 / 不喜欢——见 AssistantActionBar 头注释。 */}
        <AssistantActionBar />
      </TurnActivityProvider>
    </MessagePrimitive.Root>
  )
}

/**
 * 消息末尾的操作栏：复制、喜欢、不喜欢。三个按钮都是 assistant-ui 内置的
 * ActionBarPrimitive（Copy 直接写剪贴板；FeedbackPositive/Negative 调用
 * runtime 的 feedback adapter——落地实现见 FusionRuntimeProvider 的
 * messageFeedbackAdapter：两者都打开已有的「问题反馈」弹窗，预选分段 +
 * 静默附带这条回复原文，而不是另起一套消息评分后端）。
 *
 * 流式中不渲染：半成品回复既不该被复制也不该被评价，等 status 落定
 * （非 running）再出现，与 AssistantDeliverables 的 running 门控同源。
 *
 * 可见性分两档（2026-07-17 用户拍板）：
 *  - **最后一条**回复落定后**常驻**——回复刚写完时「复制 / 评价」正是用户
 *    最可能立刻要用的动作，让主路径等一次 hover 才现身是把它藏起来。
 *  - 往上的历史消息仍是 hover 才淡入：一屏几十条各挂三个常驻图标，转录会
 *    读成一列工具栏而不是对话。
 * `isLast` 取自 assistant-ui 的 message state（库自己的 ActionBarPrimitive.Root
 * 那套 autohide="not-last" 读的是同一个字段）。没直接换用那个 primitive 是
 * 因为它在隐藏档位是 `return null` 整个卸载，会把这里的 opacity 淡入过渡一起
 * 弄没——历史消息 hover 时图标硬闪出来。
 *
 * 喜欢/不喜欢按下后常驻高亮（读 message.metadata.submittedFeedback，
 * assistant-ui 落到消息上的持久状态）——即便鼠标移开、操作栏淡出，下次
 * hover 回来仍能看出这条消息已经评价过。
 */
function AssistantActionBar(): React.JSX.Element | null {
  const message = useMessage() as {
    status?: { type?: string }
    isCopied?: boolean
    isLast?: boolean
    metadata?: { submittedFeedback?: { type: 'positive' | 'negative' } }
  }
  if (message.status?.type === 'running') return null
  const feedback = message.metadata?.submittedFeedback?.type

  return (
    <div
      className={cn(
        // pl-[18px]：对齐 AssistantTextRow 的正文缩进（gutter 圆点 6px + gap-3）。
        'flex items-center gap-0.5 pl-[18px] transition-opacity duration-150',
        message.isLast
          ? 'opacity-100'
          : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ActionBarPrimitive.Copy
            copiedDuration={1500}
            className={actionBarButtonClass()}
          >
            {message.isCopied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </ActionBarPrimitive.Copy>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {message.isCopied ? '已复制' : '复制'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ActionBarPrimitive.FeedbackPositive
            className={actionBarButtonClass(feedback === 'positive')}
          >
            <ThumbsUp className="size-3.5" />
          </ActionBarPrimitive.FeedbackPositive>
        </TooltipTrigger>
        <TooltipContent side="bottom">喜欢这个回答</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ActionBarPrimitive.FeedbackNegative
            className={actionBarButtonClass(feedback === 'negative')}
          >
            <ThumbsDown className="size-3.5" />
          </ActionBarPrimitive.FeedbackNegative>
        </TooltipTrigger>
        <TooltipContent side="bottom">不喜欢这个回答</TooltipContent>
      </Tooltip>
    </div>
  )
}

function actionBarButtonClass(active?: boolean): string {
  return cn(
    'flex size-7 items-center justify-center rounded-md transition-colors',
    active
      ? 'text-accent'
      : 'text-muted-foreground hover:bg-hover hover:text-foreground'
  )
}

/**
 * 选区即改·对话内审阅（先审阅后落地）。
 *
 * 用户在纸面选中一段正文、经浮层发起 AI 改写后，产出【不即时落地】，而是由 end 分流登记成一条
 * blockReview（key=本轮助手消息 id）。本组件用 useMessage() 拿到当前消息 id，命中则在该助手消息
 * 下方渲染「原文 vs 改写后」对照 + 三个动作：
 *   - 应用：spliceBlocks 把改写后拼回目标节的那几块（reviseSection 重置校验/更新 baseline），
 *           补触发引用落地校验，移除本项。原文其余内容原样不动。
 *   - 放弃：移除本项，原文纹丝不动。
 *   - 继续改：展开小输入框再给一句指令，在【当前这版改写稿】上接着改——移除本项、发起新一轮，
 *           新产出到 end 会挂一条新的 blockReview（对照的「原文」始终是节内原文、不变），如此循环。
 */
function ProposalRevisionReview(): React.JSX.Element | null {
  const message = useMessage()
  const id = (message as { id?: string }).id
  const review = useProposalStore((s) => (id ? s.blockReviews[id] : undefined))
  const streaming = useChatStore((s) => s.streaming)
  const [continuing, setContinuing] = useState(false)
  const [instruction, setInstruction] = useState('')

  // 字符级 diff：把「原文 vs 改写后」的改动标出来——原文块给被删片段打红删除线、改写后块
  // 给新增片段打绿高亮，用户一眼看出改了哪几个字（否则两段平铺得肉眼逐字对比）。review 命中
  // 前 hooks 也得先跑（React 规则：hook 数量不能随分支变），故用可空源、内部兜底空串。
  const segments = useMemo(
    () => diffChars(review?.before ?? '', review?.after ?? ''),
    [review?.before, review?.after]
  )

  if (!id || !review) return null
  const r = review // 命中后窄化非空，供下方闭包使用

  const apply = (): void => {
    const st = useProposalStore.getState()
    const cur = st.blockReviews[id]
    if (!cur) return
    const target = st.sections.find((s) => s.id === cur.sectionId)
    if (target) {
      st.reviseSection(
        cur.sectionId,
        spliceBlocks(target.markdown, cur.blockRange, cur.after)
      )
      triggerProposalCitationVerification()
      // genimage 自动发起：选区即改的产出在 end 时还压在 blockReview 里没入节，
      // FusionRuntimeProvider end 处的 autoFire 扫不到它——改写块里若带新指令块，只有此刻
      // 「应用」才真正落进 sections。聊天侧对每个 genimage 围栏都提示「将自动生成」，这条
      // 落地路径必须兑现承诺；扫描按 genImageJobs 幂等，重复调用零成本。
      if (st.sessionId) autoFireProposalGenImages(st.sessionId)
    }
    st.removeBlockReview(id)
  }

  const discard = (): void => {
    useProposalStore.getState().removeBlockReview(id)
  }

  const submitContinue = async (): Promise<void> => {
    const text = instruction.trim()
    if (!text || streaming) return
    // 当前这版被「继续改稿」取代：先撤本项，再发起新一轮（新产出到 end 会挂新的 blockReview）。
    useProposalStore.getState().removeBlockReview(id)
    setContinuing(false)
    setInstruction('')
    await continueProposalSectionBlocks(r.sectionId, r.blockRange, r.after, text)
  }

  return (
    <div className="mt-1 rounded-lg border border-border bg-muted/30 p-3 text-[13px]">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-accent">
        <span>✦</span>
        <span>选区改写 · 待确认</span>
      </div>
      <div className="space-y-2">
        <div>
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>原文</span>
            <span className="inline-flex items-center gap-1 text-[10px] text-rose-500/90">
              <span className="inline-block h-2 w-2 rounded-[2px] bg-rose-500/25" />
              删除
            </span>
          </div>
          {/* 原文流 = equal + delete。被删片段打红删除线，其余保持原文的弱化色。 */}
          <div className="max-h-24 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-[12px] leading-[1.6] text-muted-foreground">
            {segments.map((seg, idx) =>
              seg.op === 'insert' ? null : seg.op === 'delete' ? (
                <span
                  key={idx}
                  className="rounded-[3px] bg-rose-500/10 text-rose-600 line-through decoration-rose-400/60 dark:text-rose-400"
                >
                  {seg.text}
                </span>
              ) : (
                <span key={idx}>{seg.text}</span>
              )
            )}
          </div>
        </div>
        <div>
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-accent">
            <span>改写后</span>
            <span className="inline-flex items-center gap-1 text-[10px] font-normal text-emerald-600/90">
              <span className="inline-block h-2 w-2 rounded-[2px] bg-emerald-500/30" />
              新增
            </span>
          </div>
          {/* 改写后流 = equal + insert。新增片段打绿高亮，其余保持成稿常规色。 */}
          <div className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border-l-2 border-accent bg-accent/5 py-1 pl-2 pr-1 text-[12px] leading-[1.6] text-foreground">
            {segments.map((seg, idx) =>
              seg.op === 'delete' ? null : seg.op === 'insert' ? (
                <span
                  key={idx}
                  className="rounded-[3px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                >
                  {seg.text}
                </span>
              ) : (
                <span key={idx}>{seg.text}</span>
              )
            )}
          </div>
        </div>
      </div>

      {continuing ? (
        <div className="mt-2.5">
          <textarea
            autoFocus
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && instruction.trim()) {
                e.preventDefault()
                void submitContinue()
              }
            }}
            placeholder="再给一句：比如「再正式些」「补一个数据」…"
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-accent"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
              onClick={() => {
                setContinuing(false)
                setInstruction('')
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:opacity-90 disabled:opacity-40"
              disabled={!instruction.trim() || streaming}
              onClick={() => void submitContinue()}
              title="⌘/Ctrl + 回车"
            >
              发送
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:opacity-90"
            onClick={apply}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            应用
          </button>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-hover"
            onClick={discard}
          >
            放弃
          </button>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-[12px] text-foreground hover:border-accent hover:text-accent"
            onClick={() => setContinuing(true)}
          >
            继续改
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * One row of assistant text with the `●` gutter glyph on the left.
 * The glyph column is fixed-width and aligns with `⎿` / `∴` glyphs
 * on adjacent rows so a multi-part turn reads as a clean ASCII tree
 * down the left edge — same shape as the fusion-code CLI.
 */
function AssistantTextRow({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex w-full gap-3">
      {/* Gutter dot. We used to render the `●` character, but its
          vertical position depends on the font's glyph metrics and
          ends up sitting above the visual center of the line.
          Replacing it with a real 6px CSS circle lets us offset it
          with pixel precision: AssistantMarkdown's first paragraph
          is `text-[14px] leading-relaxed` (line-height ≈ 22.75px),
          so the line's visual center is at ~11.4px and a 6px dot
          wants its top edge at ~8px to sit dead-center. */}
      <span
        aria-hidden
        className="mt-[8px] block size-[6px] shrink-0 rounded-full bg-foreground/60"
      />
      <div className="min-w-0 flex-1">
        <AssistantMarkdown text={text} />
      </div>
    </div>
  )
}

/* ─────────────────── Reasoning (thinking) card ─────────────── */

/**
 * Collapsible card for an extended-thinking part. The Anthropic API
 * streams `content_block_delta.thinking_delta` events for any
 * thinking block; the engine pipes them into ChatEvent.thinking_delta
 * and the chat store accumulates them into a `reasoning` part on the
 * assistant message. Without this component the part would be
 * invisible — assistant-ui ships a default `Reasoning: () => null`
 * for the slot, presumably because most apps want to hide raw chain
 * of thought.
 *
 * Behavior
 * --------
 * - While the turn is streaming, the card auto-expands so the user
 *   can watch the model think in real time.
 * - Once the turn ends, it auto-collapses to a one-line summary
 *   ("Thinking · 12s · 482 chars"). The user can click to re-expand.
 * - The expand state is per-card local — the user's collapse choice
 *   on one message doesn't affect another.
 *
 * `status` arrives from assistant-ui's MessagePartState. We treat
 * `running` as "still streaming" for the auto-expand decision.
 */
function ReasoningCard({
  text,
  status
}: {
  text: string
  status?: { type: string }
}): React.JSX.Element {
  const isStreaming = status?.type === 'running'
  // digest（回合总状态行的「只看结论」）把思考块和阶段组一起折掉。
  const turnDigest = useTurnActivityCtx()?.digest ?? false
  // A ZWSP-only reasoning part is our "pre-show placeholder" — the
  // card label should appear immediately, but the body should stay
  // collapsed until a real delta replaces the placeholder. We also
  // strip the ZWSP out of the rendered text below so a late-arriving
  // copy-paste doesn't surface an invisible character.
  const displayText = text.replace(REASONING_PLACEHOLDER, '')
  // Trim so a single stray whitespace / newline delta doesn't light
  // up an empty rounded box under the label ("思考过程 · 1 字" with
  // nothing inside).
  const trimmedText = displayText.trim()
  const hasText = trimmedText.length > 0
  // `null` ⇒ user hasn't manually toggled yet — let the streaming
  // flag drive the open state. Once they click, lock to their
  // explicit choice. This way the card auto-expands while thinking
  // and auto-collapses at end-of-turn, but doesn't fight a user
  // who expanded an old card to re-read the chain of thought.
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  // Don't auto-open the body until we actually have text to show.
  // The reasoning part is pre-created on `thinking_start` (so the
  // dot + label appear instantly), and without this guard we'd
  // briefly render an empty rounded box before the first delta
  // lands a few seconds later. Empty reasoning always stays closed.
  const open = hasText && (userToggled ?? isStreaming)
  const charCount = trimmedText.length

  // Thinking ended with NO text at all → render nothing. The API
  // sometimes ships a thinking block that carries only an encrypted
  // signature and zero visible text (short greetings often get
  // thinking_tokens > 0 but no thinking_delta / empty `thinking` in
  // the finalized message) — a permanently-empty, non-expandable
  // 「思考过程」 row is pure noise. While streaming we keep the row:
  // 「正在思考…」 is a live activity signal even before text lands.
  // (Hook order is safe: this return sits below every hook above.)
  if (!isStreaming && !hasText) return <></>


  return (
    <FoldRegion folded={turnDigest}>
    <div className="flex w-full gap-3">
      <span
        aria-hidden
        className="mt-[7px] flex size-[6px] shrink-0 items-center justify-center"
      >
        {/* State indicator dot: in-progress = amber breathing (tc-breathe,
            main.css), done = emerald. Deliberately NOT bg-accent — the
            user's theme color has uncontrolled luminance and can end up
            near-invisible against a dark bubble, whereas this dot is the
            only "is the model still thinking" signal on screen. Amber
            matches the "live" pulse convention used elsewhere (e.g.
            LivePreviewEditor's collaborator cursor). */}
        <span
          // origin-left：这一行整体坐在 FoldRegion 的 motion.div 里，那层为了做
          // 折叠高度动画必须 overflow:hidden（TurnActivity.tsx）；这颗点又紧贴
          // 行首（x=0，与裁剪盒左边界重合，右/上/下都还有 gap-3、mt-[7px] 留白）。
          // tc-breathe 默认从中心放大到 1.45 倍，往左溢出的部分正好越过裁剪盒
          // 左边界被切掉，肉眼看是「左边被削平」。改成从左边缘往右呼吸就不会
          // 再越过左边界，不用去动共享的 FoldRegion 或 .tc-breathe 关键帧。
          className={
            'block size-[6px] rounded-full ' +
            (isStreaming ? 'tc-breathe origin-left bg-amber-500' : 'bg-emerald-500')
          }
        />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => hasText && setUserToggled(!open)}
          aria-expanded={open}
          disabled={!hasText}
          className={
            'group/reason flex w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[12px] text-muted-foreground transition-colors ' +
            (hasText ? 'hover:text-foreground' : 'cursor-default')
          }
        >
          {hasText && (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={
                'shrink-0 transition-transform ' + (open ? 'rotate-90' : '')
              }
              aria-hidden
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          )}
          {isStreaming ? (
            <ShimmerText>正在思考…</ShimmerText>
          ) : (
            <span className="font-medium tracking-tight">思考过程</span>
          )}
          {!isStreaming && hasText && (
            <span className="text-[11px] text-muted-foreground/60">
              · {charCount} 字
            </span>
          )}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="reasoning-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              {/* Apple card (DESIGN.md §4): no border, subtle bg
                  contrast supplies elevation. `bg-muted` sits 1-2
                  shades off the canvas on both themes, so the card
                  reads as "inset" without any visible stroke. 13px
                  text with apple-micro tracking is Apple's smallest
                  comfortable reading size — tight but legible. */}
              <div
                data-selectable="true"
                className="mt-1.5 rounded-apple-lg bg-muted px-4 py-3 text-[13px] leading-[1.47] tracking-apple-micro text-muted-foreground"
              >
                <pre className="whitespace-pre-wrap break-words font-sans">
                  {displayText}
                </pre>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
    </FoldRegion>
  )
}

/* ───────────────────── System message ──────────────────────── */

export function SystemMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-4 flex w-full justify-center">
      {/* Borderless Apple pill (DESIGN.md §4). `rounded-pill` is the
          signature 980px capsule shape used for Apple CTA links; a
          system message is informational, not interactive, so we keep
          the shape but use `bg-muted` with no accent tint. */}
      <div className="rounded-pill bg-muted px-4 py-1.5 text-[12px] tracking-apple-micro text-muted-foreground">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

/**
 * ShimmerText
 * -----------
 * Apple-style text shimmer — a bright highlight sweeps through the
 * characters while the dimmer base color stays put, producing the
 * same "breathing" label effect used on iOS loading states and the
 * Apple homepage hero headlines during async data loads.
 *
 * How it works
 * ------------
 * 1. The `<motion.span>` has its background painted with a 3-stop
 *    horizontal gradient: muted at both ends, foreground at the
 *    center, so the middle third is brighter than the edges.
 * 2. `background-size: 200% 100%` makes the gradient twice as wide
 *    as the text, so there's room to slide the bright center in
 *    and out of view.
 * 3. `background-clip: text` + `color: transparent` clips the
 *    gradient to the letterforms — you see the gradient only where
 *    there's a glyph, so the effect looks like the letters
 *    themselves are breathing, not a rectangle pulsing behind them.
 * 4. Motion interpolates `backgroundPositionX` from `200%` to
 *    `-200%` over 2.4s on a linear repeat, sliding the bright
 *    center of the gradient right-to-left across the element.
 *    (Motion parses percentage string keyframes and smoothly
 *    animates them.)
 *
 * Respects `prefers-reduced-motion` indirectly: motion honors the
 * user's OS setting and will fall back to the final frame instead
 * of animating when `Reduce Motion` is on.
 */
function ShimmerText({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <motion.span
      className="font-medium tracking-tight"
      style={{
        backgroundImage:
          'linear-gradient(90deg, hsl(var(--muted-foreground) / 0.35) 0%, hsl(var(--foreground)) 50%, hsl(var(--muted-foreground) / 0.35) 100%)',
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent'
      }}
      initial={{ backgroundPositionX: '200%' }}
      animate={{ backgroundPositionX: '-200%' }}
      transition={{ duration: 2.4, ease: 'linear', repeat: Infinity }}
    >
      {children}
    </motion.span>
  )
}
