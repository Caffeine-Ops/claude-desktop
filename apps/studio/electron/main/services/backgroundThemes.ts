/**
 * 背景主题（用户导入的壁纸）的落盘/分析/列举/删除。每个主题一个目录：
 *   <userData>/background-themes/u-<id>/{image.<ext>, meta.json}
 *
 * 分析只在导入时跑一次（analyzeBackground，纯函数见 electron/shared/backgroundAnalysis.ts），
 * 结果写进 meta.json——启动/切换主题永不重算。meta.json 走 workspaceRegistry.ts 同款
 * tmp+rename 原子写（避免写一半崩溃留下截断 JSON 毒化下次读取）。
 *
 * 图片约束：源文件 ≤25MB 拒绝；长边 >3200px 降采样重编码（内存红线——用户导入一亿像素原图
 * 不该让 fixed 背景层吃满内存）。未降采样时原样拷贝字节，不做无谓的有损重编码。
 *
 * 内置预设（preset-*）不经过这里——它们是 public/bg-presets/ 下的静态资源 + 构建期写死的
 * meta 常量（src/lib/backgroundArt/presets.ts），本模块只管理 u-* 用户主题。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { analyzeBackground } from '../../shared/backgroundAnalysis'
import type { BackgroundThemeMeta } from '../../shared/ipc-channels'
import { backgroundThemesRoot, isPathInsideBackgroundThemesRoot } from './bgAssetProtocol'

const MAX_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_STORED_DIMENSION = 3200
const ANALYSIS_MAX_DIMENSION = 96

// Mirrors the daemon's BACKGROUND_THEME_ID pattern (apps/daemon/src/app-config.ts) —
// duplicated rather than imported because daemon and studio are separate
// deployable packages; the shape is the contract, not the source file.
// Also the path-traversal guard's first line of defense: the id is the only
// user-controlled input that becomes a directory name.
const USER_THEME_ID = /^u-[a-z0-9]{1,62}$/

function newThemeId(): string {
  return `u-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
}

function isValidMeta(value: unknown): value is BackgroundThemeMeta {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.version === 1 &&
    typeof v.id === 'string' &&
    typeof v.file === 'string' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number' &&
    typeof v.luminance === 'number' &&
    typeof v.focus === 'object' &&
    typeof v.palette === 'object'
  )
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(value), 'utf8')
  await rename(tmp, target)
}

/**
 * Downsamples + re-encodes an already-loaded nativeImage down to at most
 * `maxDimension` on its long edge. Returns the original untouched when it's
 * already within bounds (avoids a needless lossy re-encode on every import).
 */
function fitWithinDimension(
  image: Electron.NativeImage,
  maxDimension: number
): { image: Electron.NativeImage; width: number; height: number; resized: boolean } {
  const size = image.getSize()
  const longEdge = Math.max(size.width, size.height)
  if (longEdge <= maxDimension || longEdge === 0) {
    return { image, width: size.width, height: size.height, resized: false }
  }
  const scale = maxDimension / longEdge
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  return { image: image.resize({ width, height, quality: 'best' }), width, height, resized: true }
}

/**
 * Imports one image file into a new `u-<id>` theme directory: guards size,
 * downsamples for storage if oversized, runs the adaptive analysis once on
 * a small thumbnail, and atomically writes image + meta.json. Throws (in
 * Chinese, surfaced verbatim to the user) on an unreadable/corrupt image or
 * an oversized source file — the IPC handler lets these propagate.
 */
