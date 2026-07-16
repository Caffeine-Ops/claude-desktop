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
 *      内容卡的 flex-1 自动补位占满）。
 *   3. **收起态 hover 浮出**（用户三选一确认的交互，2026-07-05）：
 *      - 触发：hover 屏幕左边缘热区，或 hover 常驻按钮组里的开关钮 → peek=true
 *      - 表现：AppRail 作为 overlay 从左侧滑出，**悬浮盖在内容上**（fixed +
 *        阴影，内容区纹丝不动，不重排——这是「悬浮盖住」而非「推开」的关键）
 *      - 收回：鼠标移出 overlay 区域 → peek=false，滑回屏外消失
 *
 * 顶部常驻按钮组（开关 / 搜索 / 新建，见 railTopButtons，2026-07-16 Codex
 * 定稿）：独立于侧栏的 fixed 容器、钉死红绿灯右侧，两态共用同一组 DOM——
 * 侧栏的一切收起/展开/滑动动画都在它底下进行，按钮永不移动。
 *
 * peek 是纯本地 UI 态（不进 rail store）：它是转瞬即逝的悬停预览，和「用户
 * 收起 rail」的持久意图是两码事。collapsed 一旦被 toggle 回 false（点常驻
 * 开关钮），rail 立刻钉回常驻态，peek 自然失去意义。
 *
 * 渲染在根 layout（body 的第一个 flex item），chat / canvas 两面共享。
 */

import { Plus, Search } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { AppRail } from '@/src/components/AppRail'
import { FeedbackDialog } from '@/src/components/FeedbackDialog'
import { Button } from '@/src/components/ui/button'
import { useUnreadIdsKey } from '@/src/chat/stores/unread'
import { useDialogStore } from '@/src/chat/stores/dialogs'
import { useRailStore } from '@/src/stores/rail'
import { cn } from '@/src/lib/utils'

