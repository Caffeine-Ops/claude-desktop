import { createImageDataUrlCache } from './imageDataUrlCache'

/**
 * 运行时单例：把 imageDataUrlCache 绑到 window.chatApi 的两条 IPC 上。
 * 单独一个文件是为了让 imageDataUrlCache.ts 保持零 window 依赖（可测）；
 * 这里在**调用时**才碰 window，import 本身在 SSR / 测试环境也安全。
 */
export const imageDataUrlCache = createImageDataUrlCache({
  readFull: (path) =>
    window.chatApi
      .readImageFile({ absPath: path })
      .then((r) => (r.ok && r.dataUrl ? r.dataUrl : null)),
  readThumbs: (paths) => window.chatApi.getImageThumbs({ paths }).then((r) => r.thumbs)
})
