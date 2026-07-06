// Download the bge-small-zh-v1.5 quantized ONNX model from HuggingFace into
// apps/desktop/kb-model/bge-small-zh-v1.5/ so electron-builder can copy it
// into the packaged app's Resources/kb-model/.
//
// Why this script:
//   The model is ~24 MB (onnx/model_quantized.onnx) plus three tiny JSON files.
//   It is NOT source code, so it does NOT belong in git. It IS required at
//   build time (electron-builder extraResources) so it must be present BEFORE
//   `electron-vite build`. This script downloads it once and is idempotent:
//   already-present files with a matching sha256 are silently skipped; a
//   mismatching file is re-downloaded. The sha256 pins are the same constants
//   as in verify-kb-model.mjs — if they ever need bumping, update both files.
//
// Why node's https module (not bun fetch):
//   Some environments sit behind an SSL-MITM proxy. bun's native fetch
//   implementation fails the TLS handshake with ECONNRESET on inspected
//   connections. node's https module respects NODE_EXTRA_CA_CERTS /
//   NODE_TLS_REJECT_UNAUTHORIZED and works fine through the same proxy.
//   Set NODE_TLS_REJECT_UNAUTHORIZED=0 as a last-resort escape hatch if the
//   proxy's root CA isn't in the system store.
//
// Run via: bun scripts/prebundle-kb-model.mjs
//   or:    node scripts/prebundle-kb-model.mjs

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(__dirname, '..')
const modelDir = join(desktopRoot, 'kb-model', 'bge-small-zh-v1.5')

// SHA256 pins — must match verify-kb-model.mjs exactly.
// These are the hashes of the files downloaded from Xenova/bge-small-zh-v1.5
// via the @huggingface/transformers cache during Task 4 smoke test.
// To bump: re-download the new files, compute new hashes, update BOTH scripts.
const SHA256 = {
  'config.json': 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
  'tokenizer.json': '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  'tokenizer_config.json': 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
  'onnx/model_quantized.onnx': '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
}

const HF_REPO = 'Xenova/bge-small-zh-v1.5'
const HF_API = `https://huggingface.co/api/models/${HF_REPO}`
const FILES = Object.keys(SHA256)

// ── helpers ──────────────────────────────────────────────────────────────────

async function sha256File(filePath) {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

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
        `  If the model was intentionally updated, bump SHA256 pins in BOTH:\n` +
        `    apps/desktop/scripts/prebundle-kb-model.mjs\n` +
        `    apps/desktop/scripts/verify-kb-model.mjs`
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
