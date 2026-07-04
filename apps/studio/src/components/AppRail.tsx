'use client'

/**
 * studio 全局导航 rail —— 单视图形态下取代旧 shell renderer 的 220px rail
 * （那个 rail 现在被全屏的 studio view 整个盖住，见 desktop tabRegistry
 * layoutActiveTab 的 studio 分支）。
 *
 * 与旧 rail 的本质差别：旧 rail 的「智能助手/工作画布」pill 是 **切换
 * WebContentsView**（tabApi.switchTab，跨进程）；这里是 **Next 路由**
 * （同一 React 树内切换）——这正是单视图整合的意义：跨页面状态共享、
 * 拖拽、动画过渡都是进程内操作。
 *
 * UI 原语用 shadcn/ui（Button/lucide 图标）；会话列表（RailSessionList）
 * 是 legacy shell rail 里 ShellSessionList 的回归——Phase 4 删 shell
 * renderer 时它跟着消失了，现以 shadcn 版长回 rail 中段，数据链路复用
 * SHELL_SESSION_* IPC（详见 RailSessionList 头注释）。
 *
 * 渲染在根 layout（server 树）里，所以本组件不得在模块层触碰 window；
 * chatApi 只在事件处理器 / effect 里访问并做存在判断（浏览器直开时是
 * undefined）。
 */

