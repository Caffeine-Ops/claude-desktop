import { useEffect, useRef, useState } from 'react'

import { useI18n } from '../../../i18n'
import {
  useImageEditStore,
  useSplitWorkspaceBusy
} from '../../../stores/filePreview'
import type { ImageGenInfo } from '../../../lib/imageGenDetect'

/* ───────────────── 图片生成卡（Bash → image_gen.py 特判）───────────────── */

/**
 * 聊天里的「生成图片」是产品级动作（composer 的彩色 skill 按钮背后就是
 * imagegen skill），不该长成一张开发者工具卡。这里把 image_gen.py /
 * gpt-image-2 脚本的 Bash 调用识别出来，整卡替换成产品化的两态渲染：
 *
 *   - running：「正在创建图片」点阵显影占位卡——浅点阵从左上角向外
 *     生长-回落循环（.ig-dots，main.css），复刻 ChatGPT 式的等待隐喻。
 *   - settled：成图原位落卡（readImageFile 拿原始字节的 dataUrl），
 *     点击进标记改图面板（ImageEditPanel，与成果文件卡同一动线）。
 *
 * 识别与成果定位都靠命令/输出的文本契约，对应约束写进了
 * skills/imagegen/SKILL.md 的「聊天卡片渲染契约」节——改这里的正则
 * 前先对照那份契约，两边必须同步。
 */
/* 识别逻辑（detectImageGen / ImageGenInfo）2026-09-07 搬到 lib/imageGenDetect.ts
 * ——会话图库要在纯函数层复用它，lib 不能反向依赖组件文件。这里 re-export
 * 保持既有调用方（ToolCallCard / OutputsPanel）的 import 路径不变。 */
export { detectImageGen, type ImageGenInfo } from '../../../lib/imageGenDetect'

export function ImageGenToolCard({
  info,
  running
}: {
  info: ImageGenInfo
  running: boolean
}): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const zh = lang === 'zh'
  // 挂载瞬间是否在 running（useRef 捕获首渲染值，同 ToolCallCard 的
  // enteredLive）。一个判定管两件事：实时落进流的卡播 tc-row-in 上浮入场；
  // running→settled 的实时转换播成图淡入。挂载即 settled（历史恢复/切会话）
  // 两个动画都不播——2026-07-04 零动画方针。工具 status 单向（running →
  // settled，不回头），所以「挂载时在跑」⇔「这次 settle 是亲眼看着发生的」。
  const enteredLive = useRef(running).current
  const animateIn = enteredLive && !running

  if (running) {
    const title =
      info.mode === 'edit'
        ? zh
          ? '正在修改图片'
          : 'Editing image…'
        : zh
          ? '正在创建图片'
          : 'Creating image…'
    return (
      <div className={(enteredLive ? 'tc-row-in ' : '') + 'w-full min-w-0'}>
        <div
          role="status"
          aria-live="polite"
          aria-label={title}
          title={info.prompt ?? undefined}
          className="relative w-full max-w-[440px] overflow-hidden rounded-2xl bg-muted/50"
          style={{ aspectRatio: info.ratio }}
        >
          <div aria-hidden className="ig-dots absolute inset-0" />
          <span className="shimmer-text absolute left-5 top-4 text-[13px] font-medium">
            {title}
          </span>
        </div>
      </div>
    )
  }

  const multi = info.paths.length > 1
  return (
    <div className="w-full min-w-0">
      <div
        className={
          multi ? 'grid max-w-[440px] grid-cols-2 gap-2' : 'max-w-[440px]'
        }
      >
        {info.paths.map((p) => (
          <GeneratedImage
            key={p}
            path={p}
            ratio={info.ratio}
            alt={info.prompt}
            animateIn={animateIn}
            zh={zh}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * 一张成图：readImageFile（原始字节 dataUrl，与 ImageLightbox 同一 IPC）
 * 加载后自然宽高渲染。点击进标记改图面板；分栏被 slides/proposal 工作区
 * 占用时降级系统应用打开（与 DeliverableCard 的图片分支同一决策）。
 */
function GeneratedImage({
  path,
  ratio,
  alt,
  animateIn,
  zh
}: {
  path: string
  ratio: number
  alt: string | null
  animateIn: boolean
  zh: boolean
}): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const splitBusy = useSplitWorkspaceBusy()

  useEffect(() => {
    let cancelled = false
    void window.chatApi
      .readImageFile({ absPath: path })
      .then((r) => {
        if (cancelled) return
        if (r.ok && r.dataUrl) setDataUrl(r.dataUrl)
        else setMissing(true)
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  // 历史消息里的成图可能已被用户删掉/移走——退成一行中性说明,别让
  // 旧会话滚出一片空白大卡。
  if (missing) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
        <span className="truncate font-mono">{path.split('/').pop()}</span>
        <span className="shrink-0">
          {zh ? '图片已不在原位置' : 'Image no longer on disk'}
        </span>
      </div>
    )
  }

  const open = (): void => {
    if (!splitBusy) {
      useImageEditStore.getState().openEditor(path)
      return
    }
    void window.chatApi.openPath({ absPath: path })
  }

  return (
    <button
      type="button"
      onClick={open}
      title={path}
      className="block w-full overflow-hidden rounded-2xl bg-muted/50 text-left transition-opacity duration-200 hover:opacity-90"
    >
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={alt ?? ''}
          className={'block h-auto w-full ' + (animateIn ? 'ig-img-in' : '')}
        />
      ) : (
        // dataUrl 回来前按请求比例撑住高度，成图挂载不跳版
        <div aria-hidden className="w-full" style={{ aspectRatio: ratio }} />
      )}
    </button>
  )
}
