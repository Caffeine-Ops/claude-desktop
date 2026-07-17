import React from 'react'
import { useToastStore } from '../stores/toast'

/**
 * 角落浮条渲染器。挂 App 根、常驻（无 toast 时渲染空容器）。视觉参照 ProposalDocPanel 的浮层：
 * 右下固定、pointer-events 放行到按钮、tone 三色。裸元素不涉及 canvas reset（不在 portal、
 * 用 data-slot 稳妥标记逃逸）。
 */
export function Toaster(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2" data-slot="toaster">
      {toasts.map((tst) => (
        <button
          key={tst.id}
          type="button"
          data-slot="toast"
          onClick={() => dismiss(tst.id)}
          className={
            'pointer-events-auto max-w-[320px] rounded-lg border px-3.5 py-2.5 text-left text-[12.5px] shadow-lg transition-all ' +
            (tst.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : tst.tone === 'err'
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-border bg-card text-foreground')
          }
        >
          {tst.message}
        </button>
      ))}
    </div>
  )
}
