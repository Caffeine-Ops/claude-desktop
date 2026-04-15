/**
 * Shared helpers for tool-call rendering. Pulled out of ThreadView.tsx
 * so ToolFormatters.tsx can use them without creating a circular
 * import back into the big chat file.
 */

/**
 * Stable JSON-stringify that never throws and passes strings through
 * unchanged. Used both for pane copy buttons and for `args`/`result`
 * bodies that we want to feed to the JSON highlighter.
 */
export function safeStringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Unwrap the tool-result payload into a plain string. Claude-Code-style
 * tools return text at the top level; newer SDKs wrap it in
 * `{ content: [{ type: 'text', text: '...' }] }`. Both shapes collapse
 * to the same display string.
 */
export function extractText(result: unknown): string {
  if (result === undefined) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : typeof part === 'string'
            ? part
            : ''
      )
      .join('')
  }
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    if (Array.isArray(obj.content)) return extractText(obj.content)
  }
  return safeStringify(result)
}

/**
 * Cheap field accessor for the free-form `args` objects that tool
 * calls hand us. Returns the trimmed string value or `undefined`.
 */
export function getStringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const v = (args as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Variant of `getStringArg` for numeric fields. Also accepts
 * stringified numbers since streaming tools sometimes JSON-stringify
 * numbers mid-argument.
 */
export function getNumberArg(args: unknown, key: string): number | undefined {
  if (!args || typeof args !== 'object') return undefined
  const v = (args as Record<string, unknown>)[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}
