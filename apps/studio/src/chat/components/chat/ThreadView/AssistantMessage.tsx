import { useEffect, useMemo, useRef, useState } from 'react'
import { MessagePrimitive, useMessage } from '@assistant-ui/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
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
} {
  switch (ext) {
    case 'ppt':
    case 'pptx':
      return { zh: '幻灯片', en: 'Slides', badge: 'P', badgeClass: 'bg-[#D24726]' }
    case 'key':
      return { zh: '幻灯片', en: 'Slides', badge: 'K', badgeClass: 'bg-sky-600' }
    case 'pdf':
      return { zh: '文档', en: 'Document', badge: 'PDF', badgeClass: 'bg-[#E5252A]' }
    case 'doc':
    case 'docx':
      return { zh: '文档', en: 'Document', badge: 'W', badgeClass: 'bg-[#2B579A]' }
    case 'xls':
    case 'xlsx':
    case 'csv':
      return { zh: '表格', en: 'Spreadsheet', badge: 'X', badgeClass: 'bg-[#217346]' }
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
    <div className="group/card flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors duration-200 hover:bg-muted/50">
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
              <span className="relative">{kind.badge}</span>
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
              className="group/owb inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background/60 pl-3 pr-2.5 text-[12px] font-medium text-foreground transition-colors duration-150 hover:bg-muted"
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
    <MessagePrimitive.Root className="mb-6 flex w-full flex-col gap-3">
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
    </MessagePrimitive.Root>
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
              className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
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
            className="rounded-lg border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-muted"
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
    <div className="flex w-full gap-3">
      <span
        aria-hidden
        className="mt-[7px] flex size-[6px] shrink-0 items-center justify-center"
      >
        {/* State indicator dot — mirrors the TodoRow status pattern:
            in-progress = accent breathing (tc-breathe, main.css), done =
            emerald. Same colours used for active todos / completed todos
            in the right rail, so the chat reads as a single visual
            language across surfaces. */}
        <span
          className={
            'block size-[6px] rounded-full ' +
            (isStreaming ? 'tc-breathe bg-accent' : 'bg-emerald-500')
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
