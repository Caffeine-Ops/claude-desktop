/**
 * 「预览幻灯片」tab 在源 PPT 场景下的内容体：用户首条消息带了一个已有的
 * .pptx 路径（改/美化一份既有 deck），在 ppt-master 还没产出任何
 * svg_output/ 页面之前，先把这份源文件本身转成可视预览摆出来——
 * PPT_SOURCE_PREVIEW IPC 离线跑技能自带的 pptx_to_svg.py（不起任何常驻
 * 服务，一次性转换，结果按 (路径, mtime) 缓存在磁盘），返回每页原始 SVG
 * 文本；这里只做 href 改写（相对 `../assets/*` → `pptasset://`，复用
 * live-preview 同一套 rewriteAssetHrefs）+ 打成 blob: URL 给 `<img>` 用
 * ——比 live-preview 的 innerHTML 注入简单得多，因为这些页是一次性生成
 * 的静态参考图，不需要选中/标注交互层（那一层只有 LivePreviewEditor 有）。
 *
 * Executor 写出 svg_output/ 后 LivePreviewEditor 就绪的瞬间，SlidesWorkspace
 * 会切走这个组件——两者互斥，从不同时挂载（见该文件的 tab 内容分支）。
 */
'use client'

import { useEffect, useState } from 'react'

import { rewriteAssetHrefs } from '../../../lib/pptPreview/slidePipeline'

type ViewerState =
  | { status: 'loading' }
  | { status: 'ready'; urls: string[] }
  | { status: 'error'; message: string }

export function SourceDeckViewer({ pptxPath }: { pptxPath: string }): React.JSX.Element {
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    let cancelled = false
    // Collected so the cleanup below can revoke every blob: URL this run
    // created — otherwise each source-preview open leaks the deck's worth
    // of SVG blobs for the life of the renderer process.
    const blobUrls: string[] = []
    setState({ status: 'loading' })
    setSelected(0)
    void window.chatApi
      .previewPptSource({ pptxPath })
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setState({ status: 'error', message: res.error })
          return
        }
        const urls = res.slides.map((s) => {
          const rewritten = rewriteAssetHrefs(s.content, res.outDir)
          const url = URL.createObjectURL(new Blob([rewritten], { type: 'image/svg+xml' }))
          blobUrls.push(url)
          return url
        })
        setState({ status: 'ready', urls })
      })
      .catch((err) => {
        if (cancelled) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
      blobUrls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [pptxPath])

  if (state.status === 'loading') {
    return (
      <div className="grid flex-1 place-items-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <span className="size-5 animate-spin rounded-full border-2 border-[hsl(var(--brand)/0.25)] border-t-[hsl(var(--brand))]" />
          <span className="text-[13px]">正在生成原稿预览…</span>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <div className="text-[14px] font-medium text-foreground">预览准备中</div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            原稿暂时无法预览（{state.message}）。AI 处理完成后将在此处展示幻灯片。
          </div>
        </div>
      </div>
    )
  }

  const current = state.urls[selected]

  return (
    <div className="flex min-h-0 flex-1">
      {/* 缩略列 —— 与 ReplaySlidesViewer 同款布局，纯静态无揭示动画。 */}
      <div className="flex w-[132px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-border/40 p-3">
        {state.urls.map((url, i) => (
          <button
            key={url}
            type="button"
            onClick={() => setSelected(i)}
            aria-label={`原稿第 ${i + 1} 页`}
            className={
              'relative shrink-0 overflow-hidden rounded-md border bg-white transition-[border-color,box-shadow] ' +
              (i === selected
                ? 'border-[hsl(var(--brand))] shadow-[0_0_0_1px_hsl(var(--brand))]'
                : 'border-border/60 hover:border-border')
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="aspect-video w-full object-contain" />
            <span className="absolute left-1 top-1 rounded bg-black/45 px-1 text-[9px] tabular-nums text-white">
              {String(i + 1).padStart(2, '0')}
            </span>
          </button>
        ))}
      </div>
      {/* 大图 + 页标题行 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-baseline gap-2 px-6 pt-4">
          <span className="text-[13px] font-semibold tabular-nums text-muted-foreground">
            {String(selected + 1).padStart(2, '0')}
          </span>
          <span className="truncate text-[12px] text-muted-foreground">原稿预览（未修改）</span>
        </div>
        <div className="grid min-h-0 min-w-0 flex-1 place-items-center overflow-hidden p-6 pt-3">
          {current && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={current}
              alt=""
              className="max-h-full max-w-full rounded-lg border border-border/50 bg-white object-contain shadow-sm"
            />
          )}
        </div>
      </div>
    </div>
  )
}
