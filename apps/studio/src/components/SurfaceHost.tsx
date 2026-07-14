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
  // 知识库页：**与设置页同一套机制**——canvas App 渲染的全屏 overlay
  // （fixed inset-0 + 不透明底），?kb=1 挂在当前 pathname 上（AppRail 的
  // openKnowledgeBase 软导航 pushState 进来）。它不是独立的第三个面，而是
  // 复用 canvas 面：kb=1 时和 settings=1 一样强制放映 canvas 面，由 canvas
  // App 内部按 kbOverlay 提前 return 只渲染知识库 UI（见 App.tsx）。
  const kbOverlay = searchParams?.get('kb') === '1'
  const isProbe = pathname.startsWith('/chat-probe')
  const isChat = !isProbe && pathname.startsWith('/chat')
  // 哪个面正在「放映」：设置页/知识库页都是 canvas App 渲染的全屏 overlay
  // （fixed inset-0 + 不透明底），settings=1 或 kb=1 时无论 pathname 在哪都
  // 必须放映 canvas 面。两个参数都挂在**当前 pathname** 上（AppRail 的
  // openSettings / openKnowledgeBase），打开/关闭 pathname 全程不动——rail
  // tab 高亮、rail 中段列表、back() 的落点都保持原面（2026-07-08「返回应用时
  // tab 从工作画布切到智能助手」的根修：旧方案 pushState('/?settings=1') 把
  // pathname 拽到 '/'，rail 在设置页底下默默切到画布态，揭开时再翻回，
  // 用户看到一次假切换）。本组件所有可见性判定一律用 chatShowing，
  // isChat 只是它的原料。
  const chatShowing = isChat && !settingsOverlay && !kbOverlay

  // 面首次可见后永久保活（ref 而非 state：render 期读写、不需要触发
  // 额外渲染——pathname 变化本身就会重渲染本组件）。
  const visited = useRef({ chat: false, canvas: false })
  if (!isProbe) {
    if (chatShowing) visited.current.chat = true
    else visited.current.canvas = true
  }

  useEffect(() => {
    if (chatShowing) {
      document.documentElement.dataset.surface = 'chat'
      return () => {
        delete document.documentElement.dataset.surface
      }
    }
    return undefined
  }, [chatShowing])

  // ── 切面**不再**做任何 region-refresh 脉冲（2026-07-14 拖拽机制重构，删）──
  // 历史上这里有个切面 effect：瞬时给 documentElement 挂 `.region-refresh` 类
  // 再移除（把 .window-drag-strip 一缩一放），逼 Chromium 重采集原生拖拽区。
  // 它存在的**唯一理由**是：当年隐藏面的后代会注册 no-drag/drag 矩形、DOM 序
  // 在后盖穿常驻 strip，切面后需要逼一次重采集让 strip 恢复。
  //
  // 但脉冲机制本身是**竞态源**（CDP 真机实测坐实）：快速来回切多面时，某次
  // 脉冲「加类压 no-drag → rAF 放回」的「放回」拍被另一个写手（本 effect /
  // RailShell / 主进程 tabRegistry）的同步 cleanup 摘类打断，`.region-refresh`
  // 卡在 documentElement 上不移除 → strip 永久 no-drag → 整窗拖不动（手动清掉
  // 类 strip 立刻恢复 drag，实测确认）。补 rAF / 加兜底轮 / 换 deps 都治不了这
  // 个「多写手争抢一个全局类 + React 同步 cleanup」的结构性竞态。
  //
  // 根治：**隐藏面整棵 app-region:initial**（globals.css .surface-inactive）。注意
  // 是 `initial` 不是 `none`——app-region 合法值只有 drag/no-drag，`none` 非法会被
  // 静默忽略、保留继承来的 no-drag（2026-07-14 第六版实测，此前用 none 从未生效）；
  // `initial` 回初始态才真不注册矩形、对拖拽透明。于是隐藏面永不盖 strip；strip 几
  // 何恒定、永不重挂载，其 drag 矩形从首次采集起就恒在原生缓存里，切面时它本身的
  // 矩形零变化 → 根本不需要重采集。脉冲存在的前提消失，遂全删（本 effect + RailShell
  // + 主进程 tabRegistry 注入 + globals.css 的 .region-refresh 规则）。

  // 面元素**冻结**（引用恒定）：本组件每次随 usePathname 重渲染，若在
  // render 里裸写 <ChatSurface/>，元素引用每次都是新的 → React 对两棵
  // 万级节点的树做全量 re-render + diff（实测 FunctionCall ~485ms 的大头）。
  // useMemo 固定引用后，切换时只有包装 div 的 className 变，React 对
  // children 直接 bailout。
  const chatFace = useMemo(() => <ChatSurface />, [])
  // 设置页与知识库页都是 canvas App 内部的全屏 overlay（提前 return），
  // 由这两个 prop 驱动——memo 依赖二者，settings/kb 翻转时才重建 canvas
  // 元素，普通 chat↔画布切换（两参不变）canvas 树 bailout 不 re-render。
  const canvasFace = useMemo(
    () => (
      <CanvasApp settingsOverlay={settingsOverlay} knowledgeBaseOverlay={kbOverlay} />
    ),
    [settingsOverlay, kbOverlay]
  )

  if (isProbe) return null

  return (
    <div className="relative h-full">
      {/* chat 面的窗口拖拽由根 layout 的 .window-drag-strip（body 首子、fixed
        * 全宽 46px 常驻 drag）统一负责，ChatHeader 只在其上挖 no-drag 洞——这条
        * 一直是对的，真正的病根不在 chat 侧，而在隐藏 canvas 面容器的**全屏
        * no-drag**（.surface-inactive 容器自身）DOM 序在最后、盖过 strip 的 drag
        * （详见 globals.css 的 .surface-inactive 2026-07-14 修正注释）。那条修好
        * 后 strip 恒生效，chat 面无需自带任何 drag 源。历史上此处试过的浅层
        * drag 探条 / ChatHeader 自带 drag 均因误诊「盒子恢复赛跑」而加、真因见
        * 底后已全部撤除。 */}

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
            chatShowing
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
            // canvas 面在 chat 未放映时显示——这囊括了「画布 pathname」「设置
            // overlay（settings=1）」「知识库 overlay（kb=1）」三种情形，后两者
            // 都是 canvas App 内部的全屏 overlay，共用这块画布面容器。
            !chatShowing
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
