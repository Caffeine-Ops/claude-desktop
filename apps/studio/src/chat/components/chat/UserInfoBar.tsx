import { useCallback } from 'react'

import { useT } from '../../i18n'
import { openSettingsOverlay } from '@/src/stores/surfaceOverlay'

/**
 * UserInfoBar
 * -----------
 * Account footer pinned to the BOTTOM of the shell's vertical nav rail
 * (ShellApp). Layout: [avatar] [name / plan] [gear]. The gear is the
 * settings entry point; it opens the settings *modal* directly.
 *
 * It used to be a single gear button at the far right of the old
 * horizontal tab strip. Now that the strip is a left rail, it became a
 * full-width footer row matching the rail's nav rhythm.
 *
 * ⚠️ 2026-08-31：**本组件已是死代码**——`src/` 与 `app/` 里无任何 import，它所属
 * 的 shell 窗口渲染器（ShellApp）也已不存在。下面这个齿轮不会出现在任何界面上。
 *
 * 本次把它的 onClick 从 tabApi.openSettingsWindow()（对应 main handler 早已是空
 * 实现，那条 IPC 链本次一并删除）改成 openSettingsOverlay()，只是为了不残留指向
 * 已删 API 的调用——**不代表 rail 底部真有一个可用的设置入口**。本文件与
 * components/tabs/TabBar.tsx 该整体退役，待定。
 *
 * Note: name/plan are placeholders — there is no signed-in user model in
 * the desktop app yet. They mirror the reference design's footer; wiring
 * real account data is a separate concern.
 *
 * `window.tabApi` is available here because the shell window uses the
 * standard preload.
 */
export function UserInfoBar(): React.JSX.Element {
  const t = useT()

  const openSettings = useCallback((): void => {
    openSettingsOverlay()
  }, [])

  return (
    <div
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className="flex items-center gap-2.5 rounded-lg px-2 py-2"
    >
      {/* Avatar — placeholder initial chip. Rail-green so it matches the
          prototype's accent rather than the daemon theme color. */}
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--rail-accent-soft)] text-[12px] font-semibold text-[color:var(--rail-accent-ink)]">
        我
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[12.5px] font-semibold text-[color:var(--rail-text)]">
          我爱啦啦哈哈
        </div>
        <div className="truncate text-[11px] text-[color:var(--rail-muted)]">
          Pro trial Plan
        </div>
      </div>
      <button
        type="button"
        onClick={openSettings}
        title={t('settings')}
        aria-label={t('settings')}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-[color:var(--rail-text-soft)] transition-colors hover:bg-[var(--rail-hover)] hover:text-[color:var(--rail-text)]"
      >
        <GearIcon className="size-[15px] shrink-0" />
      </button>
    </div>
  )
}

function GearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
