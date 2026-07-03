import { useEffect, useState } from 'react'

import type { CliBackendState } from '@desktop-shared/ipc-channels'
import { useI18n, useT } from '../../i18n'
import { useSettingsStore } from '../../stores/settings'
import {
  APPEARANCE_LIMITS,
  type ThemeOverrides,
  useAppearanceStore
} from '../../stores/appearance'

/**
 * SettingsView
 * ------------
 * Fullscreen settings page that overlays the chat UI when the user
 * picks "主题" (or any other future settings entry) from the bottom
 * UserInfoBar menu.
 *
 * Layout mirrors the reference: a left rail of categories + a content
 * area on the right. Only the Appearance category has real content for
 * now — every input is a static stub with a TODO comment so the wiring
 * pass can come later.
 *
 * Mounted unconditionally in App.tsx; renders null when the store says
 * settings are closed so the chat view stays on top.
 */
export function SettingsView(): React.JSX.Element | null {
  const open = useSettingsStore((s) => s.open)
  const closeSettings = useSettingsStore((s) => s.closeSettings)
  const t = useT()

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('settings')}
      // Sits above the main chat area but below window chrome (header
      // is .header in App.tsx, z-0 by default). z-40 puts us under the
      // permission/skills dialogs (z-50) so a permission popup still
      // wins when both are open.
      className="absolute inset-0 z-40 flex flex-col bg-background text-foreground"
    >
      {/* Top bar — single row with the back link. The reference puts
          this at the very top-left, no other chrome. */}
      <div className="flex items-center px-6 pt-5">
        <button
          type="button"
          onClick={closeSettings}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          <span>{t('backToApp')}</span>
        </button>
      </div>

      <SettingsBody />
    </div>
  )
}

/**
 * The settings content proper — the category rail + the active section's
 * pane. Used by the in-chat fullscreen overlay (`SettingsView`). Kept as a
 * separate component so the rail + panes can be reused by any future shell
 * that wants the same content with different surrounding chrome.
 *
 * (The desktop gear now opens the full Open Design web settings in an
 * overlay WebContentsView instead — see desktop tabRegistry.openSettingsView.
 * This native view remains for the legacy in-chat entry point.)
 */
export function SettingsBody(): React.JSX.Element {
  const t = useT()
  const [activeCategory, setActiveCategory] =
    useState<CategoryId>('appearance')

  const categories: { id: CategoryId; label: string; icon: React.ReactNode }[] =
    [
      { id: 'general', label: t('catGeneral'), icon: <CircleIcon /> },
      { id: 'appearance', label: t('catAppearance'), icon: <SunIcon /> },
      { id: 'configuration', label: t('catConfiguration'), icon: <SlidersIcon /> },
      { id: 'personalization', label: t('catPersonalization'), icon: <PersonIcon /> },
      { id: 'usage', label: t('catUsage'), icon: <BarChartIcon /> },
      { id: 'mcp', label: t('catMcpServers'), icon: <ServerIcon /> },
      { id: 'git', label: t('catGit'), icon: <GitIcon /> },
      { id: 'environment', label: t('catEnvironment'), icon: <TerminalIcon /> },
      { id: 'worktrees', label: t('catWorktrees'), icon: <FolderTreeIcon /> },
      { id: 'archived', label: t('catArchivedThreads'), icon: <ArchiveIcon /> }
    ]

  return (
    <div className="flex min-h-0 flex-1">
      {/* Category rail — fixed 200px column. Only one category is
          active at a time; the rest are visually rendered but their
          content panes are placeholder. */}
      <nav className="w-[200px] shrink-0 overflow-y-auto px-3 py-4">
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => setActiveCategory(cat.id)}
            className={
              'mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ' +
              (activeCategory === cat.id
                ? 'bg-muted/80 text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')
            }
          >
            <span
              className={
                'flex size-4 shrink-0 items-center justify-center ' +
                (activeCategory === cat.id ? 'text-foreground' : 'text-muted-foreground/80')
              }
            >
              {cat.icon}
            </span>
            <span className="flex-1 truncate">{cat.label}</span>
          </button>
        ))}
      </nav>

      {/* Content scroll region. Centered card column matches the
          reference layout (the content sits in a max-w container,
          not edge-to-edge). */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-10 py-8">
          {activeCategory === 'appearance' ? (
            <AppearanceSection />
          ) : activeCategory === 'general' ? (
            <GeneralSection />
          ) : (
            <PlaceholderSection
              title={categories.find((c) => c.id === activeCategory)?.label ?? ''}
            />
          )}
        </div>
      </div>
    </div>
  )
}

