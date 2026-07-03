/**
 * canvas 面的挂载根 —— App 外面包 I18nProvider。
 *
 * 为什么需要这个薄壳（2026-07-03 语言页点不动的根因）：I18nProvider 原本
 * 住在 apps/web 自己的 app/layout.tsx（Next 壳层）里；Phase 3 画布迁移只搬
 * 了 web 的 src/**，Provider 没跟过来，而 useI18n() 的无 Provider 兜底是
 * **静默替身**（locale 锁死 'en'、setLocale 是空函数）——整个画布面锁死
 * 英文、设置页语言卡片点了没反应，零报错。
 *
 * 为什么包在这里而不是：
 *  - App 的 return 里 —— App 自己第一行就 useI18n()（:270），必须有外层。
 *  - SurfaceHost / 根 layout —— Provider 会脱离 dynamic(ssr:false) 边界，
 *    词典与 i18n 模块被拽进 layout chunk 参与 SSR；包在 canvas 模块图内
 *    则边界原样不动。
 *
 * SurfaceHost 的 dynamic import 指向本文件；App.tsx 保持上游原样（那个
 * 文件按 upstream rebase 友好原则尽量不动，见 EntryShell 头注释同款约定）。
 */

import { App } from './App';
import { I18nProvider } from './i18n';
import type { ComponentProps } from 'react';

export function AppRoot(props: ComponentProps<typeof App>) {
  return (
    <I18nProvider>
      <App {...props} />
    </I18nProvider>
  );
}
