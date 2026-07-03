"use client"

import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { cn } from '@/src/lib/utils'

/**
 * DialogShell —— shadcn/radix 底座版。
 *
 * API 与 @open-design/ui 的手写版**完全兼容**（label / onClose /
 * sizeClassName / .Header / .Footer / Kbd），调用方只换 import 不改代码；
 * 视觉类名也逐字平移，唯一的可见差异是补了 shadcn 标准的进场动画
 * （fade + zoom，原版无动画）。
 *
 * 换底座换来的是语义，不是样子：portal 到 body（不再受祖先 overflow/
 * transform 裁剪）、focus trap + 焦点归还、aria wiring、body 滚动锁定、
 * Esc / 点外关闭统一走 radix 的 DismissableLayer——手写版的全局 keydown
 * 监听和 e.target === e.currentTarget 判定整段删除。
 *
 * 调用方保持「条件渲染即打开」的用法（`{open && <DialogShell …>}`）：
 * 内部恒 open，radix 的一切关闭路径都汇到 onOpenChange(false) → onClose。
 * 代价是卸载即消失、退场动画不播——与原版行为一致，不算回归。
 */
export interface DialogShellProps {
  /** Accessible label for the dialog（radix Title，sr-only 渲染）. */
  label: string
  /** Called on backdrop click and on Escape. */
  onClose: () => void
  /** Tailwind width + max-height classes for the card（同原版语义）. */
  sizeClassName?: string
  children: React.ReactNode
}

const DEFAULT_SIZE =
  'h-[60vh] max-h-[560px] w-[560px] max-w-[calc(100vw-32px)]'

function DialogShellRoot({
  label,
  onClose,
  sizeClassName = DEFAULT_SIZE,
  children
}: DialogShellProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            // 视觉 = 原版 backdrop（黑 70% + blur）；动画类来自 tw-animate-css。
            'fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0'
          )}
        />
        <DialogPrimitive.Content
          // 原版没有 Description 语义，显式置空避免 radix 的 dev 告警。
          aria-describedby={undefined}
          className={cn(
            // 居中定位改由 content 自身承担（原版靠 backdrop 的 flex 居中，
            // radix 下 overlay 与 content 是兄弟节点，不能再包一层）。
            'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            // 卡片视觉 = 原版逐字平移。
            'flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.7)] outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            sizeClassName
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {label}
          </DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** Header —— 类名逐字平移自原版。 */
export interface DialogHeaderProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  onClose: () => void
  closeLabel?: string
}

function DialogHeader({
  title,
  subtitle,
  onClose,
  closeLabel = 'Close'
}: DialogHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-border px-5 py-3">
      <div>
        <div className="text-[14px] font-semibold text-foreground">{title}</div>
        {subtitle != null && (
          <div className="text-[11px] text-muted-foreground/80">{subtitle}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground/80 transition hover:bg-muted/80 hover:text-foreground"
      >
        ✕
      </button>
    </div>
  )
}

/** Footer —— 类名逐字平移自原版。 */
export interface DialogFooterProps {
  /** Localized word after the Esc keycap, e.g. "close" / "关闭". */
  hint: React.ReactNode
  /** Optional right-aligned muted content (e.g. the model name). */
  trailing?: React.ReactNode
}

function DialogFooter({
  hint,
  trailing
}: DialogFooterProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-t border-border bg-background/60 px-5 py-2 text-[11px] text-muted-foreground/80">
      <span>
        <Kbd>Esc</Kbd> {hint}
      </span>
      {trailing != null && (
        <span className="truncate font-mono text-muted-foreground/60">
          {trailing}
        </span>
      )}
    </div>
  )
}

/** Kbd —— 键帽字形，独立导出（非 dialog 表面也在用）。 */
export function Kbd({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  )
}

export const DialogShell = Object.assign(DialogShellRoot, {
  Header: DialogHeader,
  Footer: DialogFooter
})
