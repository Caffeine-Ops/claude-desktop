import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment
} from '@assistant-ui/core'

/**
 * Image attachment adapter for the composer.
 *
 * Hands assistant-ui an AttachmentAdapter so the built-in paste / drop /
 * file-picker machinery (ComposerPrimitive.Input's `addAttachmentOnPaste`,
 * AttachmentDropzone, AddAttachment) all route image files through us.
 *
 * What we do differently from the upstream SimpleImageAttachmentAdapter:
 *
 *  1. **Dimension clamp**: Anthropic's vision docs recommend ≤ 1568px on
 *     the long edge. Larger images get resized on the GPU via
 *     createImageBitmap + OffscreenCanvas so we don't ship 4000px
 *     screenshots over IPC and into the API.
 *
 *  2. **Size clamp**: the API rejects anything over 5MB base64 per image.
 *     After resizing to PNG we check the encoded length; if it's still
 *     over the ~3.75MB raw budget (which would become ~5MB base64) we
 *     re-encode as JPEG q=0.85 and keep dropping quality until it fits
 *     or we hit a minimum quality floor.
 *
 *  3. **Data URL output**: the Complete attachment's content uses
 *     `{ type: 'image', image: dataURL }` — a standard data URL
 *     (`data:image/png;base64,...`). The main process parses it back
 *     into `{ media_type, data }` when building the SDK user message,
 *     so the wire format is a single string all the way through.
 *
 * Mirrors free-code's imagePaste.ts behavior at the CLI level, minus the
 * osascript / native NSPasteboard paths — the browser's native DOM
 * paste/drop events already give us `File` objects directly.
 */

// Anthropic's own vision guide: 1568px is the sweet spot. Going larger
// doesn't improve model accuracy but costs more tokens. free-code uses
// the same constant (IMAGE_MAX_WIDTH / IMAGE_MAX_HEIGHT in apiLimits.ts).
const MAX_EDGE = 1568

// Raw-byte budget. API limit is 5MB base64, which is ~3.75MB raw since
// base64 expands by 4/3. We leave a little headroom for the data URL
// prefix and JSON framing in the IPC payload.
const MAX_RAW_BYTES = 3.5 * 1024 * 1024

// JPEG quality search: start at 0.9, step down by 0.1 until we fit or
// hit the floor. Below 0.5 the image gets visibly blurry — better to
// reject than to ship something the user can't read.
const JPEG_QUALITY_START = 0.9
const JPEG_QUALITY_FLOOR = 0.5
const JPEG_QUALITY_STEP = 0.1

/**
 * The adapter itself is a plain object, not a class — assistant-ui only
 * looks at its public methods. An exported constant is easier to memoize
 * in the runtime provider than a `new Adapter()` call on every render.
 */
export const imageAttachmentAdapter: AttachmentAdapter = {
  accept: 'image/*',

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    // At add-time we only mark it as "pending, waiting for send". The
    // actual resize + encode happens in send() so the UI shows the
    // attachment chip immediately without blocking on GPU work.
    console.log('[imageAdapter] add', {
      name: file.name,
      size: file.size,
      type: file.type
    })
    return {
      id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'image',
      name: file.name || 'Pasted image',
      contentType: file.type || 'image/png',
      file,
      status: { type: 'requires-action', reason: 'composer-send' }
    }
  },

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    console.log('[imageAdapter] send start', {
      name: attachment.name,
      fileSize: attachment.file.size,
      fileType: attachment.file.type
    })
    try {
      const dataURL = await processImageFile(attachment.file)
      console.log('[imageAdapter] send success', {
        name: attachment.name,
        dataUrlLength: dataURL.length,
        mediaType: dataURL.slice(5, dataURL.indexOf(';'))
      })
      return {
        ...attachment,
        status: { type: 'complete' },
        content: [
          {
            type: 'image',
            image: dataURL,
            filename: attachment.name
          }
        ]
      }
    } catch (err) {
      console.error('[imageAdapter] send failed', err)
      throw err
    }
  },

  async remove(): Promise<void> {
    // No background uploads to cancel — everything lives in renderer
    // memory until send() fires. The runtime drops its own reference
    // after this resolves.
  }
}

