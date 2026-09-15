import { useEffect, useState } from 'react'

import type { ShellStatFileInfo } from '@desktop-shared/ipc-channels'
import { imageCacheKey } from '../../lib/imageDataUrlCache'
import { imageDataUrlCache } from '../../lib/imageDataUrlCache.runtime'

/* ── 本地图片读取的两个 hook（共享 lib/imageDataUrlCache 的缓存） ──
 * 只给**有 stat 信息**（ShellStatFileInfo）的调用方：会话图库、成果弹层图块。
 * 没有 mtime/size 的调用方（ImageGenCard / ImageEditPanel）别用——缓存键
 * 少了版本信息会在同路径覆盖后显示旧图。 */

export type ImageLoad =
  | { phase: 'loading' }
  | { phase: 'ready'; dataUrl: string }
  | { phase: 'error' }

/**
 * 读一张图的全分辨率 dataUrl。状态里记着它属于哪个 key：切到未缓存的新图时，
 * effect 要到提交后才把状态翻成 loading，渲染那一帧若直接回旧状态，会先画
 * 一帧「上一张的像素 + 新一张的文件名」再淡出重进。所以渲染期按 key 判：
 * 不匹配就看缓存，缓存没有即 loading。
 */
export function useImageDataUrl(file: ShellStatFileInfo | null): ImageLoad {
  const key = file ? imageCacheKey(file) : null
  const [state, setState] = useState<{ key: string | null; load: ImageLoad }>(() => {
    const hit = file ? imageDataUrlCache.peekFull(file) : undefined
    return { key, load: hit ? { phase: 'ready', dataUrl: hit } : { phase: 'loading' } }
  })
  useEffect(() => {
    if (!file || key === null) return
    const hit = imageDataUrlCache.peekFull(file)
    if (hit) {
      setState({ key, load: { phase: 'ready', dataUrl: hit } })
      return
    }
    let cancelled = false
    setState({ key, load: { phase: 'loading' } })
    void imageDataUrlCache.readFull(file).then((dataUrl) => {
      if (cancelled) return
      setState({ key, load: dataUrl ? { phase: 'ready', dataUrl } : { phase: 'error' } })
    })
    return () => {
      cancelled = true
    }
    // file 由 key 完全决定（key 含 path/mtime/size）。
  }, [key])
  if (state.key === key) return state.load
  const hit = file ? imageDataUrlCache.peekFull(file) : undefined
  return hit ? { phase: 'ready', dataUrl: hit } : { phase: 'loading' }
}

/**
 * 给一批文件补齐 160px 缩略图，每批到达就触发一次重渲染。返回取图函数：
 * 还没到 / 读不出为 undefined（调用方留占位）。
 */
export function useImageThumbs(
  files: readonly ShellStatFileInfo[]
): (file: ShellStatFileInfo) => string | undefined {
  const [, bump] = useState(0)
  const missingSig = files
    .filter((f) => imageDataUrlCache.peekThumb(f) === undefined)
    .map(imageCacheKey)
    .join('\n')
  useEffect(() => {
    if (!missingSig) return
    let cancelled = false
    void imageDataUrlCache.ensureThumbs(files, () => {
      if (!cancelled) bump((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
    // files 里缺缩略图的那部分由 missingSig 完全决定。
  }, [missingSig])
  return (file) => imageDataUrlCache.peekThumb(file)
}
