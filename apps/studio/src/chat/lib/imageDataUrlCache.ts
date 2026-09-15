/**
 * 本地图片 dataUrl 的两级缓存（纯逻辑，IPC 由调用方注入，bun test 直接覆盖）。
 *
 * CSP 禁止 file: 作 img src，字节只能经 IPC 拿；同一张图会被缩略格、大图区、
 * 成果弹层图块各读一次，翻页来回也反复读。收敛前只有会话图库自己有缓存
 * （2026-09-07），成果弹层图块每次打开都全分辨率重读。这里抽成一份，谁有
 * stat 信息谁就能用：
 *
 *   - 键 = path + mtime + size（imageCacheKey）。**没有 stat 信息的调用方
 *     （ImageGenCard / ImageEditPanel 只有路径）刻意不接**：只按路径缓存会在
 *     image_gen.py --force 原地覆盖后一直显示旧图，这坑图库已经踩过一次。
 *   - 缩略图（IMAGE_THUMBS，160px）：小，按条数 FIFO；
 *   - 全分辨率（IMAGE_FILE_READ）：大，按条数 + 总字节双上限 FIFO，在途
 *     promise 记忆化（快速翻页不重复读）；失败不缓存（文件可能只是还没写完）。
 *
 * 模块级单例（createImageDataUrlCache 只在下面 new 一次给运行时用；工厂本身
 * 导出是为了测试注入假 IPC）。关面板不清：会话里反复开关图库是常态。
 */

export type ImageFileStamp = { path: string; mtimeMs: number; size: number }

export function imageCacheKey(file: ImageFileStamp): string {
  return `${file.path}:${file.mtimeMs}:${file.size}`
}

type Deps = {
  /** 读全分辨率 dataUrl；失败回 null。 */
  readFull: (path: string) => Promise<string | null>
  /** 批量读缩略图；键 = 路径，读不出的缺席。 */
  readThumbs: (paths: readonly string[]) => Promise<Record<string, string>>
  fullCountCap?: number
  fullBytesCap?: number
  thumbCountCap?: number
  thumbBatch?: number
}

export function createImageDataUrlCache(deps: Deps) {
  const fullCountCap = deps.fullCountCap ?? 40
  const fullBytesCap = deps.fullBytesCap ?? 64 * 1024 * 1024
  const thumbCountCap = deps.thumbCountCap ?? 400
  const thumbBatch = deps.thumbBatch ?? 60

  const full = new Map<string, string>()
  let fullBytes = 0
  const inflight = new Map<string, Promise<string | null>>()
  const thumbs = new Map<string, string>()

  function rememberFull(key: string, dataUrl: string): void {
    while (
      full.size > 0 &&
      (full.size >= fullCountCap || fullBytes + dataUrl.length > fullBytesCap)
    ) {
      const oldest = full.keys().next().value
      if (oldest === undefined) break
      fullBytes -= full.get(oldest)!.length
      full.delete(oldest)
    }
    full.set(key, dataUrl)
    fullBytes += dataUrl.length
  }

  return {
    peekFull(file: ImageFileStamp): string | undefined {
      return full.get(imageCacheKey(file))
    },
    readFull(file: ImageFileStamp): Promise<string | null> {
      const key = imageCacheKey(file)
      const hit = full.get(key)
      if (hit) return Promise.resolve(hit)
      const pending = inflight.get(key)
      if (pending) return pending
      // Promise.resolve().then 包一层：注入的读取函数若**同步**抛（比如 preload
      // 还是旧版本、方法不存在），也要落进 catch 而不是炸在调用方的 effect 里。
      const p = Promise.resolve()
        .then(() => deps.readFull(file.path))
        .then((dataUrl) => {
          if (dataUrl) rememberFull(key, dataUrl)
          return dataUrl
        })
        .catch(() => null)
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, p)
      return p
    },
    peekThumb(file: ImageFileStamp): string | undefined {
      return thumbs.get(imageCacheKey(file))
    },
    /**
     * 给一批文件补齐缩略图（只拉缓存里没有的），分批发。返回后调用方 peekThumb
     * 即可取；调用方若要「每批到达就重绘」，传 onBatch。
     */
    async ensureThumbs(
      files: readonly ImageFileStamp[],
      onBatch?: () => void
    ): Promise<void> {
      const missing = files.filter((f) => !thumbs.has(imageCacheKey(f)))
      for (let i = 0; i < missing.length; i += thumbBatch) {
        const batch = missing.slice(i, i + thumbBatch)
        const r = await Promise.resolve()
          .then(() => deps.readThumbs(batch.map((f) => f.path)))
          .catch(() => ({}) as Record<string, string>)
        for (const f of batch) {
          const url = r[f.path]
          if (!url) continue
          if (thumbs.size >= thumbCountCap) {
            const oldest = thumbs.keys().next().value
            if (oldest !== undefined) thumbs.delete(oldest)
          }
          thumbs.set(imageCacheKey(f), url)
        }
        onBatch?.()
      }
    }
  }
}

export type ImageDataUrlCache = ReturnType<typeof createImageDataUrlCache>
