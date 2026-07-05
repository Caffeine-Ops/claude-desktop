import { useEffect, useLayoutEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Minus, Moon, Plus, Sun } from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { Switch } from '@/src/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { cn } from '@/src/lib/utils';
import { useAnalytics } from '../../analytics/provider';
import { trackSettingsAppearanceClick } from '../../analytics/events';
import { useI18n } from '../../i18n';
import {
  ACCENT_SWATCHES,
  DEFAULT_ACCENT_COLOR,
  applyAppearanceToDocument,
  normalizeAccentColor,
} from '../../state/appearance';
import type { AppConfig, AppTheme } from '../../types';
import type { DesktopCliBackendState } from '../../App';

/* 2026-07-04 迁 chat 栈（shadcn + Tailwind utility）：seg-control/pet-swatch/
   font-stepper/settings-card 等 legacy 类全部退役。主题模式用 shadcn Tabs
   （与执行模式双档同构件）；CLI backend 不用 Tabs——它是 async 切换 + busy/
   disabled 态，Radix 受控 value 会在请求失败时和真实状态打架，分段式裸
   button + data-slot 更贴（BYOK 协议 tab 同模式）。 */

const THEMES: Array<{
  value: AppTheme;
  labelKey: 'settings.themeSystem' | 'settings.themeLight' | 'settings.themeDark';
  icon?: 'sun' | 'moon';
}> = [
  { value: 'system', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight', icon: 'sun' },
  { value: 'dark', labelKey: 'settings.themeDark', icon: 'moon' },
];

const cardCls = 'rounded-xl border border-border bg-card p-4';
const cardLabelCls = 'mb-3 text-xs font-medium text-muted-foreground';

export function AppearanceSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const current = cfg.theme ?? 'system';
  const currentAccent = normalizeAccentColor(cfg.accentColor) ?? DEFAULT_ACCENT_COLOR;
  const accentLabel = t('pet.fieldAccent');
  const defaultAccentLabel = t('pet.fieldAccentDefault');
  const customAccentLabel = t('pet.fieldAccentCustom');

  // Apply the draft theme immediately so the user sees a live preview
  // before hitting Save. SettingsDialog's cleanup reverts this on cancel.
  useLayoutEffect(() => {
    applyAppearanceToDocument({
      theme: current,
      accentColor: currentAccent,
    });
  }, [current, currentAccent]);

  const setAccentColor = (color: string) => {
    setCfg((c) => ({ ...c, accentColor: normalizeAccentColor(color) ?? c.accentColor ?? DEFAULT_ACCENT_COLOR }));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className={cardCls}>
        <div className={cardLabelCls}>{t('settings.appearanceThemeMode')}</div>
        <Tabs
          value={current}
          onValueChange={(v) => {
            // P1 ui_click area=appearance — `system|light|dark` only
            // emits from the segmented control; accent swatch picks
            // use `accent_color` with the swatch hex below.
            if (v === 'system' || v === 'light' || v === 'dark') {
              trackSettingsAppearanceClick(analytics.track, {
                page_name: 'settings',
                area: 'appearance',
                element: v,
              });
            }
            setCfg((c) => ({ ...c, theme: v as AppTheme }));
          }}
          aria-label={t('settings.appearance')}
        >
          <TabsList className="grid w-full grid-cols-3 rounded-xl p-1">
            {THEMES.map(({ value, labelKey, icon }) => (
              <TabsTrigger key={value} value={value} className="rounded-[9px]">
                {icon === 'sun' ? <Sun className="size-3.5" /> : null}
                {icon === 'moon' ? <Moon className="size-3.5" /> : null}
                {t(labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className={cardCls}>
        <div className={cardLabelCls}>{accentLabel}</div>
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={accentLabel}>
          {ACCENT_SWATCHES.map((color) => {
            const active = currentAccent === color;
            return (
              <button
                key={color}
                type="button"
                role="radio"
                data-slot="accent-swatch"
                className={cn(
                  'size-7 cursor-pointer rounded-full transition-[transform,box-shadow] hover:scale-110',
                  /* 选中态 = 色圆外留白隙再箍一圈（截图语言），ring-offset 造白隙 */
                  active && 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card',
                )}
                style={{ background: color }}
                aria-label={color === DEFAULT_ACCENT_COLOR ? defaultAccentLabel : color}
                aria-checked={active}
                onClick={() => {
                  trackSettingsAppearanceClick(analytics.track, {
                    page_name: 'settings',
                    area: 'appearance',
                    element: 'accent_color',
                    color,
                  });
                  setAccentColor(color);
                }}
              />
            );
          })}
          {/* 自定义色：原生 color input 铺满圆形 label 隐形接管点击 —— 圆形
              外观交给 label（native color swatch 没法直接圆形化）。 */}
          <label
            className="relative flex size-7 cursor-pointer items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={customAccentLabel}
          >
            <Plus className="size-3.5" />
            <input
              type="color"
              aria-label={customAccentLabel}
              data-slot="accent-swatch-picker"
              className="absolute inset-0 size-full cursor-pointer opacity-0"
              value={currentAccent}
              onChange={(e) => setAccentColor(e.target.value)}
            />
          </label>
        </div>
      </div>

      {/* Desktop-only appearance controls — font sizes, pointer cursor, and
          the CLI backend. These were the native Electron settings; they now
          live in this one overlay. Font size / cursor round-trip through the
          daemon `appearance` (the Electron renderer reads it). The CLI backend
          goes through the studio tab's chatApi preload (getCliBackend /
          setCliBackend). The whole block renders only inside the desktop
          shell (window.chatApi present) — a plain browser never sees it. */}
      <DesktopAppearanceControls cfg={cfg} setCfg={setCfg} />
    </section>
  );
}

const UI_FONT_MIN = 11;
const UI_FONT_MAX = 18;
const CODE_FONT_MIN = 10;
const CODE_FONT_MAX = 18;
const DEFAULT_UI_FONT = 13;
const DEFAULT_CODE_FONT = 12;

function clampFont(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Desktop-only appearance controls embedded in the settings overlay.
 * Renders nothing in a plain browser (no `window.chatApi`).
 *
 * Font size / pointer cursor live on the shared AppConfig and persist to the
 * daemon `appearance` via the normal config save path, so the Electron shell
 * renderer picks them up. The CLI backend (bundled fusion-code vs system
 * claude) is Electron-only state read/written through the studio tab's
 * chatApi preload (`window.chatApi.getCliBackend/setCliBackend`)。
 *
 * 历史：这里原本走独立设置窗口的 `window.electronSettings` 桥——那个
 * settings preload 已随设置窗口在 Phase 4 下线（本区块因此静默消失过，
 * 「CLI 后端」一度无处可选）。studio 单视图里 canvas 与 chat 同一
 * webContents、共享同一份 chatApi preload，直接用它即可，不需要第二座桥。
 */
function DesktopAppearanceControls({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined;
  const [cliBackend, setCliBackend] = useState<DesktopCliBackendState | null>(null);
  const [cliBusy, setCliBusy] = useState(false);

  useEffect(() => {
    if (!chatApi?.getCliBackend) return;
    let cancelled = false;
    chatApi
      .getCliBackend()
      .then((s) => {
        if (!cancelled) setCliBackend(s);
      })
      .catch(() => {
        /* shell-only; ignore in browser / on error */
      });
    return () => {
      cancelled = true;
    };
  }, [chatApi]);

  // Not inside the desktop shell → render nothing.
  if (!chatApi) return null;

  const uiFont = cfg.uiFontSize ?? DEFAULT_UI_FONT;
  const codeFont = cfg.codeFontSize ?? DEFAULT_CODE_FONT;
  const pointer = cfg.usePointerCursor ?? false;

  const setUiFont = (n: number) =>
    setCfg((c) => ({ ...c, uiFontSize: clampFont(n, UI_FONT_MIN, UI_FONT_MAX) }));
  const setCodeFont = (n: number) =>
    setCfg((c) => ({
      ...c,
      codeFontSize: clampFont(n, CODE_FONT_MIN, CODE_FONT_MAX),
    }));
  const setPointer = (v: boolean) =>
    setCfg((c) => ({ ...c, usePointerCursor: v }));

  const switchCliBackend = async (mode: 'bundled' | 'system') => {
    if (cliBusy || !chatApi.setCliBackend || cliBackend?.mode === mode) return;
    if (mode === 'system' && !cliBackend?.systemInfo) return;
    setCliBusy(true);
    try {
      const next = await chatApi.setCliBackend({ mode });
      setCliBackend(next);
      // 同 document 即时广播：rail 底部 user chip 只在挂载时拉一次后端，
      // 不派发这个事件切换后 chip 文案不更新（2026-07-05）。rail 与本
      // 设置页同一个 studio webContents，派 window 事件让 AppRail 就地
      // re-pull——同 'od:appearance-changed' 桥的跨面同步机制。
      window.dispatchEvent(
        new CustomEvent('od:cli-backend-changed', { detail: next })
      );
    } catch {
      /* ignore */
    } finally {
      setCliBusy(false);
    }
  };

  return (
    <>
      {/* 字号 + 指针三行共一张卡，divide-y 分隔（截图版式） */}
      <div className="divide-y divide-border/60 rounded-xl border border-border bg-card px-4">
        <div className="flex items-center justify-between gap-4 py-3">
          <span className="text-[13px] font-medium text-foreground">UI font size</span>
          <FontStepper
            value={uiFont}
            min={UI_FONT_MIN}
            max={UI_FONT_MAX}
            onChange={setUiFont}
            ariaLabel="UI font size"
          />
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <span className="text-[13px] font-medium text-foreground">Code font size</span>
          <FontStepper
            value={codeFont}
            min={CODE_FONT_MIN}
            max={CODE_FONT_MAX}
            onChange={setCodeFont}
            ariaLabel="Code font size"
          />
        </div>
        <div className="flex items-center justify-between gap-4 py-3.5">
          <label
            className="cursor-pointer text-[13px] font-medium text-foreground"
            htmlFor="appearance-pointer-cursor"
          >
            Use pointer cursor on clickable elements
          </label>
          <Switch
            id="appearance-pointer-cursor"
            checked={pointer}
            onCheckedChange={setPointer}
          />
        </div>
      </div>

      {cliBackend ? (
        <div className={cardCls}>
          <div className={cardLabelCls}>CLI backend</div>
          <div className="flex rounded-[10px] bg-secondary p-[3px]" role="group" aria-label="CLI backend">
            {(
              [
                { mode: 'bundled' as const, label: 'Bundled (fusion-code)', disabled: cliBusy },
                {
                  mode: 'system' as const,
                  label: `System claude${
                    cliBackend.systemInfo?.version
                      ? ` (v${cliBackend.systemInfo.version})`
                      : !cliBackend.systemInfo
                        ? ' (not installed)'
                        : ''
                  }`,
                  disabled: cliBusy || !cliBackend.systemInfo,
                },
              ]
            ).map(({ mode, label, disabled }) => (
              <button
                key={mode}
                type="button"
                data-slot="cli-backend-tab"
                aria-pressed={cliBackend.mode === mode}
                disabled={disabled}
                className={cn(
                  'min-w-0 flex-1 cursor-pointer truncate rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-[background-color,color,box-shadow] disabled:cursor-not-allowed disabled:opacity-60',
                  cliBackend.mode === mode
                    ? 'bg-card text-foreground shadow-[0_1px_3px_hsl(240_6%_10%/0.12),0_0_0_1px_hsl(240_6%_10%/0.04)]'
                    : 'hover:text-foreground/80',
                )}
                onClick={() => void switchCliBackend(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mb-0 mt-2.5 text-xs leading-relaxed text-muted-foreground">
            Takes effect immediately — an in-flight turn keeps its current
            backend; the next turn switches.
          </p>
        </div>
      ) : null}
    </>
  );
}

/** Small +/- stepper for the desktop font-size controls. */
function FontStepper({
  value,
  min,
  max,
  onChange,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="flex items-center overflow-hidden rounded-lg border border-border"
      role="group"
      aria-label={ariaLabel}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 rounded-none"
        aria-label={`${ariaLabel} decrease`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus className="size-3.5" />
      </Button>
      <span
        className="min-w-[52px] border-x border-border px-2 text-center text-xs tabular-nums text-foreground"
        aria-live="polite"
      >
        {value}px
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 rounded-none"
        aria-label={`${ariaLabel} increase`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus className="size-3.5" />
      </Button>
    </div>
  );
}
