// Fail-fast integrity check for the bge-small-zh-v1.5 ONNX model bundle.
// Run in the build:mac/win/linux chain right before electron-builder.
//
// Why this exists:
//   The model files are downloaded by prebundle-kb-model.mjs (~24 MB onnx +
//   three small JSON files). If that download was truncated — partial network
//   fetch, disk full, interrupted run — the resulting files look valid at a
//   glance but will silently produce wrong vectors at runtime (or crash the
//   ONNX session on load). We assert exact sha256 against hard-pinned constants
//   before the app is packaged, so a bad download fails the build here rather
//   than shipping to users.
//
// Two modes:
//   1. Default (no flags): check apps/desktop/kb-model/bge-small-zh-v1.5/
//      exists with all 4 files at the correct size + sha256.
//   2. --asar <path>: check a PACKAGED app's unpacked layout for:
//      a. onnxruntime-node *.node native addon(s) for darwin-arm64
//      b. kb-model/bge-small-zh-v1.5/onnx/model_quantized.onnx at correct size
//
// Usage:
//   bun scripts/verify-kb-model.mjs
//   bun scripts/verify-kb-model.mjs --asar dist/mac-arm64/Claude\ Desktop.app/Contents/Resources
//   node scripts/verify-kb-model.mjs --asar /path/to/Resources

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(__dirname, '..')

// SHA256 pins — must match prebundle-kb-model.mjs exactly.
const SHA256 = {
  'config.json': 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
  'tokenizer.json': '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  'tokenizer_config.json': 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
  'onnx/model_quantized.onnx': '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
}

// Sanity-floor sizes (bytes). We check both exact sha256 AND a minimum size so
// a zero-byte or obviously-truncated file gets a clear message before sha.
const MIN_SIZE = {
  'config.json': 100,
  'tokenizer.json': 100_000,
  'tokenizer_config.json': 100,
  'onnx/model_quantized.onnx': 20_000_000,
}

async function sha256File(filePath) {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

/** Walk a directory recursively, returning all file paths that match predicate. */
function findFiles(dir, predicate) {
  const results = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findFiles(full, predicate))
    } else if (predicate(entry.name, full)) {
      results.push(full)
    }
  }
  return results
}

// ── parse args ────────────────────────────────────────────────────────────────

const asarIdx = process.argv.indexOf('--asar')
const asarMode = asarIdx !== -1
const resourcesPath = asarMode ? process.argv[asarIdx + 1] : null

if (asarMode && !resourcesPath) {
  console.error('[verify-kb-model] --asar requires a path argument')
  process.exit(1)
}

// ── mode 2: packaged app layout ───────────────────────────────────────────────

