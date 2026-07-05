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
import { UpdateReadyToast } from '@/src/components/UpdateReadyToast'
import { cn } from '@/src/lib/utils'

// canvas App 与 ChatSurface 内部的 ChatApp 同策略：ssr:false，模块只在
// 浏览器求值（canvas 全树有模块期触碰 window 的路径）。入口是 AppRoot
// 而非 App —— I18nProvider 包在那一层：useI18n 的无 Provider 兜底是静默
// no-op（locale 锁 'en'、setLocale 空函数），直接挂 App 会让整个画布面
// 锁死英文、设置页语言切换失灵（2026-07-03 实锤，见 AppRoot 头注释）。
const CanvasApp = dynamic(() => import('@/src/canvas/AppRoot').then((m) => m.AppRoot), {
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
  // 宿主根节点引用：切面后 region-refresh toggle 挂在它身上（见下方 effect）。
  const hostRef = useRef<HTMLDivElement>(null)
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

  // ── 切面后强制重采集原生窗口拖拽区（2026-07-05「切回 chat 顶栏拖不动」实锤）──
  // chat 与 canvas 是**同一个 WebContentsView 里的两棵 React 树**，切换只翻
  // CSS class（content-visibility + surface-inactive），view bounds 不变。
  // Electron 的原生 draggable region 由 Chromium 的 DraggableRegionsChanged
  // 事件驱动上报——而这个事件只在 layout 里 draggable region 集合发生**增量
  // 变化**时才触发。纯 class 切换（尤其隐藏面用 content-visibility:hidden、
  // 其子树整个退出渲染管线）在这里不可靠地触发不了该事件：切回 chat 后 CSS
  // 层 -webkit-app-region 值全对（CDP 实测 region=drag 正常），但**原生层的
  // 拖拽矩形缓存没刷新**，仍是切走前那套 → 顶栏真机拖不动（DOM 命中正常、
  // 只有真实鼠标经过窗口系统时才暴露，同 .surface-inactive / 收起态图标排
  // 家族的坑，Electron issue #20926「app-region drag stops working when
  // BrowserView is changed」同类）。初次加载正常是因为原生层首采集恰好就是
  // 当前面。
  //
  // 修法：切面后把整个宿主根节点瞬时压成 no-drag（`region-refresh` 类，规则
  // 在 globals.css，!important 压过面内所有 drag）→ 强制一次 layout 让
  // Chromium 采集到「所有 drag 都消失」这一拍 → 下一拍移除类、drag 全部恢复。
  // 一缩一放两次显著变化必然逼出 DraggableRegionsChanged，主进程据此重采集
  // 全文档拖拽区、映射到当前可见面。比插 1px 探针稳（探针太小可能被舍入/合并
  // 优化掉）；toggle 只持续 1 帧、期间顶栏短暂不可拖，用户无感。双 rAF 等本轮
  // class 切换与 content-visibility 恢复的 layout 落定后再扰动，确保重采集读
  // 到的是新面的 region。仅桌面壳（有 app-region 语义）生效，浏览器无此层、
  // 无副作用。
  useEffect(() => {
    if (isProbe) return undefined
    const host = hostRef.current
    if (!host) return undefined
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      // 第一拍：整片压 no-drag，读一次 layout 让「drag 消失」被采集。
      host.classList.add('region-refresh')
      void host.offsetHeight
      raf2 = requestAnimationFrame(() => {
        // 第二拍：恢复，drag 全部回来——一缩一放逼出重采集。
        host.classList.remove('region-refresh')
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      host.classList.remove('region-refresh')
    }
  }, [isChat, isProbe])

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
    <div ref={hostRef} className="relative h-full">
      {/* 隐藏用 content-visibility:hidden（而非 visibility:hidden）：隐藏
        * 子树整个退出样式重算/布局/绘制管线（实测 UpdateLayoutTree 356ms
        * 的主要来源就是隐藏面仍参与全文档 recalc），DOM/状态/iframe/滚动
        * 位置全保留；顺带让子树的 IntersectionObserver 正确判定不相交——
        * 后台面里的 LazyMount 不会再全量挂载 iframe。恢复显示时付一次
        * 子树 layout，远小于重建。
        *
        * surface-inactive（globals.css）：把隐藏面的 -webkit-app-region 全部
        * 压成 no-drag。Electron 按 layout box 注册原生窗口拖拽区，不看
        * pointer-events——不加这个，隐藏 canvas 面的全宽 drag 顶栏会把可见
        * chat 面顶部一整条的点击（canvas tab bar 等）吞给窗口拖拽，反向同理。 */}
      {visited.current.chat && (
        <div
          className={cn(
            'absolute inset-0',
            isChat
              ? ''
              : '[content-visibility:hidden] pointer-events-none surface-inactive'
          )}
        >
          {chatFace}
        </div>
      )}
      {visited.current.canvas && (
        <div
          className={cn(
            'absolute inset-0',
            !isChat
              ? ''
              : '[content-visibility:hidden] pointer-events-none surface-inactive'
          )}
        >
          {canvasFace}
        </div>
      )}
      {/* 全局更新就绪提示：fixed 定位 + 顶层 z，必须在两个（可能被
        * content-visibility:hidden 冻结的）面包装 div 之外。 */}
      <UpdateReadyToast />
    </div>
  )
}
