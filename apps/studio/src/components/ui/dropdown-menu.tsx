"use client"

/* 与 shadcn 上游的刻意偏离：菜单项 highlighted 态用 bg-secondary 而非
 * 上游的 bg-accent——本项目 --accent 是「用户可调主题实色」（appearance
 * applier 会整体换色），不是上游模板假设的浅灰 hover 色；不改则悬停项
 * 渲染成主题色大色块（2026-07-04 rail 会话菜单事故）。context-menu.tsx
 * 与 select.tsx 同款处理，从上游同步新版本时保持这条替换。
 *
 * 第二处刻意偏离（2026-07-08，对齐 Claude Desktop 官方菜单观感）：菜单的
 * 「精修档」直接晋升为基件默认——Content rounded-xl + p-1.5 + 双层柔和投影
 * （替换上游生硬的 shadow-md 单层；暗档投影天然弱化，轮廓由 border 承担），
 * Item 13.5px 字 + rounded-lg hover 面 + 2.5 图标间距，Separator -mx-1.5
 * 全宽贯穿。此前这套数值以局部 className 散在 RailSessionList / ThreadView
 * 三处手工同步（注释里互相喊「改数值两处同步」），任何新菜单默认长回上游
 * 的旧样子——收进基件后全项目菜单天然同款，使用处零配置。context-menu.tsx
 * 逐类同步（··· 菜单与右键菜单必须读作同一个菜单），从上游同步新版本时
 * 保持这套数值。
 *
 * 第三处刻意偏离（2026-07-19 毛玻璃化，Content/SubContent 同步改，
 * context-menu.tsx 逐类同步）：与 ThreadView.tsx 重命名弹窗同一套配方
 * （bg-popover/55 + backdrop-blur-xl + backdrop-saturate-150 +
 * backdrop-brightness-125，border-white/15 + inset 顶部高光）——popover
 * 纯不透明底改半透明后，暗档背后内容本就偏暗，混合完还是太暗看不出玻璃感，
 * 靠 backdrop-brightness 把背后模糊内容「提亮」一档才看得出透视；固定白色
 * 描边/高光是装饰性的，不跟语义色 token 走，负责在深浅两色背景下都勾出一条
 * 看得见的玻璃边缘（该配方已经真机 CDP 截图核对过，别再回退成同色高不透明度）。
 * 这里改是基件级別，全项目所有下拉菜单（rail 会话行/AppRail/输出面板/···）
 * 天然同款生效。
 *
 * 第四处刻意偏离（2026-07-20，亮色主题玻璃感缺失修复，全项目同款配方的
 * ~15 处用法一起改，本文件是其中的基件级两处）：上面第三处的
 * backdrop-brightness-125 只在**暗色**主题下验证过——`--popover`/`--card`
 * 在亮色主题是纯白/接近纯白（`0 0% 100%`），身后壁纸/内容本来就偏亮，
 * 乘 1.25 倍亮度极易单通道封顶溢出到 255（比如 RGB 250/220/210 这种暖色調
 * 直接被「漂白」成纯白），在玻璃自己的半透明度参与混合**之前**就把身后的
 * 纹理/色彩信息抹没了——不管 popover 多透明，身后已经没什么可透。暗色
 * 主题恰好相反：近黑色有充足空间往上乘，不会溢出，125% 提亮才读得出透视
 * ——同一个数值在两个主题里需要的方向正好相反，不是「亮一点总没错」。
 * 改法：亮色档不再提亮（`backdrop-brightness-100` 等于不做任何调整，让
 * 模糊后的背景保持原样，不人为溢出），只在 `.dark` 下继续用验证过的 125%。
 * 不透明度/blur/saturate/边框/高光这几处两个主题都实测有效，不用跟着改。
 * **不是全部 ~15 处都改**：PermissionModePicker.tsx 的胶囊+下拉、
 * Composer.tsx 的 WorkspaceDirPicker 胶囊+下拉+只读镜像（合计 5 处）
 * 2026-07-19 已经真机逐像素采样验证过——那几颗胶囊直接贴在壁纸上，亮色
 * 主题下 brightness-125 同样必要、没有漂白问题，跟这里的推理结论相反，
 * 予以保留不动（各自文件里有对应说明）。上面这条「亮色纯白 popover 会被
 * 乘溢出」的推理只是通用近似，不是每处都成立，改之前先查该文件有没有
 * 已验证的反例注释。 */
import * as React from "react"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import { cn } from "@/src/lib/utils"

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  )
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[9.5rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-xl border border-white/15 bg-popover/55 p-1.5 text-popover-foreground shadow-[0_10px_38px_-10px_rgba(0,0,0,0.22),0_2px_10px_-2px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-100 dark:backdrop-brightness-125 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] outline-hidden select-none focus:bg-secondary focus:text-secondary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "relative flex cursor-default items-center gap-2.5 rounded-lg py-2 pr-2.5 pl-8 text-[13.5px] outline-hidden select-none focus:bg-secondary focus:text-secondary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "relative flex cursor-default items-center gap-2.5 rounded-lg py-2 pr-2.5 pl-8 text-[13.5px] outline-hidden select-none focus:bg-secondary focus:text-secondary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2.5 py-1.5 text-[13px] font-medium data-[inset]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1.5 my-1 h-px bg-border/70", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        // 快捷键提示列：官方菜单的 ⌥⌘P 是紧凑灰字，上游的 tracking-widest
        // 会把修饰键符号拉得松散，去掉；pl-4 保证与左侧文案的最小间距。
        "ml-auto pl-4 text-xs text-muted-foreground/75",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] outline-hidden select-none focus:bg-secondary focus:text-secondary-foreground data-[inset]:pl-8 data-[state=open]:bg-secondary data-[state=open]:text-secondary-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "z-50 min-w-[9.5rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-xl border border-white/15 bg-popover/55 p-1.5 text-popover-foreground shadow-[0_10px_38px_-10px_rgba(0,0,0,0.22),0_2px_10px_-2px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-100 dark:backdrop-brightness-125 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
