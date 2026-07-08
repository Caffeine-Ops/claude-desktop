"use client"

import * as React from "react"

import { cn } from "@/src/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // selection 刻意不用 shadcn 上游的 bg-primary + text-primary-foreground：
        // --primary 被 appearance applier 换成用户主题色后，预填全选的输入框
        // 整段变成「主题色底 + 白字」的荧光块（2026-07-07 重命名弹窗用户实锤）。
        // 改 25% 透明主题色底、文字保持原色——高亮可辨且始终可读。
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary/25 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        // ring/50 → ring/15：3px 半透明主题色环叠在变色 border 上是「荧光笔」
        // 的另一半，收敛成低透光晕（1px 主题色边界 + 柔和 3px 晕）。
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/15",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }