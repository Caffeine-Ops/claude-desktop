import type { Lang } from '../../../i18n'

/** Two-lang string picker. Kept tiny so each formatter stays readable. */
export function pick(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Minimal JSON string unescape. Handles the escapes allowed inside a
 * JSON string literal (`\n` `\r` `\t` `\\` `\"` `\/` `\b` `\f`
 * `\uXXXX`) so streaming-extracted fragments render as the real
 * characters instead of the backslash noise that lives in the
 * underlying JSON blob.
 */
export function unescapeJsonString(src: string): string {
  return src.replace(/\\([nrtbf"\\/]|u[0-9a-fA-F]{4})/g, (_, esc: string) => {
    if (esc === 'n') return '\n'
    if (esc === 'r') return '\r'
    if (esc === 't') return '\t'
    if (esc === 'b') return '\b'
    if (esc === 'f') return '\f'
    if (esc === '"') return '"'
    if (esc === '\\') return '\\'
    if (esc === '/') return '/'
    if (esc.startsWith('u')) {
      return String.fromCharCode(parseInt(esc.slice(1), 16))
    }
    return esc
  })
}

/**
 * Last path segment — used to keep long absolute paths out of the
 * one-line headline. `title={fullPath}` on the caller restores access.
 */
export function basename(p: string): string {
  if (!p) return p
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed
}
