/**
 * chat 面加载态骨架屏（预示 chat 面真实形态：46px 顶栏 + 居中空态 hero
 * 轮廓 + 底部输入卡）。原先加载态是一行居中「加载聊天界面…」文案，重量
 * 突兀（大留白里飘一行小字、加载完猛切成完整界面）；骨架让「加载→内容」
 * 是同一形状渐入而非换页。
 *
 * 两处复用（chat 冷启动的两段加载态，接力同一骨架、无空白凹陷）：
 *  1. ChatSurface 的 dynamic(import chat/App) loading —— chat App chunk
 *     下载/求值期。
 *  2. chat App 的 workspace-loading 分支（getWorkspace() IPC 未 resolve
 *     的几 ms）—— 否则骨架会倒退成纯空白再到内容。
 *
 * ⚠️ 样式约束：场景 1 时 chat chunk 尚未加载，chat 面自己的 CSS（main.css
 * 的 .ssw-sk / .pes-sk shimmer、.chat-app 布局）全不可用——骨架只能用根
 * layout 层已就位的东西：Tailwind utility + design-tokens 全局 :root token
 * （--foreground / --border…）+ Tailwind 内置 animate-pulse（不依赖 chat 侧
 * 自定义 keyframe）。左侧会话 rail（RailShell）是 shell 层、body 直接子节点，
 * 此刻早已渲染——骨架只画 chat 内容区，不画 rail。
 *
 * 度量对齐真实 chat 面，让加载→内容零位移：顶栏 h-[46px] + border-b（同
 * ChatHeader）、收起态 pl-[208px] 让红绿灯（同 ThreadView 顶栏、208 基线）、
 * hero 与输入卡走 max-w-4xl（同消息列 / EmptyState / ComposerSkeleton）。
 */
export function ChatLoadingSkeleton(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col" aria-hidden>
      {/* 顶栏骨架：对齐 ChatHeader（46px + 底 hairline + 左「圆图标 + 标题条」）。 */}
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border/55 px-4 [body[data-rail-collapsed]_&]:pl-[208px]">
        <div className="size-4 shrink-0 animate-pulse rounded-md bg-foreground/[0.08]" />
        <div className="h-3.5 w-40 animate-pulse rounded bg-foreground/[0.06]" />
      </div>

      {/* 中段：居中空态 hero 轮廓（对齐 EmptyState 的 mascot→title→subtitle
          垂直居中块）。flex-1 + justify-center 落在视口垂直中央。 */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3">
        <div className="mb-5 size-14 animate-pulse rounded-2xl bg-foreground/[0.06]" />
        <div className="mb-3 h-7 w-56 animate-pulse rounded-lg bg-foreground/[0.07]" />
        <div className="h-4 w-72 animate-pulse rounded bg-foreground/[0.05]" />
      </div>

      {/* 底部输入卡骨架：对齐 dock 的 composer 卡（圆角矩形 + 左右圆按钮
          占位），max-w-4xl 居中同消息列，pb-3 同 dock。 */}
      <div className="shrink-0 px-3 pb-3 pt-4">
        <div className="mx-auto w-full max-w-4xl">
          <div className="relative h-[92px] animate-pulse rounded-[22px] bg-foreground/[0.05]">
            <div className="absolute bottom-3 left-3 size-8 rounded-full bg-foreground/[0.07]" />
            <div className="absolute bottom-3 right-3 size-8 rounded-full bg-foreground/[0.09]" />
          </div>
        </div>
      </div>
    </div>
  )
}
