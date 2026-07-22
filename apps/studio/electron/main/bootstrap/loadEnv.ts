/**
 * Loads environment variables from <project>/env.json into process.env.
 *
 * This module runs its side effect at import time. It MUST be the very
 * first import of src/main/index.ts: ESM evaluates a module's dependencies
 * depth-first, in the order they are declared, so importing this file first
 * guarantees process.env is populated before @fc/tools and other free-code
 * modules are initialized (some of which read process.env at module load).
 *
 * Shell env always wins — we only set a key if it is not already defined.
 * This lets developers override individual values with `export FOO=bar`
 * without editing the file.
 *
 * env.json format:
 *   { "env": { "NAME": "value", ... } }
 *
 * env.json carries real credentials. It is listed in .gitignore. Do not
 * commit it, paste it, or log its values.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = '[loadEnv]'

/**
 * Keys this module (or {@link applyRemoteEnvConfig}) actually injected —
 * i.e. keys NOT already present in the shell env. Lets consumers tell an
 * "ambient leak from env.json / sub2api" apart from "the user deliberately
 * exported this in their shell" — the latter we must respect, the former we
 * may strip for a specific child process.
 *
 * Concretely: env.json (and its live sub2api replacement, see below) carry
 * a csdn gateway (ANTHROPIC_BASE_URL + ANTHROPIC_DEFAULT_*_MODEL) meant
 * ONLY for the bundled fusion-code backend. When the user picks "System
 * claude", the engine strips these injected ANTHROPIC_* keys so vanilla
 * claude falls back to its own ~/.claude login instead of being hijacked
 * onto csdn. A key the user exported themselves stays put (it's not in
 * this set — see {@link shellOwnedKeys}).
 */
const injectedKeys = new Set<string>()

/**
 * Snapshot of every key that existed in `process.env` BEFORE this module
 * touched anything — i.e. genuinely exported by the user's shell. Captured
 * once, at the top of {@link loadEnvFromFile}'s call site (module load),
 * so it stays valid as the one authority `applyRemoteEnvConfig` consults to
 * decide "shell wins" — independent of whichever keys env.json happened to
 * carry (loadEnvFromFile's own hasOwnProperty check only covers ITS keys).
 */
let shellOwnedKeys: ReadonlySet<string> = new Set()

/** Keys injected from env.json (not pre-existing in the shell). */
export function envJsonInjectedKeys(): ReadonlySet<string> {
  return injectedKeys
}

/**
 * Applies the per-user client environment config fetched from sub2api's
 * `GET /api/v1/keys/client-config` (see clientEnvConfigService.ts) on top
 * of `process.env`, replacing whatever env.json hardcoded (a single shared
 * ANTHROPIC_AUTH_TOKEN/OPENAI_API_KEY/GEMINI_API_KEY baked into every
 * shipped build) with values scoped to the signed-in user.
 *
 * Same "shell always wins" rule as env.json: a key the user genuinely
 * exported in their OWN shell (present in {@link shellOwnedKeys}) is left
 * alone — this lets a developer `export ANTHROPIC_BASE_URL=...` locally
 * without a background config fetch silently clobbering it. Every other
 * key is overwritten unconditionally (remote is fresher than env.json's
 * baked-in placeholder) and folded into {@link injectedKeys}, so
 * `systemBackendEnv()` strips it under "System claude" exactly like an
 * env.json key — these are still csdn-gateway credentials, not the user's
 * own Anthropic login.
 *
 * Returns the keys actually applied (for logging) — callers don't need to
 * know which ones were skipped as shell-owned.
 */
export function applyRemoteEnvConfig(config: Record<string, string>): string[] {
  const applied: string[] = []
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') continue
    if (shellOwnedKeys.has(key)) continue
    process.env[key] = value
    injectedKeys.add(key)
    applied.push(key)
  }
  return applied
}

function candidatePaths(): string[] {
  const cwd = process.cwd()
  const selfDir = dirname(fileURLToPath(import.meta.url))
  return [
    // Single-package dev / same-dir layout: env.json sits next to cwd.
    resolve(cwd, 'env.json'),
    // Packaged / bundled fallback: main bundle lives at out-electron/main/index.js,
    // so two levels up lands next to the packaged resources root.
    resolve(selfDir, '../../env.json'),
    // Monorepo dev — the real reason both above miss (regression of the
    // 2026-06-18 fix, dropped by the 2026-07-03 desktop→studio merge):
    // `bun run dev` is `bun run --filter='@claude-desktop/studio' dev`, so the
    // electron process cwd is apps/studio/ and selfDir is
    // apps/studio/out-electron/main/. Both candidates above then resolve to a
    // non-existent apps/studio/env.json, and the ONLY real env.json — the repo
    // root claude-desktop/env.json carrying FUSION_CODE_CLI_PATH — is never
    // tried. These two reach it from either anchor:
    //   apps/studio            → ../../env.json           = claude-desktop/env.json
    //   apps/studio/out-electron/main → ../../../../env.json = claude-desktop/env.json
    // existsSync-guarded and ordered last, so prod/single-package still hit the
    // candidates above first and this never false-matches a stray file.
    resolve(cwd, '../../env.json'),
    resolve(selfDir, '../../../../env.json')
  ]
}

function loadEnvFromFile(): void {
  const paths = candidatePaths()
  for (const path of paths) {
    if (!existsSync(path)) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      console.error(`${TAG} failed to parse ${path}:`, err)
      return
    }

    const envMap = extractEnvMap(parsed)
    if (!envMap) {
      console.warn(`${TAG} ${path} has no "env" object — skipping`)
      return
    }

    let injected = 0
    let skipped = 0
    for (const [key, value] of Object.entries(envMap)) {
      if (typeof value !== 'string') continue
      if (Object.prototype.hasOwnProperty.call(process.env, key)) {
        skipped++
        continue
      }
      process.env[key] = value
      injectedKeys.add(key)
      injected++
    }
    console.log(
      `${TAG} loaded ${injected} vars from ${path}` +
        (skipped > 0 ? ` (${skipped} already set in shell, left alone)` : '')
    )
    return
  }
  console.log(`${TAG} no env.json found (tried: ${paths.join(', ')})`)
}

function extractEnvMap(parsed: unknown): Record<string, unknown> | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const env = (parsed as Record<string, unknown>).env
  if (typeof env !== 'object' || env === null) return null
  return env as Record<string, unknown>
}

shellOwnedKeys = new Set(Object.keys(process.env))
loadEnvFromFile()
