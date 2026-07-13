'use client'

/**
 * RailShell —— AppRail 的折叠 / 浮出外壳（2026-07-05）。
 *
 * layout 里原本直接放 <AppRail/>（w-61 常驻列）。加折叠功能后，「是否常驻
 * 占位」这个布局决策不该塞进 AppRail 本体（它还要被复用成浮出的 overlay），
 * 所以抽出这层 client 外壳专管三件事：
 *
 *   1. **展开态**：把 AppRail 原样放回 flex 流，占 w-61（AppRail 自带宽度），
 *      和加折叠功能前完全一致。
 *   2. **收起态**：AppRail 退出常驻流（RailShell 在 flex 里宽度收成 0，右侧
 *      内容卡的 flex-1 自动补位占满）。左上角标题栏那一行留一排常驻图标做
 *      入口（展开 / 搜索 / 新建，见下方 CollapsedToolbar）。
 *   3. **收起态 hover 浮出**（用户三选一确认的交互，2026-07-05）：
 *      - 触发：hover 屏幕左边缘热区，或 hover 那排图标里的展开钮 → peek=true
 *      - 表现：AppRail 作为 overlay 从左侧滑出，**悬浮盖在内容上**（fixed +
 *        阴影，内容区纹丝不动，不重排——这是「悬浮盖住」而非「推开」的关键）
 *      - 收回：鼠标移出 overlay 区域 → peek=false，滑回屏外消失
 *
 * peek 是纯本地 UI 态（不进 rail store）：它是转瞬即逝的悬停预览，和「用户
 * 收起 rail」的持久意图是两码事。collapsed 一旦被 toggle 回 false（在 overlay
 * 里点顶部按钮），rail 立刻钉回常驻态，peek 自然失去意义。
 *
 * 渲染在根 layout（body 的第一个 flex item），chat / canvas 两面共享。
 */

import { Plus, Search } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { AppRail } from '@/src/components/AppRail'
import { Button } from '@/src/components/ui/button'
import { useUnreadIdsKey } from '@/src/chat/stores/unread'
import { useDialogStore } from '@/src/chat/stores/dialogs'
import { useRailStore } from '@/src/stores/rail'
import { cn } from '@/src/lib/utils'