type CategoryId =
  | 'general'
  | 'appearance'
  | 'configuration'
  | 'personalization'
  | 'usage'
  | 'mcp'
  | 'git'
  | 'environment'
  | 'worktrees'
  | 'archived'

/* ─────────────────── Appearance ─────────────────── */

/**
 * Appearance category. Theme mode, font sizes and pointer cursor are
 * wired through `useAppearanceStore`; the lower theme detail panels
 * (Light / Dark presets, accent / background / contrast / fonts) stay
 * static stubs until a full theming layer lands.
 */
function AppearanceSection(): React.JSX.Element {
  const t = useT()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const setThemeMode = useAppearanceStore((s) => s.setThemeMode)
  const uiFontSize = useAppearanceStore((s) => s.uiFontSize)
  const setUiFontSize = useAppearanceStore((s) => s.setUiFontSize)
  const codeFontSize = useAppearanceStore((s) => s.codeFontSize)
  const setCodeFontSize = useAppearanceStore((s) => s.setCodeFontSize)
  const usePointerCursor = useAppearanceStore((s) => s.usePointerCursor)
  const setUsePointerCursor = useAppearanceStore((s) => s.setUsePointerCursor)

  return (
    <section className="space-y-8">
      <h1 className="text-[20px] font-semibold text-foreground">
        {t('catAppearance')}
      </h1>

      {/* Theme mode picker — three pill buttons + a code preview block
          mocking the side-by-side diff in the reference. */}
      <Section title={t('theme')} description={t('themeDesc')}>
        <div className="flex justify-end">
          <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card/60 p-0.5">
            <ModeButton
              active={themeMode === 'light'}
              onClick={() => setThemeMode('light')}
              icon={<SunIcon />}
              label={t('themeLight')}
            />
            <ModeButton
              active={themeMode === 'dark'}
              onClick={() => setThemeMode('dark')}
              icon={<MoonIcon />}
              label={t('themeDark')}
            />
            <ModeButton
              active={themeMode === 'system'}
              onClick={() => setThemeMode('system')}
              icon={<MonitorIcon />}
              label={t('themeSystem')}
            />
          </div>
        </div>

        {/* Code preview — purely decorative. TODO(theme): swap for a
            live preview that re-renders on theme edits. */}
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-muted">
          <CodeBlock
            tone="removed"
            lines={[
              { num: 1, text: 'const themePreview: ThemeConfig = {' },
              { num: 2, text: '  surface: "sidebar",' },
              { num: 3, text: '  accent: "#2563eb",' },
              { num: 4, text: '  contrast: 42,' },
              { num: 5, text: '};' }
            ]}
          />
          <CodeBlock
            tone="added"
            lines={[
              { num: 1, text: 'const themePreview: ThemeConfig = {' },
              { num: 2, text: '  surface: "sidebar-elevated",' },
              { num: 3, text: '  accent: "#0ea5e9",' },
              { num: 4, text: '  contrast: 68,' },
              { num: 5, text: '};' }
            ]}
          />
        </div>
      </Section>

      <ThemePanel mode="light" title="Light theme" />
      <ThemePanel mode="dark" title="Dark theme" />

      {/* Misc switches + size sliders. */}
      <Section divider>
        <Row
          label={t('usePointerCursor')}
          description={t('usePointerCursorDesc')}
          control={
            <Toggle
              on={usePointerCursor}
              onChange={setUsePointerCursor}
              ariaLabel={t('usePointerCursor')}
            />
          }
        />
      </Section>

      <Section divider>
        <Row
          label={t('uiFontSize')}
          description={t('uiFontSizeDesc')}
          control={
            <SizeStepper
              value={uiFontSize}
              onChange={setUiFontSize}
              min={APPEARANCE_LIMITS.ui.min}
              max={APPEARANCE_LIMITS.ui.max}
              ariaLabel={t('uiFontSize')}
            />
          }
        />
        <Row
          label={t('codeFontSize')}
          description={t('codeFontSizeDesc')}
          control={
            <SizeStepper
              value={codeFontSize}
              onChange={setCodeFontSize}
              min={APPEARANCE_LIMITS.code.min}
              max={APPEARANCE_LIMITS.code.max}
              ariaLabel={t('codeFontSize')}
            />
          }
        />
      </Section>
    </section>
  )
}