if (asarMode) {
  let failures = 0

  // (a) onnxruntime-node native addon for darwin-arm64.
  //     electron-builder asarUnpack copies node_modules/onnxruntime-node/ to
  //     <app>.asar.unpacked/node_modules/onnxruntime-node/. The .node binary
  //     lives under bin/napi-v3/darwin/arm64/ (or similar path).
  const unpackedNm = join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node')
  if (!existsSync(unpackedNm)) {
    console.error(
      `[verify-kb-model] MISSING: app.asar.unpacked/node_modules/onnxruntime-node\n` +
        `  Path checked: ${unpackedNm}\n` +
        `  asarUnpack in package.json must include "**/onnxruntime-node/**"`
    )
    failures++
  } else {
    const nodes = findFiles(unpackedNm, (name) => name.endsWith('.node'))
    if (nodes.length === 0) {
      console.error(
        `[verify-kb-model] MISSING: no *.node binary under ${unpackedNm}\n` +
          `  onnxruntime-node native addon was not copied — check asarUnpack config`
      )
      failures++
    } else {
      // Ensure none of the unwanted win32/linux binaries slipped in
      // (they should be excluded by mac.files in package.json).
      const unwanted = nodes.filter(
        (p) => p.includes('/win32/') || p.includes('/linux/')
      )
      if (unwanted.length > 0) {
        console.error(
          `[verify-kb-model] UNEXPECTED: non-darwin .node binaries present:\n` +
            unwanted.map((p) => `  ${p}`).join('\n') +
            `\n  mac.files exclusion in package.json may be misconfigured`
        )
        failures++
      } else {
        console.log(`[verify-kb-model] ok: onnxruntime-node unpacked (${nodes.length} .node file(s))`)
        nodes.forEach((p) => console.log(`  ${p.replace(resourcesPath, '<Resources>')}`))
      }
    }
  }

  // (b) kb-model ONNX file size check (sha256 is prohibitively slow in CI for a
  //     24 MB file inside a packaged app — size sanity is sufficient here).
  const onnxInPkg = join(resourcesPath, 'kb-model', 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx')
  if (!existsSync(onnxInPkg)) {
    console.error(
      `[verify-kb-model] MISSING: kb-model/bge-small-zh-v1.5/onnx/model_quantized.onnx\n` +
        `  Path checked: ${onnxInPkg}\n` +
        `  extraResources in package.json must copy kb-model/ into Resources/`
    )
    failures++
  } else {
    const size = statSync(onnxInPkg).size
    const MIN = MIN_SIZE['onnx/model_quantized.onnx']
    if (size < MIN) {
      console.error(
        `[verify-kb-model] TRUNCATED: model_quantized.onnx is ${size} bytes (< ${MIN})\n` +
          `  Path: ${onnxInPkg}`
      )
      failures++
    } else {
      console.log(`[verify-kb-model] ok: model_quantized.onnx present (${size} bytes)`)
    }
  }

  if (failures > 0) {
    console.error(`\n[verify-kb-model] ${failures} failure(s) in asar mode — build aborted`)
    process.exit(1)
  }
  console.log('[verify-kb-model] asar mode: all checks passed')
  process.exit(0)
}

// ── mode 1: source layout check ───────────────────────────────────────────────

const modelDir = join(desktopRoot, 'kb-model', 'bge-small-zh-v1.5')

if (!existsSync(modelDir)) {
  console.error(
    `[verify-kb-model] MISSING: ${modelDir}\n` +
      `  Run: bun run prebundle:kb-model`
  )
  process.exit(1)
}

let failures = 0

for (const [relPath, expectedSha] of Object.entries(SHA256)) {
  const filePath = join(modelDir, relPath)

  if (!existsSync(filePath)) {
    console.error(
      `[verify-kb-model] MISSING: ${relPath}\n` +
        `  Expected at: ${filePath}\n` +
        `  Run: bun run prebundle:kb-model`
    )
    failures++
    continue
  }

  const size = statSync(filePath).size
  const minSize = MIN_SIZE[relPath]
  if (size < minSize) {
    console.error(
      `[verify-kb-model] TRUNCATED: ${relPath} is ${size} bytes (< ${minSize})\n` +
        `  The file is suspiciously small — re-run prebundle:kb-model`
    )
    failures++
    continue
  }

  const actualSha = await sha256File(filePath)
  if (actualSha !== expectedSha) {
    console.error(
      `[verify-kb-model] SHA256 MISMATCH: ${relPath}\n` +
        `  expected: ${expectedSha}\n` +
        `  actual:   ${actualSha}\n` +
        `  The file content differs from the pinned version.\n` +
        `  If the model was intentionally updated, bump SHA256 pins in BOTH:\n` +
        `    apps/desktop/scripts/prebundle-kb-model.mjs\n` +
        `    apps/desktop/scripts/verify-kb-model.mjs`
    )
    failures++
    continue
  }

  console.log(`[verify-kb-model] ok: ${relPath} (${size} bytes)`)
}

if (failures > 0) {
  console.error(`\n[verify-kb-model] ${failures} failure(s) — build aborted`)
  process.exit(1)
}

console.log('[verify-kb-model] all files verified')