export function RailShell() {
  const collapsed = useRailStore((s) => s.collapsed)
  // ── 收起态浮层的 z 按面分档（2026-07-13「canvas 面看不到菜单按钮」实锤）──
  // canvas 面的 tab 栏（base.css .workspace-tabs-chrome）是 z-index:120 +
  // 不透明 backdrop 背景：图标排 z-30 / overlay z-40 在它底下，工作画布收起
  // rail 后整排按钮直接被盖没（不可见也不可点，hover 展开也失效——事件全
  // 打在 tab 栏上）。chat 面顶栏无 z，30/40 够用且**必须维持**：chat 的
  // dialog 层在 z-50（shadcn 默认），图标排/overlay 低于它才会被 modal
  // backdrop 正常罩住。故 canvas 面提到 125/135——压过 tab 栏（120），
  // 仍让给 canvas 全屏层（1200/9000）；overlay 恒高图标排 10，保持
  // 「浮出面板盖住按钮排」的既有不变式。tab 搜索 popover（z-130）与
  // 图标排（125）几何不相交（一个右上一个左上），无碰撞。
  const pathname = usePathname()
  const isChat = pathname.startsWith('/chat')
  // 收起态下 AppRail 临时浮出。展开态永远为 false（collapsed 翻回 false 时
  // 一并清掉，否则钉住展开后残留的 peek=true 会让下次收起瞬间又浮出）。
  const [peek, setPeek] = useState(false)
  useEffect(() => {
    if (!collapsed) setPeek(false)
  }, [collapsed])

  // Portal 目标只在客户端挂载后可用（SSR 无 document.body；且首帧渲染时
  // 若直接 createPortal 到 body 会与 hydration 打架）。挂载后置真，触发一次
  // 重渲染把图标排 portal 出去。见下方图标排段的「为什么必须 portal」长注释。
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // 收起态给 <body> 挂 data-rail-collapsed：内容卡的舞台 gutter 靠它切换
  // （globals.css 的 .shell-stage）——rail 撤走后左侧补回 10px，卡片四边
  // 对称 10px 悬浮。展开态清掉，卡片回原位。
  useEffect(() => {
    const body = document.body
    if (collapsed) body.dataset.railCollapsed = 'true'
    else delete body.dataset.railCollapsed
    return () => {
      delete body.dataset.railCollapsed
    }
  }, [collapsed])

  // ── peek 翻转后强制重采集原生拖拽区（2026-07-06「hover 按钮周围面板仍
  // 消失」二次实锤）──给 overlay 挂 no-drag 类只改了 CSS 层；Electron 的
  // 原生 draggable region 缓存靠 DraggableRegionsChanged 事件刷新，而纯
  // class 切换/transform 位移不可靠地触发不了它（SurfaceHost「切回 chat
  // 顶栏拖不动」同根，Electron issue #20926 同类）。结果：overlay 滑入后
  // 原生层还是滑入前的矩形集合——chat header 那条全宽 46px drag 依然罩着
  // 面板顶部，鼠标一进那片就被当 non-client 合成 mouse-leave，面板自杀，
  // 顶部按钮也点不动。修法复用 globals.css 的 .region-refresh 脉冲：等
  // 滑入/滑回动画落定（200ms + 余量）后整片压 no-drag 一帧再放开，一缩
  // 一放逼 Chromium 重发事件，重采集读到的就是 overlay 当前几何（挖洞
  // 生效/恢复）。挂 body：规则是 .region-refresh 及其后代，body 覆盖全
  // 文档，与 SurfaceHost 挂宿主根的用法互不冲突。
  useEffect(() => {
    if (!collapsed) return undefined
    let raf = 0
    const timer = window.setTimeout(() => {
      document.body.classList.add('region-refresh')
      // 读一次 layout 让「所有 drag 消失」这一拍真的被采集到。
      void document.body.offsetHeight
      raf = requestAnimationFrame(() => {
        document.body.classList.remove('region-refresh')
      })
    }, 240)
    return () => {
      window.clearTimeout(timer)
      cancelAnimationFrame(raf)
      document.body.classList.remove('region-refresh')
    }
  }, [peek, collapsed])

  // 展开态：AppRail 原样占 flex 列，零额外包装（保持与加功能前一致的布局，
  // 避免多套一层 div 影响 w-61 shrink-0 的 flex 行为）。
  if (!collapsed) return <AppRail />

  return (
    // 收起态：本节点在 flex 流里宽度为 0（不占位，内容卡补满）。overlay 与
    // 边缘热区都脱离文档流（fixed / absolute），不撑宽本容器。
    <div className="w-0 shrink-0">
      {/* 左边缘 hover 热区：一条贴着视口左边的透明竖条，进入即触发浮出。
        * fixed 定位盖在内容卡最左侧上方（z 高于内容卡但低于 overlay）。
        * 顶部 48px 让给红绿灯 + 窗口拖拽（top-12）——否则热区会截胡红绿灯
        * 那一横的窗口拖拽/点击。 */}
      <div
        className="fixed left-0 top-12 z-30 h-[calc(100%-3rem)] w-3"
        onMouseEnter={() => setPeek(true)}
      />

      {/* 常驻工具栏：收起后 rail 整个没了，在内容面自己的 46px 标题栏那一行
        * （平铺后标题栏从视口 y=0 起、红绿灯右侧、标题左侧的空白处）留一排
        * 图标——展开 / 搜索 / 新建，仿 macOS 常见的「红绿灯后跟一排
        * 工具钮」布局（用户提供的目标截图）。left-[100px] 让过红绿灯净空——
        * 这个起点必须跟 tabRegistry 的 trafficLightPosition.x（当前 30）联动：
        * 红绿灯右移多少，这里同增多少，否则两者不成一横（2026-07-05 用户要求
        * 整组往右移，红绿灯 x 14→30、本值 84→100 同步）。top-0：容器高与
        * header 同为 46px，顶对顶即中线对中线（23）；浮卡时代是 top-2.5，
        * 对的是从 y=10 起的 header——2026-07-08 平铺化随 stage gutter 归零。
        *
        * ⚠️ 为什么必须 portal 到 body 末尾（2026-07-05「三图标点不动」实锤）：
        * 图标排标了 no-drag，但覆盖它所在 y 的窗口拖拽矩形不止一条——根
        * .window-drag-strip（body 首子元素，比 RailShell 更靠前，对它不
        * portal 也能挖动）之外，canvas 面自己的顶栏 drag（base.css 的
        * .workspace-tabs-chrome，冗余保留）在 shell-stage 深处、DOM 比
        * RailShell **靠后**。Electron 收集 app-region 是按渲染树遍历顺序
        * 注册原生拖拽矩形、**后注册覆盖先注册**，且 no-drag 只能在「先
        * 注册的 drag」上挖洞——不 portal 则图标排 no-drag 先注册、被后面
        * 的 drag 整片盖过 → macOS 把点击当窗口拖拽截走，mousedown 根本
        * 不下发给 renderer（DOM elementFromPoint 仍能命中按钮、CDP 的
        * Input.dispatchMouseEvent 也能点 → 都是假象，app-region 拦截在
        * 原生层、只有真实鼠标经过窗口系统时才发生；同 .surface-inactive
        * 家族的坑）。portal 到 body 末尾让图标排 no-drag **最后注册**，
        * 稳压一切 drag，真实点击才落到按钮上。mounted 前不 portal（SSR
        * 无 body + 防 hydration）。图标排里全是 shadcn Button（带 data-slot），
        * 不受 portal 出 .chat-app 豁免后的 canvas 裸元素 reset 影响。 */}
      {mounted &&
        createPortal(
          <div
            className={cn(
              'fixed left-[100px] top-0 flex h-[46px] items-center gap-0.5 [-webkit-app-region:no-drag]',
              // z 分档理由见 RailShell 顶部注释：canvas 面要压过 tab 栏
              // （z-120），chat 面维持低位让 dialog（z-50）罩得住。
              isChat ? 'z-30' : 'z-[125]'
            )}
          >
            <CollapsedToolbar peek={peek} onPeek={() => setPeek(true)} />
          </div>,
          document.body
        )}

      {/* 浮出的 overlay：完整 AppRail（含红绿灯净空条、顶部收起按钮、列表、
        * 设置）。fixed 贴左，默认 -translate-x-full 藏在屏外，peek 时滑入。
        * 悬浮盖在内容上（高 z + 阴影），内容区不参与、不重排。移出整块
        * overlay（含热区/图标是 mouseenter 触发，这里是 mouseleave 收回）
        * 即滑回。
        *
        * ⚠️ 三件事缺一不可，否则「鼠标刚移进面板就缩回、顶部按钮点不到」
        * （2026-07-06 实锤，机制同上方图标排的「三图标点不动」）：
        *
        * 1. **portal 到 body 末尾**：overlay 顶部 y≈10-56 与窗口拖拽带
        *    （根 .window-drag-strip 46px + canvas 面顶栏的冗余 drag）在
        *    屏幕上重叠。drag/no-drag 矩形按 DOM 遍历顺序注册、后者覆盖
        *    前者——RailShell 在 body 靠前位，不 portal 则 overlay 的
        *    no-drag 会被 DOM 更靠后的 canvas 顶栏 drag 整片盖回，白标。
        * 2. **peek 时容器标 no-drag**：把 overlay 覆盖的整个矩形从原生拖拽
        *    区里挖掉。真实鼠标落在 drag 区＝落在 non-client 区，renderer
        *    收不到 mousemove 还会被合成 mouse-leave → onMouseLeave 误 fire →
        *    peek=false → 面板消失。CDP/elementFromPoint 全测不出（不走原生
        *    窗口层），只有真实鼠标复现。只在 peek 时标：藏在屏外时不占洞，
        *    万一 region 收集不按 transform 后的位置算，也不会把收起态标题栏
        *    左段的窗口拖拽误挖掉。
        * 3. **AppRail 传 overlay**：关掉它自带的顶部 drag 净空条——那是子
        *    节点、比本容器后遍历，不关会把刚挖的洞原地填回（no-drag 挖洞
        *    只对「先注册的 drag」有效）。 */}
      {mounted &&
        createPortal(
          <div
            className={cn(
              'fixed left-0 top-0 h-full transition-transform duration-200 ease-out',
              'bg-sidebar shadow-[0_8px_40px_rgba(0,0,0,0.18)]',
              // z 分档理由见 RailShell 顶部注释：canvas 面不提的话，overlay
              // 滑出后顶部 46px 会被 tab 栏（z-120）压住，AppRail 自己的
              // 收起按钮被盖没点不到。恒比图标排高 10，浮出时盖住按钮排。
              isChat ? 'z-40' : 'z-[135]',
              peek
                ? 'translate-x-0 [-webkit-app-region:no-drag]'
                : '-translate-x-full'
            )}
            onMouseLeave={(e) => {
              // 假 leave 免疫：区分「真离开」与「drag 区合成的 leave」。
              // region-refresh 脉冲生效前有 ~240ms 窗口（外加任何原生
              // region 缓存失灵的场合），鼠标碰到残留 drag 矩形会收到一次
              // 合成 mouse-leave——其坐标是鼠标最后位置，仍在 overlay 矩形
              // **内**；真移出 overlay 的 leave 坐标必在矩形外。坐标在内
              // 就忽略，面板不再被假 leave 杀掉（此时按钮可能仍点不动，
              // 等脉冲刷完即恢复，但至少面板不当着用户的面缩回）。
              const r = e.currentTarget.getBoundingClientRect()
              const inside =
                e.clientX >= r.left &&
                e.clientX < r.right &&
                e.clientY >= r.top &&
                e.clientY < r.bottom
              if (!inside) setPeek(false)
            }}
          >
            <AppRail overlay />
          </div>,
          document.body
        )}
    </div>
  )
}

