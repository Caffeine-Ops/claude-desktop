'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import { LOCALES, type Dict, type Locale } from './types';

export { LOCALES, LOCALE_LABEL } from './types';
export type { Locale } from './types';

type DictKey = keyof Dict;

/**
 * 19 本字典约 2MB 源码，全静态 import 会把它们无条件塞进首屏 chunk（实测落在
 * 两个 1891.8KB 的 chunk 里、且两个入口各打一份）。而一个用户只可能用其中一种。
 *
 * 于是分两类：
 *
 * **静态内联 2 本**
 *   · `en` —— **兜底字典，必须同步可用**。`t()` 的取值链是
 *     `dict[key] ?? en[key] ?? key`，无 Provider 的兜底分支也直接读它；把它变
 *     成异步的，首帧会连英文都没有，整个 UI 拿不到任何文案。
 *   · `zh-CN` —— 主要用户群。多留这一本（~100KB）换中文用户零闪烁，划算。
 *
 * **其余 17 本动态 import**，切到那些语言时才从磁盘读对应 chunk。加载完成前
 * `t()` 自动走上面那条 `?? en[key]` 兜底链——**所以 t() 的逻辑一个字都不用改**，
 * 代价只是非中英文用户首帧短暂显示英文。这是 Electron、读的是本地文件而非网络，
 * 毫秒级，基本看不见。
 */
const STATIC_DICTS: Partial<Record<Locale, Dict>> = {
  'en': en,
  'zh-CN': zhCN,
};

/**
 * 按需加载表。**每个 import() 的路径必须是字面量**——打包器靠静态分析这个字符串
 * 切 chunk，写成 `import(`./locales/${locale}`)` 会退化成「把整个目录都打进来」，
 * 那就白改了。
 */
const LAZY_DICTS: Partial<Record<Locale, () => Promise<Dict>>> = {
  'id': () => import('./locales/id').then((m) => m.id),
  'de': () => import('./locales/de').then((m) => m.de),
  'zh-TW': () => import('./locales/zh-TW').then((m) => m.zhTW),
  'pt-BR': () => import('./locales/pt-BR').then((m) => m.ptBR),
  'es-ES': () => import('./locales/es-ES').then((m) => m.esES),
  'ru': () => import('./locales/ru').then((m) => m.ru),
  'fa': () => import('./locales/fa').then((m) => m.fa),
  'ar': () => import('./locales/ar').then((m) => m.ar),
  'ja': () => import('./locales/ja').then((m) => m.ja),
  'ko': () => import('./locales/ko').then((m) => m.ko),
  'pl': () => import('./locales/pl').then((m) => m.pl),
  'hu': () => import('./locales/hu').then((m) => m.hu),
  'fr': () => import('./locales/fr').then((m) => m.fr),
  'uk': () => import('./locales/uk').then((m) => m.uk),
  'tr': () => import('./locales/tr').then((m) => m.tr),
  'th': () => import('./locales/th').then((m) => m.th),
  'it': () => import('./locales/it').then((m) => m.it),
};

// 开发期完整性检查：新增语言时漏登记 loader 会**静默锁英文**（零报错，和
// 2026-07-03 Provider 漏搬那次同一种病）。同 skills/writing 的
// validate_library.py 抓「新增手册漏登记进 _index.md」的思路。
if (process.env.NODE_ENV !== 'production') {
  const orphans = LOCALES.filter((l) => !STATIC_DICTS[l] && !LAZY_DICTS[l]);
  if (orphans.length) {
    console.error(
      `[i18n] 这些语言既不在 STATIC_DICTS 也没有 LAZY_DICTS loader，切过去会静默锁英文：${orphans.join(', ')}`,
    );
  }
}

const LS_KEY = 'open-design:locale';

export function resolveSystemLocale(languages: readonly string[]): Locale | null {
  const supported = LOCALES as readonly string[];
  for (const raw of languages) {
    const normalized = raw.trim();
    if (!normalized) continue;

    const exact = LOCALES.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;

    const [language, regionOrScript] = normalized.toLowerCase().split('-');
    if (language === 'zh') {
      if (regionOrScript === 'hant' || regionOrScript === 'tw' || regionOrScript === 'hk' || regionOrScript === 'mo') {
        return 'zh-TW';
      }
      return 'zh-CN';
    }

    const baseMatch = LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language);
    if (baseMatch && supported.includes(baseMatch)) return baseMatch;
  }
  return null;
}

// First-run defaults to the user's browser/system language when possible.
// An explicit user pick saved to localStorage always wins; unsupported
// languages fall back to English.
function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(LS_KEY);
    if (stored && (LOCALES as string[]).includes(stored)) {
      return stored as Locale;
    }
  } catch {
    /* ignore */
  }
  const detected = resolveSystemLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language],
  );
  return detected ?? 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

// useI18n 无 Provider 兜底的一次性告警闸（见 useI18n 内注释）。
let warnedMissingProvider = false;