import { usePathname } from 'next/navigation'
import { Image as ImageIcon, MessageCircle, Plus, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { Button } from '@/src/components/ui/button'
import { RailProjectList } from '@/src/components/RailProjectList'
import { RailSessionList } from '@/src/components/RailSessionList'
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs'

/* 两个 surface 的切换是「同级二选一」而非普通导航列表——语义和视觉都用
 * shadcn Tabs（segmented：muted 底槽 + 选中段白卡凸起），不再用 ghost pill。
 * canvas SPA 挂在根 catch-all（router 是根路径制，见 app/[[...slug]]），
 * 所以「工作画布」对应一切非 /chat 路径。 */
const SURFACE_TABS: { value: 'chat' | 'canvas'; label: string; icon: ReactNode }[] = [
  {
    value: 'chat',
    label: '智能助手',
    icon: <MessageCircle className="size-4" />
  },
  {
    value: 'canvas',
    label: '工作画布',
    icon: <ImageIcon className="size-4" />
  }
]

/**
 * 切到聊天面 —— **原生 pushState（shallow）**而非 router.push：两个面都
 * 常驻在 SurfaceHost、page 全是空壳，切换其实不需要 Next 做任何导航工作
 * （dev 下 router.push 的 RSC 请求 + 内部处理实测占 ~276ms EvaluateScript）。
 * Next 16 官方支持原生 History API：usePathname/useSearchParams 照常同步
 * （SurfaceHost 因此切面），但零 RSC fetch、零 page 切换。canvas 侧的
 * navigate() 本来就是同款机制。
 */
function goChatShallow(): void {
  window.history.pushState(null, '', '/chat')
}

export function AppRail() {
  const pathname = usePathname()
  // '/chat*' 归聊天面，其余一切路径都是 canvas 的地盘——rail 上所有
  // 「跟随当前 surface」的元素（顶部主按钮 / Tabs 选中态 / 中段列表）
  // 都从这一个判定派生。
  const isChat = pathname.startsWith('/chat')

  // 底部 user chip 的真实数据：OS 用户名（preload 启动时 os.userInfo() 读定，
  // 同步属性）+ 当前 CLI 后端（bundled → fusion-code / system → Claude Code）。
  // 浏览器直开无 chatApi 时 identity 保持 null，chip 整个不渲染——rail 上
  // 一块空比一块假身份诚实（与 RailSessionList 空态同一原则）。
  const [identity, setIdentity] = useState<{ user: string; backend: string } | null>(null)
  useEffect(() => {
    const api = window.chatApi
    if (!api) return
    const user = api.osUser || '本机用户'
    setIdentity({ user, backend: 'fusion-code' })
    api
      .getCliBackend()
      .then((s) => {
        setIdentity({ user, backend: s.mode === 'system' ? 'Claude Code' : 'fusion-code' })
      })
      .catch(() => {
        /* 检测失败保持默认 fusion-code 文案，不打断 rail 渲染 */
      })
  }, [])

  return (
    // 无右边框：rail 与窗口背景是同一块面（bg-sidebar == body），内容区靠
    // 悬浮卡的阴影分隔，而不是一条竖线。宽度对齐原型 --sidebar-w: 244px
    // （docs/ui-prototype-shell-floating.html；旧值 220 给不下「标题 + 相对
    // 时间」的会话行）。
    // ⚠️ w-61（244px）与设置页 V2 的 --sv2-sidebar-w（settings-v2.css）配对：
    // 设置页是全屏 overlay、自己画 rail + 浮卡，两边宽度不等则切换
    // 设置 ↔ 聊天时内容卡左边缘跳动。改宽度必须两处同步。
    <nav className="flex h-full w-61 shrink-0 flex-col gap-1 bg-sidebar px-3 pb-3">
      {/* 顶部 48px：macOS 红绿灯的净空 + 窗口拖拽面（原型 .traffic）。
        * 原来是 nav 的 pt-12 padding——padding 不能标 app-region，改成
        * 实体条后这块「空白」真的能拖动窗口。 */}
      <div aria-hidden className="h-12 shrink-0 [-webkit-app-region:drag]" />
      {/* 顶部主按钮跟随当前 surface（2026-07-04 用户要求）：
        *  - 聊天面「新对话」= 切到「新会话」再进聊天路由。sessionId null 的
        *    SWITCH_REQUEST 经 main 正规化后由 chat 的 FusionRuntimeProvider
        *    接住（onSwitchToNewThread）；浏览器直开无 chatApi 时退化为纯导航。
        *  - 画布面「新画布」= 回 canvas 主页（说说你的需求吧 composer 就是
        *    「新建」的入口，canvas 没有独立的空白新建页）。走 canvas router
        *    的 navigate（动态 import 原因见下方画布 tab 注释）；已在主页时
        *    navigate 同路径早退，点击为无害 no-op。 */}
      <Button
        variant="ghost"
        className="mb-2 justify-start gap-2 bg-sidebar-primary/12 px-3 text-sidebar-primary hover:bg-sidebar-primary/18 hover:text-sidebar-primary"
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
        <Plus className="size-4" /> {isChat ? '新对话' : '新画布'}
      </Button>
      {/* 新建项目（2026-07-04 从画布首页 EntryNavRail 迁入，那条 rail 已
        * 退役）——只在画布面显示，落位「新画布」下方。NewProjectModal 归
        * EntryShell 所有（canvas 树），跨树触达走「事件 + pending 信箱」
        * （state/newProjectRequest.ts 头注释）：先 request（EntryShell 在
        * SurfaceHost keep-alive 下多半已挂载，事件直接开 modal），再
        * navigate 回画布首页兜底（未挂载场景由挂载 effect 消费 pending）。
        * 两个 canvas 模块必须动态 import——canvas 链求值期触碰 window，
        * 静态进 layout 树会炸 SSR（同工作画布 tab 的 router import 约束）。 */}
      {!isChat && (
        <Button
          variant="ghost"
          className="mb-2 justify-start gap-2 px-3 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={() => {
            void Promise.all([
              import('@/src/canvas/state/newProjectRequest'),
              import('@/src/canvas/router')
            ]).then(([{ requestNewProject }, { navigate }]) => {
              requestNewProject()
              navigate({ kind: 'home', view: 'home' })
            })
          }}
        >
          <Plus className="size-4" /> 新建项目
        </Button>
      )}

      {/* '/chat*' 归聊天，其余一切路径（'/'、'/projects'、'/project/x'…）
        * 都是 canvas SPA 的地盘——受控 value 直接从 pathname 派生，切面后
        * usePathname 同步，选中态无需本地 state。 */}
      <Tabs
        value={pathname.startsWith('/chat') ? 'chat' : 'canvas'}
        onValueChange={(value) => {
          if (value === 'canvas') {
            // 工作画布不能走 Next <Link>：canvas 树常驻在 SurfaceHost
            // （keep-alive），它的自制 router 只听 popstate——Next 软导航
            // 改了 URL 它不知道，视图不会回首页。canvas.navigate 自己
            // pushState + 派发 popstate：canvas 回首页，Next 的 native
            // history 集成同步 usePathname，SurfaceHost 随之切面。
            // 动态 import：canvas 模块求值期触碰 window，不能静态 import
            // 进本组件（layout SSR 会炸）；事件处理器内加载则安全。
            void import('@/src/canvas/router').then(({ navigate }) => {
              navigate({ kind: 'home', view: 'home' })
            })
          } else {
            // 智能助手同为 shallow pushState（见 goChatShallow 注释）。
            goChatShallow()
          }
        }}
      >
        <TabsList className="w-full">
          {SURFACE_TABS.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              // 选中段用 bg-card（纯白）而非默认 bg-background：本项目的
              // --background 是 97% 灰面，压在 muted 底槽（93%）上对比太弱，
              // 白卡才有 segmented 的凸起感（同悬浮内容卡的表面语言）。
              // 选中 icon 走品牌绿——「身份/CTA/选中」点位的用色纪律。
              className="data-[state=active]:bg-card [&[data-state=active]_svg]:text-sidebar-primary"
            >
              {item.icon}
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* rail 中段列表跟随当前 surface：聊天面列会话、画布面列项目
        *（各自内部自带 ScrollArea，占满剩余高度）。两个列表都是「空态
        * 渲染 null」，切面时中段可能整块消失重现——这是数据诚实优先。 */}
      {pathname.startsWith('/chat') ? <RailSessionList /> : <RailProjectList />}

      <div className="mt-auto flex flex-col gap-1 pt-3">
        <Button
          variant="ghost"
          className="justify-start gap-2 px-3 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={() => {
            // 设置走 canvas App 的 overlay 模式（?settings=1 → 全屏设置页，
            // 数据链路完整）。shallow pushState：canvas 的 isSettingsOverlay
            // 用 useSearchParams 响应式读取，Next 的 native history 集成会
            // 同步它，overlay 即开——零刷新零 RSC 请求（关闭走
            // handleOverlayClose 的 history.back，同文档软回退）。
            window.history.pushState(null, '', '/?settings=1')
          }}
        >
          <Settings className="size-4" />
          设置
        </Button>
        {identity && (
          // user chip（原型 .user-chip）：头像首字母走品牌绿 tint——绿只给
          // 「身份/CTA/选中」点位的用色纪律。点击同「设置」入口（身份与
          // CLI 后端的详情都在设置页里）。
          <Button
            variant="ghost"
            className="h-10 justify-start gap-2.5 px-2.5 hover:bg-sidebar-accent"
            onClick={() => {
              window.history.pushState(null, '', '/?settings=1')
            }}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/15 text-xs font-semibold text-sidebar-primary">
              {identity.user.charAt(0).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-col items-start leading-tight">
              <span className="max-w-full truncate text-[12.5px] font-medium text-sidebar-foreground">
                {identity.user}
              </span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {identity.backend} · 已连接
              </span>
            </span>
          </Button>
        )}
      </div>
    </nav>
  )
}
