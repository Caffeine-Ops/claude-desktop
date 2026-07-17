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
import { useSurfaceOverlayStore } from '@/src/stores/surfaceOverlay'
import { useBackgroundZoneStore } from '@/src/stores/backgroundZone'
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

// 外观写手 + 同步桥（零 DOM）。ssr:false 与上面同理：applier 走 useLayoutEffect、
// 且链上是 chat 的 store 树，不能进 SSR。
//
// 挂在**这里**而不是 chat/App.tsx 里（2026-07-17 迁移）：chat 面随 chatShowing
// 整棵拆装，设置页一开写手和 od:theme-mode-applied 监听器就双双缺席——偏偏
// 「在设置页里切主题」正是它们最该在岗的场景。本组件由根 layout 渲染、跨路由
// 保活，挂这层后它们的存活与任何面的可见性策略解耦（此前是靠 keep-alive 的
// visitedRef 侥幸兜住的，见 AppearanceBridge 头注释）。
const AppearanceBridge = dynamic(
  () => import('@/src/chat/AppearanceBridge').then((m) => m.AppearanceBridge),
  { ssr: false }
)

// 插件市场面（?market=1）。ssr:false 与上面两个同理。它是**第三个面**而不是
// canvas 内部的 overlay（设置页那样）：SurfaceHost 渲染在 rail 右侧的
// shell-stage 里（app/layout.tsx），所以挂在这一层天然就是「rail 常驻 + 右侧
// 换成市场」——用户定稿的形态（2026-07-17）。市场树本身住 canvas 目录但生在
// chat 栈（shadcn + scoped @source，见 chat/styles/index.css），依赖链只有
// shadcn 原语 + contracts，不碰 canvas 的 window 触碰路径，dynamic 只是为了
// 按需加载 + 与另两面策略一致。
const MarketSurface = dynamic(
  () => import('@/src/canvas/components/market/MarketSurface').then((m) => m.MarketSurface),
  { ssr: false }
)

// 知识库面（?kb=1）—— **第四个面，与市场面同构**（2026-07-17 用户要求「改造成
// 跟插件页面交互一样，不要切换页面」）。此前它是 canvas App 内部 `fixed inset-0
// z-50` 的全屏 overlay（同设置页），逃出 stage 连 rail 一起盖住，所以得自画一条
// 244px 左导航 + 「返回应用」；抬到这一层后 rail 常驻，那条自画导航收成顶栏
// tabs、返回按钮直接删（退出路径就是 rail 本身）。设置页仍留在 canvas 内部
// overlay 那一族——它是「模态化的系统配置」，盖住 rail 是刻意的。
const KnowledgeBaseSurface = dynamic(
  () =>
    import('@/src/canvas/components/knowledge-base/KnowledgeBaseSurface').then(
      (m) => m.KnowledgeBaseSurface
    ),
  { ssr: false }
)

