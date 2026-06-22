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
import { dirname, parse as parsePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = '[loadEnv]'

/**
 * Keys this module actually injected from env.json (i.e. keys NOT already
 * present in the shell env). Lets consumers tell an "ambient leak from
 * env.json" apart from "the user deliberately exported this in their
 * shell" — the latter we must respect, the former we may strip for a
 * specific child process.
 *
 * Concretely: env.json carries a csdn gateway (ANTHROPIC_BASE_URL +
 * ANTHROPIC_DEFAULT_*_MODEL=gpt-5.4) meant ONLY for the bundled
 * fusion-code backend. When the user picks "System claude", the engine
 * strips the env.json-injected ANTHROPIC_* keys so vanilla claude falls
 * back to its own ~/.claude login instead of being hijacked onto csdn.
 * A key the user exported themselves stays put (it's not in this set).
 */
const injectedKeys = new Set<string>()

/** Keys injected from env.json (not pre-existing in the shell). */
export function envJsonInjectedKeys(): ReadonlySet<string> {
  return injectedKeys
}

/**
 * Walk up from `start` to the filesystem root, returning the first ancestor
 * that looks like the workspace/monorepo root — a directory holding a bun
 * lockfile, or a package.json with a top-level `workspaces` field. Returns
 * that dir, or null if none is found before reaching the fs root.
 *
 * Why a marker search instead of a fixed `../../` climb: the previous code
 * hard-coded the apps/desktop nesting depth. Any layout change (moving the
 * package, an extra level) silently broke it — or worse, the blind climb
 * could match an UNRELATED env.json two levels up and inject the wrong
 * credentials. A marker search locates the real root at any depth and only
 * ever points at a directory that is actually a workspace root.
 */
function findWorkspaceRoot(start: string): string | null {
  const { root } = parsePath(start)
  let dir = start
  for (;;) {
    if (
      existsSync(resolve(dir, 'bun.lock')) ||
      existsSync(resolve(dir, 'bun.lockb')) ||
      hasWorkspacesField(resolve(dir, 'package.json'))
    ) {
      return dir
    }
    if (dir === root) return null
    dir = dirname(dir)
  }
}

/** True iff `pkgPath` is a readable package.json declaring `workspaces`. */
function hasWorkspacesField(pkgPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      workspaces?: unknown
    }
    return pkg.workspaces !== undefined
  } catch {
    return false
  }
}

function candidatePaths(): string[] {
  const cwd = process.cwd()
  const selfDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // Typical single-package dev: `bun run dev` invoked from the package dir.
    resolve(cwd, 'env.json'),
    // Packaged / bundled fallback: main bundle lives at out/main/index.js,
    // so two levels up lands at the project root.
    resolve(selfDir, '../../env.json')
  ]
  // bun monorepo (current layout): root `bun run dev` delegates via
  // `--filter='@claude-desktop/desktop' dev`, which runs electron-vite with
  // cwd = apps/desktop. The candidates above resolve INSIDE apps/desktop/,
  // but the real env.json lives at the monorepo root (apps/desktop has none).
  // Find that root by marker search (depth-independent, never matches a stray
  // grandparent) and append its env.json. existsSync-gated below and last in
  // line, so the prod/single-package hits above still win first.
  const root = findWorkspaceRoot(cwd)
  if (root) candidates.push(resolve(root, 'env.json'))
  return candidates
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

loadEnvFromFile()
