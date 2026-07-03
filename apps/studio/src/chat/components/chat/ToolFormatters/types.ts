import React from 'react'

import type { Lang } from '../../../i18n'

/**
 * Friendly (human-readable) renderings for the tool-call cards in
 * ThreadView. Each formatter converts a tool's raw JSON args / result
 * into a short headline plus optional replacement panes that are
 * understandable by a non-engineer.
 *
 * The dispatcher is keyed by tool name. Tools without a formatter
 * (notably every MCP tool, plus obscure built-ins) fall through to the
 * default raw-JSON view in `ToolCallCard`, which stays intact.
 *
 * Per-pane semantics:
 *   - `undefined`  ⇒ let ToolCallCard render its default pane
 *   - `null`       ⇒ suppress the default pane (nothing is shown)
 *   - ToolPaneSpec ⇒ render the friendly pane in place of the default
 *
 * Keeping the contract symmetric for `input` and `output` means each
 * formatter can mix-and-match — e.g. Read returns only a headline and
 * leaves both default panes alone, while Bash replaces both.
 */

export type ToolPaneSpec = {
  label: string
  content: React.ReactNode
  copyText: string
}

export type FriendlyView = {
  headline?: React.ReactNode
  input?: ToolPaneSpec | null
  output?: ToolPaneSpec | null
}

export type FormatterCtx = {
  args: unknown
  /** Raw streaming JSON text — present while the tool call is still
   *  being generated and `args` is not yet parsed. Formatters can
   *  regex out partial fields here to render a preview instead of
   *  falling through to the default raw-JSON pane. */
  argsText?: string
  result: unknown
  running: boolean
  lang: Lang
}

export type Formatter = (ctx: FormatterCtx) => FriendlyView | null
