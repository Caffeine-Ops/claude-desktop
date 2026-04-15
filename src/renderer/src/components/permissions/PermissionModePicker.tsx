import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { useI18n } from '../../i18n'
import { usePermissionModeStore } from '../../stores/permissionMode'
import type { UiPermissionMode } from '../../../../shared/ipc-channels'

/**
 * Permission mode picker — a small pill that sits in the empty strip
 * to the right of `<WorkspacePill />`, above the composer card. It
 * mirrors Claude Code's terminal-side mode indicator (`default`,
 * `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk`) and lets the
 * user flip mode mid-conversation without retyping a slash command.
 *
 * Visual language
 * ---------------
 * Each mode has a dedicated accent color. Inspired by the terminal:
 *   - default:          muted (asks per tool)
 *   - plan:             blue   (read-only planning)
 *   - acceptEdits:      green  (auto-allow edits)
 *   - bypassPermissions:red    (full auto — danger)
 *   - dontAsk:          red    (silent deny — risk of getting stuck)
 *
 * The pill itself only shows a colored dot + the short label. The
 * long description lives in the popover rows so the pill stays
 * compact enough to share the row with WorkspacePill.
 */

type ModeColor = 'muted' | 'blue' | 'green' | 'red'

interface ModeMeta {
  id: UiPermissionMode
  color: ModeColor
  /** Terminal-style glyph shown on the pill. */
  glyph: string
  labelZh: string
  labelEn: string
  descZh: string
  descEn: string
}

const MODES: readonly ModeMeta[] = [
  {
    id: 'default',
    color: 'muted',
    glyph: '◯',
    labelZh: '默认',
    labelEn: 'Default',
    descZh: '关键操作前先向你确认',
    descEn: 'Ask before each sensitive action'
  },
  {
    id: 'plan',
    color: 'blue',
    glyph: '⏸',
    labelZh: '计划',
    labelEn: 'Plan',
    descZh: '只读工具 + 先出计划再执行',
    descEn: 'Read-only + plan before running'
  },
  {
    id: 'acceptEdits',
    color: 'green',
    glyph: '⏵',
    labelZh: '自动编辑',
    labelEn: 'Accept edits',
    descZh: '自动批准文件编辑,其它仍询问',
    descEn: 'Auto-approve edits, prompt for the rest'
  },
  {
    id: 'bypassPermissions',
    color: 'red',
    glyph: '⏵⏵',
    labelZh: '全自动',
    labelEn: 'Bypass',
    descZh: '全权托付 Claude，无需逐步确认',
    descEn: 'Hand off fully — Claude runs without prompts'
  },
  {
    id: 'dontAsk',
    color: 'red',
    glyph: '⏴',
    labelZh: '不问即拒',
    labelEn: "Don't ask",
    descZh: '未预先允许的工具一律拒绝',
    descEn: 'Silently deny anything not pre-approved'
  }
]

const COLOR_CLASS: Record<ModeColor, { dot: string; ring: string }> = {
  muted: {
    dot: 'bg-muted-foreground/60',
    ring: 'ring-muted-foreground/30'
  },
  blue: {
    dot: 'bg-sky-500',
    ring: 'ring-sky-400/50'
  },
  green: {
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-400/50'
  },
  red: {
    dot: 'bg-rose-500',
    ring: 'ring-rose-400/50'
  }
}

function pickLabel(meta: ModeMeta, lang: 'zh' | 'en'): string {
  return lang === 'zh' ? meta.labelZh : meta.labelEn
}

function pickDesc(meta: ModeMeta, lang: 'zh' | 'en'): string {
  return lang === 'zh' ? meta.descZh : meta.descEn
}

export function PermissionModePicker(): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const mode = usePermissionModeStore((s) => s.mode)
  const setMode = usePermissionModeStore((s) => s.setMode)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  const currentColor = COLOR_CLASS[current.color]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = useCallback(
    (next: UiPermissionMode) => {
      void setMode(next)
      setOpen(false)
    },
    [setMode]
  )

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={lang === 'zh' ? '权限模式' : 'Permission mode'}
        title={pickDesc(current, lang)}
        className={
          'group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] shadow-sm backdrop-blur-sm transition-colors ' +
          'border-border/70 bg-card/70 text-muted-foreground hover:border-accent/50 hover:bg-card hover:text-foreground ' +
          (open ? ' border-accent/60 text-foreground' : '')
        }
      >
        <span
          className={
            'inline-block size-1.5 rounded-full ring-2 ring-offset-0 transition ' +
            currentColor.dot +
            ' ' +
            currentColor.ring
          }
          aria-hidden
        />
        <span className="font-mono text-[10px] leading-none">
          {current.glyph}
        </span>
        <span className="leading-none">{pickLabel(current, lang)}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={
            'ml-0.5 opacity-60 transition-transform ' +
            (open ? 'rotate-180' : '')
          }
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className="absolute bottom-full right-0 z-40 mb-1.5 w-64 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
            role="listbox"
          >
            {MODES.map((meta) => {
              const selected = meta.id === mode
              const color = COLOR_CLASS[meta.color]
              return (
                <button
                  key={meta.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(meta.id)}
                  className={
                    'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ' +
                    (selected
                      ? 'bg-accent/15 text-foreground'
                      : 'text-muted-foreground hover:bg-accent/10 hover:text-foreground')
                  }
                >
                  <span
                    className={
                      'mt-[5px] inline-block size-2 shrink-0 rounded-full ring-2 ring-offset-0 ' +
                      color.dot +
                      ' ' +
                      color.ring
                    }
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-[12px] font-medium">
                      <span className="font-mono text-[10px] opacity-70">
                        {meta.glyph}
                      </span>
                      {pickLabel(meta, lang)}
                    </span>
                    <span className="text-[11px] leading-snug opacity-80">
                      {pickDesc(meta, lang)}
                    </span>
                  </span>
                  {selected && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mt-0.5 shrink-0 text-accent"
                      aria-hidden
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
