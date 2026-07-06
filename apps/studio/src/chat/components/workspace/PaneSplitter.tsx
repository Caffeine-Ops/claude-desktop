import { useCallback, useEffect, useRef } from 'react'

/**
 * 竖向可拖拽分隔条（纯受控）。拖动时把鼠标 clientX 通过 onDrag 上报，由父组件决定
 * 落到哪一侧的宽度——组件不持有宽度状态，便于复用与父组件统一钳制范围。
 *
 * mousemove/mouseup 挂在 window 上（而非自身），保证鼠标拖出条宽后仍持续收到事件；
 * 拖拽期间禁用 body 的 userSelect，避免拖动时选中正文。监听在 mouseup/卸载时摘除。
 *
 * onDrag 经 ref 取最新值，使 onMove/stop/start 终身稳定（deps []）。关键：
 * removeEventListener 必须用与 addEventListener「同一个函数引用」才摘得掉；若 onMove
 * 跟随父级每次渲染重建的 onDrag 一起换身份，mousedown 时 add 的那个 onMove 在 mouseup/
 * 卸载时就 remove 不掉，监听泄漏。稳定化后 add/remove 永远配对（评审 #5 的前提）。
 */
export function PaneSplitter({
  onDrag
}: {
  onDrag: (clientX: number) => void
}): React.JSX.Element {
  const dragging = useRef(false)
  const onDragRef = useRef(onDrag)
  onDragRef.current = onDrag

  const onMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return
    onDragRef.current(e.clientX)
  }, [])

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

  // 卸载兜底：拖动中若本组件被摘掉（chatCollapsed 翻 true / proposalWorkspace 翻 false
  // 令分隔条不再渲染），mouseup 永不到达、stop() 不跑——window 上的 mousemove/mouseup
  // 监听与 body.userSelect='none' 会泄漏（全局鼠标残留 + 全应用文字选不动）（评审 #5）。
  // stop 终身稳定，故此 effect 只在真正卸载时清理，不会因重渲误杀进行中的拖动。
  useEffect(() => stop, [stop])

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
