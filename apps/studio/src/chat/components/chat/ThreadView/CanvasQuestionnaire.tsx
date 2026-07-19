import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'

import type { PermissionRequest } from '@desktop-shared/types'
import { usePendingAskTiming } from '../../../stores/chat'
import { parsePartialToolArgs } from '../../../stores/todos'
import { usePermissionStore } from '../../../stores/permissions'
import {
  parseQuestions,
  seedAnswers,
  type AskUserQuestionItem
} from '../../permissions/AskUserQuestionView'
import {
  registerQuestionDemoHandle,
  unregisterQuestionDemoHandle,
  type QuestionDemoHandle
} from '../../../replay/questionDemoRegistry'
import { AppleGlowEffect } from '../AppleGlowEffect'
import { ToolElapsed } from './ToolCallCard'

/**
 * Canvas questionnaire — the AskUserQuestion form rendered in the 问题 tab
 * (the full-form layout from the reference: numbered questions, option cards
 * with descriptions, an 其他 free-text row, and a 提交答案 bar).
 *
 * Answers ride the SAME permission-broker path the inline prompt uses — there
 * is no separate channel. Submit → respond(requestId, 'allow-once', {answers})
 * feeds the answers back as the tool's updatedInput. (We must NOT send a user
 * message / fabricate a tool_result — the broker would hang and the text would
 * be swallowed; see the project's error notes.)
 *
 * Note: there is intentionally no「AI 自行决定」escape hatch here. An earlier
 * version had one that went through respond('deny'), which the model read as
 * 「user refused」and answered every question with its first option. The button
 * was removed rather than reworked — the user must answer explicitly.
 */
