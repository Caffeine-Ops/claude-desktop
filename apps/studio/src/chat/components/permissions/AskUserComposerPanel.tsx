import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react'

import type { PermissionRequest } from '@desktop-shared/types'
import { identifyProposalStageConfirm } from '@desktop-shared/proposal'
import { Input } from '@/src/components/ui/input'
import { useI18n, type Lang } from '../../i18n'
import { applyProposalStageConfirm } from '../../lib/proposalStageConfirm'
import { usePermissionStore } from '../../stores/permissions'
import { parseQuestions, seedAnswers } from './AskUserQuestionView'

/**
 * AskUserQuestion 的 composer 位提问面板（2026-07-16 形态迁移，原型
 * docs/ui-prototype-askuser-above-composer.html）。
 *
 * 迁移背景：此前 AskUserQuestion 渲染为消息流 tool card 里的内联问卷
 * （InlinePermissionPrompt，已删除）——问卷常随流滚出视野，用户盯着
 * composer 等回复却看不到问题。现在提问到达时 **composer 输入卡整个变形
 * 为本面板**（AskComposerSwap 负责 morph），答完变回来：提问期间不存在
 * 输入框，自由回答走面板内的「其他」行——这正是「提问 = 本轮唯一要的
 * 输入」的语义。消息流侧的 tool card 只留一行等待锚点指到这里。
 *
 * 样式参考 ChatGPT 的问答卡：单行紧凑选项（圈号 + 粗标签 + 描述同行
 * 截断）、高亮项浅底带 →、底部「其他」自由输入 + 跳过。保住既有能力：
 * 多题分页（‹ n/N › 可回看改答案）、数字直选/↑↓/Enter/⌫/Esc 键盘、
 * proposal 阶段确认的说明行与 applyProposalStageConfirm 前置推进
 * （从 InlinePermissionPrompt 原样搬入）。
 *
 * 跳过语义（新增，对齐参考）：跳过 = 该题不作答继续；全部题处理完
 * （答或跳）即提交已答部分——answers Record 本就允许缺题。Esc 维持
 * 「取消整个提问」（deny），与右上角 × 一致，不改现有肌肉记忆。
 *
 * 数据解析复用 AskUserQuestionView 的 parseQuestions / seedAnswers
 * （那是解析契约的唯一实现；该组件本体仍服务 slides 会话的 canvas
 * 问题 tab，两个渲染面共享一份解析器）。
 */

function pick(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

/** 题间滑动：方向感变体（前进从右进、后退从左进）。 */
const qVariants = {
  enter: (dir: number) => ({ opacity: 0, x: 20 * dir }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: -20 * dir })
}
const Q_SPRING = { type: 'spring', bounce: 0, visualDuration: 0.28 } as const

type Props = { request: PermissionRequest }

