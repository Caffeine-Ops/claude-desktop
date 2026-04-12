import { basename, dirname } from 'node:path'
import type { PermissionRuleValue } from '@anthropic-ai/claude-agent-sdk'

/**
 * Per-tool derivation of the info the permission dialog needs. This is
 * the one place we keep tool-specific knowledge so that the Agent SDK
 * wiring (engine.ts) and the renderer UI (PermissionDialog) stay
 * completely tool-agnostic.
 *
 * Four outputs per tool:
 *
 *   - `displayName` — user-friendly label above the dialog card
 *                     ("Read file", "Run shell command", …)
 *   - `summary`     — short parameter snippet rendered in the dialog
 *                     code-block ("~/.zshrc", "git status", …)
 *   - `scopeLabel`  — human label for the "allow … during this session"
 *                     button, e.g. "reading from Downloads/". Undefined
 *                     when we don't know how to safely scope the tool;
 *                     the dialog then omits option #2 so the user only
 *                     sees Yes / No.
 *   - `rules`       — `PermissionRuleValue[]` handed back to the SDK as
 *                     `updatedPermissions.addRules` when the user picks
 *                     "allow during session". Empty ⇒ no rule is added
 *                     (the SDK treats that as allow-once).
 *
 * Rule-content format note
 * ------------------------
 * The SDK's rule engine uses a tool-specific mini-DSL for `ruleContent`.
 * For file-path tools the working assumption (matching the built-in
 * fusion-code rules) is a glob like `<dir>/**`. For shell commands we
 * don't yet trust a prefix match, so Bash's allow-session option simply
 * adds a tool-global rule (`{ toolName: 'Bash' }`). If future experiments
 * show the SDK handles Bash prefixes, tighten it here — nothing else
 * in the codebase needs to change.
 */
export interface ScopeInfo {
  displayName: string
  summary: string
  scopeLabel?: string
  rules: PermissionRuleValue[]
}

/**
 * Human labels for built-in tools. Anything not in this map falls back
 * to the raw tool name (e.g. a custom MCP tool called "slack_post").
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: 'Read file',
  Write: 'Write file',
  Edit: 'Edit file',
  NotebookEdit: 'Edit notebook',
  Bash: 'Run shell command',
  Glob: 'File search',
  Grep: 'Content search',
  WebFetch: 'Fetch URL',
  WebSearch: 'Web search',
  TodoWrite: 'Update task list',
  Task: 'Launch subagent'
}

export function deriveScope(toolName: string, input: unknown): ScopeInfo {
  const displayName = TOOL_DISPLAY_NAMES[toolName] ?? toolName
  const obj = isRecord(input) ? input : {}

  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const filePath = strField(obj.file_path) ?? strField(obj.notebook_path) ?? ''
      if (!filePath) {
        return { displayName, summary: '(no file path)', rules: [{ toolName }] }
      }
      const dir = dirname(filePath)
      const dirLabel = basename(dir) || dir || 'this directory'
      const verb =
        toolName === 'Read'
          ? 'reading from'
          : toolName === 'NotebookEdit'
            ? 'notebook edits in'
            : toolName === 'Write'
              ? 'writes in'
              : 'edits in'
      return {
        displayName,
        summary: compactPath(filePath),
        scopeLabel: `${verb} ${dirLabel}/`,
        rules: [{ toolName, ruleContent: `${dir}/**` }]
      }
    }

    case 'Bash': {
      const cmd = strField(obj.command) ?? ''
      const first = cmd.split(/\s+/, 1)[0] ?? ''
      return {
        displayName,
        summary: truncate(cmd || '(empty command)', 120),
        // Bash scoping is intentionally coarse — allow-session maps to
        // a tool-global rule. See the module header for why.
        scopeLabel: first ? `running shell commands` : undefined,
        rules: [{ toolName: 'Bash' }]
      }
    }

    case 'Glob':
    case 'Grep': {
      const path = strField(obj.path) ?? process.cwd()
      const pattern = strField(obj.pattern) ?? ''
      const dirLabel = basename(path) || path || 'this directory'
      const verb = toolName === 'Grep' ? 'searching inside' : 'globbing inside'
      return {
        displayName,
        summary: pattern ? `${pattern}  ·  ${compactPath(path)}` : compactPath(path),
        scopeLabel: `${verb} ${dirLabel}/`,
        rules: [{ toolName, ruleContent: `${path}/**` }]
      }
    }

    case 'WebFetch': {
      const url = strField(obj.url) ?? ''
      return {
        displayName,
        summary: truncate(url || '(no url)', 120),
        scopeLabel: 'fetching URLs for this session',
        rules: [{ toolName: 'WebFetch' }]
      }
    }

    case 'WebSearch': {
      const query = strField(obj.query) ?? ''
      return {
        displayName,
        summary: truncate(query || '(no query)', 120),
        scopeLabel: 'web searches for this session',
        rules: [{ toolName: 'WebSearch' }]
      }
    }

    default:
      // Unknown / custom tool — we have no safe scope, but still offer
      // a generic "trust for this session" option keyed on tool name.
      return {
        displayName,
        summary: truncate(safeStringify(obj), 160),
        scopeLabel: `using ${displayName} for this session`,
        rules: [{ toolName }]
      }
  }
}

/* ───────────────────────── helpers ───────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function strField(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function compactPath(p: string): string {
  const home = process.env.HOME ?? ''
  if (home && (p === home || p.startsWith(home + '/'))) {
    return '~' + p.slice(home.length)
  }
  return p
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