export function SurfaceHost() {
  const pathname = usePathname()
  // settings=1 的判定收在这里（而不是 canvas App 根组件自己订阅
  // useSearchParams）：本组件树很小，随 URL 重渲染便宜；canvas 元素的
  // memo 只依赖 settingsOverlay，chat/画布切换（query 不变）不会再把
  // 整棵 canvas 树拖着 re-render。
  const searchParams = useSearchParams()
  const settingsOverlay = searchParams?.get('settings') === '1'
  // 面开关（?market=1 插件市场 / ?kb=1 知识库）：与 settings 同一套「query 挂
  // 当前 pathname」机制，但**不是** canvas 内部的全屏 overlay，而是下面与
  // chat/canvas 平级的独立面（本组件已在 rail 右侧的 stage 里，故它们天然不盖
  // rail）。机制与形态取舍详见 src/stores/surfaceOverlay.ts 头注释。
  const marketOverlay = searchParams?.get('market') === '1'
  const kbOverlay = searchParams?.get('kb') === '1'
  const isProbe = pathname.startsWith('/chat-probe')
  const isChat = !isProbe && pathname.startsWith('/chat')
  // 哪个面正在「放映」：设置页是 canvas App 渲染的全屏 overlay（fixed inset-0
  // + 不透明底），settings=1 时无论 pathname 在哪都必须放映 canvas 面。所有
  // overlay 参数都挂在**当前 pathname** 上（AppRail 的 openSettings /
  // openSurfaceOverlay），打开/关闭 pathname 全程不动——rail tab 高亮、rail
  // 中段列表、back() 的落点都保持原面（2026-07-08「返回应用时 tab 从工作画布
  // 切到智能助手」的根修：旧方案 pushState('/?settings=1') 把 pathname 拽到
  // '/'，rail 在设置页底下默默切到画布态，揭开时再翻回，用户看到一次假切换）。
  // 本组件所有可见性判定一律用 chatShowing，isChat 只是它的原料。
  //
  // 面开关（market/kb）优先级最高：它们盖住 chat/canvas 任一面（参数可以挂在
  // 两个面的 pathname 上）。四者互斥、恰有一个在放映——两个面开关同时出现在
  // URL 上是不可能的（openSurfaceOverlay 开新面时先剥旧面），万一手工构造出
  // 这种 URL，下面的 || 顺序让 market 赢，不会两个一起渲染。
  const marketShowing = !isProbe && marketOverlay
  const kbShowing = !isProbe && kbOverlay && !marketShowing
  const overlayShowing = marketShowing || kbShowing
  const chatShowing = isChat && !settingsOverlay && !overlayShowing
  // 画布面：chat 与两个面开关都没在放映时显示——这囊括「画布 pathname」与
  // 「设置 overlay」两种情形（后者是 canvas App 内部的全屏 overlay，共用画布
  // 面容器）。
  const canvasShowing = !chatShowing && !overlayShowing

  // 面首次可见后永久保活（ref 而非 state：render 期读写、不需要触发
  // 额外渲染——pathname 变化本身就会重渲染本组件）。
  // market/kb 两面**不进这套**：它们轻量且是临时目的地，走条件渲染即用即卸
  // （理由见 MarketSurface 头注释）。这里必须用 canvasShowing 而不是
  // `else`——否则面开着时会把 canvas 误标成 visited，白挂一棵重型树。
  const visited = useRef({ chat: false, canvas: false })
  if (!isProbe) {
    if (chatShowing) visited.current.chat = true
    else if (canvasShowing) visited.current.canvas = true
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

  // 背景图（壁纸）的 route-aware 遮罩分级：唯一写手，与上面的 data-surface
  // 同款「本组件是本属性的唯一写手」纪律。chat 面放映时跟着
  // useBackgroundZoneStore（BgZoneReporter 在 ThreadView 的空态/会话态两分支
  // 各报一次）；canvas/market/kb 任一面放映时恒 'focus'——v1 只有 chat 面分
  // 氛围/工作两档，其余面密度高，没有氛围态可言（background-art.css 消费）。
  // isProbe 下不写，避免探针页染上属性。
  const chatZone = useBackgroundZoneStore((s) => s.chatZone)
  useEffect(() => {
    if (isProbe) return undefined
    document.documentElement.setAttribute('data-bg-zone', chatShowing ? chatZone : 'focus')
    return () => {
      document.documentElement.removeAttribute('data-bg-zone')
    }
  }, [isProbe, chatShowing, chatZone])

  // 把当前放映的面镜像进 store 供 rail 订阅（rail 不在 Suspense 内、不能自己
  // useSearchParams，理由见 stores/surfaceOverlay.ts）。本组件是唯一写手。
  useEffect(() => {
    useSurfaceOverlayStore.setState({
      open: marketShowing ? 'market' : kbShowing ? 'kb' : null
    })
  }, [marketShowing, kbShowing])

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
  // 设置页是 canvas App 内部的全屏 overlay（提前 return），由这个 prop 驱动
  // ——memo 只依赖它，settings 翻转时才重建 canvas 元素，普通 chat↔画布切换
  //（该参不变）canvas 树 bailout 不 re-render。
  // 知识库曾是这里的第二个 prop（knowledgeBaseOverlay），2026-07-17 抬成独立
  // 的第四个面后不再经 canvas 树，故摘除——canvas 面从此少一个重建触发源。
  const canvasFace = useMemo(
    () => <CanvasApp settingsOverlay={settingsOverlay} />,
    [settingsOverlay]
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
            // surface-face(--chat): background-art.css 的路由感知遮罩挂点
            // （门控在 html[data-bg-art]，功能关闭时零命中）。
            'absolute inset-0 surface-face surface-face--chat',
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
            'absolute inset-0 surface-face surface-face--canvas',
            canvasShowing
              ? ''
              : '[content-visibility:hidden] pointer-events-none surface-inactive'
          )}
        >
          {canvasFace}
        </div>
      )}
      {/* 两个面开关（?market=1 / ?kb=1）——与上面两面平级、DOM 序在后（放映时
        * 另两面都已是隐藏态，不存在盖穿问题）。条件渲染而非 keep-alive：轻量
        * 临时目的地，见 MarketSurface 头注释。顶部 46px 是 window-drag-strip
        * 的地盘，两个面的顶栏都自己挖了 no-drag 洞（各自组件里）。
        *
        * bg-card 是本条**新加**的（2026-07-17，背景图换肤功能引出的回归）：
        * MarketView.tsx/KnowledgeBaseSurface.tsx 自己的根节点从来没有背景色，
        * 一直白嫖 .shell-content-card 的不透明底（hsl(var(--card))）。壁纸
        * 功能把 .shell-content-card 在 html[data-bg-art] 时改成透明后，这两
        * 个"本该保持不透明、不参与换肤"的临时面（用户已确认此范围，
        * background-art.css 头注释）意外也漏了壁纸——页面里零散的卡片/搜索框
        * 各自的 bg-card 底不会漏、但页面整体大面积区域会露出壁纸色调，跟那些
        * 不透明色块拼成花斑（2026-07-17 真机实锤，看着像"配色不搭配"）。这里
        * 直接给包装 div 补一层不受 data-bg-art 影响的固定不透明底，两个面
        * 就永远不透壁纸，不用在每个组件内部分别处理。 */}
      {marketShowing && (
        <div className="absolute inset-0 bg-card">
          <MarketSurface />
        </div>
      )}
      {kbShowing && (
        <div className="absolute inset-0 bg-card">
          <KnowledgeBaseSurface />
        </div>
      )}
      {/* 外观写手 + 同步桥：零 DOM，但和 UpdateReadyToast 同理必须在两个面的
        * 包装 div 之外——它要在「chat 面被撤掉（设置页/知识库页开着）」时继续
        * 在岗，那正是 canvas 写手广播 themeMode 的时刻。 */}
      <AppearanceBridge />
      {/* 全局更新就绪提示：fixed 定位 + 顶层 z，必须在两个（可能被
        * content-visibility:hidden 冻结的）面包装 div 之外。 */}
      <UpdateReadyToast />
    </div>
  )
}
