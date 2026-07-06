// Download the bge-small-zh-v1.5 quantized ONNX model from HuggingFace into
// apps/studio/kb-model/bge-small-zh-v1.5/ so electron-builder can copy it
// into the packaged app's Resources/kb-model/.
//
// Why this script:
//   The model is ~24 MB (onnx/model_quantized.onnx) plus three tiny JSON files.
//   It is NOT source code, so it does NOT belong in git. It IS required at
//   build time (electron-builder extraResources) so it must be present BEFORE
//   `electron-vite build`. This script downloads it once and is idempotent:
//   already-present files with a matching sha256 are silently skipped; a
//   mismatching file is re-downloaded. Model dir name / HF repo / sha256 pins
//   live in kb-model-manifest.mjs (single source shared with verify-kb-model.mjs;
//   the TS-side twin is KB_MODEL_ID in src/shared/kbIndex.ts — bump both worlds).
//
// Why node's https module (not bun fetch):
//   Some environments sit behind an SSL-MITM proxy. bun's native fetch
//   implementation fails the TLS handshake with ECONNRESET on inspected
//   connections. node's https module respects NODE_EXTRA_CA_CERTS /
//   NODE_TLS_REJECT_UNAUTHORIZED and works fine through the same proxy.
//   Set NODE_TLS_REJECT_UNAUTHORIZED=0 as a last-resort escape hatch if the
//   proxy's root CA isn't in the system store.
//
// Run via: node scripts/prebundle-kb-model.mjs (package.json script pins `node`,
//   not `bun` — bun's own resolve-cache layer intercepts this script's plain
//   node:https request to huggingface.co and rewrites it into a malformed URL
//   ("/api/resolve-cache/..." with the original URL re-encoded into its own
//   query string), which throws ERR_INVALID_URL. Seen on CI with bun-version:
//   latest; reproduce locally with a bun new enough to have the resolve-cache
//   feature. `bun scripts/prebundle-kb-model.mjs` may or may not hit this
//   depending on the installed bun version — `node` sidesteps it entirely.

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 目录名 / HF 仓库 / sha256 pins / 哈希 helper 统一来自 manifest——与 verify-kb-model.mjs
// 同源，bump 模型改 kb-model-manifest.mjs 一处即可（TS 侧另见 shared/kbIndex.ts KB_MODEL_ID）。
import { MODEL_DIR_NAME, HF_REPO, SHA256, sha256File } from './kb-model-manifest.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(__dirname, '..')
const modelDir = join(desktopRoot, 'kb-model', MODEL_DIR_NAME)

const HF_API = `https://huggingface.co/api/models/${HF_REPO}`
const FILES = Object.keys(SHA256)

// ── helpers ──────────────────────────────────────────────────────────────────

/** GET url → string body, following up to maxRedirects redirects. */
function httpsGetText(url, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    function follow(u, remaining) {
      https
        .get(u, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (remaining <= 0) return reject(new Error(`Too many redirects for ${url}`))
            return follow(res.headers.location, remaining - 1)
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from ${u}`))
          }
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString()))
          res.on('error', reject)
        })
        .on('error', reject)
    }
    follow(url, maxRedirects)
  })
}

/** Download url → filePath, following redirects, streaming to disk. */
function downloadFile(url, filePath, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    function follow(u, remaining) {
      https
        .get(u, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (remaining <= 0) return reject(new Error(`Too many redirects for ${url}`))
            return follow(res.headers.location, remaining - 1)
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from ${u}`))
          }
          const ws = createWriteStream(filePath)
          res.pipe(ws)
          ws.on('finish', resolve)
          ws.on('error', reject)
          res.on('error', reject)
        })
        .on('error', reject)
    }
    follow(url, maxRedirects)
  })
}

// ── resolve revision ──────────────────────────────────────────────────────────
// Try to pin the download to the exact commit SHA so repeated runs always
// fetch the same bytes (determinism). Fall back to 'main' when the API is
// unreachable; sha256 post-download verification is the integrity backstop.

let REVISION = 'main'
try {
  const json = await httpsGetText(HF_API)
  const data = JSON.parse(json)
  if (data.sha && typeof data.sha === 'string' && data.sha.length === 40) {
    REVISION = data.sha
    console.log(`[prebundle-kb-model] pinned to commit: ${REVISION}`)
  } else {
    console.warn(`[prebundle-kb-model] HF API returned no sha — using 'main'`)
  }
} catch (e) {
  console.warn(`[prebundle-kb-model] HF API unreachable (${e.message}) — using 'main'`)
}

// ── download loop ─────────────────────────────────────────────────────────────

mkdirSync(join(modelDir, 'onnx'), { recursive: true })

let skipped = 0
let downloaded = 0

for (const relPath of FILES) {
  const dest = join(modelDir, relPath)
  const expected = SHA256[relPath]

  // Idempotent: if the file is present and sha matches the pin, skip.
  if (existsSync(dest)) {
    const actual = await sha256File(dest)
    if (actual === expected) {
      console.log(`[prebundle-kb-model] skip (verified): ${relPath}`)
      skipped++
      continue
    }
    console.warn(`[prebundle-kb-model] sha mismatch for ${relPath} — re-downloading`)
  }

  const url = `https://huggingface.co/${HF_REPO}/resolve/${REVISION}/${relPath}`
  console.log(`[prebundle-kb-model] downloading: ${relPath}`)
  await downloadFile(url, dest)

  // Verify integrity immediately after download.
  const actual = await sha256File(dest)
  if (actual !== expected) {
    console.error(
      `[prebundle-kb-model] INTEGRITY FAILURE: ${relPath}\n` +
        `  expected sha256: ${expected}\n` +
        `  actual sha256:   ${actual}\n` +
        `  The downloaded file does not match the pinned sha256.\n` +
        `  If the model was intentionally updated, bump the SHA256 pins in\n` +
        `    apps/studio/scripts/kb-model-manifest.mjs (shared with verify-kb-model.mjs)`
    )
    process.exit(1)
  }

  const size = statSync(dest).size
  console.log(`[prebundle-kb-model] ok: ${relPath} (${size} bytes)`)
  downloaded++
}

console.log(
  `[prebundle-kb-model] done — ${downloaded} downloaded, ${skipped} already-verified → ${modelDir}`
)
