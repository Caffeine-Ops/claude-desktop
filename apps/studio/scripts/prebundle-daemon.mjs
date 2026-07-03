// Prebundle the Open Design daemon + resources into a self-contained tree that
// electron-builder copies into the packaged app's Resources/prebundled.
//
// Why: in dev the Electron shell spawns the daemon from the live monorepo
// (apps/daemon/dist/cli.js) with the whole 2.8G node_modules on disk. A
// packaged .app can't carry that. Mirroring open-design's tools-pack approach,
// we esbuild-bundle the daemon's ENTIRE JS dependency graph into one mjs and
// keep only the two native modules (better-sqlite3 / blake3-wasm) as external,
// copied alongside with their .node binaries. Resource dirs the daemon reads
// at runtime (skills, design-systems, …) and the web static export are copied
// verbatim.
//
// Layout produced (must mirror the monorepo so daemon's resolveProjectRoot(
// __dirname) === <prebundled root>, satisfying its OD_RESOURCE_ROOT-under-root
// security check):
//
//   prebundled/
//     apps/daemon/dist/daemon-cli.mjs        ← esbuild bundle (entry)
//     apps/daemon/dist/node_modules/         ← better-sqlite3, blake3-wasm, deps
//     apps/studio/out/                       ← next static export (app://studio serves it)
//     skills/ design-systems/ design-templates/ craft/ assets/
//     prompt-templates/ plugins/             ← daemon resource roots
//
// Run from apps/studio via `bun run prebundle:daemon` (bun resolves esbuild
// from the workspace store; plain `node` can't resolve it under bun's layout).

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// apps/studio/scripts → apps/studio → apps → repo root
const repoRoot = join(__dirname, '..', '..', '..')
const pkgRoot = join(__dirname, '..')
const out = join(pkgRoot, 'prebundled')

const daemonEntry = join(repoRoot, 'apps', 'daemon', 'dist', 'cli.js')
if (!existsSync(daemonEntry)) {
  console.error(`[prebundle] daemon entry not found: ${daemonEntry}\n` +
    `  build it first: bun run --filter='@open-design/daemon' build`)
  process.exit(1)
}

// Clean previous output so stale files never leak into the package.
rmSync(out, { recursive: true, force: true })

const daemonDistOut = join(out, 'apps', 'daemon', 'dist')
mkdirSync(daemonDistOut, { recursive: true })

console.log('[prebundle] bundling daemon with esbuild…')
const result = await build({
  bundle: true,
  format: 'esm',
  platform: 'node',
  // Match the system Node the shell spawns the daemon with (.nvmrc → 24).
  target: 'node24',
  entryPoints: [daemonEntry],
  outfile: join(daemonDistOut, 'daemon-cli.mjs'),
  // Native modules can't be bundled — keep them external and ship their
  // node_modules folders next to the bundle (resolved via the dist/node_modules
  // dir below). better-sqlite3 loads a .node; blake3-wasm loads a .wasm.
  external: ['better-sqlite3', 'blake3-wasm'],
  // Several transitive deps are CJS and call require(); an ESM bundle has no
  // require by default, so inject one bound to the bundle's own URL.
  banner: {
    js: 'import { createRequire as __odCreateRequire } from "node:module"; const require = __odCreateRequire(import.meta.url);'
  },
  logLevel: 'warning',
  metafile: true
})
console.log(`[prebundle] daemon bundle ok — ${Object.keys(result.metafile.inputs).length} inputs`)

// Copy the two native packages + their runtime deps into the bundle-adjacent
// node_modules so the external require() resolves them. prebuild-install is a
// build-time dep of better-sqlite3 and not needed at runtime — skip it.
const nativeNodeModules = join(daemonDistOut, 'node_modules')
mkdirSync(nativeNodeModules, { recursive: true })

