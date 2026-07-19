import { useEffect, useLayoutEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { ImagePlus, Minus, Moon, Plus, Sun, Trash2 } from 'lucide-react';
import type { BackgroundThemeMeta } from '@desktop-shared/ipc-channels';

import { Button } from '@/src/components/ui/button';
import { Slider } from '@/src/components/ui/slider';
import { Switch } from '@/src/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { cn } from '@/src/lib/utils';
import { useAppearanceStore } from '@/src/chat/stores/appearance';
import { toBgAssetUrl } from '@/src/chat/lib/bgAssetUrl';
import {
  useBackgroundArtStore,
  resolveBackgroundTheme,
  isUserBackgroundTheme,
} from '@/src/stores/backgroundArt';
import { BACKGROUND_PRESETS } from '@/src/lib/backgroundArt/presets';
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

/* 2026-07-04 迁 chat 栈（shadcn + Tailwind utility）：seg-control/pet-swatch/
   font-stepper/settings-card 等 legacy 类全部退役。主题模式用 shadcn Tabs
   （与执行模式双档同构件）。CLI backend 卡片 2026-07-16 迁去执行模式
   section（CliBackendCard.tsx）——它管的是聊天执行链路，与外观无关。 */

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
            className="relative flex size-7 cursor-pointer items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
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

      {/* 背景图（壁纸）——独立于上面 theme/accent 的草稿+Save+取消回滚流程：
          直接读写 chat 侧 useAppearanceStore.background，点击即生效即持久化
          （该 store 自己的 subscribe 已经在做 daemon 推送，backgroundArt.
          applier.ts 已经在响应式地把它应用到 DOM）。不经过 cfg/setCfg 草稿，
          是因为这样能直接复用 Phase 3 已建好的整条链路，不用为背景图另起
          一份"预览值计算"，桌面壳外（无 window.chatApi）不渲染，同
          DesktopAppearanceControls。 */}
      <BackgroundArtSection setCfg={setCfg} />

      {/* Desktop-only appearance controls — font sizes and pointer cursor.
          These were the native Electron settings; they now live in this one
          overlay and round-trip through the daemon `appearance` (the Electron
          renderer reads it). The block renders only inside the desktop shell
          (window.chatApi present) — a plain browser never sees it. The CLI
          backend card that used to sit here moved to the execution section
          (CliBackendCard.tsx, 2026-07-16). */}
      <DesktopAppearanceControls cfg={cfg} setCfg={setCfg} />
    </section>
  );
}

const FOCUS_GRID = [0, 0.5, 1] as const;

/**
 * Background art (wallpaper) picker. Desktop-only (same `window.chatApi`
 * gate as DesktopAppearanceControls below) — the whole feature is main-
 * process file IO + a custom protocol, meaningless in a plain browser tab.
 *
 * Reads/writes `useAppearanceStore.background` directly rather than the
 * `cfg`/`setCfg` draft the rest of this section uses: that store already
 * persists on every change (subscribe → daemon push) and is already applied
 * reactively to the DOM (backgroundArt.applier.ts, built in the same pass as
 * this section) — piggybacking on it means a click here IS the live preview,
 * with no separate preview/revert machinery to build or keep in sync with
 * the applier's own veil-alpha math.
 */
