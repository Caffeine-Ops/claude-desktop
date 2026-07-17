'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

import type { PermissionRequest } from '@desktop-shared/types'
import { Input } from '@/src/components/ui/input'
import { useT, useTFormat, useToolLabel } from '../../i18n'
import { usePermissionStore } from '../../stores/permissions'
import { safeStringify } from '../chat/toolHelpers'
import { PANEL_SHELL, SKIP_BTN } from './AskUserComposerPanel'

/**
 * PermissionComposerPanel —— 权限请求的 composer 位接管面板
 * （2026-07-16 形态迁移，原型 docs/ui-prototype-composer-states.html）。
 *
 * 迁移背景：此前权限请求渲染为 composer 上方的独立浮卡
 * （PermissionFloatCard，已退役）——浮卡 + 下方仍在跳动的输入卡是两张
 * 视觉层，且「回答权限」期间输入区并无实际用处。现在权限到达时
 * **composer 输入卡整卡变形为本面板**（与 AskUserComposerPanel 走同一个
 * AskComposerSwap 槽），答完变回来——与提问面板完全同构：同一张卡、
 * 同一套圈号选项行、同一个底部自由输入 + 跳过。
 *
 * 与提问面板对齐的交互语义（用户在原型上逐轮拍板）：
 *   - 点选项即提交（一拍 ✓ 反馈后 respond），不再是旧浮卡的两步
 *     「选中 → 提交按钮」。
 *   - 数字键直选即提交；↑↓ 移动高亮 + Enter 提交高亮项；Esc = 跳过
 *     （plain deny）。
 *   - 「不同意」从选项降为底部常驻输入胶囊：输入理由 Enter（或点
 *     「发送」）→ deny + denyMessage 回传引擎；空手点「跳过」= plain
 *     deny。
 *
 * 队列语义原样保留：store 可能同时挂着多个 pending（并行 tool_use），
 * 面板显示最旧一个 + 「还有 N 个等待」计数；keyed remount（Composer 里
 * key=requestId）让每个请求重放入场动画并重置本地态。等待计时从面板
 * 出现起算（PermissionRequest 不带到达时间戳，「轮到它被看见」就是
 * 用户视角的等待起点）。
 */

type ChoiceKind = 'allow-once' | 'allow-session'