/* ─────────────────── General ─────────────────── */

/**
 * General settings category. Currently hosts just the CLI backend
 * picker — lets the user swap between the bundled fusion-code binary
 * and a system-installed Claude Code. State lives in main (persisted
 * to userData/settings.json); we pull it once on mount and again
 * after every set() so the version badge reflects whatever `claude
 * --version` last returned.
 */
function GeneralSection(): React.JSX.Element {
  const t = useT()
  const lang = useI18n((s) => s.lang)
  const setLang = useI18n((s) => s.setLang)
  const [state, setState] = useState<CliBackendState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.chatApi
      .getCliBackend()
      .then((s) => {
        if (!cancelled) setState(s)
      })
      .catch((err) => {
        console.error('[settings] getCliBackend failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setMode = async (mode: 'bundled' | 'system'): Promise<void> => {
    if (busy || !state || state.mode === mode) return
    // Guard: if there's no system claude installed we can't let the
    // user flip to it. The radio is disabled anyway but this catches
    // a programmatic hit via keyboard.
    if (mode === 'system' && !state.systemInfo) return
    setBusy(true)
    try {
      const next = await window.chatApi.setCliBackend({ mode })
      setState(next)
    } catch (err) {
      console.error('[settings] setCliBackend failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-8">
      <h1 className="text-[20px] font-semibold text-foreground">
        {t('catGeneral')}
      </h1>

      {/* Language — moved here from the old bottom-bar dropdown when the
          settings menu became a modal. Binary toggle: clicking either
          chip switches to that language. */}
      <Section title={t('language')} description="">
        <div className="flex gap-2">
          <ModeButton
            active={lang === 'zh'}
            onClick={() => setLang('zh')}
            icon={null}
            label="中文"
          />
          <ModeButton
            active={lang === 'en'}
            onClick={() => setLang('en')}
            icon={null}
            label="English"
          />
        </div>
      </Section>

      <Section title={t('cliBackendTitle')} description={t('cliBackendDesc')}>
        <div className="space-y-2">
          <CliBackendOption
            active={state?.mode === 'bundled'}
            disabled={busy || !state}
            onClick={() => setMode('bundled')}
            label={t('cliBackendBundled')}
            description={t('cliBackendBundledDesc')}
            pathLabel={t('cliBackendPath')}
            path={state?.bundledPath ?? null}
          />
          <CliBackendOption
            active={state?.mode === 'system'}
            disabled={busy || !state || !state.systemInfo}
            onClick={() => setMode('system')}
            label={t('cliBackendSystem')}
            description={t('cliBackendSystemDesc')}
            pathLabel={t('cliBackendPath')}
            path={state?.systemInfo?.path ?? null}
            badge={
              state?.systemInfo
                ? state.systemInfo.version
                  ? `${t('cliBackendVersion')} ${state.systemInfo.version}`
                  : t('cliBackendDetected')
                : t('cliBackendNotInstalled')
            }
          />
          <p className="pt-1 text-[11px] text-muted-foreground/70">
            {t('cliBackendApplyHint')}
          </p>
        </div>
      </Section>
    </section>
  )
}

function CliBackendOption({
  active,
  disabled,
  onClick,
  label,
  description,
  pathLabel,
  path,
  badge
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  label: string
  description: string
  pathLabel: string
  path: string | null
  badge?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={
        'group relative flex w-full flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition-all ' +
        (active
          ? 'border-accent/50 bg-accent/8 shadow-[inset_0_0_0_1px_hsl(var(--accent)/0.15)]'
          : 'border-border/60 bg-card/40 hover:border-accent/30 hover:bg-card/60') +
        ' disabled:cursor-not-allowed disabled:opacity-50'
      }
    >
      <div className="flex w-full items-center gap-2">
        <span
          className={
            'flex size-4 shrink-0 items-center justify-center rounded-full border ' +
            (active
              ? 'border-accent bg-accent text-accent-foreground'
              : 'border-border bg-background')
          }
        >
          {active && (
            <span className="block size-1.5 rounded-full bg-accent-foreground" />
          )}
        </span>
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {badge && (
          <span
            className={
              'ml-auto rounded-full px-2 py-0.5 text-[10.5px] font-medium ' +
              (path
                ? 'bg-accent/15 text-accent'
                : 'bg-muted text-muted-foreground/80')
            }
          >
            {badge}
          </span>
        )}
      </div>
      <p className="pl-6 text-[11.5px] text-muted-foreground/80">
        {description}
      </p>
      {path && (
        <p className="pl-6 font-mono text-[10.5px] text-muted-foreground/60">
          {pathLabel}: {path}
        </p>
      )}
    </button>
  )
}

function PlaceholderSection({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center pt-32 text-center">
      <h1 className="mb-2 text-[20px] font-semibold text-foreground">{title}</h1>
      <p className="text-[12.5px] text-muted-foreground/80">
        {/* TODO(settings): build out this category */}
        待实现
      </p>
    </div>
  )
}

/* ─────────────────── Layout helpers ─────────────────── */

function Section({
  title,
  description,
  divider,
  children
}: {
  title?: string
  description?: string
  divider?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={
        divider ? 'border-t border-border/80 pt-6' : ''
      }
    >
      {(title || description) && (
        <div className="mb-3">
          {title && (
            <div className="text-[14px] font-medium text-foreground">{title}</div>
          )}
          {description && (
            <div className="mt-0.5 text-[12px] text-muted-foreground/80">{description}</div>
          )}
        </div>
      )}
      {children}
    </div>
  )
}

function Row({
  label,
  description,
  control
}: {
  label: string
  description?: string
  control: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-[11.5px] text-muted-foreground/80">{description}</div>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function ThemePanel({
  mode,
  title
}: {
  mode: 'light' | 'dark'
  title: string
}): React.JSX.Element {
  const t = useT()
  const overrides = useAppearanceStore((s) => s[mode])
  const patchTheme = useAppearanceStore((s) => s.patchTheme)
  const resetTheme = useAppearanceStore((s) => s.resetTheme)

  const patch = (p: Partial<ThemeOverrides>): void => patchTheme(mode, p)

  const handleCopy = (): void => {
    const json = JSON.stringify(overrides, null, 2)
    void navigator.clipboard?.writeText(json)
  }

  const handleImport = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard?.readText()
      if (!text) return
      const parsed = JSON.parse(text) as Partial<ThemeOverrides>
      patch(parsed)
    } catch (err) {
      console.warn('[appearance] import failed', err)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card/40">
      {/* Panel header — title left, import / copy / reset on the right. */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="text-[12.5px] font-medium text-foreground">{title}</div>
        <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
          <button
            type="button"
            onClick={() => void handleImport()}
            className="transition-colors hover:text-foreground"
          >
            {t('themeImport')}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="transition-colors hover:text-foreground"
          >
            {t('themeCopy')}
          </button>
          <button
            type="button"
            onClick={() => resetTheme(mode)}
            className="transition-colors hover:text-foreground"
          >
            {t('themeReset')}
          </button>
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-card/80 px-2 py-1 text-foreground">
            <span className="flex size-4 items-center justify-center rounded-sm bg-muted text-[9px] font-bold text-foreground/80">
              Aa
            </span>
            <span>{overrides.presetName}</span>
          </div>
        </div>
      </div>

      <div className="px-4 py-2 text-[12.5px]">
        <ColorRow
          label="Accent"
          value={overrides.accent}
          onChange={(v) => patch({ accent: v })}
        />
        <ColorRow
          label="Background"
          value={overrides.background}
          onChange={(v) => patch({ background: v })}
        />
        <ColorRow
          label="Foreground"
          value={overrides.foreground}
          onChange={(v) => patch({ foreground: v })}
        />
        <FontRow label="UI font" value="-apple-system, BlinkM…" />
        <FontRow label="Code font" value='ui-monospace, "SFMo…' />
        <Row
          label="Translucent sidebar"
          control={
            <Toggle
              on={overrides.translucentSidebar}
              onChange={(v) => patch({ translucentSidebar: v })}
              ariaLabel="Translucent sidebar"
            />
          }
        />
        <Row
          label="Contrast"
          control={
            <div className="flex w-[280px] items-center gap-3">
              <Slider
                value={overrides.contrast}
                onChange={(v) => patch({ contrast: v })}
                min={0}
                max={100}
                ariaLabel="Contrast"
              />
              <span className="w-8 text-right text-[12px] tabular-nums text-foreground/80">
                {overrides.contrast}
              </span>
            </div>
          }
        />
      </div>
    </div>
  )
}

function ColorRow({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (next: string) => void
}): React.JSX.Element {
  // Native color input wrapped in a label so clicking the chip or the
  // hex string opens the OS picker. The native input itself is hidden
  // off-screen — we can't style it directly, but we can listen to its
  // change event and render our own swatch + hex code.
  const normalized = normalizeHex(value)
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 last:border-b-0">
      <span className="text-foreground/80">{label}</span>
      <label className="relative flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-foreground/80 transition-colors hover:border-input">
        <span
          aria-hidden
          className="size-3.5 rounded-sm border border-input"
          style={{ backgroundColor: normalized }}
        />
        <span className="font-mono text-[11px] uppercase">{normalized}</span>
        <input
          type="color"
          value={normalized}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  )
}

function normalizeHex(input: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(input.trim())
  return m ? `#${m[1].toLowerCase()}` : '#000000'
}

function FontRow({
  label,
  value
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2">
      <span className="text-foreground/80">{label}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground/80">
        {value}
      </span>
    </div>
  )
}

function CodeBlock({
  tone,
  lines
}: {
  tone: 'added' | 'removed'
  lines: { num: number; text: string }[]
}): React.JSX.Element {
  const bg = tone === 'added' ? 'bg-emerald-500/5' : 'bg-rose-500/5'
  return (
    <div className={`p-3 font-mono text-[11px] leading-relaxed ${bg}`}>
      {lines.map((l) => (
        <div key={l.num} className="flex">
          <span className="mr-3 w-4 select-none text-right text-muted-foreground/60">
            {l.num}
          </span>
          <span className="text-foreground/80">{l.text}</span>
        </div>
      ))}
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors ' +
        (active
          ? 'bg-secondary/80 text-foreground'
          : 'text-muted-foreground hover:text-foreground')
      }
    >
      <span className="size-3.5">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function Toggle({
  on,
  onChange,
  ariaLabel
}: {
  on: boolean
  onChange: (next: boolean) => void
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      className={
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors ' +
        (on ? 'bg-accent' : 'bg-secondary')
      }
    >
      <span
        className={
          'absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform ' +
          (on ? 'translate-x-[18px]' : 'translate-x-0.5')
        }
      />
    </button>
  )
}

function Slider({
  value,
  onChange,
  min,
  max,
  ariaLabel
}: {
  value: number
  onChange: (next: number) => void
  min: number
  max: number
  ariaLabel?: string
}): React.JSX.Element {
  // Real <input type="range"> styled to match the surrounding mock —
  // track painted via a wrapper, native thumb hidden then redrawn so
  // we keep keyboard / accessibility behavior for free.
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="relative flex h-4 flex-1 items-center">
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
        className="theme-slider relative z-10 h-4 w-full cursor-pointer appearance-none bg-transparent"
      />
    </div>
  )
}

function SizeStepper({
  value,
  onChange,
  min,
  max,
  ariaLabel
}: {
  value: number
  onChange: (next: number) => void
  min: number
  max: number
  ariaLabel?: string
}): React.JSX.Element {
  const dec = (): void => onChange(Math.max(min, value - 1))
  const inc = (): void => onChange(Math.min(max, value + 1))
  const atMin = value <= min
  const atMax = value >= max
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex items-stretch overflow-hidden rounded-md border border-border bg-card/60 text-[12px] text-foreground"
    >
      <button
        type="button"
        onClick={dec}
        disabled={atMin}
        aria-label="decrease"
        className="flex w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:cursor-default disabled:text-muted-foreground/60 disabled:hover:bg-transparent"
      >
        −
      </button>
      <div className="flex items-center gap-1 border-x border-border px-2 tabular-nums">
        <span>{value}</span>
        <span className="text-muted-foreground/80">px</span>
      </div>
      <button
        type="button"
        onClick={inc}
        disabled={atMax}
        aria-label="increase"
        className="flex w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:cursor-default disabled:text-muted-foreground/60 disabled:hover:bg-transparent"
      >
        +
      </button>
    </div>
  )
}

/* ─────────────────── Icons ─────────────────── */

function CircleIcon(): React.JSX.Element {
  return iconWrap(<circle cx="8" cy="8" r="6" />)
}
function SunIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <circle cx="8" cy="8" r="3" />
      <line x1="8" y1="1.5" x2="8" y2="3" />
      <line x1="8" y1="13" x2="8" y2="14.5" />
      <line x1="1.5" y1="8" x2="3" y2="8" />
      <line x1="13" y1="8" x2="14.5" y2="8" />
      <line x1="3.3" y1="3.3" x2="4.4" y2="4.4" />
      <line x1="11.6" y1="11.6" x2="12.7" y2="12.7" />
      <line x1="3.3" y1="12.7" x2="4.4" y2="11.6" />
      <line x1="11.6" y1="4.4" x2="12.7" y2="3.3" />
    </>
  )
}
function MoonIcon(): React.JSX.Element {
  return iconWrap(<path d="M14 9.5A6.5 6.5 0 1 1 6.5 2a5 5 0 0 0 7.5 7.5z" />)
}
function MonitorIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <rect x="2" y="3" width="12" height="8" rx="1" />
      <line x1="6" y1="14" x2="10" y2="14" />
      <line x1="8" y1="11" x2="8" y2="14" />
    </>
  )
}
function SlidersIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <line x1="2" y1="5" x2="14" y2="5" />
      <line x1="2" y1="11" x2="14" y2="11" />
      <circle cx="6" cy="5" r="1.5" />
      <circle cx="11" cy="11" r="1.5" />
    </>
  )
}
function PersonIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 14a5 5 0 0 1 10 0" />
    </>
  )
}
function BarChartIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <line x1="3" y1="13" x2="3" y2="9" />
      <line x1="8" y1="13" x2="8" y2="5" />
      <line x1="13" y1="13" x2="13" y2="7" />
    </>
  )
}
function ServerIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <rect x="2" y="3" width="12" height="4" rx="1" />
      <rect x="2" y="9" width="12" height="4" rx="1" />
      <line x1="5" y1="5" x2="5" y2="5" />
      <line x1="5" y1="11" x2="5" y2="11" />
    </>
  )
}
function GitIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5.5v5" />
      <path d="M4 8h5a2 2 0 0 1 2 2v.5" />
    </>
  )
}
function TerminalIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <path d="M3 5l3 3-3 3" />
      <line x1="8" y1="12" x2="13" y2="12" />
    </>
  )
}
function FolderTreeIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <path d="M2 4h4l1 1h7v3H2z" />
      <path d="M5 11v2h7" />
    </>
  )
}
function ArchiveIcon(): React.JSX.Element {
  return iconWrap(
    <>
      <rect x="2" y="3" width="12" height="3" rx="0.5" />
      <path d="M3 6v7h10V6" />
      <line x1="6" y1="9" x2="10" y2="9" />
    </>
  )
}
function ArrowLeftIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <line x1="13" y1="8" x2="3" y2="8" />
      <path d="M7 4l-4 4 4 4" />
    </svg>
  )
}
function iconWrap(children: React.ReactNode): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-full"
      aria-hidden
    >
      {children}
    </svg>
  )
}
