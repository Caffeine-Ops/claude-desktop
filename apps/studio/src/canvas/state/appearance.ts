import type { AppTheme } from '../types';

// '--od-accent' 而非 '--accent'：canvas 的 legacy accent（完整颜色值）与
// design-tokens 的共享 --accent（HSL 三元组）曾同名。这里往 documentElement
// 写 inline style 是全 document 最高优先级——旧名会把 chat 面所有
// hsl(var(--accent)) 打成无效值（2026-07-03 撞名事故）。-strong/-soft 等
// 派生名共享 token 没有定义，不撞，保持原名。
const ACCENT_VARS = [
  '--od-accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-tint',
  '--accent-hover',
] as const;

export const DEFAULT_ACCENT_COLOR = '#c96442';
export const ACCENT_SWATCHES = [
  DEFAULT_ACCENT_COLOR,
  '#2563eb',
  '#7c3aed',
  '#059669',
  '#dc2626',
  '#d97706',
  '#0891b2',
  '#db2777',
] as const;

export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolveAccentColor(value: unknown): string {
  return normalizeAccentColor(value) ?? DEFAULT_ACCENT_COLOR;
}

function accentVars(accentColor: string): Record<(typeof ACCENT_VARS)[number], string> {
  return {
    '--od-accent': accentColor,
    // Keep these mix ratios in sync with the pre-hydration script in app/layout.tsx.
    '--accent-strong': `color-mix(in srgb, ${accentColor} 86%, var(--text-strong))`,
    '--accent-soft': `color-mix(in srgb, ${accentColor} 22%, var(--bg-panel))`,
    '--accent-tint': `color-mix(in srgb, ${accentColor} 12%, var(--bg-panel))`,
    '--accent-hover': `color-mix(in srgb, ${accentColor} 90%, var(--text-strong))`,
  };
}

export function applyAppearanceToDocument({
  theme,
  accentColor,
}: {
  theme?: AppTheme;
  accentColor?: string;
}): void {
  const root = document.documentElement;
  // 明暗双标记桥接（对称实现见 chat 侧 appearance.applier.ts）：canvas CSS
  // 认 data-theme，chat CSS 认 .dark 类——单写一种会让两面明暗分裂，所以
  // 每次落 data-theme 时同步翻 .dark；system 模式按 matchMedia 解析后同样
  // 双写，保证任意时刻两种标记指向同一明暗。
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
    root.classList.toggle('dark', theme === 'dark');
  } else {
    root.removeAttribute('data-theme');
    root.classList.toggle(
      'dark',
      window.matchMedia('(prefers-color-scheme: dark)').matches
    );
  }

  const normalized = resolveAccentColor(accentColor);
  const vars = accentVars(normalized);
  for (const name of ACCENT_VARS) {
    root.style.setProperty(name, vars[name]);
  }
}