export function PermissionComposerPanel({
  request,
  queuedCount
}: {
  request: PermissionRequest
  queuedCount: number
}): React.JSX.Element {
  const t = useT()
  const tf = useTFormat()
  const toolLabel = useToolLabel()
  const respond = usePermissionStore((s) => s.respond)

  // 选项 2 只在请求可作用域化时存在（同旧浮卡 / 终端 CLI 的规则）。
  const choices = useMemo<ChoiceKind[]>(
    () => (request.scopeLabel ? ['allow-once', 'allow-session'] : ['allow-once']),
    [request.scopeLabel]
  )
  const [highlight, setHighlight] = useState(0)
  const [picked, setPicked] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [denyEditing, setDenyEditing] = useState(false)
  const denyInputRef = useRef<HTMLInputElement | null>(null)
  // 「一拍选中反馈」定时器；已提交中就不再接受第二次点击/按键。
  const commitTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current)
    },
    []
  )

  // 等待计时：面板出现起算，每秒走字。1s 一次的整面板重渲染对这张小
  // 面板是零成本，不值得为它拆子组件。
  const [shownAt] = useState(() => Date.now())
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const waitedS = Math.max(0, Math.floor((Date.now() - shownAt) / 1000))

  const allow = useCallback(
    (i: number) => {
      if (commitTimerRef.current !== null) return
      setPicked(i)
      setHighlight(i)
      commitTimerRef.current = window.setTimeout(() => {
        void respond(request.requestId, choices[i] ?? 'allow-once')
      }, 200)
    },
    [choices, respond, request.requestId]
  )
  const deny = useCallback(
    (message?: string) => {
      void respond(request.requestId, 'deny', undefined, message)
    },
    [respond, request.requestId]
  )

  // deny 输入行在键盘序列末位（↓ 从最后一个选项走到它，Enter 进入输入）。
  const denyIndex = choices.length

  // 全局键盘接管（面板在场即生效；deny 输入态旁路给输入框）——与
  // AskUserComposerPanel 同一套模式。
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (denyEditing) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setDenyEditing(false)
          denyInputRef.current?.blur()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        deny()
        return
      }
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1
        if (n >= 0 && n < choices.length) {
          e.preventDefault()
          allow(n)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => Math.min(h + 1, denyIndex))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (highlight === denyIndex) {
          setDenyEditing(true)
          setTimeout(() => denyInputRef.current?.focus(), 0)
          return
        }
        allow(highlight)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [denyEditing, highlight, denyIndex, choices.length, allow, deny])

  // Command / parameter preview. `summary` is the broker's short
  // human-readable line (file path, command, …); raw input is the
  // fallback so the user is never asked to approve a blind call.
  const detail =
    request.summary && request.summary.trim().length > 0
      ? request.summary
      : request.input !== undefined && request.input !== null
        ? safeStringify(request.input)
        : t('permissionNoParams')

  return (
    <div
      className={PANEL_SHELL}
      role="dialog"
      aria-label={tf('permissionAriaLabel', { toolName: request.toolName })}
    >
      <div className="px-4 pb-4 pt-4">
        {/* 标题行：问题 + 右侧元信息（排队计数 · 工具名 chip · 等待计时）。 */}
        <div className="flex items-baseline gap-3">
          <h3 className="min-w-0 flex-1 text-[15.5px] font-semibold leading-[1.45] tracking-[-0.2px] text-foreground">
            {tf('permissionFloatTitle', { tool: toolLabel(request.toolName) })}
          </h3>
          <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
            {queuedCount > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
                {tf('permissionFloatQueued', { count: String(queuedCount) })}
              </span>
            )}
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {request.toolName}
            </span>
            <span className="tabular-nums">
              {tf('permissionWaitElapsed', { s: String(waitedS) })}
            </span>
          </span>
        </div>

        {/* Command / parameter block */}
        <div className="mt-3 max-h-28 overflow-y-auto whitespace-pre-wrap break-all rounded-xl bg-muted/60 px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-foreground/80">
          {detail}
        </div>

        {/* 圈号选项行 —— 与提问面板同一套样式：点选即提交，一拍 ✓ 反馈。 */}
        <div className="mt-3 flex flex-col gap-0.5">
          {choices.map((kind, i) => {
            const isPicked = picked === i
            const hot = i === highlight && !denyEditing
            return (
              <button
                key={kind}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => allow(i)}
                className={
                  'group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-100 ' +
                  (hot ? 'bg-muted/75' : 'hover:bg-muted/50')
                }
              >
                <span
                  className={
                    'grid size-[26px] shrink-0 place-items-center rounded-full text-[12.5px] font-semibold tabular-nums transition-colors duration-100 ' +
                    (isPicked
                      ? 'bg-[hsl(var(--brand))] text-[hsl(var(--brand-foreground))]'
                      : 'bg-card text-muted-foreground shadow-[inset_0_0_0_1.2px_hsl(var(--border))]')
                  }
                >
                  {isPicked ? '✓' : i + 1}
                </span>
                <span className="shrink-0 text-[14px] font-semibold text-foreground">
                  {kind === 'allow-once' ? t('permissionYes') : t('permissionFloatAllowSession')}
                </span>
                {kind === 'allow-session' && request.scopeLabel ? (
                  <span className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {request.scopeLabel}
                  </span>
                ) : null}
                <span
                  aria-hidden
                  className={
                    'ml-auto shrink-0 text-muted-foreground transition-opacity duration-100 ' +
                    (hot ? 'opacity-80' : 'opacity-0')
                  }
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-[15px]"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
              </button>
            )
          })}
        </div>

        {/* 底部：不同意（自由输入理由）+ 跳过 —— 与提问面板的「其他」行
            同构；输入非空时跳过位变「发送」。理由随 deny 作 denyMessage
            回传，assistant 能听到 WHY。 */}
        <div
          className="mt-2 flex items-center gap-2 px-3 pt-0.5"
          onMouseEnter={() => setHighlight(denyIndex)}
        >
          <div className="relative min-w-0 flex-1">
            <Pencil className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              ref={denyInputRef}
              type="text"
              value={feedback}
              maxLength={4000}
              onFocus={() => setDenyEditing(true)}
              onBlur={() => setDenyEditing(false)}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const v = feedback.trim()
                  if (v) deny(v)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setDenyEditing(false)
                  denyInputRef.current?.blur()
                }
                e.stopPropagation()
              }}
              placeholder={t('permissionFloatDenyFeedback')}
              className={
                'h-9 rounded-full border-border/70 bg-muted/40 pl-9 pr-4 text-[13.5px] shadow-none md:text-[13.5px] dark:bg-muted/25 focus-visible:bg-transparent ' +
                (highlight === denyIndex && !denyEditing ? 'border-ring/50' : '')
              }
            />
          </div>
          {denyEditing && feedback.trim() ? (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                deny(feedback.trim())
              }}
              className="flex h-9 shrink-0 items-center rounded-full bg-[hsl(var(--brand))] px-4 text-[13px] font-medium text-[hsl(var(--brand-foreground))] transition-colors hover:bg-[hsl(var(--brand)/0.9)]"
            >
              {t('permissionDenySend')}
            </button>
          ) : (
            <button type="button" onClick={() => deny()} className={SKIP_BTN}>
              {t('permissionFloatSkip')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