export function AskUserComposerPanel({ request }: Props): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const respond = usePermissionStore((s) => s.respond)
  const questions = useMemo(() => parseQuestions(request.input), [request.input])
  const stage = identifyProposalStageConfirm(request.input)

  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    seedAnswers(request.input)
  )
  // 「处理过」集合（答 or 跳都算）：全部处理完才提交。answers 缺题即跳过。
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set())
  const [qIndex, setQIndex] = useState(0)
  const [dir, setDir] = useState(1)
  const [highlight, setHighlight] = useState(0)
  const [otherEditing, setOtherEditing] = useState(false)
  const [otherDrafts, setOtherDrafts] = useState<Record<string, string>>({})
  const otherInputRef = useRef<HTMLInputElement | null>(null)
  // pick 的「一拍选中反馈」定时器；卸载/换题时清，防迟到 advance。
  const advanceTimerRef = useRef<number | null>(null)

  const current = questions[qIndex] ?? null
  const total = questions.length
  const otherIndex = current ? current.options.length : -1

  const clearAdvanceTimer = useCallback(() => {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
    }
  }, [])
  useEffect(() => clearAdvanceTimer, [clearAdvanceTimer])

  const goTo = useCallback((next: number, d: number) => {
    setDir(d)
    setQIndex(next)
    setHighlight(0)
    setOtherEditing(false)
  }, [])

  const submit = useCallback(
    (finalAnswers: Record<string, string>) => {
      // 按题目顺序重建 Record，assistant 读 tool_result 时顺序稳定。
      const out: Record<string, string> = {}
      for (const q of questions) {
        const a = finalAnswers[q.question]
        if (a) out[q.question] = a
      }
      // 方案模式：目录/封面确认先同步推进 phase（先于 AI 回包的 end 过
      // 阶段门），再回传答案——从 InlinePermissionPrompt 原样搬入。
      applyProposalStageConfirm(request.input, out)
      void respond(request.requestId, 'allow-once', { answers: out })
    },
    [questions, request, respond]
  )

  /** 当前题处理完（答/跳）后：跳最近的未处理题；没有了就提交。 */
  const advance = useCallback(
    (nextAnswers: Record<string, string>, nextHandled: ReadonlySet<string>) => {
      let target = -1
      for (let i = qIndex + 1; i < questions.length; i++) {
        if (!nextHandled.has(questions[i]!.question)) { target = i; break }
      }
      if (target < 0) {
        for (let i = 0; i < questions.length; i++) {
          if (!nextHandled.has(questions[i]!.question)) { target = i; break }
        }
      }
      if (target < 0) { submit(nextAnswers); return }
      goTo(target, target > qIndex ? 1 : -1)
    },
    [qIndex, questions, submit, goTo]
  )

  const commit = useCallback(
    (label: string | null) => {
      if (!current) return
      const nextAnswers = { ...answers }
      if (label) nextAnswers[current.question] = label
      else delete nextAnswers[current.question]
      const nextHandled = new Set(handled)
      nextHandled.add(current.question)
      setAnswers(nextAnswers)
      setHandled(nextHandled)
      // 一拍选中反馈再走（纯跳过不需要反馈拍，立即走）。
      clearAdvanceTimer()
      if (label) {
        advanceTimerRef.current = window.setTimeout(
          () => advance(nextAnswers, nextHandled),
          200
        )
      } else {
        advance(nextAnswers, nextHandled)
      }
    },
    [current, answers, handled, advance, clearAdvanceTimer]
  )

  const cancel = useCallback(() => {
    void respond(request.requestId, 'deny')
  }, [respond, request.requestId])

  // ── 键盘（面板在场即全局接管；Other 输入态旁路给输入框） ──────────
  useEffect(() => {
    if (!current) return
    const handler = (e: KeyboardEvent): void => {
      if (otherEditing) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setOtherEditing(false)
          otherInputRef.current?.blur()
        }
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); return }
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1
        if (n >= 0 && n < current.options.length) {
          e.preventDefault()
          setHighlight(n)
          commit(current.options[n]!.label)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => Math.min(h + 1, otherIndex))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (highlight === otherIndex) {
          setOtherEditing(true)
          setTimeout(() => otherInputRef.current?.focus(), 0)
          return
        }
        const label = current.options[highlight]?.label
        if (label) commit(label)
        return
      }
      if (e.key === 'Backspace' && qIndex > 0) {
        e.preventDefault()
        goTo(qIndex - 1, -1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [current, highlight, otherIndex, otherEditing, qIndex, commit, cancel, goTo])

  if (!current) {
    // 解析失败兜底：极简「继续 / 取消」，同 AskUserQuestionView 的降级观。
    return (
      <div className={PANEL_SHELL}>
        <div className="px-4 py-4 text-[14px] text-foreground">
          {pick(lang, 'Claude 想问你一个问题，但内容无法解析。', 'Claude has a question, but it could not be parsed.')}
        </div>
        <div className="flex gap-2 px-4 pb-4">
          <button type="button" onClick={() => submit({})} className={SKIP_BTN}>
            {pick(lang, '继续', 'Continue')}
          </button>
          <button type="button" onClick={cancel} className={SKIP_BTN}>
            {pick(lang, '取消', 'Cancel')}
          </button>
        </div>
      </div>
    )
  }

  const currentAnswer = answers[current.question]
  const draft = otherDrafts[current.question] ?? ''

  return (
    <div className={PANEL_SHELL} role="dialog" aria-label={current.question}>
      {/* 右上角：分页导航 + 取消。absolute 固定，不随题间滑动。 */}
      <div className="absolute right-3.5 top-3.5 z-10 flex items-center gap-0.5 text-muted-foreground">
        {total > 1 ? (
          <>
            <button
              type="button"
              className={NAV_BTN}
              disabled={qIndex === 0}
              onClick={() => goTo(qIndex - 1, -1)}
              aria-label={pick(lang, '上一题', 'Previous')}
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <span className="mx-1 text-[12.5px] tabular-nums">
              {qIndex + 1} / {total}
            </span>
            <button
              type="button"
              className={NAV_BTN}
              disabled={qIndex === total - 1}
              onClick={() => goTo(qIndex + 1, 1)}
              aria-label={pick(lang, '下一题', 'Next')}
            >
              <ChevronRight className="size-3.5" />
            </button>
          </>
        ) : null}
        <button type="button" className={NAV_BTN} onClick={cancel} aria-label={pick(lang, '取消提问', 'Cancel')}>
          <X className="size-3.5" />
        </button>
      </div>

      {/* 方案阶段确认说明行（从 InlinePermissionPrompt 搬入，语义不变）。 */}
      {stage ? (
        <div className="border-b border-black/[0.06] bg-brand/5 px-4 py-2 text-[12px] leading-snug text-muted-foreground dark:border-white/[0.06]">
          这是【{stage === 'cover' ? '封面确认' : '目录确认'}】。点“确认”后 AI 才会
          {stage === 'cover' ? '继续下一步：生成目录' : '开始逐章撰写正文'}。
        </div>
      ) : null}

      {/* 题面：问题 + 选项 + 底部行，整体随分页滑动。overflow-x-clip 防
          滑动位移横向露头；纵向不裁（无溢出内容）。 */}
      <div className="overflow-x-clip px-4 pb-2.5 pt-4">
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div
            key={qIndex}
            custom={dir}
            variants={qVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={Q_SPRING}
          >
            <div className="pr-24 text-[15.5px] font-semibold leading-[1.45] tracking-[-0.2px] text-foreground">
              {current.question}
            </div>

            <div className="mt-3 flex flex-col gap-0.5">
              {current.options.map((opt, i) => {
                const picked = currentAnswer === opt.label
                const hot = i === highlight && !otherEditing
                return (
                  <button
                    key={`${qIndex}-${i}`}
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => commit(opt.label)}
                    className={
                      'group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-100 ' +
                      (hot ? 'bg-muted/75' : 'hover:bg-muted/50')
                    }
                  >
                    <span
                      className={
                        'grid size-[26px] shrink-0 place-items-center rounded-full text-[12.5px] font-semibold tabular-nums transition-colors duration-100 ' +
                        (picked
                          ? 'bg-[hsl(var(--brand))] text-[hsl(var(--brand-foreground))]'
                          : 'bg-card text-muted-foreground shadow-[inset_0_0_0_1.2px_hsl(var(--border))]')
                      }
                    >
                      {picked ? '✓' : i + 1}
                    </span>
                    <span className="shrink-0 text-[14px] font-semibold text-foreground">
                      {opt.label}
                    </span>
                    {opt.description ? (
                      <span className="min-w-0 truncate text-[13.5px] text-muted-foreground">
                        {opt.description}
                      </span>
                    ) : null}
                    <span
                      aria-hidden
                      className={
                        'ml-auto shrink-0 text-muted-foreground transition-opacity duration-100 ' +
                        (hot ? 'opacity-80' : 'opacity-0')
                      }
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="size-[15px]">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    </span>
                  </button>
                )
              })}
            </div>

            {/* 底部：其他（自由输入）+ 跳过。输入框用 shadcn Input 基件的
                明确「框」形态（描边圆角 + 全 app 同款 focus 环）——初版照抄
                参考图的「铅笔圈 + 裸灰字」被用户实锤「看不出来是 input」
                （2026-07-16），与其他输入处一致性优先。键盘 ↓ 走到本行时
                给 border 提亮提示「Enter 将进入输入」。 */}
            <div
              className="mt-2 flex items-center gap-2 px-3 pb-1 pt-0.5"
              onMouseEnter={() => setHighlight(otherIndex)}
            >
              <div className="relative min-w-0 flex-1">
                <Pencil className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <Input
                  ref={otherInputRef}
                  type="text"
                  value={draft}
                  onFocus={() => setOtherEditing(true)}
                  onBlur={() => setOtherEditing(false)}
                  onChange={(e) =>
                    setOtherDrafts((prev) => ({ ...prev, [current.question]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const v = draft.trim()
                      if (v) { setOtherEditing(false); commit(v) }
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setOtherEditing(false)
                      otherInputRef.current?.blur()
                    }
                    e.stopPropagation()
                  }}
                  placeholder={pick(lang, '其他——用自己的话回答', 'Other — answer in your own words')}
                  // pill 形 + 浅底弱边，贴面板的形状语言（22px 卡/12px 选项行/
                  // pill 圈号与跳过钮）——基件默认的 rounded-md 硬描边在这套
                  // 大圆角体系里像个异物（2026-07-16 用户二次反馈）。focus 时
                  // 底色让位给基件的主题色环，键盘走到本行时边框先提亮半档。
                  className={
                    'h-9 rounded-full border-border/70 bg-muted/40 pl-9 pr-4 text-[13.5px] shadow-none md:text-[13.5px] dark:bg-muted/25 focus-visible:bg-transparent ' +
                    (highlight === otherIndex && !otherEditing ? 'border-ring/50' : '')
                  }
                />
              </div>
              {otherEditing && draft.trim() ? (
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); commit(draft.trim()) }}
                  className="flex h-9 shrink-0 items-center rounded-full bg-[hsl(var(--brand))] px-4 text-[13px] font-medium text-[hsl(var(--brand-foreground))] transition-colors hover:bg-[hsl(var(--brand)/0.9)]"
                >
                  {pick(lang, '回答', 'Answer')}
                </button>
              ) : (
                <button type="button" onClick={() => commit(null)} className={SKIP_BTN}>
                  {pick(lang, '跳过', 'Skip')}
                </button>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

/** 面板皮肤：与 composer 输入卡同族材质（bg-popover/95 + blur + ring），
 * 圆角同 22px——morph 时读起来是同一张卡，只有投影加重表达「聚焦」。
 * PANEL_SHELL / SKIP_BTN 导出给 PermissionComposerPanel 共用——权限面板
 * 与提问面板是同一形态家族（2026-07-16 权限也迁入 composer 接管），
 * 面板皮肤只在这里定义一次。 */
export const PANEL_SHELL =
  'relative overflow-hidden rounded-[22px] bg-popover/95 ring-1 ring-black/[0.08] backdrop-blur-xl backdrop-saturate-150 shadow-[0_12px_36px_rgba(18,18,23,0.12),0_3px_10px_rgba(18,18,23,0.06)] dark:ring-white/[0.08] dark:shadow-[0_16px_44px_rgba(0,0,0,0.5)]'
const NAV_BTN =
  'grid size-[26px] place-items-center rounded-lg transition-colors hover:bg-muted hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent'
export const SKIP_BTN =
  'flex h-9 shrink-0 items-center rounded-full px-4 text-[13px] font-medium text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))] transition-colors hover:bg-muted'

/* ================================================================
   AskComposerSwap —— composer 输入卡 ⇄ 提问面板的 morph 容器。
   ================================================================
   动效：容器高度 spring 跟随活动面（ResizeObserver 量正常流内容高），
   面板 AnimatePresence popLayout 进出（退场自动 absolute 脱流），输入卡
   **永不卸载**——卸载会销毁 ProseMirror 编辑器，重建时 external-sync 走
   parseText 会撕碎 namespaced slash chip（见 ProseMirrorComposerInput
   fillBody 注释），草稿就毁了。所以输入卡只在提问态：absolute 脱流
   （不贡献高度）+ 上飘淡出 + inert（不可聚焦不可点，React 19 原生支持），
   面板退场后再回到正常流淡入。z 序：退场中的面盖在入场面上方 crossfade。

   高度动画顺带覆盖了面板内部的题间高度差与输入框日常长高——RO 量到
   变化就 spring 过去，全程一个写手。
 */
const HEIGHT_SPRING = { type: 'spring', bounce: 0.12, visualDuration: 0.42 } as const
const FACE_SPRING = { type: 'spring', bounce: 0, visualDuration: 0.3 } as const

export function AskComposerSwap({
  ask,
  children,
  anchor = 'top'
}: {
  /** 提问面板元素；null = 常态（显示输入卡）。 */
  ask: React.ReactNode | null
  /** composer 输入卡（常驻，提问态只隐藏不卸载）。 */
  children: React.ReactNode
  /**
   * 高度动画期间内容锚哪条边（2026-07-16 用户拍板）：dock 态传
   * 'bottom'——卡底贴窗口底，input/工具行的屏幕位置必须**全程纹丝
   * 不动**，队列段、接管面板的高度差一律表现为卡顶向上生长/收缩。
   * 顶对齐（默认 'top'，hero 空态沿用）在中间帧会把贴底的 input
   * 推下再回弹——就是「input 位置跟着动画跑」的根源。
   */
  anchor?: 'top' | 'bottom'
}): React.JSX.Element {
  const asking = ask != null
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | 'auto'>('auto')

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      // offsetHeight 只含正常流内容——absolute 脱流的隐藏面不计入。
      setHeight(el.offsetHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <motion.div
      animate={{ height }}
      transition={HEIGHT_SPRING}
      // bottom 锚：flex + justify-end 让内容贴住容器底边——容器高度
      // spring 追赶内容的中间帧里，溢出/空隙都发生在顶部（那里是透明
      // 的 thread 区，没有视觉边界可破坏），底部的 input 恒定。刻意
      // 不加 overflow-hidden：裁切矩形会砍掉卡的 ring/阴影。
      className={anchor === 'bottom' ? 'relative flex flex-col justify-end' : 'relative'}
    >
      <div ref={innerRef} className="w-full">
        <AnimatePresence mode="popLayout" initial={false}>
          {asking ? (
            <motion.div
              key="ask"
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={FACE_SPRING}
            >
              {ask}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.div
          animate={asking ? { opacity: 0, y: -10, scale: 0.98 } : { opacity: 1, y: 0, scale: 1 }}
          transition={FACE_SPRING}
          inert={asking || undefined}
          style={
            asking
              ? {
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  // 隐藏的输入卡与可见面同边对齐：bottom 锚时贴底淡出，
                  // 面板退场后它从底部原位淡回——不跨边跳位。
                  ...(anchor === 'bottom' ? { bottom: 0 } : { top: 0 }),
                  zIndex: 1,
                  pointerEvents: 'none'
                }
              : undefined
          }
        >
          {children}
        </motion.div>
      </div>
    </motion.div>
  )
}
