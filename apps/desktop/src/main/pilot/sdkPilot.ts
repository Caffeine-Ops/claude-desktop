#!/usr/bin/env bun
/**
 * POC: drive fusion-code ./cli through @anthropic-ai/claude-agent-sdk.
 *
 * Purpose
 * -------
 * Verify that the agent SDK's `query()` function can spawn our local
 * fusion-code CLI binary and carry a conversation end-to-end over the
 * stream-json protocol. If this POC works, the Electron ChatEngine can
 * replace its direct `new QueryEngine(...)` path (which requires the
 * ~400-line free-code compat plugin in electron.vite.config.ts) with
 * a simple call to the same `query()`, and every feature that already
 * works in `./cli` — slash commands, skills, MCP, permissions, markdown,
 * tool UI, session memory — comes along for free.
 *
 * Run
 * ---
 *   cd claude-desktop
 *   bun run src/main/pilot/sdkPilot.ts                 # default prompt "hi"
 *   bun run src/main/pilot/sdkPilot.ts "your prompt"
 *
 * Standalone — this file does NOT pull in Electron. It reloads env.json
 * with its own tiny loader so the exact same mechanism behaves identically
 * in both the pilot and the live app.
 *
 * If this fails with "fusion-code CLI not found", update FUSION_CLI_PATH
 * below. If it fails with a spawn/protocol error, drop back to the
 * `spawnClaudeCodeProcess` callback option (see comment at bottom).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { query } from '@anthropic-ai/claude-agent-sdk'

// ─────────────────── configuration ───────────────────
const SELF_DIR = dirname(fileURLToPath(import.meta.url))
// apps/desktop/src/main/pilot/sdkPilot.ts  →  apps/desktop/ (bun monorepo)
const PROJECT_ROOT = resolve(SELF_DIR, '../../..')
// apps/desktop/ → up three more (claude-desktop, claude_code_01) → free-code/cli,
// a sibling of claude-desktop under claude_code_01/
const FUSION_CLI_PATH = resolve(PROJECT_ROOT, '../../../free-code/cli')
const PROMPT = process.argv.slice(2).join(' ').trim() || 'hi'
const TAG = '[pilot]'

// ─────────────────── env.json injection ──────────────
// Mirror src/main/bootstrap/loadEnv.ts: load env.json from the project
// root, shell env wins over file values. Keeps the POC independent of the
// Electron bootstrap chain so running it can't accidentally skip a step
// the real app relies on.
function loadEnvJson(): void {
  const envPath = resolve(PROJECT_ROOT, 'env.json')
  if (!existsSync(envPath)) {
    console.log(`${TAG} no env.json at ${envPath}`)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(envPath, 'utf8'))
  } catch (err) {
    console.error(`${TAG} failed to parse env.json:`, err)
    return
  }
  if (!isRecord(parsed) || !isRecord(parsed.env)) {
    console.warn(`${TAG} env.json has no "env" object — skipping`)
    return
  }
  let injected = 0
  let skipped = 0
  for (const [k, v] of Object.entries(parsed.env)) {
    if (typeof v !== 'string') continue
    if (Object.prototype.hasOwnProperty.call(process.env, k)) {
      skipped++
      continue
    }
    process.env[k] = v
    injected++
  }
  console.log(
    `${TAG} env.json: injected ${injected}, skipped ${skipped} (shell wins)`
  )
}

loadEnvJson()

// ─────────────────── sanity checks ───────────────────
if (!existsSync(FUSION_CLI_PATH)) {
  console.error(`${TAG} FATAL: fusion-code CLI not found at ${FUSION_CLI_PATH}`)
  console.error(`${TAG}   → build it first: cd ../free-code && bun run build`)
  process.exit(1)
}
console.log(`${TAG} fusion-code cli : ${FUSION_CLI_PATH}`)
console.log(`${TAG} cwd             : ${PROJECT_ROOT}`)
console.log(`${TAG} prompt          : ${JSON.stringify(PROMPT)}`)
console.log(`${TAG} auth            : ${describeAuth()}`)
console.log(`${TAG} base URL        : ${process.env.ANTHROPIC_BASE_URL ?? '(default)'}`)
console.log(`${TAG} model overrides : haiku=${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '-'} sonnet=${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '-'} opus=${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '-'}`)
console.log('')

// ─────────────────── drive the SDK ───────────────────
async function main(): Promise<void> {
  const started = Date.now()
  let msgCount = 0
  let assistantText = ''
  let lastResult: Record<string, unknown> | null = null

  try {
    const q = query({
      prompt: PROMPT,
      options: {
        // Point the SDK at our fusion-code binary instead of the
        // bundled upstream claude-code it would otherwise use.
        pathToClaudeCodeExecutable: FUSION_CLI_PATH,
        cwd: PROJECT_ROOT,
        // POC: skip all permission prompts. In the real integration we
        // wire canUseTool into an Electron dialog. bypassPermissions
        // requires allowDangerouslySkipPermissions as a safety flag.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // We want streaming text deltas (stream_event messages), not just
        // the final assistant blocks — mirrors ChatEngine's current shape.
        includePartialMessages: true,
        // env.json has already been merged into process.env; pass the
        // whole thing through so the child CLI sees ANTHROPIC_BASE_URL
        // and auth tokens.
        env: process.env as Record<string, string>
      }
    })

    for await (const msg of q) {
      msgCount++
      const summary = summarize(msg)
      console.log(`${TAG} msg #${msgCount.toString().padStart(3, ' ')}: ${summary}`)

      if (isRecord(msg) && msg.type === 'assistant') {
        assistantText += extractAssistantText(msg)
      }
      if (isRecord(msg) && msg.type === 'result') {
        lastResult = msg
      }
    }

    const elapsed = Date.now() - started
    console.log('')
    console.log(`${TAG} ──────────── DONE ────────────`)
    console.log(`${TAG} elapsed : ${elapsed}ms`)
    console.log(`${TAG} messages: ${msgCount}`)

    if (assistantText) {
      console.log(`${TAG} assistant text:`)
      const indented = assistantText
        .split('\n')
        .map((line) => `         │ ${line}`)
        .join('\n')
      console.log(indented)
    } else {
      console.log(`${TAG} WARN: no assistant text in the stream`)
    }

    if (lastResult) {
      console.log(`${TAG} result  :`, JSON.stringify({
        subtype: lastResult.subtype,
        is_error: lastResult.is_error,
        duration_ms: lastResult.duration_ms,
        num_turns: lastResult.num_turns,
        total_cost_usd: lastResult.total_cost_usd
      }))
    }
    if (lastResult?.is_error === true) {
      process.exit(2)
    }
  } catch (err) {
    console.error('')
    console.error(`${TAG} FATAL during query():`, err)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    console.error('')
    console.error(`${TAG} if the SDK could not spawn ${FUSION_CLI_PATH},`)
    console.error(`${TAG} try the spawnClaudeCodeProcess escape hatch — see`)
    console.error(`${TAG} comment at the bottom of this file.`)
    process.exit(1)
  }
}

// ─────────────────── helpers ───────────────────
function describeAuth(): string {
  if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY=(set)'
  if (process.env.ANTHROPIC_AUTH_TOKEN) return 'ANTHROPIC_AUTH_TOKEN=(set)'
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN=(set)'
  return '(none)'
}

function summarize(msg: unknown): string {
  if (!isRecord(msg)) return '(non-object)'
  const bits: string[] = []
  if (typeof msg.type === 'string') bits.push(msg.type)
  if (typeof msg.subtype === 'string') bits.push(`[${msg.subtype}]`)
  if (isRecord(msg.message)) {
    const m = msg.message
    if (Array.isArray(m.content)) {
      const types = m.content
        .map((b: unknown) =>
          isRecord(b) && typeof b.type === 'string' ? b.type : '?'
        )
        .join(',')
      bits.push(`content=[${types}]`)
    }
    if (typeof m.model === 'string') bits.push(`model=${m.model}`)
    if (isRecord(m.usage)) {
      if (typeof m.usage.input_tokens === 'number') {
        bits.push(`in=${m.usage.input_tokens}`)
      }
      if (typeof m.usage.output_tokens === 'number') {
        bits.push(`out=${m.usage.output_tokens}`)
      }
    }
  }
  if (isRecord(msg.event)) {
    const e = msg.event
    if (typeof e.type === 'string') bits.push(`event=${e.type}`)
    if (isRecord(e.delta) && typeof e.delta.type === 'string') {
      bits.push(`delta=${e.delta.type}`)
      if (typeof e.delta.text === 'string' && e.delta.text.length > 0) {
        const preview = e.delta.text.length > 40
          ? `${e.delta.text.slice(0, 40)}…`
          : e.delta.text
        bits.push(`"${preview.replace(/\n/g, '\\n')}"`)
      }
    }
  }
  if (msg.is_error === true) bits.push('is_error=true')
  return bits.join(' ') || '(empty)'
}

function extractAssistantText(msg: Record<string, unknown>): string {
  const message = msg.message
  if (!isRecord(message)) return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

main().catch((err) => {
  console.error(`${TAG} unhandled:`, err)
  process.exit(1)
})

// ─────────────────── escape hatch (not wired by default) ───────────────────
// If `pathToClaudeCodeExecutable` alone doesn't work (SDK rejects binary
// or can't locate a required runtime), wire this into options instead:
//
//   import { spawn } from 'node:child_process'
//   options: {
//     spawnClaudeCodeProcess: (spawnOptions) => {
//       return spawn(FUSION_CLI_PATH, spawnOptions.args, {
//         cwd: spawnOptions.cwd,
//         env: spawnOptions.env,
//         signal: spawnOptions.signal,
//         stdio: ['pipe', 'pipe', 'pipe']
//       })
//     }
//   }
//
// The SDK will forward SpawnOptions with the correct stream-json flags
// already baked in; we just need to invoke the right executable.
