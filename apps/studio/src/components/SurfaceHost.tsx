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
  // 修法：切面后给 documentElement 瞬时挂 `region-refresh` 类再移除——
  // 它让根 layout 的**窗口拖拽条**（.window-drag-strip，fixed 全宽 46px
  // 常驻，兼任脉冲探针）一缩一放两次 region 变化，必然逼出
  // DraggableRegionsChanged；该事件全量上报，主进程据此重采集**全文档**
  // 拖拽区。2026-07-08 性能收窄：最初规则是全文档 `*` 压平，每轮脉冲两次
  // 16k+ 节点 recalc ≈ 165ms（切面「不丝滑」主因）——事件既然全量上报，
  // 一个探针的变化就够，详见 globals.css 的 .window-drag-strip 注释。
  // 同日拖拽面收敛重构后，组件顶栏不再自带 drag、strip 恒在缓存里，本
  // 脉冲的兜底对象缩小为「新挂载控件的 no-drag 洞未入缓存」。
  //
  // 2026-07-08 加固（「切换几次页面后又拖不动」实锤）：v1 的单轮双 rAF
  // （rAF 加类 → 下一 rAF 移除）有两个败点——
  //  ① 快速连续切面：effect cleanup 同步摘类，若「加类」尚未被任何一帧
  //     commit 就被摘掉，这一轮净变化为零、事件不发；用户停在最后一次
  //     切换上时若恰逢该竞态，就没有下一轮补救了。
  //  ② 「压缩拍」只依赖单个 rAF 间隙被 commit——切面瞬间主线程正忙
  //     （隐藏面 content-visibility 恢复的大 layout），帧调度无保证。
  // 现在每轮 pulse 改为「加类 → 双 rAF（至少一次完整帧带着 no-drag 状态
  // commit）→ 移除」，并在 250ms 后追加第二轮兜底：彼时切面大 layout 已
  // 落定，这轮的一缩一放不再与切面自身的 region 变化交错，必然干净逼出
  // 两次上报。比插 1px 探针稳（探针太小可能被舍入/合并优化掉）；toggle
  // 期间顶栏短暂不可拖（各约 2 帧），用户无感。仅桌面壳（有 app-region
  // 语义）生效，浏览器无此层、无副作用。
  //
  // 同族修复：window tab 切换（removeChildView/addChildView swap）后
  // renderer 的 region 集合零变化、不会重新上报——那条路径由主进程
  // tabRegistry.activateTab 注入同款扰动兜底（本 effect 感知不到 swap）。
  useEffect(() => {
    if (isProbe) return undefined
    const root = document.documentElement
    const rafs: number[] = []
    const timers: ReturnType<typeof setTimeout>[] = []
    const raf = (fn: FrameRequestCallback) => {
      rafs.push(requestAnimationFrame(fn))
    }
    // 单轮扰动：探针压 no-drag → 双 rAF 保证该状态至少随一次完整帧
    // commit → 恢复。offsetHeight 强制同步 layout，让探针的 region 变化
    // 在本帧就绪（收窄后 invalidation 只有探针一个元素，此处 ≈0ms）。
    const pulse = () => {
      root.classList.add('region-refresh')
      void root.offsetHeight
      raf(() =>
        raf(() => {
          root.classList.remove('region-refresh')
        })
      )
    }
    // 第一轮：下一帧起跳（等本次 class 切换 / content-visibility 恢复的
    // layout 先落定，重采集读到的才是新面的 region）。
    raf(pulse)
    // 第二轮兜底：切面重活干完后的稳定态再逼一次。
    timers.push(setTimeout(pulse, 250))
    return () => {
      rafs.forEach(cancelAnimationFrame)
      timers.forEach(clearTimeout)
      root.classList.remove('region-refresh')
    }
    // deps 是 chatShowing（不是 isChat）：设置页/知识库页盖上/揭开也是一次
    // 面切换（chat 面 content-visibility 翻转、drag region 集合变化），同样
    // 需要逼一次原生拖拽区重采集——两者都经 chatShowing 翻转，无需单列。
  }, [chatShowing, isProbe])

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