/**
 * 收起态标题栏那一排图标（展开 / 搜索 / 新建）。
 *
 * 三个钮的语义按用户确认（2026-07-05）落定：
 *  - **展开**：实心侧栏图标 + 蓝点未读徽标（见 CollapseSidebarIcon）。hover
 *    或点击都触发浮出（对不习惯蹭左边缘的用户更友好）。浮出时它和 overlay
 *    里 AppRail 顶部的收起按钮位置重叠，淡出让位避免两个图标叠在一起。
 *  - **搜索**：只在聊天面显示——它开的是 chat 的会话搜索框（SessionSearchDialog
 *    只挂在 chat 树里，openDialog('search') 的弹窗在 canvas 面是隐藏面里的
 *    DOM，点了也看不到）。canvas 没有对应的统一搜索，故该面不渲染此钮。
 *  - **新建**：跟随当前 surface（与 AppRail 顶部主按钮同一套逻辑）——聊天面
 *    「新对话」（切到 null 会话），画布面「新画布」（回 canvas 首页）。
 *
 * 蓝点挂在展开钮上：未读发生在收起的会话列表里，蓝点是「侧栏里有新回复」
 * 的提示。数据源用 useUnreadIdsKey()——空串即无未读，稳定字符串 key 避免
 * fresh-Set 的 getSnapshot 循环（和 RailSessionList 同一订阅姿势）。
 */
