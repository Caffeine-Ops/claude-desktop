import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessagePrimitive, useMessage } from '@assistant-ui/react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/src/lib/utils'
import { useI18n, useT } from '../../../i18n'
import {
  LEADING_SLASH_COMMAND_RE,
  findSkillChipSpec
} from '../../../composer/skillChipRegistry'
import { FileTypeIcon } from '../FileTypeIcon'
import { SkillChipIcon } from '../SkillChipIcon'
import {
  FILE_MENTION_DISPLAY_RE,
  basenameOf,
  mentionInnerToPath
} from '../../../lib/mentionDisplay'
import {
  parseImageEditMessage,
  parseSheetSelectionMessage,
  useImageEditStore,
  useSheetPreviewStore,
  type ImageEditMeta,
  type SheetSelectionMeta
} from '../../../stores/filePreview'

/* ─────────────────────── User message ──────────────────────── */

export function UserMessage(): React.JSX.Element {
  return (
    // 钉顶呼吸位（data-[aui-top-anchor-user]:pt-5，2026-07-17 二进宫）：
    // turnAnchor="top" 把最新用户消息滚到视口顶部时，气泡不贴死顶栏 hairline，
    // 留 20px 呼吸。
    //
    // 这条变体今天早些时候被删过一次——当时的考古结论（assistant-ui 0.12.24
    // 不渲染 data-aui-top-anchor-user、库里没有按锚点算 scrollTop 的代码）
    // 在当时成立；随后包升到 0.14.27，两个前提都翻了：MessageRoot 对锚点
    // 消息渲染 `data-aui-top-anchor-user=""`（非锚点为 undefined 不渲染），
    // mountTopAnchorReserve 会按 computeTopAnchorTargetScrollTop（anchor 的
    // offsetTop 链）手算 scrollTop 执行 viewport.scrollTo——真锚定滚动。
    //
    // 为什么是 padding 而不是 margin / scroll-margin：那套手算钉的是本节点
    // **border-box 顶缘**（offsetTop 不含自身 margin，也不是 scrollIntoView
    // 不认 scroll-margin），margin 会被滚出视野，只有 border-box 之内的
    // padding 在锚定后仍然可见。挂在 data 变体上而不是常驻 pt：呼吸位只属于
    // 「被钉顶」这一态，历史消息的行距、首条消息与视口列 pt-8 的关系都不动。
    <MessagePrimitive.Root className="mb-6 flex w-full flex-col items-end gap-2 data-[aui-top-anchor-user]:pt-5">
      {/* User bubble — text content. `components.Image` overrides the
          default renderer with our own, and `components.Text` (implicit
          default) just returns the raw string, which is then wrapped by
          the bubble's whitespace-pre-wrap styling.
          Image parts render OUTSIDE the bubble so the blue pill stays
          clean — thumbnails sit above the text bubble, right-aligned,
          matching how messaging apps (iMessage, WhatsApp) stack an
          image caption. */}
      <MessagePrimitive.Parts
        unstable_showEmptyOnNonTextEnd={false}
        components={{
          Image: UserImagePart,
          // Text is set to null so the outer Parts renders only
          // images. The bubble below renders the text instead — this
          // split avoids text flowing "through" the image thumb gap.
          Text: () => null
        }}
      />
      {/* User bubble.

          底色是中性 `bg-muted`，不是主题色实底（2026-07-17 用户拍板，对齐
          参考截图）：用户消息在转录里是「我说过的话」，不是需要抢注意力的
          交互元素——实底强调色会让每条自己发的话都比 AI 的回答更响。长短
          消息共用同一底色，长消息只是多一个折叠 toggle，不另换视觉语言。

          圆角 `rounded-xl`（12px）同样是长短共用一个值。别再往大调：半径
          一旦逼近短气泡的半高（旧值 22px 就是），同一个类会把长消息渲染成
          圆角卡片、把「你好」这种一行短句渲染成药丸——**同一份声明产出两种
          形状**，读起来像两套语言（2026-07-17 用户截图实锤）。12px 在短气泡
          上仍远小于半高，长短都稳定读作圆角矩形。

          ClampedUserBubble caps the height of a very long message so one
          giant paste can't fill the whole transcript — it clamps to
          USER_BUBBLE_MAX_PX, fades the overflow out at the bottom, and
          offers a 「显示更多 / 收起」toggle to expand it in place.

          毛玻璃质感（2026-07-18，跟账户菜单/composer/rail 同一批）：bg-muted
          实底换成半透明 + backdrop-blur，见 ClampedUserBubble 容器。颜色/
          圆角/字号等上面两条纪律都没动，只换材质。 */}
      <ClampedUserBubble />
    </MessagePrimitive.Root>
  )
}

/**
 * Max rendered height (px) of a user bubble before it clamps. ~5-6 lines at
 * the bubble's text-[14px]/leading-relaxed rhythm (matches AssistantMarkdown's
 * body rhythm, see the text container's className comment) plus its py-2.5
 * padding. A long paste gets cut here so it can't dominate the transcript;
 * shorter messages render in full and never clamp.
 */
const USER_BUBBLE_MAX_PX = 150

/** Join a user message's text parts into the full raw string (drives the
 *  sheet-selection / image-edit card detection + the empty-message check). */
function useUserMessageText(): string {
  const message = useMessage()
  return useMemo(() => {
    const content = (message as { content?: readonly unknown[] }).content
    if (!Array.isArray(content)) return ''
    let text = ''
    for (const part of content) {
      const p = part as { type?: string; text?: string }
      if (p.type === 'text' && typeof p.text === 'string') {
        text += (text ? '\n' : '') + p.text
      }
    }
    return text
  }, [message])
}

/**
 * The user bubble body, height-clamped when it overflows. We measure the
 * content's natural scrollHeight against USER_BUBBLE_MAX_PX (re-measuring on
 * resize) and only then apply the max-height + a bottom fade mask — so a
 * short message keeps clean edges and only a genuinely long one gets the
 * truncation treatment.
 *
 * A long one grows a 「显示更多 ⌄」toggle under the faded text; pressing it
 * expands the card **in place**（就地展开，按钮变「收起 ⌃」）rather than
 * opening a modal —— 2026-07-17 用户对齐参考截图定的形态。两条纪律来自那次
 * 对照：
 *  - 折叠文本与 toggle 之间**不加分隔线**：mask 渐隐已经把「下面还有」说清
 *    楚了，再压一条 border 会把一条消息读成两个区块（第一版实现踩过）。
 *  - toggle 是 inline-flex：命中盒贴着文字，不铺满整行——整行热区会让这条
 *    「次要动作」在视觉与手感上都压过消息本身。
 *
 * `clamped` 与 `expanded` 是两件事：前者＝内容确实超高（展开后仍为真，
 * 所以「收起」不会自己消失），后者＝用户当下选择看全。
 */
