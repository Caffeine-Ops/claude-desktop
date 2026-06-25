import { useCallback, useRef } from 'react'

/**
 * 竖向可拖拽分隔条（纯受控）。拖动时把鼠标 clientX 通过 onDrag 上报，由父组件决定
 * 落到哪一侧的宽度——组件不持有宽度状态，便于复用与父组件统一钳制范围。
 *
 * mousemove/mouseup 挂在 window 上（而非自身），保证鼠标拖出条宽后仍持续收到事件；
 * 拖拽期间禁用 body 的 userSelect，避免拖动时选中正文。监听在 mouseup/卸载时摘除。
 */
export function PaneSplitter({
  onDrag
}: {
  onDrag: (clientX: number) => void
}): React.JSX.Element {
  const dragging = useRef(false)

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return
      onDrag(e.clientX)
    },
    [onDrag]
  )

  const stop = useCallback(() => {
    dragging.current = false
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stop)
  }, [onMove])

  const start = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', stop)
    },
    [onMove, stop]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={start}
      className="group relative w-[7px] shrink-0 cursor-col-resize"
    >
      {/* 1px 视觉线，hover/拖动时变 accent 色 */}
      <div className="absolute inset-y-0 left-[3px] w-px bg-border transition-colors group-hover:bg-accent" />
    </div>
  )
}