/** Find a package's real dir under bun's flat store (node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>). */
function findPkgDir(pkg) {
  const bunStore = join(repoRoot, 'node_modules', '.bun')
  // Glob-free: scan store entries that start with "<pkg>@".
  const entries = readdirSync(bunStore)
  const match = entries.find((e) => e === pkg || e.startsWith(`${pkg}@`))
  if (!match) return null
  const dir = join(bunStore, match, 'node_modules', pkg)
  return existsSync(dir) ? dir : null
}

const RUNTIME_NATIVE_PKGS = ['better-sqlite3', 'blake3-wasm', 'bindings', 'file-uri-to-path']
for (const pkg of RUNTIME_NATIVE_PKGS) {
  const src = findPkgDir(pkg)
  if (!src) {
    console.error(`[prebundle] native runtime package not found in store: ${pkg}`)
    process.exit(1)
  }
  // Dereference symlinks (-L equivalent) so the .node binary is a real file in
  // the package, not a dangling link into the store.
  cpSync(src, join(nativeNodeModules, pkg), { recursive: true, dereference: true })
  console.log(`[prebundle] copied native pkg: ${pkg}`)
}

// Sanity-check the better-sqlite3 .node landed.
const sqliteNode = join(nativeNodeModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
if (!existsSync(sqliteNode)) {
  console.error(`[prebundle] better_sqlite3.node missing after copy: ${sqliteNode}`)
  process.exit(1)
}

// Copy the repo's .nvmrc into the prebundled root. The daemon MUST be spawned
// with the exact Node version its better-sqlite3 .node was compiled against
// (ABI 137 = Node 24); resolveNodeBin() reads <prebundled>/.nvmrc to pin the
// nvm absolute path. Without it, prod falls back to a bare `node` off PATH and
// hits whatever nvm version comes first — which is NOT necessarily the one the
// native module needs, causing ERR_DLOPEN_FAILED + daemon exit 1 + a 30s
// waitForDaemonReady timeout + "无法连接本地 daemon".
// See errors/2026-05-23-prod缺nvmrc回退裸node撞ABI致daemon起不来.md.
const nvmrcSrc = join(repoRoot, '.nvmrc')
if (existsSync(nvmrcSrc)) {
  cpSync(nvmrcSrc, join(out, '.nvmrc'))
  console.log('[prebundle] copied .nvmrc')
} else {
  console.warn('[prebundle] .nvmrc missing — prod daemon may pick wrong Node ABI')
}

// （apps/web 已随 Phase 4 物理下线——prod 唯一 UI 是 studio/out。）

// studio 静态产物（单视图形态 prod 的唯一 UI，app://studio 读这里）。
// 缺失=打出来的包开屏就 404，按硬错误处理而不是 warning——单视图已是默认
// 形态，没有 studio 的包是废包（LEGACY_TABS 用户除外，但那是逃生门不是常态）。
const studioOut = join(repoRoot, 'apps', 'studio', 'out')
if (existsSync(studioOut)) {
  cpSync(studioOut, join(out, 'apps', 'studio', 'out'), { recursive: true, dereference: true })
  console.log('[prebundle] copied apps/studio/out')
} else {
  console.error(
    '[prebundle] apps/studio/out missing — 单视图 prod 开屏即 404。' +
      "先构建：bun run --filter='@claude-desktop/studio' build"
  )
  process.exit(1)
}

const RESOURCE_DIRS = [
  'skills',
  'design-systems',
  'design-templates',
  'craft',
  'assets',
  'prompt-templates',
  'plugins'
]
for (const dir of RESOURCE_DIRS) {
  const src = join(repoRoot, dir)
  if (!existsSync(src)) {
    console.warn(`[prebundle] resource dir missing, skipping: ${dir}`)
    continue
  }
  cpSync(src, join(out, dir), { recursive: true, dereference: true })
  console.log(`[prebundle] copied resource dir: ${dir}`)
}

console.log(`[prebundle] done → ${out}`)