export function CanvasQuestionnaire({
  request,
  streamingArgsText,
  replayQuestions
}: {
  request: PermissionRequest | null
  streamingArgsText: string | null
  /**
   * 回放态：题目内容直接由 SlidesWorkspace 从（回放态）tool item 的 args
   * 派生传入——不走 request/streamingArgsText（两者都读真实权限 broker /
   * live 流状态，回放时永远是 null，见 usePendingAskUserQuestion 的头注
   * 释）。传入即视为回放模式：answerable 恒真（题目已经「生成完毕」，直接
   * 进选中态表演）、submit 变成纯视觉（不触发真实 respond()）。
   */
  replayQuestions?: AskUserQuestionItem[]
}): React.JSX.Element {
  const isReplay = replayQuestions !== undefined
  const respond = usePermissionStore((s) => s.respond)
  // answerable once the permission request exists (has a requestId); during the
  // pure-streaming phase it's a read-only preview. 回放态恒可答（题目已就绪）。
  const answerable = isReplay || request !== null
  // Elapsed timer for the questionnaire header. The inline ToolCallCard (which
  // normally carries this) is suppressed in slides mode, so we read the same
  // AskUserQuestion timing here and show it next to「请回答以下问题」. Still
  // running until the user submits and the tool result lands (endedAt).
  const { startedAt: askStartedAt, endedAt: askEndedAt } = usePendingAskTiming()

  // Hold the last successfully-parsed questions so a streaming frame that
  // lands mid-`\uXXXX` escape (parsePartialToolArgs returns null that tick)
  // doesn't blank the preview — we keep showing the previous good parse.
  const lastQuestionsRef = useRef<AskUserQuestionItem[]>([])
  const questions = useMemo(() => {
    // 回放态：题目由外部一次性给定，不参与 streaming 增量解析。
    if (replayQuestions) return replayQuestions
    // Prefer the finalized permission input; fall back to the streaming text.
    if (request) {
      const qs = parseQuestions(request.input)
      lastQuestionsRef.current = qs
      return qs
    }
    if (streamingArgsText) {
      const partial = parsePartialToolArgs(streamingArgsText)
      const qs = parseQuestions(partial)
      // Only adopt a non-empty parse; otherwise keep the last good one.
      if (qs.length > 0) lastQuestionsRef.current = qs
    }
    return lastQuestionsRef.current
  }, [replayQuestions, request, streamingArgsText])
  // Per-question selection: question text → chosen option label (or the user's
  // free-text for 其他). Seeded from any prior answers on the input (resume).
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    request ? seedAnswers(request.input) : {}
  )
  // Per-question 其他 draft text, kept separate so toggling between a preset
  // option and 其他 doesn't lose what was typed.
  const [otherDraft, setOtherDraft] = useState<Record<string, string>>({})

  const pick = (q: string, label: string): void =>
    setAnswers((a) => ({ ...a, [q]: label }))

  // 回放态：注册命令式 handle，供 ReplayController 驱动选中态表演。
  useEffect(() => {
    if (!isReplay) return
    const handle: QuestionDemoHandle = {
      select(question, label) {
        setAnswers((a) => ({ ...a, [question]: label }))
      },
      typeOther(question, text) {
        setOtherDraft((d) => ({ ...d, [question]: text }))
        setAnswers((a) => ({ ...a, [question]: text }))
      },
      submit() {
        // 纯视觉——真实结果已经由 chat 轨的 tool_result 呈现，这里不调用
        // respond()（回放没有真实 requestId 可答）。
      }
    }
    registerQuestionDemoHandle(handle)
    return () => unregisterQuestionDemoHandle(handle)
  }, [isReplay])

  const typeOther = (q: string, text: string): void => {
    setOtherDraft((d) => ({ ...d, [q]: text }))
    // Selecting 其他 means the answer IS the typed text.
    setAnswers((a) => ({ ...a, [q]: text }))
  }

  // Every question must carry a non-empty answer before submit is allowed.
  // (A chosen option label, or non-blank 其他 text — both land in `answers`.)
  const allAnswered =
    questions.length > 0 &&
    questions.every((q) => {
      const a = answers[q.question]
      return typeof a === 'string' && a.trim().length > 0
    })

  const submit = (): void => {
    if (!request) return // still streaming — not answerable yet
    if (!allAnswered) return // guard: must answer every question first
    // Build answers in question order for a stable tool_result.
    const out: Record<string, string> = {}
    for (const q of questions) {
      const a = answers[q.question]
      if (a && a.trim()) out[q.question] = a
    }
    void respond(request.requestId, 'allow-once', { answers: out })
  }

  // Count of questions carrying a non-empty answer — drives the header
  // tally, the per-question progress dots, and the submit unlock.
  const answeredCount = questions.filter((q) => {
    const a = answers[q.question]
    return typeof a === 'string' && a.trim().length > 0
  }).length

  if (questions.length === 0 && answerable) {
    // Finalized but empty → a real parse failure (streaming empty falls
    // through to the main render, which shows the skeleton card).
    return (
      <div className="relative min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <h2 className="text-[19px] font-bold text-foreground">请回答以下问题</h2>
        <p className="mt-3 text-[13px] text-muted-foreground">无法解析问题内容。</p>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Siri / Apple-Intelligence edge glow — the「AI 活动」signal while the
          questionnaire is still streaming (!answerable); removed once
          answering is possible. The old whole-form opacity breathing was
          dropped on purpose: the skeleton card + glow already say "working",
          and a pulsing page reads as jitter, not polish. */}
      {!answerable ? <AppleGlowEffect /> : null}

      {/* header: title + status line | answered tally + elapsed */}
      <div className="shrink-0 px-8 pb-1 pt-6">
        <div className="mx-auto flex w-full max-w-[760px] items-start gap-3">
          <div>
            <h2 className="text-[19px] font-bold text-foreground">请回答以下问题</h2>
            <p
              className={
                'mt-1 text-[12.5px] ' +
                (answerable ? 'text-muted-foreground' : 'shimmer-text font-medium')
              }
            >
              {answerable ? '回答后提交，AI 将按你的选择继续规划' : 'AI 正在生成问题…'}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3 self-center">
            {questions.length > 0 && (
              <span className="text-[11.5px] tabular-nums text-muted-foreground">
                <span className="font-semibold text-accent">{answeredCount}</span> /{' '}
                {questions.length} 已回答
              </span>
            )}
            <ToolElapsed
              startedAt={askStartedAt}
              endedAt={askEndedAt}
              running={askEndedAt === undefined}
            />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-4">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3.5">
          {questions.map((q, i) => {
            const otherText = otherDraft[q.question] ?? ''
            const otherSelected =
              answers[q.question] !== undefined &&
              answers[q.question] === otherText &&
              otherText.length > 0
            const answered =
              typeof answers[q.question] === 'string' && answers[q.question].trim().length > 0
            // The badge flip + radio pop share one springy cubic-bezier so all
            // the micro-interactions speak the same motion language.
            const springCss = 'ease-[cubic-bezier(0.3,1.3,0.5,1)]'
            return (
              <motion.div
                // Index key (not question text): during streaming the last
                // question's text mutates token-by-token, so a text key would
                // make that row re-mount and replay its enter animation every
                // tick (flicker). Index is stable — questions only append,
                // never reorder — so only a genuinely NEW row animates in.
                key={i}
                initial={{ opacity: 0, y: 14, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: 'spring', bounce: 0.2, visualDuration: 0.4 }}
                // 毛玻璃质感（2026-07-18，跟 workspace 面同一批 /70 + blur-xl）：
                // bg-card 实底换成半透明 + backdrop-blur。下方选项行本就是
                // ghost 样式（未选中透明、选中 bg-brand/[0.08] 半透明色块），
                // 不带自己的不透明底，卡片一透它们自然跟着透。
                className="rounded-xl border border-border bg-card/70 px-[18px] pb-[18px] pt-4 shadow-sm backdrop-blur-xl backdrop-saturate-150"
              >
                <div className="flex items-start gap-2.5">
                  {/* Question badge: number → check, a 3D flip once answered.
                      Progress feedback lives ON the number, not in a footnote. */}
                  <span className="relative mt-px size-6 shrink-0 [perspective:80px]" aria-hidden>
                    <span
                      className={
                        `absolute inset-0 grid place-items-center rounded-[7px] bg-brand/10 text-[11px] font-bold text-brand [backface-visibility:hidden] transition-transform duration-[450ms] ${springCss} ` +
                        (answered ? '[transform:rotateY(-180deg)]' : '')
                      }
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      className={
                        `absolute inset-0 grid place-items-center rounded-[7px] bg-brand text-brand-foreground [backface-visibility:hidden] transition-transform duration-[450ms] ${springCss} ` +
                        (answered ? '' : '[transform:rotateY(180deg)]')
                      }
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3.5"
                        className="size-3"
                      >
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <h3 className="text-[14.5px] font-semibold leading-6 text-foreground">
                      {q.header ?? q.question}
                    </h3>
                    {q.header ? (
                      <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                        {q.question}
                      </p>
                    ) : null}
                  </span>
                  <span className="shrink-0 self-center rounded-full border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground">
                    单选
                  </span>
                </div>

                <div className="mt-3 flex flex-col gap-[7px]">
                  {q.options.map((opt) => {
                    const selected = answers[q.question] === opt.label
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        disabled={!answerable}
                        onClick={() => answerable && pick(q.question, opt.label)}
                        className={
                          'flex w-full items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-left transition-all duration-150 active:scale-[0.995] ' +
                          (selected
                            ? 'border-brand bg-brand/[0.08] shadow-[0_0_0_1px_hsl(var(--brand))]'
                            : 'border-border hover:border-border hover:bg-foreground/[0.03]') +
                          (!answerable ? ' cursor-default opacity-70' : '')
                        }
                      >
                        {/* radio: the inner dot springs from 0 on select */}
                        <span
                          className={
                            'relative mt-[1.5px] size-4 shrink-0 rounded-full border-[1.5px] transition-colors ' +
                            (selected ? 'border-brand' : 'border-muted-foreground/40')
                          }
                          aria-hidden
                        >
                          <span
                            className={
                              `absolute inset-[2.5px] rounded-full bg-brand transition-transform duration-300 ${springCss} ` +
                              (selected ? 'scale-100' : 'scale-0')
                            }
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={
                              'block text-[13px] font-medium leading-snug ' +
                              (selected ? 'text-brand' : 'text-foreground')
                            }
                          >
                            {opt.label}
                          </span>
                          {opt.description ? (
                            <span
                              className={
                                'mt-0.5 block text-[11.5px] leading-relaxed ' +
                                (selected ? 'text-brand/70' : 'text-muted-foreground')
                              }
                            >
                              {opt.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}

                  {/* 其他 free-text row — a radio-styled row whose answer is
                      the typed text; focus solidifies the dashed border. */}
                  <label
                    className={
                      'flex items-center gap-2.5 rounded-lg border border-dashed pl-3.5 pr-1 transition-all duration-150 focus-within:border-solid focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 ' +
                      (otherSelected
                        ? 'border-solid border-brand bg-brand/[0.08] shadow-[0_0_0_1px_hsl(var(--brand))]'
                        : 'border-border hover:border-foreground/20')
                    }
                  >
                    <span
                      className={
                        'relative size-4 shrink-0 rounded-full border-[1.5px] transition-colors ' +
                        (otherSelected ? 'border-brand' : 'border-muted-foreground/40')
                      }
                      aria-hidden
                    >
                      <span
                        className={
                          `absolute inset-[2.5px] rounded-full bg-brand transition-transform duration-300 ${springCss} ` +
                          (otherSelected ? 'scale-100' : 'scale-0')
                        }
                      />
                    </span>
                    <input
                      type="text"
                      value={otherText}
                      disabled={!answerable}
                      onChange={(e) => typeOther(q.question, e.target.value)}
                      placeholder="其他（请填写）"
                      className="min-w-0 flex-1 bg-transparent py-2.5 pr-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-70"
                    />
                  </label>
                </div>
              </motion.div>
            )
          })}

          {/* Skeleton card for the question the AI is writing next — the
              streaming signal with a SHAPE, replacing the old page-wide
              breathing. Appears while !answerable, springs in like a real
              card, and the real question replaces it on the next parse. */}
          {!answerable && (
            <motion.div
              key="skeleton"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', bounce: 0.2, visualDuration: 0.4 }}
              className="rounded-xl border border-dashed border-border px-[18px] py-4"
            >
              <div className="flex items-center gap-2.5">
                <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-accent/10">
                  <span className="size-1 animate-pulse rounded-full bg-accent" />
                </span>
                <span className="h-[11px] w-28 animate-pulse rounded bg-muted" />
              </div>
              <div className="mt-3.5 space-y-2">
                <span
                  className="block h-[11px] w-[72%] animate-pulse rounded bg-muted"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="block h-[11px] w-[54%] animate-pulse rounded bg-muted"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* Action bar: per-question progress dots + hint + the submit button.
          The button UNLOCKS (grey → accent, one scale beat + a single sheen
          sweep) the moment every question is answered — the "ready to hand
          back" moment gets a visible beat instead of a silent color swap. */}
      {/* Footer bar: same card surface as the body, separated by the top
          hairline alone (bg-card = white in light / card colour in dark).
          毛玻璃质感（2026-07-18，同一批）：纯 chrome 条（进度点 + 提示文字 +
          提交按钮），比正文卡片更透一点，对齐 composer dock 同档 /65。 */}
      <div className="shrink-0 border-t border-border bg-card/65 px-8 py-2.5 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex w-full max-w-[760px] items-center gap-3.5">
          <div className="flex gap-[5px]" aria-hidden>
            {questions.map((q, i) => {
              const on =
                typeof answers[q.question] === 'string' && answers[q.question].trim().length > 0
              return (
                <span
                  key={i}
                  className={
                    'size-[7px] rounded-full transition-all duration-300 ease-[cubic-bezier(0.3,1.3,0.5,1)] ' +
                    (on ? 'scale-110 bg-brand' : 'border border-border bg-muted')
                  }
                />
              )
            })}
            {!answerable && (
              <span className="size-[7px] animate-pulse rounded-full border border-dashed border-muted-foreground/50" />
            )}
          </div>
          <span className="text-[11.5px] text-muted-foreground">
            {!answerable
              ? 'AI 正在生成问题…'
              : allAnswered
                ? '就绪，随时可提交'
                : `还有 ${questions.length - answeredCount} 题未回答`}
          </span>
          <div className="flex-1" />
          <motion.button
            type="button"
            onClick={submit}
            disabled={!answerable || !allAnswered}
            // One scale beat when the button flips to ready. The keyframe array
            // replays only when `animate` changes (ready false → true).
            animate={answerable && allAnswered ? { scale: [1, 1.05, 1] } : { scale: 1 }}
            transition={{ duration: 0.45, ease: [0.3, 1.3, 0.5, 1] }}
            // 就绪色钉死品牌绿 --brand（不跟主题色 --accent 走，2026-07-19
            // 用户实锤）——同上面进度点的 bg-brand 保持一致，之前两者不同色
            // 其实是既有的不一致。
            className={
              'relative overflow-hidden rounded-lg px-[18px] py-2 text-[13px] font-semibold transition-colors duration-300 ' +
              (answerable && allAnswered
                ? 'bg-brand text-brand-foreground shadow-sm hover:opacity-90'
                : 'cursor-not-allowed border border-border bg-muted text-muted-foreground/70')
            }
          >
            提交答案
            {/* Single sheen sweep across the freshly-unlocked button; parks
                off-canvas (x:110%) so it never replays on re-render. */}
            {answerable && allAnswered && (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.45) 50%, transparent 70%)'
                }}
                initial={{ x: '-110%' }}
                animate={{ x: '110%' }}
                transition={{ duration: 0.9, ease: 'easeOut', delay: 0.15 }}
              />
            )}
          </motion.button>
        </div>
      </div>
    </div>
  )
}
