import type { Lang } from '../i18n'

/**
 * canvas 的界面语言（19 种 locale）→ chat 面的语言（只有 zh / en 两本字典）。
 *
 * 为什么是有损映射：设置页「界面语言」驱动的是 canvas 那套 i18n
 * （`src/canvas/i18n/`，19 本字典）；而 chat 面自带另一套更小的
 * （`src/chat/i18n.ts`，手写 zh/en 两本）。两套字典规模不对等，日语用户
 * 选了 ja，chat 面**没有**日语译文可给——只能退回 en，这与 canvas 侧
 * `t()` 的 `dict[key] ?? en[key]` 兜底链是同一个方向，不是新引入的降级。
 *
 * 判据用前缀而不是白名单：canvas 的 Locale 里中文只有 zh-CN / zh-TW 两个，
 * 但将来若加 zh-HK 之类，这里零改动就跟上；反过来漏配一个新语言只会让它
 * 落 en（可用但英文），不会崩。
 */
export function chatLangForLocale(locale: string): Lang {
  return locale.startsWith('zh') ? 'zh' : 'en'
}
