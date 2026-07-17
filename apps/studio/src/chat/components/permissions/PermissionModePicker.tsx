import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'

import { useI18n } from '../../i18n'
import { usePermissionModeStore } from '../../stores/permissionMode'
import { useComposerOverlayStore } from '../../stores/composerOverlay'
import type { UiPermissionMode } from '@desktop-shared/ipc-channels'

/**
 * Permission mode picker — a small pill anchored to the right edge of
 * the strip above the composer card. It mirrors Claude Code's
 * terminal-side mode indicator (`default`,
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
 * long description lives in the popover rows so the pill stays compact.
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
    descZh: '全权托付，无需逐步确认',
    descEn: 'Hand off fully — runs without prompts'
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

/**
 * 菜单里暂时下架的模式（2026-07-07 产品收敛：只暴露 默认/计划/全自动 三
 * 档）。只从菜单里摘、不从 MODES 里删——localStorage 里可能残留着此前选过
 * 的 acceptEdits/dontAsk（persist 中间件），pill 的 current 查找必须仍认得
 * 它们，否则 pill 会误显示「默认」而引擎实际还跑在旧模式上。恢复上架 = 从
 * 这个集合里删掉对应 id。
 */
const MENU_HIDDEN: ReadonlySet<UiPermissionMode> = new Set<UiPermissionMode>([
  'acceptEdits',
  'dontAsk'
])

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
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 菜单 portal 到 body 后用 fixed 定位。本 picker 右对齐（菜单右缘贴按钮
  // 右缘），故锚点存 right（视口宽 − 按钮 right）+ bottom（视口高 − 按钮 top）。
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(
    null
  )

  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  const currentColor = COLOR_CLASS[current.color]

  // 打开时测量按钮 rect 换算 fixed 锚点；滚动/缩放跟随。useLayoutEffect 在
  // 绘制前定位好，避免菜单先闪现在角落再跳位。
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const b = btnRef.current?.getBoundingClientRect()
      if (b)
        setAnchor({
          right: window.innerWidth - b.right,
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
    // Hide the composer's blur strip while this popover is open — its
    // backdrop-blur otherwise slices a blurred band across the menu.
    const overlay = useComposerOverlayStore.getState()
    overlay.setOpen(true)
    const onDown = (e: MouseEvent): void => {
      // 菜单已 portal 出 rootRef 子树——按钮壳与菜单都不含才算点外部。
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
        ref={btnRef}
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

      {/* ⚠️ portal 到 body（2026-07-05「菜单顶部被裁」同 ComposerModePicker）：
        * 菜单 `bottom-full` 向上弹，被祖先 Composer 卡片的 overflow-hidden 裁掉
        * 溢出顶部（露出后面元素）——z-index 治不了裁剪。portal 脱离裁剪祖先 +
        * fixed 定位（测按钮 rect，右对齐用 right 锚点）；菜单项加 data-slot 逃逸
        * .chat-app 外的 canvas 裸 button reset。 */}
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
                style={{ right: anchor.right, bottom: anchor.bottom }}
                className="fixed z-[9999] mb-1.5 w-64 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
                role="listbox"
              >
                {MODES.filter((m) => !MENU_HIDDEN.has(m.id)).map((meta) => {
                  const selected = meta.id === mode
                  const color = COLOR_CLASS[meta.color]
                  return (
                    <button
                      key={meta.id}
                      data-slot="permission-mode-option"
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => choose(meta.id)}
                      className={
                        'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ' +
                        (selected
                          ? 'bg-accent/10 text-foreground'
                          : 'text-muted-foreground hover:bg-hover hover:text-foreground')
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
          </AnimatePresence>,
          document.body
        )}
    </div>
  )
}