interface ProviderProps {
  initial?: Locale;
  children: ReactNode;
}

const RTL_LOCALES: Locale[] = ['ar', 'fa'];

export function I18nProvider({ initial, children }: ProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initial ?? detectInitialLocale());
  // 手上已有的字典：静态那两本 + 已按需加载回来的。
  const [dicts, setDicts] = useState<Partial<Record<Locale, Dict>>>(STATIC_DICTS);

  /**
   * 当前语言的字典还没到手就去加载它。
   *
   * **竞态是这里唯一的坑**：用户快速连切 fr → de → ja 时，三个 import() 的完成
   * 顺序不保证，晚发起的可能先回来。cleanup 里的 cancelled 标志保证只有「当前
   * 这次 effect」的结果会被采纳，过期的一律丢弃——否则界面会停在中途某个语言，
   * 而且是那种「偶尔才出现、复现不了」的 bug。
   *
   * 已加载过的语言再切回来会重新调 import()，但模块已在内存里，那次是同步
   * resolve 的，成本可忽略；setDicts 里再挡一道，避免无意义的重渲染。
   */
  useEffect(() => {
    const load = LAZY_DICTS[locale];
    if (!load) return; // 静态内联的那两本，或未登记的语言（dev 下已报错）
    let cancelled = false;
    void load()
      .then((dict) => {
        if (cancelled) return;
        setDicts((prev) => (prev[locale] ? prev : { ...prev, [locale]: dict }));
      })
      .catch((err: unknown) => {
        // 加载失败不致命：t() 会继续走 en 兜底，UI 是英文但可用。
        console.error(`[i18n] 语言包 ${locale} 加载失败，暂时回退英文`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  // Keep <html lang="…" dir="…"> in sync so screen readers and CSS hooks
  // pick the right language token and direction without each component
  // having to set it itself.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const dir = RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
      document.documentElement.setAttribute('lang', locale);
      document.documentElement.setAttribute('dir', dir);
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LS_KEY, next);
    } catch {
      /* ignore */
    }
    // 同 document 广播给 chat 面（监听方：src/chat/LocaleBridge.tsx）。
    // chat 面自带另一套 i18n（zh/en 两本，独立持久化在
    // `claude-desktop:lang`），本函数**不**触及它——两套 store 互不
    // 知晓，不广播的话「设置页选中文、智能助手空态仍是英文」（2026-09-01
    // 实锤：canvas 已是 zh-CN，chat 卡在 en，且 chat 那套当时已无任何 UI
    // 入口可改）。做法照抄主题的 `od:theme-mode-applied` 即时广播通道
    // （见 canvas/state/appearance.ts 那段注释），同为「canvas 是写手、
    // chat 是订阅者」的单向桥。
    window.dispatchEvent(
      new CustomEvent('od:locale-applied', { detail: { locale: next } })
    );
  }, []);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>): string => {
      // 取值链与改造前完全一致，只是数据源从常量表换成了 state：字典还在路上
      // 时 `dicts[locale]` 是 undefined，自然落到 en —— 这正是我们要的降级。
      const dict = dicts[locale] ?? en;
      const raw = dict[key] ?? en[key] ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, name: string) => {
        const v = vars[name];
        return v == null ? `{${name}}` : String(v);
      });
    },
    // dicts 必须在依赖里：字典异步到手后要靠这个身份变化触发重渲染，
    // 漏了它界面会一直停在英文（而且没有任何报错）。
    [locale, dicts],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fall back to a stand-alone English translator when no provider is
    // mounted (e.g. an isolated test). This keeps the API safe to call
    // without requiring every callsite to wrap in a provider.
    //
    // ⚠️ 这个兜底在应用里出现即事故：它是**静默替身**（locale 锁 'en'、
    // setLocale 空函数），Provider 丢失时整个 UI 锁死英文、语言切换点了
    // 没反应且零报错——2026-07-03 画布迁移把 Provider（原住 apps/web 的
    // app/layout.tsx）漏在了搬迁清单外，靠它掩护潜伏到用户报障才被发现。
    // dev 下必须吼一声；只吼一次，避免每个 useI18n 调用点刷屏。
    if (process.env.NODE_ENV !== 'production' && !warnedMissingProvider) {
      warnedMissingProvider = true;
      console.warn(
        '[i18n] useI18n() called outside <I18nProvider> — falling back to a ' +
          'no-op English stub. Language switching WILL NOT work. Mount the ' +
          'provider (see src/canvas/AppRoot.tsx).',
      );
    }
    return {
      locale: 'en',
      setLocale: () => { },
      t: (key, vars) => {
        const raw = en[key] ?? key;
        if (!vars) return raw;
        return raw.replace(/\{(\w+)\}/g, (_, n: string) => {
          const v = vars[n];
          return v == null ? `{${n}}` : String(v);
        });
      },
    };
  }
  return ctx;
}

// Convenience for components that only need the translator function.
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
