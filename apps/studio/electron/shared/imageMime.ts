/**
 * 图片扩展名 ↔ MIME 的唯一事实源。
 *
 * 收口前这套映射在四处各有一份手抄（kbasset 协议、proposalasset 协议、register 的
 * mimeForImagePath、imageGenService 的 EXT_BY_MIME 逆映射），加一个格式要同步改四处；
 * 评审抓到的活例：上传对话框曾单方面收了 webp，预览/导出却双双降级——正是这类漂移。
 * 注意区分职责：这里回答「这个扩展名是什么 MIME」（能被协议服务/正确标注）；
 * 「docx 能不能嵌」由 shared/proposal.ts 的 EMBEDDABLE_IMAGE_EXTS 单独回答（有意的子集，
 * webp/svg 可服务但不可嵌入），两个集合别合并。
 */

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

/** 扩展名不认识时的 fallback 由调用方定：协议服务用 octet-stream，改图源 mime 用 image/png。 */
export function mimeForImagePath(filePath: string, fallback = 'application/octet-stream'): string {
  const idx = filePath.lastIndexOf('.')
  if (idx === -1) return fallback
  return IMAGE_MIME_BY_EXT[filePath.slice(idx).toLowerCase()] ?? fallback
}

/** MIME → 规范扩展名（不带点；jpeg 归一为 jpg）。与 IMAGE_MIME_BY_EXT 同文件维护=单点同步。 */
const EXT_BY_IMAGE_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

export function extForImageMime(mime: string, fallback = 'png'): string {
  return EXT_BY_IMAGE_MIME[mime] ?? fallback
}

/**
 * Non-image extensions the pptasset:// protocol may need to serve —
 * ppt-master project `assets/` can hold narration audio extracted alongside
 * SVG media. Kept separate from IMAGE_MIME_BY_EXT (named/typed around "this
 * is an image") rather than folded in; pptasset is the only caller that
 * needs audio/video too.
 */
const MEDIA_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4'
}

/** Like mimeForImagePath, but also resolves the media extensions above —
 *  used by localAssetProtocol's shared handler (all four schemes it serves,
 *  including image-only ones, since a superset lookup is harmless there). */
export function mimeForAssetPath(filePath: string, fallback = 'application/octet-stream'): string {
  const idx = filePath.lastIndexOf('.')
  if (idx === -1) return fallback
  const ext = filePath.slice(idx).toLowerCase()
  return IMAGE_MIME_BY_EXT[ext] ?? MEDIA_MIME_BY_EXT[ext] ?? fallback
}