function CollapsedToolbar({ peek, onPeek }: { peek: boolean; onPeek: () => void }) {
  const pathname = usePathname()
  const isChat = pathname.startsWith('/chat')
  // 空串 = 无未读；任意非空 = 有未读会话 → 展开钮亮蓝点。
  const hasUnread = useUnreadIdsKey() !== ''

  return (
    <>
      {/* 展开钮：浮出时淡出让位（见上）。图标是自定义实心侧栏（lucide 只有
        * 描边版 PanelLeft，目标截图是左格填充的实心款，故手写 SVG）。 */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="展开侧边栏"
        title="展开侧边栏"
        className={cn(
          'relative text-muted-foreground transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground',
          peek && 'pointer-events-none opacity-0'
        )}
        onMouseEnter={onPeek}
        onClick={onPeek}
      >
        <CollapseSidebarIcon className="size-4" />
        {hasUnread && (
          // 未读徽标：钉在图标右上角的小蓝点。bg-[#3b82f6] 与会话行未读点
          // 同色（RailSessionList），描一圈 sidebar 底色让它从图标上「浮」
          // 出来（避免和图标线条糊在一起）。
          <span className="absolute right-1 top-1 size-2 rounded-full bg-[#3b82f6] ring-2 ring-sidebar" />
        )}
      </Button>

      {/* 搜索：仅聊天面（见 CollapsedToolbar 头注释） */}
      {isChat && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="搜索会话"
          title="搜索会话"
          className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={() => useDialogStore.getState().openDialog('search')}
        >
          <Search className="size-4" />
        </Button>
      )}

      {/* 新建：跟随 surface（与 AppRail 顶部主按钮同逻辑）。浏览器直开无
        * tabApi 时聊天分支退化为 no-op；canvas 分支动态 import router（其
        * 模块求值期触碰 window，不能静态进本组件——同 AppRail 的约束）。 */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={isChat ? '新对话' : '新画布'}
        title={isChat ? '新对话' : '新画布'}
        className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={() => {
          if (isChat) {
            void window.tabApi?.switchShellSession?.(null)
          } else {
            void import('@/src/canvas/router').then(({ navigate }) => {
              navigate({ kind: 'home', view: 'home' })
            })
          }
        }}
      >
        <Plus className="size-4" />
      </Button>
    </>
  )
}

/**
 * 实心侧栏图标 —— 收起态展开钮专用。
 *
 * lucide 的 PanelLeft 是「圆角外框 + 一条竖分割线」的纯描边款；用户目标
 * 截图要的是**左侧那一格被填充成实心**的观感（表达「侧栏在这、点开」）。
 * lucide 无此变体，故手写：外框 rect 走 stroke（跟随 currentColor），左格
 * 用一个 filled rect 补实心。stroke-width 2、圆角 2，和 lucide 同款几何，
 * 混排在 lucide 图标堆里不违和。
 */
function CollapseSidebarIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 外框 */}
      <rect x="3" y="3" width="18" height="18" rx="2" />
      {/* 左格实心填充：从外框内壁到 x=9 分割线，填 currentColor */}
      <path d="M4 4h5v16H4z" fill="currentColor" stroke="none" />
      {/* 分割线（x=9），与 lucide PanelLeft 对齐 */}
      <path d="M9 3v18" />
    </svg>
  )
}
