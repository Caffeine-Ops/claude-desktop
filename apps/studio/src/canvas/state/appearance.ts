import { createThemeTransitionGate } from '@/src/lib/themeTransition';

import type { AppTheme } from '../types';

/** 本写手专属的闸门（chat 的 applier 另持一个，理由见 themeTransition.ts）。 */
const themeGate = createThemeTransitionGate();

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

// 2026-07-07 默认主题色改为绿（原为首格赭色 #c96442）。
// 2026-07-08 用户要求：色板首位加 UI 品牌绿 #16a34a（rail 主按钮/logo 同款，
// tokens.css --brand 的 hex），其余顺移一位。DEFAULT_ACCENT_COLOR 不变
// （已持久化的用户 normalizeAccentColor 命中即用存值，不受色板顺序影响）。
export const DEFAULT_ACCENT_COLOR = '#059669';
export const ACCENT_SWATCHES = [
  '#16a34a',
  '#c96442',
  '#2563eb',
  '#7c3aed',
  DEFAULT_ACCENT_COLOR,
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
  // 本次要落的明暗先解析出来（闸门要用它比对本写手上次写的值）。
  //
  // system：按 matchMedia 解析后仍然**显式写** data-theme，不再
  // removeAttribute——chat 写手（appearance.applier.ts）依赖「data-theme
  // 永不留空」的契约压掉 canvas CSS 的 @media 兜底分支；这里留空会让
  // 两面标记再度分叉（canvas 跟 @media 实时走、.dark 冻结在解析瞬间）。
  // 解析值与 @media 兜底此刻等价，显式写不改变视觉、只锁一致性。
  const nextDark =
    theme === 'light' || theme === 'dark'
      ? theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;

  // 翻明暗这一拍掐掉全局 transition，否则带 transition 的元素会把换色演成
  // 150ms 动画、比无 transition 的底色慢半拍（2026-07-17，实测与三步顺序见
  // lib/themeTransition.ts）。chat 侧 applier 持有另一个闸门做同样处理——两个
  // 写手串联时各判各的「上次写了什么」，谁先翻标记都不会让后一个漏掐。
  themeGate(nextDark, () => {
    // 明暗双标记桥接（对称实现见 chat 侧 appearance.applier.ts）：canvas CSS
    // 认 data-theme，chat CSS 认 .dark 类——单写一种会让两面明暗分裂，所以
    // 每次落 data-theme 时同步翻 .dark，保证任意时刻两种标记指向同一明暗。
    root.setAttribute('data-theme', nextDark ? 'dark' : 'light');
    root.classList.toggle('dark', nextDark);

    const normalized = resolveAccentColor(accentColor);
    const vars = accentVars(normalized);
    for (const name of ACCENT_VARS) {
      root.style.setProperty(name, vars[name]);
    }
  });

  // 同 document 即时广播（与走 daemon 的 'od:appearance-changed' 是两条不同
  // 语义的通道，勿合并）：chat 面的主体颜色被它的 applier 以 inline token
  // 钉在 documentElement.style 上，光翻上面的双标记压不动它们——若只靠
  // 「syncConfigToDaemon 成功 → od:appearance-changed → chat 再 GET daemon」
  // 的持久化链，chat 要晚两次网络往返才变色，主题切换看起来「一点点变」
  // （2026-07-04 分拍事故）。这里在标记落地的同一帧把 themeMode 直接递给
  // chat（src/chat/App.tsx 监听），chat 同帧改 store 重写 inline token，
  // 切换一拍完成；持久化校准链保持原样。detail 只带模式不带颜色：颜色
  // 归 chat 自己的 store 管。chat 侧「值相同不 set」断回声环。
  window.dispatchEvent(
    new CustomEvent('od:theme-mode-applied', {
      detail: { themeMode: theme === 'light' || theme === 'dark' ? theme : 'system' },
    })
  );
}
