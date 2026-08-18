/**
 * 空态 composer 下方的「最佳实践案例」区（原型：WorkBuddy 空态，2026-08-17；
 * 2026-08-18 改版：横向滑动大卡 + 共享布局过渡）。
 *
 * 通用组件：**不知道任何具体技能**。它只做三件事——
 *   1. 从 composer.text 派生「当前选中的技能」（与 ScenarioRail 同一真源、同一
 *      正则 LEADING_SLASH_COMMAND_RE：以 slash 命令开头即视为选中该技能）；
 *   2. 从 stores/scenarioCases 里按裸名取出该技能的案例（后台「客户端技能案例」
 *      页配置，无案例的技能整块不渲染）；
 *   3. 一条横向滑动的封面卡（封面 16:9 + 下方标题/一句说明）+ 右上角 ‹ › 翻屏 +
 *      hover 露出「查看 →」+ 点卡片，都弹详情（大图 / 缩略图点选 /
 *      说明 / 「用这个提示词试试」→ onFillPrompt 走推荐 prompt 的同一条 fillBody
 *      通道）。
 *
 * 所以后台给任何技能配了案例，这里就自动出现，不用改客户端代码。
 *
 * 只在「刚选完技能、正文还空着」时显示（bodyAfterChip === ''）——与 ScenarioRail
 * 的推荐 prompt 行同一判定：正文有了内容，案例的使命（帮忙起草）就完成了，继续
 * 占着 composer 下面一整排会挤掉用户正在看的东西。
 *
 * ── 动效为什么这么做 ──
 * 卡片封面与详情弹窗里的大图共用同一个 `layoutId`（Motion 的共享布局动画：
 * 同一 id 的元素在两处之间自动 FLIP 过去）。点开时封面从卡片位置「长大」到
 * 弹窗里，关闭时缩回卡片——比凭空弹出多一层「我点的就是它」的连贯感。为了不
 * 让 FLIP 的测量被 CSS 动画干扰，这里**不用**共享的 DialogContent 基件（它带
 * zoom-in-96 的 tailwind 动画），而是直接用 radix-ui 的 Dialog 原语 +
 * `forceMount` 交给 AnimatePresence 管开合，面板本身只做透明度淡入。
 * 弹窗面板与封面容器都不做 scale 变换——祖先的非 layout transform 会让子级
 * 的投影算偏。
 *
 * 图片一律 `<img src=URL>` 直连（服务端与 main 侧都只放行 http/https）；加载失败
 * 的封面退化成纯色底，不显示破图。
 */
'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { XIcon } from 'lucide-react'
import type { ScenarioCase } from '@desktop-shared/ipc-channels'

import { Button } from '@/src/components/ui/button'
import { GLASS_DIALOG_SURFACE } from '@/src/components/ui/glassDialogSurface'
import { cn } from '@/src/lib/utils'

import { useT } from '../../../i18n'
import { useSkillCases } from './useSkillCases'

export interface SkillCaseShowcaseProps {
  /** 把案例的 prompt 填进 composer 正文（保留 leading chip）。 */
  onFillPrompt: (text: string) => void
}

/** 卡片宽度（px）。封面 16:9 → 高 ~118px，加两行文字 ~40px，整块约 180px 高。 */
const CARD_WIDTH = 210
/** 卡片间距（px），与 tailwind gap-3 一致。 */
const CARD_GAP = 12

/** 整块进出场的节奏：与 ThreadView EmptyState 的 COMPACT_TRANSITION 同一份数值。 */
const SHOWCASE_TRANSITION = { type: 'spring', bounce: 0.1, visualDuration: 0.34 } as const

/** 封面共享布局 id：卡片 ↔ 详情弹窗大图。 */
function coverLayoutId(id: string): string {
  return `skill-case-cover:${id}`
}

