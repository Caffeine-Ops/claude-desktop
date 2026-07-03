import { useMemo, useRef, useState } from 'react'
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
  streamingArgsText
}: {
  request: PermissionRequest | null
  streamingArgsText: string | null
}): React.JSX.Element {
  const respond = usePermissionStore((s) => s.respond)
  // answerable once the permission request exists (has a requestId); during the
  // pure-streaming phase it's a read-only preview.
  const answerable = request !== null
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
  }, [request, streamingArgsText])
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
                className="rounded-xl border border-border bg-card px-[18px] pb-[18px] pt-4 shadow-sm"
              >
                <div className="flex items-start gap-2.5">
                  {/* Question badge: number → check, a 3D flip once answered.
                      Progress feedback lives ON the number, not in a footnote. */}
                  <span className="relative mt-px size-6 shrink-0 [perspective:80px]" aria-hidden>
                    <span
                      className={
                        `absolute inset-0 grid place-items-center rounded-[7px] bg-accent/10 text-[11px] font-bold text-accent [backface-visibility:hidden] transition-transform duration-[450ms] ${springCss} ` +
                        (answered ? '[transform:rotateY(-180deg)]' : '')
                      }
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      className={
                        `absolute inset-0 grid place-items-center rounded-[7px] bg-accent text-accent-foreground [backface-visibility:hidden] transition-transform duration-[450ms] ${springCss} ` +
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
                            ? 'border-accent bg-accent/[0.08] shadow-[0_0_0_1px_hsl(var(--accent))]'
                            : 'border-border hover:border-border hover:bg-foreground/[0.03]') +
                          (!answerable ? ' cursor-default opacity-70' : '')
                        }
                      >
                        {/* radio: the inner dot springs from 0 on select */}
                        <span
                          className={
                            'relative mt-[1.5px] size-4 shrink-0 rounded-full border-[1.5px] transition-colors ' +
                            (selected ? 'border-accent' : 'border-muted-foreground/40')
                          }
                          aria-hidden
                        >
                          <span
                            className={
                              `absolute inset-[2.5px] rounded-full bg-accent transition-transform duration-300 ${springCss} ` +
                              (selected ? 'scale-100' : 'scale-0')
                            }
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={
                              'block text-[13px] font-medium leading-snug ' +
                              (selected ? 'text-accent' : 'text-foreground')
                            }
                          >
                            {opt.label}
                          </span>
                          {opt.description ? (
                            <span
                              className={
                                'mt-0.5 block text-[11.5px] leading-relaxed ' +
                                (selected ? 'text-accent/70' : 'text-muted-foreground')
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
                        ? 'border-solid border-accent bg-accent/[0.08] shadow-[0_0_0_1px_hsl(var(--accent))]'
                        : 'border-border hover:border-foreground/20')
                    }
                  >
                    <span
                      className={
                        'relative size-4 shrink-0 rounded-full border-[1.5px] transition-colors ' +
                        (otherSelected ? 'border-accent' : 'border-muted-foreground/40')
                      }
                      aria-hidden
                    >
                      <span
                        className={
                          `absolute inset-[2.5px] rounded-full bg-accent transition-transform duration-300 ${springCss} ` +
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
      <div className="shrink-0 border-t border-border/60 bg-background/90 px-8 py-2.5 backdrop-blur">
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
                    (on ? 'scale-110 bg-accent' : 'border border-border bg-muted')
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
            className={
              'relative overflow-hidden rounded-lg px-[18px] py-2 text-[13px] font-semibold transition-colors duration-300 ' +
              (answerable && allAnswered
                ? 'bg-accent text-accent-foreground shadow-sm hover:opacity-90'
                : 'cursor-not-allowed bg-muted text-muted-foreground/70')
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
