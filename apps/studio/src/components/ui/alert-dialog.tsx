"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { cn } from "@/src/lib/utils"
import { buttonVariants } from "@/src/components/ui/button"

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      // 暗幕淡入淡出，节奏与 AlertDialogContent 对齐（开 240ms ease-out /
      // 合 160ms ease-in）。开慢合快：暗幕柔和铺开、干脆收走。
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-[240ms] data-[state=open]:ease-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-[160ms] data-[state=closed]:ease-in",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          // 与 dialog.tsx 同步的骨架精修（rounded-2xl + 柔和多层投影），两类
          // 弹窗保持同一张脸。
          //
          // 开合动效（2026-07-21 第二轮，连 9222 CDP 逐帧采样定的数值）：
          // 上一版用 cubic-bezier(0.22,1,0.36,1)（easeOutQuart）+ 200ms +
          // zoom-98。CDP 实测这套**性能与几何都没问题**（60fps 满帧、无横向
          // 漂移），但 easeOutQuart 前段太陡——透明度在时间轴 ~10% 处就冲到
          // 53%、~30ms 已近 0.7，肉眼读成「啪一下就全亮」再蠕动 150ms，加上
          // 98% 缩放只有 8px 几乎看不出位移，整体是「弹」不是「滑」。这才是
          // 用户两次说「不丝滑」的真因（不是卡顿）。
          //
          // 本版三管齐下让透明度均匀爬升、位移可感：
          //  - 曲线换 cubic-bezier(0.33,1,0.68,1)（easeOutCubic）——同为
          //    decelerate 但前段温和得多（~10% 时间点约 28% 进度，不再一冲
          //    到顶），淡入读成「渐显」而非「闪现」。
          //  - 时长拉到 240ms（原 200ms 偏短，配前段温和的曲线才不显拖）。
          //  - 缩放放宽到 96%（~18px）、上滑加到 8px（slide-2），让「向上浮
          //    定 + 微微放大」真的看得见、由位移带着眼睛走，而不是纯靠透明度。
          //  - 开慢合快：合 160ms + easeInQuart（cubic-bezier(0.4,0,1,1)，
          //    加速退场，干脆收起），关闭只留缩放+淡出不带 slide，避免退场
          //    方向感掩盖「已确认/已取消」的焦点转移。
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-2xl border bg-background p-6 shadow-[0_24px_70px_-18px_rgba(0,0,0,0.28),0_8px_24px_-12px_rgba(0,0,0,0.14)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-96 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-[240ms] data-[state=open]:ease-[cubic-bezier(0.33,1,0.68,1)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-[160ms] data-[state=closed]:ease-[cubic-bezier(0.4,0,1,1)] sm:max-w-lg",
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants(), className)}
      {...props}
    />
  )
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