function ClampedUserBubble(): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [clamped, setClamped] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const fullText = useUserMessageText()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      // scrollHeight is the full content height regardless of max-height;
      // compare against the cap to decide whether to clamp + fade.
      setClamped(el.scrollHeight > USER_BUBBLE_MAX_PX + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 表格预览「框选问 AI」的消息(首行协议标记,见 stores/filePreview):
  // 不走普通气泡,渲染成结构化卡片——文件名 + 范围 + 问题;完整 TSV 只在
  // CLI 侧文本里,不上屏。(hooks 已全部跑完,分支安全。)
  const sheetSel = parseSheetSelectionMessage(fullText)
  if (sheetSel) return <SheetSelectionCard meta={sheetSel} />

  // 图片标记编辑面板发出的消息（同一套首行协议标记）：同样替掉普通气泡，
  // 渲染成紧凑卡片——图片名 + 各标记点描述 + 素材数；完整指令只在 CLI 侧
  // 文本里。
  const imgEdit = parseImageEditMessage(fullText)
  if (imgEdit) return <ImageEditCard meta={imgEdit} />

  // 无文本(纯图片消息)时整卡不渲染——原先靠单一 div 的 CSS `empty:hidden`
  // 判定，拆成卡片+按钮两层后 `:empty` 在外层永远命不中(外层结构上总有
  // 内层这个子元素)，改用 hasText 在 JS 侧同等短路：外层 div 没有任何
  // JSX 子节点时才会真的“空”。
  const hasText = fullText.trim().length > 0

  // 折叠中（超高且未展开）才裁切 + 渐隐；展开后彻底撤掉 maxHeight/mask，
  // 让内容照原高铺开。
  const collapsed = clamped && !expanded

  return (
    <div className="max-w-[80%] overflow-hidden rounded-xl bg-muted/65 text-foreground backdrop-blur-xl backdrop-saturate-150">
      {hasText ? (
        <>
          <div
            ref={ref}
            // data-selectable：放开用户消息气泡文本可选（.chat-app 全局禁选之上）。
            data-selectable="true"
            style={
              collapsed
                ? {
                    maxHeight: `${USER_BUBBLE_MAX_PX}px`,
                    // Fade the bottom ~40px into the card's own background so
                    // the cut reads as "there's more" rather than a hard slice.
                    // WebkitMaskImage for Chromium (Electron's renderer).
                    WebkitMaskImage:
                      'linear-gradient(to bottom, black 0, black calc(100% - 40px), transparent 100%)',
                    maskImage:
                      'linear-gradient(to bottom, black 0, black calc(100% - 40px), transparent 100%)'
                  }
                : undefined
            }
            className={cn(
              // 字体样式跟 AssistantMarkdown 的正文容器对齐（text-[14px]
              // font-medium leading-relaxed tracking-normal，一字不差）——
              // 之前这里用的是 tracking-apple-body（-0.022em，AssistantMarkdown
              // 头注释解释过：这个负字距是给英文字形的侧边距调的，中文全角
              // 表意字本来就很密，同样的负值会把中文字挤得发闷）+ leading-
              // [1.47]（比 leading-relaxed 的 1.625 更紧），两条叠在一起让用户
              // 自己发的消息读起来比 AI 回复局促——两种气泡本该是同一种字体
              // 语言的两侧，不该分叉。
              'overflow-hidden whitespace-pre-wrap break-words px-4 pt-2.5 text-[14px] font-medium leading-relaxed tracking-normal',
              // 有 toggle 时底部留白由 toggle 那一行给，避免两份 padding 叠出
              // 一道空带。
              clamped ? 'pb-1' : 'pb-2.5'
            )}
          >
            <MessagePrimitive.Parts
              unstable_showEmptyOnNonTextEnd={false}
              components={{
                // Within the bubble, skip image parts — they're already
                // rendered above. We provide a no-op Image component so
                // nothing appears here, and render Text via UserBubbleText
                // so `@"path"` file mentions become inline file chips
                // instead of raw absolute paths.
                Image: () => null,
                Text: UserBubbleText
              }}
            />
          </div>
          {clamped ? (
            <div className="px-4 pb-2.5">
              <button
                type="button"
                data-slot="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {expanded ? '收起' : '显示更多'}
                <ChevronDown
                  className={cn(
                    'size-3.5 transition-transform',
                    expanded && 'rotate-180'
                  )}
                />
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/**
 * 胶囊 hover 浮层的展开方向决策（SheetSelectionCard / ImageEditCard 共
 * 用）。浮层默认往上弹（bottom-full）——但当这条消息是会话头几条、胶囊
 * 贴着消息列表顶部时，向上没有空间，浮层会顶进 ChatHeader 底下被盖住
 * （2026-07-13 用户截图实锤）。浮层常驻 DOM 只是 opacity-0，高度可以
 * 直接量（opacity 不影响布局），所以 mouseenter 时拿浮层实高 + 胶囊
 * viewport 坐标做一次实测：上方放不下就翻到胶囊下方展开。只在进入时
 * 判一次——hover 期间不追（滚动会先断 hover，无需响应式）。
 */
const HOVER_CARD_TOP_SAFE_PX = 54 // ChatHeader 46px + 8px 呼吸位

function useHoverCardFlip(): {
  flipBelow: boolean
  popRef: React.RefObject<HTMLDivElement | null>
  onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => void
} {
  const popRef = useRef<HTMLDivElement | null>(null)
  const [flipBelow, setFlipBelow] = useState(false)
  const onMouseEnter = (e: React.MouseEvent<HTMLDivElement>): void => {
    const cardH = popRef.current?.offsetHeight ?? 0
    const capsuleTop = e.currentTarget.getBoundingClientRect().top
    setFlipBelow(capsuleTop - cardH < HOVER_CARD_TOP_SAFE_PX)
  }
  return { flipBelow, popRef, onMouseEnter }
}

/** 浮层容器类名（方向差分 + 共同部分）。间隙桥接用内边距不用外边距的
 *  原因见 SheetSelectionCard 内注释（外边距会瞬断 hover）。 */
function hoverCardWrapClass(flipBelow: boolean): string {
  return (
    'pointer-events-none absolute right-0 z-20 w-[400px] max-w-[72vw] opacity-0 transition-opacity duration-150 group-hover/selcard:pointer-events-auto group-hover/selcard:opacity-100 ' +
    (flipBelow ? 'top-full pt-2' : 'bottom-full pb-2')
  )
}

/**
 * 表格选区消息(替代绿气泡)。默认收起为「💬 1 条注释」小胶囊,鼠标
 * 移入在上方浮出完整卡片:Excel 徽章 + 文件名(点击重开预览)、
 * 「范围:工作表!A1:B2」、用户的问题——观感对齐文档类应用的注释交互
 * (2026-07-08 用户给的 WPS 风格参照)。
 */
function SheetSelectionCard({
  meta
}: {
  meta: SheetSelectionMeta
}): React.JSX.Element {
  const t = useT()
  const { flipBelow, popRef, onMouseEnter } = useHoverCardFlip()
  return (
    <div className="group/selcard relative" onMouseEnter={onMouseEnter}>
      {/* 收起态胶囊。hover 反馈只提边框,展开动作由浮层自己接管。 */}
      <div className="flex cursor-default items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-[13.5px] font-medium text-foreground shadow-sm transition-colors group-hover/selcard:border-input">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-muted-foreground"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M8 9h8M8 13h5" />
        </svg>
        {t('sheetSelectionPill')}
      </div>
      {/* hover 浮层:pill 上方右对齐展开(顶部空间不足时翻到下方,见
          useHoverCardFlip)。opacity 过渡 + hover 时才接管指针(文件名可
          点击重开预览);离开即收。
          pill 与卡片间的 8px 间隙用容器的 pb-2/pt-2 透明内边距桥接(不是
          外边距)——外边距不在 group 的命中盒里,鼠标穿过缝隙会瞬断 hover
          致卡片抖没(2026-07-08 用户反馈「hover 不上去」)。内边距仍属容器,
          指针全程不脱离 .group/selcard。 */}
      <div ref={popRef} className={hoverCardWrapClass(flipBelow)}>
        <div
          data-selectable="true"
          className="overflow-hidden rounded-2xl border border-border bg-card text-left shadow-[0_2px_6px_rgba(0,0,0,0.06),0_16px_40px_-16px_rgba(0,0,0,0.35)]"
        >
          <div className="px-4 pt-3">
            <button
              type="button"
              disabled={!meta.path}
              onClick={() => {
                if (meta.path) {
                  useSheetPreviewStore.getState().openPreview(meta.path)
                }
              }}
              title={meta.path || undefined}
              className="group/file flex max-w-full items-center gap-2 text-left"
            >
              <span
                aria-hidden
                className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-[#217346] text-[10px] font-bold text-white"
              >
                X
              </span>
              <span className="truncate text-[13.5px] font-medium text-accent group-hover/file:underline">
                {meta.name}
              </span>
            </button>
            <div className="pt-1.5 text-[12.5px] text-muted-foreground">
              {t('sheetSelectionRange')}
              {meta.sheet ? `${meta.sheet}!` : ''}
              {meta.range}
            </div>
          </div>
          {meta.q ? (
            <div className="whitespace-pre-wrap break-words px-4 pb-3 pt-2 text-[14px] leading-[1.5] text-foreground">
              {meta.q}
            </div>
          ) : (
            <div className="pb-3" />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 图片标记编辑消息（替代绿气泡）。结构照抄 SheetSelectionCard：收起为
 * 「🖼 N 处图片修改」胶囊，hover 浮出完整卡片——图片名（点击重开编辑
 * 面板）+ 逐条标记描述 + 额外要求 + 融合素材计数。间隙桥接用 pb-2 内
 * 边距的原因见 SheetSelectionCard 内注释（外边距会瞬断 hover）。
 */
function ImageEditCard({ meta }: { meta: ImageEditMeta }): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  const editCount = meta.edits.length + (meta.extra ? 1 : 0)
  const { flipBelow, popRef, onMouseEnter } = useHoverCardFlip()
  return (
    <div className="group/selcard relative" onMouseEnter={onMouseEnter}>
      <div className="flex cursor-default items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-[13.5px] font-medium text-foreground shadow-sm transition-colors group-hover/selcard:border-input">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-muted-foreground"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        {zh ? `${editCount} 处图片修改` : `${editCount} image edits`}
      </div>
      <div ref={popRef} className={hoverCardWrapClass(flipBelow)}>
        <div
          data-selectable="true"
          className="overflow-hidden rounded-2xl border border-border bg-card text-left shadow-[0_2px_6px_rgba(0,0,0,0.06),0_16px_40px_-16px_rgba(0,0,0,0.35)]"
        >
          <div className="px-4 pt-3">
            <button
              type="button"
              disabled={!meta.path}
              onClick={() => {
                if (meta.path) {
                  useImageEditStore.getState().openEditor(meta.path)
                }
              }}
              title={meta.path || undefined}
              className="group/file flex max-w-full items-center gap-2 text-left"
            >
              <span
                aria-hidden
                className="grid size-5 shrink-0 place-items-center rounded-[5px] border border-border bg-background"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                  className="text-muted-foreground"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              </span>
              <span className="truncate text-[13.5px] font-medium text-accent group-hover/file:underline">
                {meta.name}
              </span>
            </button>
          </div>
          <div className="px-4 pb-3 pt-2 text-[14px] leading-[1.6] text-foreground">
            {meta.edits.map((e, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 font-semibold tabular-nums">
                  {i + 1}.
                </span>
                <span className="min-w-0 break-words">{e.note}</span>
              </div>
            ))}
            {meta.extra ? (
              <div className="flex gap-2">
                <span className="shrink-0 font-semibold">＋</span>
                <span className="min-w-0 break-words">{meta.extra}</span>
              </div>
            ) : null}
            {meta.fusion.length > 0 ? (
              <div className="pt-1 text-[12.5px] text-muted-foreground">
                {zh
                  ? `融合素材 ${meta.fusion.length} 张`
                  : `${meta.fusion.length} fusion image(s)`}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the user bubble's text, turning `@"/abs/path"` / `@/abs/path`
 * file mentions into inline chips (document glyph + file name) instead
 * of dumping the raw absolute path into the bubble.
 *
 * Why here and not upstream: the wire format sent to fusion-code MUST
 * stay `@"path"` (extractAtMentionedFiles parses it), and the chat
 * store keeps that verbatim text so a reload re-renders identically.
 * The chip is a pure *display* transform applied at render time — the
 * stored/sent string is untouched, exactly like the composer's own
 * mention chips (chipNodeView) are a view layer over the same text.
 *
 * Matching lives in lib/mentionDisplay.ts (FILE_MENTION_DISPLAY_RE)，与
 * ChatHeader / 侧栏标题的 condenseFileMentions 同一份规则：quoted 任意
 * 位置命中、bare 允许中文前缀零空格相邻（占位 pill 替换出的 chip 常紧贴
 * 中文），路径体在中文标点处截断（旧 `@\S+` 会把「：【说明…】」整段吞进
 * chip）。email 的 `user@host` 由 lookbehind 拒掉。
 */

function UserBubbleText({ text }: { text: string }): React.JSX.Element {
  // Split into alternating plain-text / mention segments. We keep the
  // leading-whitespace capture group so spacing around chips is faithful.
  const nodes: React.ReactNode[] = []
  let last = 0
  let key = 0

  // Leading skill command → friendly chip (icon + 「制作PPT」/「生成图片」),
  // mirroring the composer chip. Pure display transform: the stored/sent text
  // keeps the raw `/claude-desktop:…` verbatim. Only known skills (those in the
  // chip registry) get the treatment; other `/cmd` stays plain text.
  const slashMatch = LEADING_SLASH_COMMAND_RE.exec(text)
  const slashSkill = slashMatch ? findSkillChipSpec(slashMatch[1]!) : null
  if (slashMatch && slashSkill) {
    nodes.push(
      <span
        key={`sk-${key++}`}
        title={slashMatch[1]}
        // 底色/描边走中性 token 而不是半透明白：气泡自 2026-07-17 起是
        // `bg-muted` 中性底，白系 chip 在浅色主题下等于隐形。
        className="mr-0.5 inline-flex items-center gap-1 rounded-md bg-background px-1.5 py-0.5 align-baseline text-[13px] font-medium ring-1 ring-border"
      >
        <SkillChipIcon src={slashSkill.image} size={12} />
        <span>{slashSkill.label}</span>
      </span>
    )
    // Skip past the command token (keep the separating space as plain text).
    last = slashMatch[1]!.length
  }

  let m: RegExpExecArray | null
  FILE_MENTION_DISPLAY_RE.lastIndex = last
  while ((m = FILE_MENTION_DISPLAY_RE.exec(text)) !== null) {
    const token = m[0]
    const tokenStart = m.index
    // Plain text before this mention.
    if (tokenStart > last) {
      nodes.push(text.slice(last, tokenStart))
    }
    const path = mentionInnerToPath(m[1]!)
    nodes.push(
      <span
        key={`fm-${key++}`}
        title={path}
        // 中性 token 而非半透明白，同上面的技能 chip。
        className="mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-md bg-background px-1.5 py-0.5 align-baseline text-[13px] font-medium ring-1 ring-border"
      >
        {/* Per-type glyph, kept un-coloured: 一行文字里嵌三四个各带类型色的
            小图标会比文字本身还吵，chip 的职责是「这是个文件」而不是「这是
            哪类文件」。 */}
        <FileTypeIcon
          pathOrName={path}
          size={12}
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate">{basenameOf(path)}</span>
      </span>
    )
    last = tokenStart + token.length
  }
  if (last < text.length) {
    nodes.push(text.slice(last))
  }
  // No mentions → render the string as-is (keeps the common path cheap).
  if (nodes.length === 0) return <>{text}</>
  return <>{nodes}</>
}

/**
 * Render a user-attached image as a thumbnail chip above the message
 * bubble. `image` is the data URL that flowed through:
 *   paste → imageAttachmentAdapter.send → ImageMessagePart.image
 *         → AppendMessage → chat store.appendUserMessage → here
 *
 * We cap the thumbnail at 220×220 (object-cover crops overflow); clicking
 * it opens an in-app lightbox modal — ESC or backdrop click dismisses.
 */
function UserImagePart({
  image,
  filename
}: {
  image: string
  filename?: string
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const altText = filename ?? t('imageAttachedAlt')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-block max-w-[80%] cursor-zoom-in overflow-hidden rounded-xl border border-input bg-card/70 transition hover:border-input"
        title={altText}
      >
        <img
          src={image}
          alt={altText}
          className="max-h-[220px] max-w-full object-cover"
        />
      </button>
      {/* Portal the lightbox into document.body so `position: fixed`
          covers the entire window, not just the ThreadView column.
          Ancestors in the message tree (motion wrappers, assistant-ui
          Viewport) set `transform` / `will-change` which turns them
          into containing blocks for fixed descendants, causing the
          modal to visually clip to the chat column. Portaling escapes
          that chain entirely. */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={filename ?? t('imagePreviewAria')}
              // `WebkitAppRegion: no-drag` on the outer wrapper — the
              // root layout's `.window-drag-strip` keeps the window's
              // top 46px a native drag zone (screen coordinates, not
              // DOM). Without a `no-drag` override on the modal, that
              // strip (overlapping the lightbox top) would swallow
              // clicks there (backdrop dismiss, image click, close
              // button top half) into a window drag. `no-drag`
              // inherits through the subtree so every interactive
              // element in the lightbox is click-safe.
              //
              // No onClick here — dismiss-on-backdrop lives on the blur
              // layer below so the close button's click has a clean
              // path and doesn't need to fight with this wrapper.
              style={
                { WebkitAppRegion: 'no-drag' } as React.CSSProperties
              }
              className="fixed inset-0 z-[100] flex items-center justify-center"
            >
              {/* Blur layer — owns the backdrop dismiss. Static
                  backdrop-filter isolated in its own layer so Chromium
                  doesn't re-run the blur on every frame of the opacity
                  tween (backdrop-filter + animated opacity is the #1
                  cause of laggy modal transitions in Electron).
                  Entry and exit share the same tween duration with
                  entry using easeOutExpo (snappy start, soft stop)
                  and exit using easeInOutQuad (gentle both ends) so
                  the close doesn't feel like it's been yanked away. */}
              <motion.div
                aria-hidden
                onClick={() => setOpen(false)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.28,
                  ease: [0.22, 1, 0.36, 1]
                }}
                style={{ willChange: 'opacity' }}
                className="absolute inset-0 z-0 bg-background/78 backdrop-blur-lg"
              />

              {/* Image wrapper. `z-10` sits above the blur layer; the
                  motion element creates its own stacking context via
                  `willChange: transform` anyway, but the explicit z
                  makes hit-test order unambiguous. Tween with
                  cubic-bezier easeOutExpo — snappier and more
                  predictable than the old bouncy spring. Exit uses a
                  gentler scale-down (0.94, matching the entry) so the
                  reverse motion reads as a true inverse instead of
                  snapping shut. */}
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{
                  opacity: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
                  scale: { duration: 0.36, ease: [0.22, 1, 0.36, 1] }
                }}
                style={{ willChange: 'transform, opacity' }}
                className="relative z-10 flex max-h-[85vh] max-w-[90vw] flex-col items-center transform-gpu"
              >
                <img
                  src={image}
                  alt={altText}
                  onClick={() => setOpen(false)}
                  draggable={false}
                  className="max-h-[85vh] max-w-[90vw] cursor-zoom-out rounded-xl object-contain shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/10"
                />
                {/* Filename caption pill. Only shown when we actually
                    know the name — pasted clipboard images have none. */}
                {filename && (
                  <div className="mt-3 max-w-full truncate rounded-full border border-border/60 bg-card/80 px-3 py-1 font-mono text-[11px] text-muted-foreground">
                    {filename}
                  </div>
                )}
              </motion.div>

              {/* Close button — `motion.button` with **opacity-only**
                  animation. No `scale` / `y` / `rotate`: those would
                  introduce a transform layer and re-trigger the
                  earlier hit-test bug where the button's top half was
                  unclickable (will-change: transform + the image
                  wrapper's transform-gpu layer made Chromium's
                  cross-layer hit-test non-deterministic). Pure
                  opacity fades don't create a transform containing
                  block, so the hit rect stays exactly the layout box.
                  Hit target: `p-2.5` extends the clickable region to
                  60×60 while the visible 40×40 pill is an inner span.
                  `WebkitAppRegion: no-drag` is inherited from the
                  parent wrapper but spelled out here defensively —
                  the app header's drag region would otherwise swallow
                  clicks on the top half of the button. */}
              <motion.button
                type="button"
                // data-slot：portal 到 body、脱离 .chat-app 豁免子树，防
                // canvas 裸 button reset 泄漏（同文件上方全文弹窗同款）。
                data-slot="modal-action"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                }}
                aria-label={t('imagePreviewClose')}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.28,
                  ease: [0.22, 1, 0.36, 1]
                }}
                style={
                  {
                    WebkitAppRegion: 'no-drag',
                    willChange: 'opacity'
                  } as React.CSSProperties
                }
                className="group/close fixed right-4 top-4 z-50 flex items-center justify-center p-2.5"
              >
                <span
                  aria-hidden
                  className="flex size-10 items-center justify-center rounded-full border border-border/70 bg-background/90 text-foreground shadow-lg transition-colors group-hover/close:border-input group-hover/close:bg-hover"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
              </motion.button>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