function BackgroundArtSection({
  setCfg,
}: {
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined;
  const background = useAppearanceStore((s) => s.background);
  const userThemes = useBackgroundArtStore((s) => s.userThemes);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void useBackgroundArtStore.getState().refreshUserThemes();
  }, []);

  if (!chatApi) return null;

  const activeMeta = resolveBackgroundTheme(background.themeId);
  const tiles: BackgroundThemeMeta[] = [...BACKGROUND_PRESETS, ...userThemes];

  const select = (id: string | null): void => {
    useAppearanceStore.getState().setBackgroundTheme(id);
  };

  const applyAccentFromPhoto = (): void => {
    if (!activeMeta) return;
    const color = normalizeAccentColor(activeMeta.palette.accent);
    if (!color) return;
    setCfg((c) => ({ ...c, accentColor: color }));
  };

  const handleImport = async (): Promise<void> => {
    if (!chatApi.importBackgroundTheme) return;
    setImporting(true);
    try {
      const meta = await chatApi.importBackgroundTheme();
      if (meta) {
        await useBackgroundArtStore.getState().refreshUserThemes();
        select(meta.id);
      }
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    if (!chatApi.deleteBackgroundTheme) return;
    // Clear the active theme FIRST if we're about to delete it — the applier
    // resolving a themeId to `null` (deleted) already renders nothing, but
    // doing this first avoids a frame where the store still points at a
    // themeId whose files are already gone.
    if (background.themeId === id) select(null);
    const ok = await chatApi.deleteBackgroundTheme({ themeId: id });
    if (ok) await useBackgroundArtStore.getState().refreshUserThemes();
  };

  return (
    <div className={cardCls}>
      <div className={cardLabelCls}>{t('settings.background')}</div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-slot="bg-theme-tile"
          onClick={() => select(null)}
          aria-pressed={!background.themeId}
          className={cn(
            'flex size-16 items-center justify-center rounded-lg border text-[11px] text-muted-foreground transition-colors hover:text-foreground',
            !background.themeId
              ? 'border-primary ring-2 ring-primary/40'
              : 'border-border bg-secondary',
          )}
        >
          {t('settings.background.none')}
        </button>

        {tiles.map((meta) => {
          const active = background.themeId === meta.id;
          const deletable = isUserBackgroundTheme(meta.id);
          const thumbUrl = deletable ? toBgAssetUrl(meta.file) : meta.file;
          return (
            <button
              key={meta.id}
              type="button"
              data-slot="bg-theme-tile"
              onClick={() => select(meta.id)}
              aria-label={meta.name}
              aria-pressed={active}
              className={cn(
                'group relative size-16 overflow-hidden rounded-lg border bg-cover bg-center',
                active ? 'border-primary ring-2 ring-primary/40' : 'border-border',
              )}
              style={{ backgroundImage: `url("${thumbUrl}")` }}
            >
              {deletable && (
                <span
                  data-slot="bg-theme-delete"
                  role="button"
                  tabIndex={0}
                  aria-label={t('settings.background.delete')}
                  className="absolute right-0.5 top-0.5 hidden size-5 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white group-hover:flex"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(meta.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.stopPropagation();
                    e.preventDefault();
                    void handleDelete(meta.id);
                  }}
                >
                  <Trash2 className="size-3" />
                </span>
              )}
            </button>
          );
        })}

        <button
          type="button"
          data-slot="bg-theme-import"
          onClick={() => void handleImport()}
          disabled={importing}
          className="flex size-16 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-60"
        >
          <ImagePlus className="size-4" />
          <span className="text-[10px]">
            {importing ? t('settings.background.importing') : t('settings.background.import')}
          </span>
        </button>
      </div>

      {background.themeId && activeMeta && (
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('settings.background.scrim')}</span>
              <span className="tabular-nums">{background.scrim}</span>
            </div>
            <Slider
              value={[background.scrim]}
              min={0}
              max={100}
              step={1}
              aria-label={t('settings.background.scrim')}
              onValueChange={([v]) => {
                if (typeof v === 'number') useAppearanceStore.getState().setBackgroundScrim(v);
              }}
            />
          </div>

          {/* 焦点微调只对用户主题开放——预设的焦点是设计值，没有让用户改的必要。 */}
          {isUserBackgroundTheme(activeMeta.id) && (
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">
                {t('settings.background.focus')}
              </div>
              <div
                className="grid w-24 grid-cols-3 gap-1"
                role="group"
                aria-label={t('settings.background.focus')}
              >
                {FOCUS_GRID.flatMap((y) =>
                  FOCUS_GRID.map((x) => {
                    const fx = background.focusX ?? activeMeta.focus.x;
                    const fy = background.focusY ?? activeMeta.focus.y;
                    const focusActive = Math.abs(fx - x) < 0.01 && Math.abs(fy - y) < 0.01;
                    return (
                      <button
                        key={`${x}-${y}`}
                        type="button"
                        aria-label={`${Math.round(x * 100)}% ${Math.round(y * 100)}%`}
                        aria-pressed={focusActive}
                        onClick={() =>
                          useAppearanceStore.getState().setBackgroundFocus({ x, y })
                        }
                        className={cn(
                          'size-7 rounded-md border',
                          focusActive ? 'border-primary bg-primary/20' : 'border-border bg-secondary',
                        )}
                      />
                    );
                  }),
                )}
              </div>
            </div>
          )}

          <Button type="button" variant="outline" size="sm" onClick={applyAccentFromPhoto}>
            {t('settings.background.applyAccent')}
          </Button>
        </div>
      )}
    </div>
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
 * renderer picks them up.
 *
 * 历史：这里原本走独立设置窗口的 `window.electronSettings` 桥——那个
 * settings preload 已随设置窗口在 Phase 4 下线（本区块因此静默消失过）。
 * studio 单视图里 canvas 与 chat 同一 webContents、共享同一份 chatApi
 * preload，直接用它即可，不需要第二座桥。CLI backend 卡片曾在此，
 * 2026-07-16 迁至执行模式 section（CliBackendCard.tsx）。
 */
function DesktopAppearanceControls({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined;

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