/**
 * Read a File, optionally resize+re-encode, and return the final data URL.
 *
 * Strategy (robust against Electron wire-format quirks):
 *
 *   1. **Baseline**: always read the raw File into a data URL via
 *      FileReader first. This is the same path SimpleImageAttachmentAdapter
 *      uses and is known to work even when createImageBitmap is flaky
 *      on externally-dragged files.
 *
 *   2. **Fast exit**: if the source file is already within the API byte
 *      budget AND within the dimension cap, return the baseline as-is
 *      (common case: screenshots that are already reasonable size).
 *
 *   3. **Resize path**: if the source is too large in bytes OR pixels,
 *      try the canvas resize pipeline (createImageBitmap →
 *      OffscreenCanvas → convertToBlob). Walk JPEG qualities down from
 *      0.9 until it fits.
 *
 *   4. **Best-effort fallback**: if the canvas path fails (bitmap
 *      decode error, OOM, missing API) but the baseline is still
 *      within the hard MAX_DATAURL limit the main-process validator
 *      will accept, return the baseline even if it exceeds
 *      MAX_RAW_BYTES. Better to send a larger image than to fail.
 *
 *   5. **Hard failure**: only throw if even the baseline read fails
 *      (meaning the File blob is genuinely unreadable).
 */
async function processImageFile(file: File): Promise<string> {
  // ── Step 1: baseline read ────────────────────────────────────────
  // FileReader.readAsDataURL is the authoritative way to extract a
  // File's bytes in the renderer. No GPU/canvas dependency, works on
  // every supported format, handles Electron's lazy-materialized
  // external drops transparently.
  let baselineDataURL: string
  try {
    baselineDataURL = await blobToDataURL(file)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not read image file: ${msg}`)
  }

  const baselineBytes = estimateDataURLBytes(baselineDataURL)

  // ── Step 2: fast exit ────────────────────────────────────────────
  // Both the raw bytes and the pixel dimensions are under budget?
  // Return baseline as-is. Most screenshot users hit this path.
  if (baselineBytes <= MAX_RAW_BYTES) {
    // Still check dimensions if possible — a tiny file with massive
    // dimensions (e.g., a very compressed PNG) would waste API tokens.
    try {
      const bitmap = await createImageBitmap(file)
      try {
        if (bitmap.width <= MAX_EDGE && bitmap.height <= MAX_EDGE) {
          console.log('[imageAdapter] fast exit: baseline fits', {
            bytes: baselineBytes,
            width: bitmap.width,
            height: bitmap.height
          })
          return baselineDataURL
        }
        // Dimensions too big — fall through to resize with this bitmap.
        return await resizeViaCanvas(bitmap, baselineDataURL, baselineBytes)
      } finally {
        bitmap.close()
      }
    } catch (err) {
      // createImageBitmap failed but we have a baseline that fits the
      // byte budget. Return it — dimension-based over-budget is only
      // a token efficiency concern, not a correctness issue.
      console.warn(
        '[imageAdapter] createImageBitmap failed, keeping baseline',
        err
      )
      return baselineDataURL
    }
  }

  // ── Step 3: resize path ──────────────────────────────────────────
  // File is over the byte budget — MUST compress. Canvas is the only
  // way to do lossy compression in the renderer.
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch (err) {
    // Baseline is over-budget AND we can't decode — best we can do is
    // return baseline if it's under the hard IPC limit, else fail.
    console.warn('[imageAdapter] createImageBitmap failed on oversize file', err)
    if (baselineBytes <= MAX_DATAURL_HARD_LIMIT) {
      console.warn(
        '[imageAdapter] returning oversize baseline — may hit API limits'
      )
      return baselineDataURL
    }
    throw new Error(
      `Image is too large (${Math.round(
        baselineBytes / 1024
      )}KB) and cannot be decoded for resizing`
    )
  }
  try {
    return await resizeViaCanvas(bitmap, baselineDataURL, baselineBytes)
  } finally {
    bitmap.close()
  }
}

/**
 * Canvas resize + re-encode pipeline. Returns the best data URL under
 * MAX_RAW_BYTES. Falls back to `fallbackDataURL` if every encoding
 * attempt is over budget.
 */
async function resizeViaCanvas(
  bitmap: ImageBitmap,
  fallbackDataURL: string,
  fallbackBytes: number
): Promise<string> {
  const { width, height } = clampToMaxEdge(bitmap.width, bitmap.height)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    console.warn('[imageAdapter] no 2d context, using fallback')
    return fallbackDataURL
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)

  // PNG first (lossless). If fits → return.
  try {
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' })
    if (pngBlob.size <= MAX_RAW_BYTES) {
      console.log('[imageAdapter] resize PNG fit', {
        width,
        height,
        bytes: pngBlob.size
      })
      return await blobToDataURL(pngBlob)
    }
    // JPEG fallback — step quality down.
    for (
      let q = JPEG_QUALITY_START;
      q >= JPEG_QUALITY_FLOOR - 1e-9;
      q -= JPEG_QUALITY_STEP
    ) {
      const jpegBlob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: q
      })
      if (jpegBlob.size <= MAX_RAW_BYTES) {
        console.log('[imageAdapter] resize JPEG fit', {
          width,
          height,
          quality: q,
          bytes: jpegBlob.size
        })
        return await blobToDataURL(jpegBlob)
      }
    }
  } catch (err) {
    console.warn('[imageAdapter] convertToBlob failed', err)
  }

  // Every encoding attempt over budget. Fall back to baseline if it
  // at least fits the hard limit.
  if (fallbackBytes <= MAX_DATAURL_HARD_LIMIT) {
    console.warn(
      '[imageAdapter] resize could not fit budget, returning baseline'
    )
    return fallbackDataURL
  }
  throw new Error(
    `Image is too large (${Math.round(fallbackBytes / 1024)}KB) and compression did not fit the budget`
  )
}

/**
 * Rough byte count for a `data:image/<subtype>;base64,<body>` URL.
 * The base64 body expands the raw bytes by 4/3, plus a tiny header
 * and some padding. We use this to decide whether the baseline read
 * is already under the size budget without decoding it.
 */
function estimateDataURLBytes(dataURL: string): number {
  const commaIdx = dataURL.indexOf(',')
  if (commaIdx === -1) return dataURL.length
  const base64Len = dataURL.length - commaIdx - 1
  return Math.floor((base64Len * 3) / 4)
}

// Hard cap on a data URL body the main-process validator will accept
// (MAX_DATAURL_BYTES in main/ipc/register.ts). We use it here as the
// "would fail server-side" threshold for our fallback decisions.
const MAX_DATAURL_HARD_LIMIT = 7.5 * 1024 * 1024

/**
 * Compute dimensions that preserve aspect ratio and fit within
 * MAX_EDGE × MAX_EDGE. Short-circuits when the source is already
 * small enough so we don't re-encode for no reason.
 */
function clampToMaxEdge(
  srcW: number,
  srcH: number
): { width: number; height: number } {
  if (srcW <= MAX_EDGE && srcH <= MAX_EDGE) {
    return { width: srcW, height: srcH }
  }
  const longEdge = Math.max(srcW, srcH)
  const scale = MAX_EDGE / longEdge
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale))
  }
}

/**
 * Blob → data URL (`data:image/<subtype>;base64,<...>`). FileReader is
 * the only browser API that outputs a data URL directly; doing it by
 * hand (await blob.arrayBuffer → btoa) would work but would block the
 * main thread for big images.
 */
function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('FileReader returned non-string result'))
      }
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader error'))
    reader.readAsDataURL(blob)
  })
}
