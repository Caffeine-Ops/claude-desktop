import type {
  AttachmentAdapter,
  CompleteAttachment,
  ComposerRuntime,
  PendingAttachment
} from '@assistant-ui/core'

import {
  splitWorkspaceBusyNow,
  useImageEditStore,
  useSheetPreviewStore
} from '../stores/filePreview'

/**
 * Unified attachment adapter for the composer — handles BOTH images and
 * arbitrary files. Hands assistant-ui an AttachmentAdapter so the
 * built-in paste / drop / file-picker machinery (the composer's
 * addAttachmentOnPaste, AttachmentDropzone, our custom AddAttachment
 * button) all route every dropped/picked file through us.
 *
 * Two attachment kinds, distinguished by `attachment.type`:
 *
 *  ── Images (`type: 'image'`) ─────────────────────────────────────────
 *  Kept as `type: 'image'` so the composer chip shows a thumbnail, but
 *  the SEND format depends on whether the image exists on disk
 *  (2026-07-09 用户定稿:图片文件一律发路径,不再 base64 内联):
 *
 *   a. **On-disk image files** (drag/drop, file picker) → same as any
 *      other file: the absolute path rides a FileMessagePart
 *      (FILE_PATH_MIME) and becomes an `@"path"` mention. fusion-code's
 *      Read tool loads the image itself and returns a vision block to
 *      the model. The transcript (jsonl) stores only the path — no
 *      megabyte base64 blobs in history, and the mention renders as a
 *      compact file chip in the user bubble.
 *
 *   b. **Clipboard pastes** (no disk path exists) → the legacy inline
 *      pipeline: resized + base64-encoded to a data URL, sent as a
 *      vision block. Details:
 *      1. **Dimension clamp**: Anthropic's vision docs recommend ≤
 *         1568px on the long edge (resized via createImageBitmap +
 *         OffscreenCanvas).
 *      2. **Size clamp**: the API rejects > 5MB base64 per image; PNG
 *         first, then JPEG stepping quality down until it fits.
 *      3. **Data URL output**: `{ type: 'image', image: dataURL }`; the
 *         main process parses it back into `{ media_type, data }`.
 *
 *  ── Files (`type: 'file'`) ───────────────────────────────────────────
 *  NON-image files do NOT ship their bytes. Instead we resolve the
 *  on-disk **absolute path** (Electron's webUtils.getPathForFile, exposed
 *  as chatApi.pathForFile) at add()-time, and the Complete attachment
 *  carries it in a FileMessagePart `{ type: 'file', data: <path>,
 *  mimeType: FILE_PATH_MIME }`. FusionRuntimeProvider.onNew picks the
 *  path out and appends it to the prompt as an `@"path"` mention, so
 *  fusion-code's extractAtMentionedFiles reads the file itself with the
 *  Read tool. "The model receives the path", per the feature request.
 *
 *  The composer chip (ComposerAttachmentChip) already renders non-image
 *  attachments as a labelled pill showing `attachment.name` (the file
 *  name) instead of a thumbnail, so files appear in the same row above
 *  the input as images.
 *
 * Mirrors free-code's imagePaste.ts behavior at the CLI level, minus the
 * osascript / native NSPasteboard paths — the browser's native DOM
 * paste/drop events already give us `File` objects directly.
 */

// Sentinel mimeType marking a FileMessagePart whose `data` is an on-disk
// absolute path (not base64 bytes). onNew matches on this to know it
// should emit an `@"path"` mention rather than try to read inline data.
export const FILE_PATH_MIME = 'application/x-fusion-file-path'

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

/** True for files we treat as inline vision images. */
function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

/**
 * 按磁盘路径移除 composer 里的 pending 附件——给右栏面板的「面板内直发」
 * 路径用（ImageEditPanel.send / UniverSheetView.askAI 走 dispatchChatTurn
 * 直发，完全绕过 assistant-ui 的 composer.send()，chip 不会像正常发送
 * 那样被消费掉）。面板消息里已经带了文件路径，chip 的使命结束；只删
 * path 匹配的那一颗，用户为下一条文字消息挂着的其它附件不动。路径匹配
 * 读 add() stash 进 content 的 FILE_PATH_MIME part（与 send() 同一套
 * type-guard）。
 */
export function removeComposerAttachmentsByPath(
  runtime: ComposerRuntime,
  absPath: string
): void {
  // 公开 ComposerRuntime 没有按 id 删除，只有 getAttachmentByIndex →
  // AttachmentRuntime.remove()（chip 上 × 按钮的同一条路）。倒序遍历 +
  // 逐个立即 remove：runtime 绑定按 index 解析，正序删会让后面的 index
  // 左移错位，倒序删则未处理的低位 index 恒稳。
  const attachments = runtime.getState().attachments
  for (let i = attachments.length - 1; i >= 0; i--) {
    const stashed = attachments[i].content?.find(
      (p): p is { type: 'file'; data: string; mimeType: string } =>
        p.type === 'file' && p.mimeType === FILE_PATH_MIME
    )
    if (stashed?.data === absPath) {
      void runtime.getAttachmentByIndex(i).remove()
    }
  }
}