export function RailShell() {
  const collapsed = useRailStore((s) => s.collapsed)
  const toggleCollapsed = useRailStore((s) => s.toggle)
  // 空串 = 无未读；任意非空 = 有未读会话 → 收起态开关钮亮蓝点（未读发生
  // 在收起的会话列表里，蓝点是「侧栏里有新回复」的提示）。稳定字符串 key
  // 避免 fresh-Set 的 getSnapshot 循环（和 RailSessionList 同一订阅姿势）。
  const hasUnread = useUnreadIdsKey() !== ''
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

  // ── peek 翻转**不再**做 region-refresh 脉冲（2026-07-14 拖拽机制重构，删）──
  // 历史上这里有个 240ms 后给 body 挂 `.region-refresh` 再摘的脉冲，逼原生层
  // 重采集，让浮出 overlay 的 no-drag（peek 时容器上标的，见下方 overlay）生效
  // ——因为当年 chat header / canvas 顶栏在 overlay 之外还各有一条 drag 罩着面板
  // 顶部，overlay 的 no-drag 不逼重采集不生效。
  // 现在两条前提都没了：① 组件顶栏统一不再自带 drag（EntryShell/app-chrome-header
  // 的 drag 已撤，全靠常驻 strip）；② overlay 是 portal 到 body 末尾（DOM 最后）、
  // peek 时标 no-drag——它 DOM 序最晚、no-drag 天然最后注册、稳压 strip 的 drag，
  // 不需要任何脉冲就生效（RailShell 收起态图标排同理，见下方 portal 注释）。
  // 且脉冲是全局 .region-refresh 类的多写手争抢竞态源（详见 SurfaceHost 删脉冲
  // 注释），留着有害无益，遂删。overlay 的「假-leave 免疫」靠 no-drag 挖洞本身，
  // 与脉冲无关，保留。

  /* ── 常驻顶栏按钮组：开关 / 搜索 / 新建（2026-07-16 用户参照 Codex 定稿，
   * 同日搜索从「新对话」行迁入开关右侧）────────────────────────────
   * 整组是**独立于侧栏的 fixed 容器**，钉死在红绿灯右侧 x=100——侧栏
   * 收起/展开/peek 滑动的所有动画都在它底下进行，按钮自身永不移动（此前
   * 开关挂在 AppRail 顶栏里：收起时随 rail 卸载、peek 时随 overlay 滑动，
   * 动画过程中按钮跟着跑，用户对照 Codex 实锤）。三个钮的显隐：
   *  - **开关**：恒显。点击 = toggle（直接钉住展开/收起，Codex 同款）；
   *    收起态 hover = peek 浮出预览。收起且有未读时亮蓝点。
   *  - **搜索**：仅聊天面（SessionSearchDialog 只挂在 chat 树里，canvas
   *    点了也看不到），两态恒显——收起/展开时它和开关一样原地不动。
   *  - **新建**：仅收起态（展开态 rail 内已有「新对话」主按钮）；peek
   *    浮出时淡出——浮出面板顶部空白条正好露出本组，面板内已有新对话
   *    主按钮，这颗不淡出会语义重复。跟随 surface（聊天面新对话/画布面
   *    新画布，与 AppRail 主按钮同一套逻辑）。
   *
   * ⚠️ 为什么必须 portal 到 body 末尾（2026-07-05「三图标点不动」实锤）：
   * 按钮组标了 no-drag，但覆盖它所在 y 的窗口拖拽矩形不止一条——根
   * .window-drag-strip（body 首子元素，比 RailShell 更靠前，对它不
   * portal 也能挖动）之外，canvas 面自己的顶栏 drag（base.css 的
   * .workspace-tabs-chrome，冗余保留）在 shell-stage 深处、DOM 比
   * RailShell **靠后**。Electron 收集 app-region 是按渲染树遍历顺序
   * 注册原生拖拽矩形、**后注册覆盖先注册**，且 no-drag 只能在「先
   * 注册的 drag」上挖洞——不 portal 则按钮组 no-drag 先注册、被后面
   * 的 drag 整片盖过 → macOS 把点击当窗口拖拽截走，mousedown 根本
   * 不下发给 renderer（DOM elementFromPoint 仍能命中按钮、CDP 的
   * Input.dispatchMouseEvent 也能点 → 都是假象，app-region 拦截在
   * 原生层、只有真实鼠标经过窗口系统时才发生；同 .surface-inactive
   * 家族的坑）。portal 到 body 末尾让按钮组 no-drag **最后注册**，
   * 稳压一切 drag，真实点击才落到按钮上。mounted 前不 portal（SSR
   * 无 body + 防 hydration）。组里全是 shadcn Button（带 data-slot），
   * 不受 portal 出 .chat-app 豁免后的 canvas 裸元素 reset 影响。
   *
   * z 分档：chat z-[45]——高于 peek overlay（z-40）让按钮浮出时仍可点，
   * 低于 dialog（z-50）被 modal 正常罩住；canvas z-[140]——高于该面
   * overlay（z-135）。坐标联动：红绿灯 x=30（tabRegistry
   * trafficLightPosition）/ 本组 left=100，改一个必须同步另一个；组内
   * 间距 gap 自动排布，无需手算。 */
  const railTopButtons =
    mounted &&
    createPortal(
      <div
        className={cn(
          'fixed left-[100px] top-0 flex h-[46px] items-center gap-0.5 [-webkit-app-region:no-drag]',
          isChat ? 'z-[45]' : 'z-[140]'
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          className="relative text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={toggleCollapsed}
          onMouseEnter={collapsed ? () => setPeek(true) : undefined}
        >
          <RailToggleIcon collapsed={collapsed} />
          {collapsed && hasUnread && (
            // 未读徽标：钉在图标右上角的小蓝点。bg-[#3b82f6] 与会话行未读
            // 点同色（RailSessionList），描一圈 sidebar 底色让它从图标上
            // 「浮」出来。
            <span className="absolute right-1 top-1 size-2 rounded-full bg-[#3b82f6] ring-2 ring-sidebar" />
          )}
        </Button>
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
        {collapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={isChat ? '新对话' : '新画布'}
            title={isChat ? '新对话' : '新画布'}
            className={cn(
              'text-muted-foreground transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground',
              peek && 'pointer-events-none opacity-0'
            )}
            onClick={() => {
              if (isChat) {
                void window.tabApi?.switchShellSession?.(null)
              } else {
                // canvas router 模块求值期触碰 window，不能静态 import——
                // 同 AppRail 主按钮的约束。
                void import('@/src/canvas/router').then(({ navigate }) => {
                  navigate({ kind: 'home', view: 'home' })
                })
              }
            }}
          >
            <Plus className="size-4" />
          </Button>
        )}
      </div>,
      document.body
    )

  // 展开态：AppRail 原样占 flex 列，零额外包装（保持与加功能前一致的布局，
  // 避免多套一层 div 影响 w-61 shrink-0 的 flex 行为）。FeedbackDialog 挂
  // 在两个分支里各一份而不是外面包一层 Fragment——本函数两分支各自都是
  // 独立 return，包一层会打破「展开态零额外包装」这条不变式；反正
  // Dialog 本身不渲染任何可见 DOM（open=false 时 Radix 直接不出内容）。
  if (!collapsed)
    return (
      <>
        <AppRail />
        {railTopButtons}
        <FeedbackDialog />
      </>
    )

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
      {railTopButtons}
      <FeedbackDialog />
    </div>
  )
}

/**
 * 侧栏开关图标——带状态过渡（2026-07-16 用户定稿，三版迭代）。
 *
 * 几何基于 lucide PanelLeft（外框 rect 3,3,18,18 + 竖线 x=9），外框圆角
 * 加大到 rx=4（lucide 原版 rx=2 在 16px 渲染下近乎直角，观感生硬）。
 * 外框与竖线**恒定显示**，状态语义交给左格的实心填充：
 *  - **收起态**：左格填充淡入（实心 = 「侧栏收着、点开」，与 2026-07-05
 *    确认的实心款同一语义）。第二版曾让竖线淡出剩纯空框，用户实锤
 *    「里面是空的、太丑」——面板指示不能消失，遂回归实心表收起。
 *  - **展开态**：填充淡出，剩线条版 PanelLeft。
 *
 * 过渡只动填充的 opacity（200ms ease-out）：开关按钮本体永不移动（常驻
 * fixed，见 railTopButtons），左格填充的亮起/熄灭就是「收起/展开」的
 * 全部视觉反馈，克制不抢戏。motion-reduce 下瞬变。
 *
 * 填充 path 左侧带 r2.5 圆弧（跟外框 rx=4 的内壁弧贴合），右缘到竖线
 * x=9 —— 直角填充会戳出外框圆角，弧度必须配对。
 */
function RailToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className="size-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      {/* 左格实心填充：收起态亮起，展开态熄灭。 */}
      <path
        d="M9 4.5H7a2.5 2.5 0 0 0-2.5 2.5v10a2.5 2.5 0 0 0 2.5 2.5h2z"
        fill="currentColor"
        stroke="none"
        className={cn(
          'transition-opacity duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'opacity-100' : 'opacity-0'
        )}
      />
      <path d="M9 3.5v17" />
    </svg>
  )
}


