'use client'

/**
 * 双面宿主 —— 「切换卡顿」的治本层（keep-alive）。
 *
 * 问题：App Router 的软导航会把离开路由的 page 树整棵卸载。chat 与
 * canvas 都是重型 SPA 树，每次 rail 切换 = 拆一棵 + 从零重建另一棵：
 * 实测 canvas 面重挂要重载上百个预览 iframe（主线程冻结 1.2-1.5s），
 * chat 面重挂是一个 ~570ms 的整块 render+commit。
 *
 * 方案：两棵树都挂在**这里**——本组件由根 layout 渲染，layout 跨路由
 * 保活，所以两树的挂载与路由生死解耦。路由（usePathname）只决定谁
 * **可见**：切换 = 翻 visibility，React 树不拆、iframe 不重载、滚动
 * 位置与内部状态原样保留。app/chat 与 app/[[...slug]] 的 page 退化为
 * 空壳（仅承担路由命中）。
 *
 * 细节：
 *  - **首访惰挂**：一个面首次成为可见面才挂载（visitedRef），此后常驻。
 *    启动只付当前面的初始化成本，不为「可能切过去」的面预付。
 *  - **隐藏用 visibility 而非 display:none**：none 会使子树失去布局，
 *    恢复显示时滚动位置归零；visibility 保布局保滚动，配 pointer-events
 *    截断交互。两面均 absolute inset-0 叠放。
 *  - **data-surface='chat'** 随可见面翻转（原先挂在 chat page 的挂载/
 *    卸载上；常驻后挂卸不再对应可见性）。main.css 靠它切窗口 chrome 样式。
 *  - /chat-probe 是独立探针页，两面都不渲染，让 page 自己显示。
 */

import dynamic from 'next/dynamic'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef } from 'react'

import { ChatSurface } from '@/src/components/ChatSurface'
import { cn } from '@/src/lib/utils'

// canvas App 与 ChatSurface 内部的 ChatApp 同策略：ssr:false，模块只在
// 浏览器求值（canvas 全树有模块期触碰 window 的路径）。
const CanvasApp = dynamic(() => import('@/src/canvas/App').then((m) => m.App), {
  ssr: false,
  loading: () => <div className="od-loading-shell">加载工作画布…</div>
})

export function SurfaceHost() {
  const pathname = usePathname()
  // settings=1 的判定收在这里（而不是 canvas App 根组件自己订阅
  // useSearchParams）：本组件树很小，随 URL 重渲染便宜；canvas 元素的
  // memo 只依赖 settingsOverlay，chat/画布切换（query 不变）不会再把
  // 整棵 canvas 树拖着 re-render。
  const searchParams = useSearchParams()
  const settingsOverlay = searchParams?.get('settings') === '1'
  const isProbe = pathname.startsWith('/chat-probe')
  const isChat = !isProbe && pathname.startsWith('/chat')

  // 面首次可见后永久保活（ref 而非 state：render 期读写、不需要触发
  // 额外渲染——pathname 变化本身就会重渲染本组件）。
  const visited = useRef({ chat: false, canvas: false })
  if (!isProbe) {
    if (isChat) visited.current.chat = true
    else visited.current.canvas = true
  }

  useEffect(() => {
    if (isChat) {
      document.documentElement.dataset.surface = 'chat'
      return () => {
        delete document.documentElement.dataset.surface
      }
    }
    return undefined
  }, [isChat])

  // 面元素**冻结**（引用恒定）：本组件每次随 usePathname 重渲染，若在
  // render 里裸写 <ChatSurface/>，元素引用每次都是新的 → React 对两棵
  // 万级节点的树做全量 re-render + diff（实测 FunctionCall ~485ms 的大头）。
  // useMemo 固定引用后，切换时只有包装 div 的 className 变，React 对
  // children 直接 bailout。
  const chatFace = useMemo(() => <ChatSurface />, [])
  const canvasFace = useMemo(
    () => <CanvasApp settingsOverlay={settingsOverlay} />,
    [settingsOverlay]
  )

  if (isProbe) return null

  return (
    <div className="relative h-full">
      {/* 隐藏用 content-visibility:hidden（而非 visibility:hidden）：隐藏
        * 子树整个退出样式重算/布局/绘制管线（实测 UpdateLayoutTree 356ms
        * 的主要来源就是隐藏面仍参与全文档 recalc），DOM/状态/iframe/滚动
        * 位置全保留；顺带让子树的 IntersectionObserver 正确判定不相交——
        * 后台面里的 LazyMount 不会再全量挂载 iframe。恢复显示时付一次
        * 子树 layout，远小于重建。 */}
      {visited.current.chat && (
        <div
          className={cn(
            'absolute inset-0',
            isChat ? '' : '[content-visibility:hidden] pointer-events-none'
          )}
        >
          {chatFace}
        </div>
      )}
      {visited.current.canvas && (
        <div
          className={cn(
            'absolute inset-0',
            !isChat ? '' : '[content-visibility:hidden] pointer-events-none'
          )}
        >
          {canvasFace}
        </div>
      )}
    </div>
  )
}