export async function importBackgroundThemeFromFile(
  filePath: string,
  displayName?: string
): Promise<BackgroundThemeMeta> {
  const stats = await stat(filePath)
  if (stats.size > MAX_SOURCE_BYTES) {
    throw new Error('图片超过 25MB 限制，请先压缩后再导入')
  }

  const { nativeImage } = await import('electron')
  const original = nativeImage.createFromPath(filePath)
  if (original.isEmpty()) {
    throw new Error('无法识别的图片格式')
  }

  const sourceExt = extname(filePath).slice(1).toLowerCase() || 'png'
  const stored = fitWithinDimension(original, MAX_STORED_DIMENSION)
  // nativeImage can only encode PNG/JPEG — anything else (webp, etc.) that
  // needed resizing normalizes to PNG. Unresized images keep their original
  // bytes verbatim (no re-encode) regardless of format.
  let storedBuffer: Buffer
  let storedExt: string
  if (!stored.resized) {
    storedBuffer = await readFile(filePath)
    storedExt = sourceExt
  } else if (sourceExt === 'jpg' || sourceExt === 'jpeg') {
    storedBuffer = stored.image.toJPEG(90)
    storedExt = 'jpg'
  } else {
    storedBuffer = stored.image.toPNG()
    storedExt = 'png'
  }

  // Analysis always runs on a small independent thumbnail — decoupled from
  // the stored resolution so it stays cheap regardless of MAX_STORED_DIMENSION.
  const analysisSource = fitWithinDimension(original, ANALYSIS_MAX_DIMENSION).image
  const analysisSize = analysisSource.getSize()
  const bitmap = analysisSource.toBitmap()
  const analysis = analyzeBackground({
    data: new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength),
    width: analysisSize.width,
    height: analysisSize.height,
    format: 'bgra'
  })

  const id = newThemeId()
  const root = backgroundThemesRoot()
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const fileName = `image.${storedExt}`
  const absImagePath = join(dir, fileName)
  await writeFile(absImagePath, storedBuffer)

  const fileExt = extname(filePath)
  const baseName = filePath.slice(filePath.lastIndexOf('/') + 1, filePath.length - fileExt.length)
  const meta: BackgroundThemeMeta = {
    version: 1,
    id,
    name: displayName?.trim() || baseName || 'Untitled',
    // Absolute path, not just a filename — the renderer has no other way to
    // know the userData root, so it hands this straight to toBgAssetUrl()
    // (same convention kbasset/proposalasset already use for KB/draft
    // images). Bundled presets use a public/-relative URL here instead; see
    // the BackgroundThemeMeta.file doc comment.
    file: absImagePath,
    width: stored.width,
    height: stored.height,
    luminance: analysis.luminance,
    focus: analysis.focus,
    safeSide: analysis.safeSide,
    palette: analysis.palette,
    createdAt: Date.now()
  }
  await atomicWriteJson(join(dir, 'meta.json'), meta)
  return meta
}

/**
 * Lists user-imported themes only (bundled presets are static assets the
 * renderer already knows about — see src/lib/backgroundArt/presets.ts).
 * A directory with a missing/corrupt meta.json is silently skipped: one bad
 * theme shouldn't blank the whole picker.
 */
export async function listBackgroundThemes(): Promise<BackgroundThemeMeta[]> {
  const root = backgroundThemesRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const metas: BackgroundThemeMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !USER_THEME_ID.test(entry.name)) continue
    try {
      const raw = await readFile(join(root, entry.name, 'meta.json'), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isValidMeta(parsed)) metas.push(parsed)
    } catch {
      continue
    }
  }
  metas.sort((a, b) => b.createdAt - a.createdAt)
  return metas
}

/**
 * Deletes a user-imported theme's directory. Only `u-*` ids are accepted
 * (presets aren't files, there's nothing to delete); the id is re-validated
 * here independent of whatever the caller already checked, and the guard
 * factory's isPathInsideRoot is a second independent check before rm.
 * Caller is responsible for clearing `background.themeId` first if this
 * theme was active — this function only touches files.
 */
export async function deleteBackgroundTheme(themeId: string): Promise<boolean> {
  if (!USER_THEME_ID.test(themeId)) return false
  const root = backgroundThemesRoot()
  const dir = join(root, themeId)
  if (!isPathInsideBackgroundThemesRoot(dir, root)) return false
  try {
    await rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
