"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/src/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        // 本地化偏离 upstream：ghost/outline 的 hover 用 muted 而非 accent。
        // shadcn 语境里 --accent 是中性 hover 灰，但本项目的 --accent 被产品
        // 语义占用（用户主题色，默认 Apple 蓝，appearance applier 会 live 改
        // 写）——沿用 upstream 会让全项目 ghost/outline 按钮 hover 闪蓝底。
        outline:
          "border bg-background shadow-xs hover:bg-hover hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-hover hover:text-foreground dark:hover:bg-hover/60",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // 本地化偏离 upstream（2026-07-08 用户三轮定稿的统一按钮样式，
      // 参照 Notion 弹窗按钮）：形状是大圆角矩形不是胶囊（第一轮 pill
      // 被否）；default 档收到 32px 高 + 8px 圆角 + px-3.5（第二轮 36px/
      // 10px 被嫌大，按参照图实测 ~30px 高、~8px 圆角收定）。sm 与
      // default 同高，仅 padding/gap 更紧，留给行内嵌入场景。
      // icon 档保持 base 的 rounded-md。
      size: {
        default: "h-8 rounded-lg px-3.5 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-lg px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-[10px] px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }