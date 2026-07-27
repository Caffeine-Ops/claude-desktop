/**
 * 幻灯片舞台的缩放/平移共用件 —— LivePreviewEditor（SVG 项目预览）与
 * SourceDeckViewer（template-fill 成品预览）共用同一套手感与同一组按钮。
 *
 * 抽出来而不是各写一份：两处都是「一张 16:9 的幻灯片摆在舞台中央，可放大看细节、
 * 可点选元素做标注」，缩放步长、最小/最大倍率、空格平移这些参数一旦漂移，用户在
 * 同一个「预览幻灯片」tab 里来回切就会觉得是两个不同的东西。
 *
 * 只抽「参数 + 控件」，不抽舞台内容：两边的覆盖层坐标系不同（live-preview 用屏幕 px
 * 配重算，成品预览用相对舞台的百分比，天然随缩放自适应），硬统一反而各带一半用不上的
 * 逻辑。
 */
'use client'

import { useEffect, useState } from 'react'
import { useControls } from 'react-zoom-pan-pinch'

/**
 * TransformWrapper 的共用参数。
 *
 * `wheel.step` 0.04 是实测值：0.12 对离散鼠标滚轮刚好，但触控板一次两指滑动会打出
 * 几十个 wheel 事件，同样的每事件步长会累积成巨大跳变；库没有单独的触控板灵敏度旋钮，
 * 只能压低 step（鼠标滚轮因此需要多滚几格，可接受）。
 */
export const PPT_STAGE_ZOOM_PROPS = {
  minScale: 0.25,
  maxScale: 4,
  initialScale: 1,
  centerOnInit: true,
  doubleClick: { disabled: true },
  wheel: { step: 0.04 }
} as const

/**
 * 「按住空格 = 平移」（Figma / PS 惯例）。左键拖拽在 live-preview 那边要留给框选，
 * 所以平移必须挂在空格上；成品预览虽然没有框选，但手感要一致。
 *
 * 输入态（textarea/input/contenteditable）里按空格是打字，不能吞掉——标注输入框正是
 * 一直开着的，这个判断是必需的而不是防御性代码。
 */
export function useSpacePanning(): boolean {
  const [spacePanning, setSpacePanning] = useState(false)
  useEffect(() => {
    const isTyping = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null
      if (!el || !el.tagName) return false
      const tag = el.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || el.isContentEditable
    }
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return
      e.preventDefault() // 否则页面会跟着滚动
      setSpacePanning(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpacePanning(false)
    }
    // 切走窗口时空格的 keyup 收不到，回来就会卡在 panning 态——blur 一律复位。
    const blur = (): void => setSpacePanning(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return spacePanning
}

/** 舞台右下角的缩小 / 还原 / 放大。必须渲染在 TransformWrapper 内部（用 useControls）。 */
export function ZoomControls(): React.JSX.Element {
  const { zoomIn, zoomOut, resetTransform } = useControls()
  const btnClass =
    'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground'
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/95 p-1 shadow-sm backdrop-blur-sm">
      <button type="button" title="缩小" className={btnClass} onClick={() => zoomOut()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" title="还原" className={btnClass} onClick={() => resetTransform()}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
      </button>
      <button type="button" title="放大" className={btnClass} onClick={() => zoomIn()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
  )
}
