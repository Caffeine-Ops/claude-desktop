import { useEffect, useLayoutEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useAnalytics } from '../../analytics/provider';
import { trackSettingsAppearanceClick } from '../../analytics/events';
import { useI18n } from '../../i18n';
import { Icon } from '../shared/Icon';
import {
  ACCENT_SWATCHES,
  DEFAULT_ACCENT_COLOR,
  applyAppearanceToDocument,
  normalizeAccentColor,
} from '../../state/appearance';
import type { AppConfig, AppTheme } from '../../types';
import type { DesktopCliBackendState } from '../../App';

const THEMES: Array<{ value: AppTheme; labelKey: 'settings.themeSystem' | 'settings.themeLight' | 'settings.themeDark'; icon?: 'sun' | 'moon' }> = [
  { value: 'system', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight', icon: 'sun' },
  { value: 'dark', labelKey: 'settings.themeDark', icon: 'moon' },
];

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
    <section className="settings-section settings-section--cards">
      <div className="settings-card">
        <div className="settings-card-label">{t('settings.appearanceThemeMode')}</div>
        <div className="seg-control" role="group" aria-label={t('settings.appearance')} style={{ '--seg-cols': THEMES.length } as React.CSSProperties}>
        {THEMES.map(({ value, labelKey, icon }) => (
          <button
            key={value}
            type="button"
            className={'seg-btn' + (current === value ? ' active' : '')}
            aria-pressed={current === value}
            onClick={() => {
              // P1 ui_click area=appearance — `system|light|dark` only
              // emits from the segmented control; accent swatch picks
              // use `accent_color` with the swatch hex below.
              if (value === 'system' || value === 'light' || value === 'dark') {
                trackSettingsAppearanceClick(analytics.track, {
                  page_name: 'settings',
                  area: 'appearance',
                  element: value,
                });
              }
              setCfg((c) => ({ ...c, theme: value }));
            }}
          >
            {icon ? <Icon name={icon} size={14} aria-hidden="true" /> : null}
            <span className="seg-title">{t(labelKey)}</span>
          </button>
        ))}
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-card-label">{accentLabel}</div>
        <div className="pet-swatches" role="radiogroup" aria-label={accentLabel}>
          {ACCENT_SWATCHES.map((color) => {
            const active = currentAccent === color;
            return (
              <button
                key={color}
                type="button"
                className={`pet-swatch${active ? ' active' : ''}`}
                style={{ background: color }}
                aria-label={color === DEFAULT_ACCENT_COLOR ? defaultAccentLabel : color}
                aria-checked={active}
                role="radio"
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
          <input
            type="color"
            aria-label={customAccentLabel}
            className="pet-swatch-picker"
            value={currentAccent}
            onChange={(e) => setAccentColor(e.target.value)}
          />
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
    } catch {
      /* ignore */
    } finally {
      setCliBusy(false);
    }
  };

  return (
    <>
      <div className="settings-card">
        <div className="field">
          <span className="field-label">UI font size</span>
          <FontStepper
            value={uiFont}
            min={UI_FONT_MIN}
            max={UI_FONT_MAX}
            onChange={setUiFont}
            ariaLabel="UI font size"
          />
        </div>
        <div className="field">
          <span className="field-label">Code font size</span>
          <FontStepper
            value={codeFont}
            min={CODE_FONT_MIN}
            max={CODE_FONT_MAX}
            onChange={setCodeFont}
            ariaLabel="Code font size"
          />
        </div>
        <div className="field">
          <label className="settings-checkbox-row">
            <input
              type="checkbox"
              checked={pointer}
              onChange={(e) => setPointer(e.target.checked)}
            />
            <span>Use pointer cursor on clickable elements</span>
          </label>
        </div>
      </div>

      {cliBackend ? (
        <div className="settings-card">
          <div className="settings-card-label">CLI backend</div>
          <div className="seg-control" role="group" aria-label="CLI backend">
            <button
              type="button"
              className={'seg-btn' + (cliBackend.mode === 'bundled' ? ' active' : '')}
              aria-pressed={cliBackend.mode === 'bundled'}
              disabled={cliBusy}
              onClick={() => void switchCliBackend('bundled')}
            >
              <span className="seg-title">Bundled (fusion-code)</span>
            </button>
            <button
              type="button"
              className={'seg-btn' + (cliBackend.mode === 'system' ? ' active' : '')}
              aria-pressed={cliBackend.mode === 'system'}
              disabled={cliBusy || !cliBackend.systemInfo}
              onClick={() => void switchCliBackend('system')}
            >
              <span className="seg-title">
                System claude
                {cliBackend.systemInfo?.version
                  ? ` (v${cliBackend.systemInfo.version})`
                  : !cliBackend.systemInfo
                    ? ' (not installed)'
                    : ''}
              </span>
            </button>
          </div>
          <p className="hint">
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
    <div className="font-stepper" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        aria-label={`${ariaLabel} decrease`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="font-stepper-value" aria-live="polite">
        {value}px
      </span>
      <button
        type="button"
        aria-label={`${ariaLabel} increase`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}