export function SkillCaseShowcase({ onFillPrompt }: SkillCaseShowcaseProps): React.JSX.Element | null {
  const t = useT()
  const { skillValue, cases, visible } = useSkillCases()
  const [active, setActive] = useState<ScenarioCase | null>(null)

  // 高度预算：这一块必须和 hero 标题、rail、composer 一起在 800px 高的窗口里
  // 不滚动放下（用户硬要求，2026-08-17）。EmptyState 在案例可见时切紧凑模式
  // （useSkillCases().visible 同一判定），这里则压紧上边距。
  //
  // 进出场：不是 visible 就 return null（那样退场是瞬间消失），而是交给
  // AnimatePresence——高度 0 ↔ auto + 淡入淡出，与 EmptyState 大标题的收放
  // 同一节奏，整页看起来是「上面收、下面长」的一次连续位移。
  return (
    <>
      <AnimatePresence initial={false}>
        {visible ? (
          <motion.div
            key="showcase"
            data-testid="skill-case-showcase"
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SHOWCASE_TRANSITION}
          >
            <div className="pt-5">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={skillValue}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  <CaseStrip
                    cases={cases}
                    title={t('skillCaseTitle')}
                    onOpen={setActive}
                  />
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <CaseDetailDialog
        item={active}
        onClose={() => setActive(null)}
        onUsePrompt={(text) => {
          onFillPrompt(text)
          setActive(null)
        }}
      />
    </>
  )
}

/* ───────────────────────── 横向滑动条 ───────────────────────── */

function CaseStrip({
  cases,
  title,
  onOpen
}: {
  cases: readonly ScenarioCase[]
  title: string
  onOpen: (c: ScenarioCase) => void
}): React.JSX.Element {
  const t = useT()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canPrev, setCanPrev] = useState(false)
  const [canNext, setCanNext] = useState(false)

  // 两端到头判定：驱动 ‹ › 的可用态与右侧渐隐遮罩。滚动、尺寸变化、案例数变化
  // 都要重算。
  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setCanPrev(el.scrollLeft > 1)
    setCanNext(el.scrollLeft < max - 1)
  }, [])

  useLayoutEffect(() => {
    measure()
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, cases])

  const scrollByPage = (dir: 1 | -1) => {
    const el = scrollerRef.current
    if (!el) return
    // 一次翻「一屏能完整放下的整数张」，目标位置对齐到卡片左边（两头夹住）。
    // 不用 CSS scroll-snap：mandatory 吸附会让最后一屏永远停在「差几像素到底」
    // 的上一个吸附点，最后一张右边被切、› 也灰不下来（Chromium 实测）；触控板
    // 自由滑动本来也不需要吸附。
    const step = CARD_WIDTH + CARD_GAP
    const perPage = Math.max(1, Math.floor((el.clientWidth + CARD_GAP) / step))
    const max = el.scrollWidth - el.clientWidth
    const idx = Math.round(el.scrollLeft / step) + dir * perPage
    let left = Math.min(Math.max(idx * step, 0), max)
    // 离两头不足一张时直接贴边：否则最后一张可能只差几像素露不全、› 灰不下来。
    if (max - left < step) left = max
    if (left < step) left = 0
    el.scrollTo({ left, behavior: 'smooth' })
  }

  const arrowCls =
    'grid size-6 place-items-center p-0 rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-30'

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 px-0.5">
        <span className="text-[13px] text-foreground/80">{title}</span>
        {canPrev || canNext ? (
          <div className="flex items-center gap-0.5">
            <button type="button" aria-label={t('skillCasePrev')} className={arrowCls} disabled={!canPrev} onClick={() => scrollByPage(-1)}>
              <ChevronIcon dir="left" />
            </button>
            <button type="button" aria-label={t('skillCaseNext')} className={arrowCls} disabled={!canNext} onClick={() => scrollByPage(1)}>
              <ChevronIcon dir="right" />
            </button>
          </div>
        ) : null}
      </div>

      {/*
        滚动容器：横向自由滑动，隐藏滚动条（触控板照样能滑）。右侧到头前用
        mask 渐隐提示「还有」，到头就撤掉遮罩，最后一张完整露出。
        上下留 4px 内边距，给 focus ring 一点空间不被 overflow 裁掉。
        `layoutScroll`：告诉 Motion 这个容器会滚，共享布局测量封面位置时要把
        scrollLeft 算进去，否则滑过之后再点开，大图会从错位的地方起飞。
      */}
      <motion.div
        layoutScroll
        ref={scrollerRef}
        data-testid="skill-case-strip"
        onScroll={measure}
        className={cn(
          'flex gap-3 overflow-x-auto overflow-y-hidden py-1',
          canNext && '[mask-image:linear-gradient(to_right,black_calc(100%-56px),transparent)]'
        )}
        // 隐藏滚动条走内联样式而不是 `[scrollbar-width:none]` 工具类：main.css 里
        // 有一条不分层的 `* { scrollbar-width: thin }`，按 CSS 分层规则它压过所有
        // @layer utilities 里的类（实测 CDP 里 computed 仍是 thin，滑动时会露一条
        // 细滚动条）。内联样式的优先级最高，能赢。
        style={{ scrollbarWidth: 'none' }}
      >
        {cases.map((c) => (
          <CaseCard
            key={c.id}
            item={c}
            onOpen={() => onOpen(c)}
            openLabel={t('skillCaseOpen')}
            viewLabel={t('skillCaseView')}
          />
        ))}
      </motion.div>
    </div>
  )
}