/**
 * 上传即预览（2026-07-13）：add() 解析出磁盘路径后，若是右栏面板认的
 * 类型就直接把面板开出来——用户拖一张图/一份表进输入框，右侧立刻能看
 * 到，不用再点一次 chip（chip 的点击入口保留，面板被关掉后还能重开）。
 * 判定与 DeliverableCard / ComposerAttachmentChip 的点击分支同一套：
 * 表格三件套 → SpreadsheetPreviewPanel；图片只放 edit API 认的格式
 * （gif 不进面板）。slides/proposal 分栏占用右栏时不抢（面板本来就会
 * 让位，openXxx 只会写下一个不渲染的僵尸 path，等分栏关闭时突然弹出
 * 来）；剪贴板粘贴无路径的图片跳过。与点击路径不同这里不降级系统应用
 * ——自动弹一个外部窗口太突兀，降级只留给用户主动点击。
 */
function autoOpenPreviewPanel(name: string, path: string): void {
  if (!path || splitWorkspaceBusyNow()) return
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    useSheetPreviewStore.getState().openPreview(path)
  } else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') {
    useImageEditStore.getState().openEditor(path)
  }
}

/**
 * The adapter itself is a plain object, not a class — assistant-ui only
 * looks at its public methods. An exported constant is easier to memoize
 * in the runtime provider than a `new Adapter()` call on every render.
 */
export const fileAttachmentAdapter: AttachmentAdapter = {
  // Accept anything. The picker / dropzone no longer filter by type;
  // we branch on the file's MIME at add()-time instead.
  accept: '*',

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    if (isImageFile(file)) {
      // Resolve the disk path NOW (same reasoning as the file branch
      // below: the native File reference is freshest at add-time).
      // Present for drag/drop & picker images, '' for clipboard pastes
      // — send() branches on it: path → `@"path"` mention, no path →
      // inline base64 vision block.
      const path = window.chatApi?.pathForFile(file) ?? ''
      console.log('[fileAdapter] add image', {
        name: file.name,
        size: file.size,
        type: file.type,
        path
      })
      autoOpenPreviewPanel(file.name, path)
      return {
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        // type 保持 'image':composer chip 据此渲染缩略图预览,与发送
        // 形态(路径 or base64)无关。
        type: 'image',
        name: file.name || 'Pasted image',
        contentType: file.type || 'image/png',
        file,
        content: path
          ? [{ type: 'file', filename: file.name, data: path, mimeType: FILE_PATH_MIME }]
          : [],
        status: { type: 'requires-action', reason: 'composer-send' }
      }
    }

    // Non-image: resolve the disk path NOW, while the File reference is
    // fresh. webUtils.getPathForFile (via chatApi.pathForFile) needs the
    // original native File from the drop/picker event; stashing the path
    // here means send() doesn't depend on the File still being valid.
    const path = window.chatApi?.pathForFile(file) ?? ''
    console.log('[fileAdapter] add file', {
      name: file.name,
      size: file.size,
      type: file.type,
      path
    })
    autoOpenPreviewPanel(file.name, path)
    return {
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'file',
      name: file.name || 'File',
      contentType: file.type || 'application/octet-stream',
      file,
      // Stash the resolved path on the pending attachment's content so
      // send() can echo it through without re-resolving. The chip reads
      // `name`, not this, so it's invisible in the UI until send.
      content: path
        ? [{ type: 'file', filename: file.name, data: path, mimeType: FILE_PATH_MIME }]
        : [],
      status: { type: 'requires-action', reason: 'composer-send' }
    }
  },

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    // ── File branch: emit the path-carrying FileMessagePart ───────────
    if (attachment.type === 'file') {
      const stashed = attachment.content?.find(
        (p): p is { type: 'file'; data: string; mimeType: string; filename?: string } =>
          p.type === 'file' && p.mimeType === FILE_PATH_MIME
      )
      // Fall back to re-resolving from the File if the stash is missing
      // (defensive — add() always sets it when a path was available).
      const path = stashed?.data || window.chatApi?.pathForFile(attachment.file) || ''
      if (!path) {
        // No disk path (blob-backed / synthetic File). We can't mention
        // something that isn't on disk — surface a clear error rather
        // than silently sending an empty attachment.
        throw new Error(`Cannot resolve a disk path for "${attachment.name}"`)
      }
      console.log('[fileAdapter] send file', { name: attachment.name, path })
      return {
        ...attachment,
        status: { type: 'complete' },
        content: [
          { type: 'file', filename: attachment.name, data: path, mimeType: FILE_PATH_MIME }
        ]
      }
    }

    // ── Image branch ───────────────────────────────────────────────
    // On-disk image? Send the PATH, exactly like the file branch —
    // the model reads it with the Read tool (which returns a vision
    // block), and the transcript stores a path instead of megabytes
    // of base64(2026-07-09 用户定稿:图片文件一律发路径)。
    {
      const stashed = attachment.content?.find(
        (p): p is { type: 'file'; data: string; mimeType: string; filename?: string } =>
          p.type === 'file' && p.mimeType === FILE_PATH_MIME
      )
      const path = stashed?.data || window.chatApi?.pathForFile(attachment.file) || ''
      if (path) {
        console.log('[fileAdapter] send image as path', { name: attachment.name, path })
        return {
          ...attachment,
          status: { type: 'complete' },
          content: [
            { type: 'file', filename: attachment.name, data: path, mimeType: FILE_PATH_MIME }
          ]
        }
      }
    }

    // Clipboard paste (no disk path) — inline base64 vision block.
    console.log('[fileAdapter] send image start', {
      name: attachment.name,
      fileSize: attachment.file.size,
      fileType: attachment.file.type
    })
    try {
      const dataURL = await processImageFile(attachment.file)
      console.log('[fileAdapter] send image success', {
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
      console.error('[fileAdapter] send image failed', err)
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
export async function processImageFile(file: File): Promise<string> {
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
