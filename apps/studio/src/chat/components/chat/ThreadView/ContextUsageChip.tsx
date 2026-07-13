import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'

import { useT } from '../../../i18n'
import { useChatStore } from '../../../stores/chat'
import { useComposerOverlayStore } from '../../../stores/composerOverlay'

/**
 * Claude's effective context window in tokens. Mirrors the constant in
 * ThreadListSidebar's sidebar badge (kept as a separate copy rather than
 * a shared import — both are small, self-contained presentational
 * helpers and a shared constant isn't worth the cross-file coupling).
 */
const CONTEXT_WINDOW_TOKENS = 200_000

function clampFraction(tokens: number): number {
  if (tokens <= 0) return 0
  const f = tokens / CONTEXT_WINDOW_TOKENS
  if (f > 1) return 1
  return f
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

function percentClass(fraction: number): string {
  const pct = fraction * 100
  if (pct < 40) return 'text-emerald-600 dark:text-emerald-400'
  if (pct < 80) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

function barClass(fraction: number): string {
  const pct = fraction * 100
  if (pct < 40) return 'bg-emerald-500'
  if (pct < 80) return 'bg-amber-500'
  return 'bg-red-500'
}

/**
 * Context usage chip — sits between WorkspaceDirPicker and
 * PermissionModePicker in the below-card chip row. Click opens a
 * popover breaking down the latest turn's prompt size (input / cache
 * read / cache write / output) against the model's context window,
 * echoing the shape of Claude Code's terminal `/context` report at a
 * glance. Interaction shape copied from PermissionModePicker: portal
 * to body + fixed anchor (escapes the Composer card's overflow-hidden
 * clip) + click-outside/Escape to close + composerOverlay hide while
 * open (see that file's comments for why each step exists).
 */
export function ContextUsageChip(): React.JSX.Element | null {
  const t = useT()
  const sessionId = useChatStore((s) => s.sessionId)
  const usage = useChatStore((s) =>
    sessionId ? s.perSession[sessionId]?.usage ?? null : null
  )
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 左对齐（菜单左缘贴按钮左缘，向上弹）——本 chip 挂在左侧簇（桌面 chip
  // 右边），跟 WorkspaceDirPicker 同侧，用它的锚点公式而非
  // PermissionModePicker 的右对齐公式。
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
    null
  )

  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const b = btnRef.current?.getBoundingClientRect()
      if (b)
        setAnchor({
          left: b.left,
          bottom: window.innerHeight - b.top
        })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const overlay = useComposerOverlayStore.getState()
    overlay.setOpen(true)
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      const inRoot = rootRef.current?.contains(target)
      const inMenu = menuRef.current?.contains(target)
      if (!inRoot && !inMenu) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      overlay.setOpen(false)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 还没有任何一轮完成过（usage 恒为 null）时不渲染 chip——没有数据可看，
  // 一个点了也是空态的按钮只会增加噪音。第一轮结束后 store 一更新，chip
  // 自然出现。
  if (!usage) return null

  const fraction = clampFraction(usage.contextTokens)
  const pctLabel = `${Math.floor(fraction * 100)}%`

  const rows: Array<{ key: string; label: string; value: number }> = [
    { key: 'input', label: t('contextUsageInput'), value: usage.inputTokens },
    {
      key: 'cacheRead',
      label: t('contextUsageCacheRead'),
      value: usage.cacheReadTokens
    },
    {
      key: 'cacheWrite',
      label: t('contextUsageCacheWrite'),
      value: usage.cacheCreateTokens
    }
  ]

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('contextUsageTitle')}
        title={t('contextUsageTitle')}
        className={
          'group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] shadow-sm backdrop-blur-sm transition-colors ' +
          'border-border/70 bg-card/70 text-muted-foreground hover:border-brand/50 hover:bg-card hover:text-foreground ' +
          (open ? ' border-brand/60 text-foreground' : '')
        }
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </svg>
        <span className="leading-none">{t('contextUsageLabel')}</span>
        <span className={'font-mono leading-none ' + percentClass(fraction)}>
          {pctLabel}
        </span>
      </button>

      {anchor !== null &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={menuRef}
                initial={{ opacity: 0, y: 4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                style={{ left: anchor.left, bottom: anchor.bottom }}
                className="fixed z-[9999] mb-1.5 w-72 overflow-hidden rounded-xl border border-border bg-card p-3 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
                role="dialog"
                aria-label={t('contextUsageTitle')}
              >
                <div className="flex items-center justify-between text-[12px] font-medium text-foreground">
                  <span>{t('contextUsageTitle')}</span>
                  <span className={'font-mono ' + percentClass(fraction)}>
                    {pctLabel}
                  </span>
                </div>

                <div
                  data-slot="context-usage-bar-track"
                  className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    data-slot="context-usage-bar-fill"
                    className={'h-full rounded-full transition-[width] ' + barClass(fraction)}
                    style={{ width: `${fraction * 100}%` }}
                  />
                </div>

                <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    {t('contextUsageUsed')} {formatTokens(usage.contextTokens)}
                  </span>
                  <span>
                    {t('contextUsageWindow')} {formatTokens(CONTEXT_WINDOW_TOKENS)}
                  </span>
                </div>

                <div className="mt-3 flex flex-col gap-1.5 border-t border-border/70 pt-2.5">
                  {rows.map((row) => (
                    <div
                      key={row.key}
                      className="flex items-center justify-between text-[11px]"
                    >
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-mono text-foreground">
                        {formatTokens(row.value)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">
                      {t('contextUsageOutput')}
                    </span>
                    <span className="font-mono text-foreground">
                      {formatTokens(usage.outputTokens)}
                    </span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </div>
  )
}