function ChevronIcon({ dir }: { dir: 'left' | 'right' }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {dir === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
    </svg>
  )
}

/* ───────────────────────── 卡片 ───────────────────────── */

function CaseCard({
  item,
  onOpen,
  openLabel,
  viewLabel
}: {
  item: ScenarioCase
  onOpen: () => void
  openLabel: string
  viewLabel: string
}): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  // 说明只取第一行：卡片下方只有一行的位置，多行说明留给详情弹窗。
  const blurb = item.description?.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''

  // 结构说明：整卡的点击热区是一个铺满的 <button>（不能把「查看」按钮嵌进去——
  // button 套 button 不合法），「查看」是另一个绝对定位在封面右下角、层级更高
  // 的 <button>。封面容器挂 layoutId，供详情弹窗共享。
  return (
    <div
      className="group relative shrink-0"
      style={{ width: CARD_WIDTH }}
    >
      <motion.div
        layoutId={coverLayoutId(item.id)}
        className="relative aspect-video overflow-hidden rounded-[10px] border border-border/50 bg-muted"
      >
        {!broken ? (
          <img
            src={item.cover}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
          />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_20%_0%,hsl(var(--accent)/0.18),transparent_60%)]" />
        )}
      </motion.div>

      <div className="h-[40px] px-0.5 pt-1.5">
        <div className="truncate text-[12.5px] font-semibold leading-[18px] text-foreground/90 transition-colors group-hover:text-foreground">
          {item.title}
        </div>
        {blurb ? (
          <div className="truncate text-[11.5px] leading-[16px] text-muted-foreground">{blurb}</div>
        ) : null}
      </div>

      {/* 整卡热区：点开详情 */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${openLabel}: ${item.title}`}
        className="absolute inset-0 z-[1] rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[hsl(var(--accent))]"
      />

      {/*
        hover / 键盘聚焦时露出的「查看 →」：和整卡热区一样打开详情弹窗，只是给
        一个明确的可点提示。「用这个提示词试试」留在详情弹窗里——先看清案例再决定
        要不要套用，不在封面上直接改写输入框。
        用 tabIndex=-1 + aria-hidden：功能与整卡热区完全相同，不重复占一个 Tab 停靠点。
      */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={onOpen}
        className="absolute right-2 z-[2] inline-flex translate-y-1 items-center gap-1 rounded-full bg-white/92 px-2.5 py-1 text-[11.5px] font-medium text-neutral-900 opacity-0 shadow-[0_2px_10px_rgba(0,0,0,0.18)] backdrop-blur-sm transition-[opacity,transform,background-color] duration-200 ease-out hover:bg-white group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
        style={{ bottom: 40 + 8 }}
      >
        {viewLabel}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14" />
          <path d="m13 6 6 6-6 6" />
        </svg>
      </button>
    </div>
  )
}

/* ───────────────────────── 详情弹窗 ───────────────────────── */

function CaseDetailDialog({
  item,
  onClose,
  onUsePrompt
}: {
  item: ScenarioCase | null
  onClose: () => void
  onUsePrompt: (text: string) => void
}): React.JSX.Element {
  const t = useT()
  // 大图列表：详情图为空时退化成只看封面。
  const images = item ? (item.images.length > 0 ? item.images : [item.cover]) : []
  const [index, setIndex] = useState(0)
  // 轮播切换方向：1 = 往右翻（新图从右滑入），-1 = 往左翻。喂给 motion 的
  // custom，让进入/退出两张图各自知道该往哪边滑。
  const [dir, setDir] = useState<1 | -1>(1)
  // 用户一旦手动翻页 / 点缩略图，就停掉自动轮播——别跟人抢。
  const [autoplay, setAutoplay] = useState(true)
  // 鼠标悬在大图上时暂停自动轮播：人在看，别在眼皮底下换图。
  const [hovering, setHovering] = useState(false)
  useEffect(() => {
    setIndex(0)
    setDir(1)
    setAutoplay(true)
  }, [item?.id])
  const count = images.length
  const safeIndex = Math.min(index, Math.max(count - 1, 0))
  const current = images[safeIndex]

  // 跳到第 next 张（自动取模循环），并记下滑动方向；manual=true 表示是人操作的。
  const goTo = useCallback(
    (next: number, direction: 1 | -1, manual: boolean) => {
      if (count <= 1) return
      setDir(direction)
      setIndex(((next % count) + count) % count)
      if (manual) setAutoplay(false)
    },
    [count]
  )
  const step = useCallback(
    (delta: 1 | -1, manual: boolean) => goTo(safeIndex + delta, delta, manual),
    [goTo, safeIndex]
  )

  // 自动轮播：多图时每 4s 往右翻一张，悬停 / 手动操作过 / 单图 时不跑。
  useEffect(() => {
    if (!item || count <= 1 || !autoplay || hovering) return
    const timer = window.setInterval(() => step(1, false), 4000)
    return () => window.clearInterval(timer)
  }, [item, count, autoplay, hovering, step])

  // 键盘 ← → 翻页：弹窗开着时挂在 window 上（Radix Dialog 已把焦点圈在弹窗里）。
  useEffect(() => {
    if (!item || count <= 1) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        step(1, true)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        step(-1, true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, count, step])

  const navBtnCls =
    'pointer-events-auto grid size-8 place-items-center p-0 rounded-full bg-black/45 text-white shadow-[0_2px_10px_rgba(0,0,0,0.25)] backdrop-blur-sm transition-[opacity,background-color] duration-150 hover:bg-black/60 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white/80'

  return (
    <DialogPrimitive.Root
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {/*
        forceMount + AnimatePresence：Radix 自己在 open=false 时会立刻卸载，
        退出动画（大图缩回卡片、暗幕淡出）就播不出来；forceMount 把卸载权交给
        AnimatePresence（等 exit 动画完再卸）。这是 Motion 官方推荐的 Radix 接法。
      */}
      <AnimatePresence>
        {item ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              />
            </DialogPrimitive.Overlay>
            {/* 居中用 flex 而不是 translate(-50%,-50%)：祖先带 transform 会让共享
                布局的投影算偏。这层不吃鼠标，只有面板本身吃。 */}
            <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6">
              <DialogPrimitive.Content asChild forceMount>
                <motion.div
                  className={cn(
                    GLASS_DIALOG_SURFACE,
                    'pointer-events-auto relative flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden p-6 outline-none sm:max-w-[720px]'
                  )}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.14 } }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  {/*
                    限高 + 内滚：说明和提示词是运营配的自由文本，长度不可控，不限高时
                    弹窗会比窗口还高、底部按钮被顶出屏幕。中间内容区 min-h-0 +
                    overflow-y-auto 吃掉多余高度，「用这个提示词试试」始终露在底部。
                  */}
                  <div className="-mr-2 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2">
                    <div className="flex flex-col gap-1.5 pr-8">
                      <DialogPrimitive.Title className="text-[19px] font-semibold leading-tight">
                        {item.title}
                      </DialogPrimitive.Title>
                      {item.description ? (
                        <DialogPrimitive.Description className="whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">
                          {item.description}
                        </DialogPrimitive.Description>
                      ) : (
                        <DialogPrimitive.Description className="sr-only">{item.title}</DialogPrimitive.Description>
                      )}
                    </div>

                    {/* 大图：与卡片封面共享 layoutId，开合时在两处之间飞 */}
                    <motion.div
                      layoutId={coverLayoutId(item.id)}
                      className="group/carousel relative shrink-0 overflow-hidden rounded-xl border border-border/60 bg-muted"
                      onMouseEnter={() => setHovering(true)}
                      onMouseLeave={() => setHovering(false)}
                    >
                      {/*
                        轮播：进入的图从翻页方向滑入、退出的图往反方向滑出，两张同时
                        在场（popLayout 让退出的那张脱离文档流叠在上面），配合淡入淡出。
                        `custom={dir}` 让 variants 拿到方向；AnimatePresence 也要传
                        custom，否则退出中的那张读到的是旧方向。
                      */}
                      <div className="aspect-video w-full">
                        {current ? (
                          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                            <motion.img
                              key={current + safeIndex}
                              src={current}
                              alt=""
                              draggable={false}
                              className="h-full w-full object-cover"
                              custom={dir}
                              variants={{
                                enter: (d: 1 | -1) => ({ x: `${d * 28}%`, opacity: 0 }),
                                center: { x: 0, opacity: 1 },
                                exit: (d: 1 | -1) => ({ x: `${d * -28}%`, opacity: 0 })
                              }}
                              initial="enter"
                              animate="center"
                              exit="exit"
                              transition={{ x: { duration: 0.32, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.22 } }}
                            />
                          </AnimatePresence>
                        ) : null}
                      </div>

                      {count > 1 ? (
                        <>
                          {/* ‹ ›：默认淡淡的，悬停大图时完全显现；键盘聚焦到按钮上也显现 */}
                          <div className="pointer-events-none absolute inset-y-0 left-2 right-2 flex items-center justify-between opacity-60 transition-opacity duration-150 group-hover/carousel:opacity-100 has-[:focus-visible]:opacity-100">
                            <button type="button" aria-label={t('skillCasePrev')} className={navBtnCls} onClick={() => step(-1, true)}>
                              <ChevronIcon dir="left" />
                            </button>
                            <button type="button" aria-label={t('skillCaseNext')} className={navBtnCls} onClick={() => step(1, true)}>
                              <ChevronIcon dir="right" />
                            </button>
                          </div>
                          {/* 页码 */}
                          <div className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/90 backdrop-blur-sm">
                            {safeIndex + 1} / {count}
                          </div>
                        </>
                      ) : null}
                    </motion.div>

                    {/* 多图：一排缩略图点选（替代原来的 ‹ › 盲翻） */}
                    {images.length > 1 ? (
                      <div className="-mt-1 flex shrink-0 gap-2 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {images.map((src, i) => (
                          <button
                            key={src + i}
                            type="button"
                            aria-label={`${i + 1} / ${images.length}`}
                            aria-current={i === safeIndex}
                            onClick={() => goTo(i, i >= safeIndex ? 1 : -1, true)}
                            className={cn(
                              'relative aspect-video w-[72px] shrink-0 overflow-hidden rounded-md border bg-muted transition-[opacity,box-shadow,border-color] duration-150',
                              i === safeIndex
                                ? 'border-[hsl(var(--accent))] shadow-[0_0_0_2px_hsl(var(--accent)/0.25)]'
                                : 'border-border/60 opacity-60 hover:opacity-100'
                            )}
                          >
                            <img src={src} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
                          </button>
                        ))}
                      </div>
                    ) : null}

                    {/* 提示词预览 */}
                    <div className="shrink-0 rounded-xl bg-foreground/[0.04] px-3.5 py-3 dark:bg-white/[0.05]">
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t('skillCasePromptLabel')}
                      </div>
                      <div className="line-clamp-4 whitespace-pre-line text-[13px] leading-relaxed text-foreground/90">
                        {item.prompt}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex justify-end">
                    <Button type="button" onClick={() => onUsePrompt(item.prompt)}>
                      {t('skillCaseUsePrompt')}
                    </Button>
                  </div>

                  <DialogPrimitive.Close asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-3 top-3 size-8 rounded-full text-muted-foreground"
                    >
                      <XIcon className="size-4" />
                      <span className="sr-only">Close</span>
                    </Button>
                  </DialogPrimitive.Close>
                </motion.div>
              </DialogPrimitive.Content>
            </div>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}
