'use client'

/**
 * 聊天面 —— 原 app/chat/page.tsx 的实体，抽成组件后由 SurfaceHost 常驻
 * 挂载（路由切换只翻显隐，不再卸载重挂——切回聊天不用重付 ~570ms 的
 * 全树 remount 冻结）。
 *
 * 两层包装，各管一件事：
 *
 *  - **dynamic + ssr:false**：迁入的 App 树（src/chat/）是原 Vite SPA 代码，
 *    stores/组件里有模块求值期就触碰 window/localStorage 的路径。关掉 SSR/
 *    prerender 让这些模块只在浏览器求值。
 *
 *  - **HostGate**：window.chatApi 的宿主门。类型上 chatApi 声明为非可选
 *    （见 src/types/window.d.ts），运行时浏览器直开是 undefined——gate 不过
 *    就不渲染 App。注入检测给 2s 宽限窗轮询（不能查一次锁死：瞬时竞态会被
 *    永久化成错误页，见 errors/2026-07-03-HostGate单次判定锁死…）。
 *
 * data-surface='chat' 的打标不在这里——组件常驻后挂卸载不再对应「聊天面
 * 是否可见」，打标随可见性走，收在 SurfaceHost。
 */

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'

import { Button } from '@/src/components/ui/button'
import { ChatLoadingSkeleton } from '@/src/components/ChatLoadingSkeleton'

const ChatApp = dynamic(() => import('@/src/chat/App'), {
  ssr: false,
  // chat App chunk 下载/求值期的骨架（预示 chat 形态，替代旧的「加载聊天
  // 界面…」文案）。同一骨架也在 chat App 的 workspace-loading 分支复用，两
  // 段加载态接力无空白凹陷——见 ChatLoadingSkeleton 头注释。
  loading: () => <ChatLoadingSkeleton />
})

const HOST_GATE_GRACE_MS = 2000
const HOST_GATE_POLL_MS = 100

export function ChatSurface() {
  // null = 检测中（首帧 + 宽限窗口，避免文案闪烁/误判）。
  // 初始值**恒为 null**，不在 useState 初始化器里分支 typeof window：本组件
  // 会被 prerender（服务端渲染出空），客户端 hydration 首帧若同步判成 true
  // 会直接渲染 ChatApp 的 Suspense 壳，与服务端 HTML 对不上 → hydration
  // mismatch 整树重建（2026-07-04 实锤）。「挂载同步判一次」下移到 effect：
  // 仍是挂载后立即放行（壳内正常路径不等轮询），只多付一帧空白。
  const [hosted, setHosted] = useState<boolean | null>(null)

  useEffect(() => {
    // 壳内正常路径 preload 早已注入：首跑同步判一次直接放行。
    if (typeof window.chatApi !== 'undefined') {
      setHosted(true)
      return undefined
    }
    // 没判到再进 2s 宽限窗轮询——不能查一次锁死，瞬时竞态会被永久化成
    // 错误页（见 errors/2026-07-03-HostGate单次判定锁死…）。
    const deadline = Date.now() + HOST_GATE_GRACE_MS
    const timer = window.setInterval(() => {
      if (typeof window.chatApi !== 'undefined') {
        window.clearInterval(timer)
        setHosted(true)
      } else if (Date.now() >= deadline) {
        window.clearInterval(timer)
        setHosted(false)
      }
    }, HOST_GATE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  if (hosted === null) return null
  if (!hosted) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-2 text-sm">
        <p>聊天功能需要在桌面应用内使用。</p>
        <p className="opacity-60">这是浏览器直开的 studio（未注入 chatApi）。</p>
        {/* 自救出口：若走到这里的其实是壳内的罕见时序问题（而非真浏览器
            直开），重载一次即恢复——preload 会随新文档重新注入。
            shadcn Button（非裸 button）：根 layout 层不在 canvas reset 的
            豁免范围内，裸写会被填成描边卡片（见 CLAUDE.md 样式分层）。 */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
          className="mt-2 text-xs text-muted-foreground hover:text-foreground"
        >
          重新加载
        </Button>
      </main>
    )
  }
  // 不再自带浮动卡：悬浮内容卡上移到了壳层（app/layout.tsx 的
  // .shell-content-card），chat 与 canvas 两面共用一块卡——旧版只有聊天面
  // 浮、画布面贴死，两面视觉不一致（docs/ui-prototype-shell-floating.html
  // 落地时统一）。原先这里还画了一层 bg-sidebar 兜底 main.css 的
  // data-surface='chat' 透明规则，那条规则已随单视图化删除，兜底一并退役。
  return <ChatApp />
}
