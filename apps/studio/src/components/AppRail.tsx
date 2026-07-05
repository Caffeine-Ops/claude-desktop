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
import {
  BookOpen,
  Crown,
  FileClock,
  Image as ImageIcon,
  Info,
  LogOut,
  MessageCircle,
  Palette,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Settings
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { Button } from '@/src/components/ui/button'
import { RailProjectList } from '@/src/components/RailProjectList'
import { RailSessionList } from '@/src/components/RailSessionList'
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { useRailStore } from '@/src/stores/rail'

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

/* 账户菜单里尚未接入功能的占位项共用的空动作（升级订阅/帮助/更新日志/
 * 关于我们/退出登录，2026-07-05 用户确认先做占位）。模块级常量＝稳定引用，
 * 不随渲染重建。接入真实链路时逐项换掉对应 onSelect 即可。 */
const noop = (): void => {}

export function AppRail() {
  const pathname = usePathname()
  // 折叠意图（跨 chat/canvas 共享，见 src/stores/rail.ts）。收起态下这个
  // 组件本体被 RailShell 复用为 hover 浮出的 overlay——所以顶部 toggle 的
  // 语义天然自洽：collapsed=false 点击=收起，collapsed=true（overlay 里）
  // 点击=展开钉住，都是同一个 toggle()。图标也随 collapsed 翻。
  const collapsed = useRailStore((s) => s.collapsed)
  const toggleCollapsed = useRailStore((s) => s.toggle)
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

  // 打开设置 overlay（?settings=1）——账户菜单里「设置」与「偏好设置」子项
  // 共用这一个入口，机制见调用处注释（shallow pushState + canvas 响应式读参）。
  const openSettings = () => {
    window.history.pushState(null, '', '/?settings=1')
  }

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
        * 实体条后这块「空白」真的能拖动窗口。收起/展开按钮叠在这条的
        * 右端：整条仍是 drag 区，按钮自身标 no-drag 才点得动（否则
        * Electron 按 layout box 注册拖拽区，点击被窗口拖拽吞掉）。 */}
      <div className="relative flex h-12 shrink-0 items-center justify-end [-webkit-app-region:drag]">
        {/* 收起按钮与右侧内容卡标题栏（红绿灯 / 标题 / 收起态图标排）垂直
          * 对齐（2026-07-05 用户要求）。错位根因：rail 顶栏从视口 y=0 起、
          * items-center 让 32px 按钮中线落 y=24；而内容卡标题栏从 y=10
          * 起（stage 的 10px gutter）+46px 高、中线在 y=33——两侧「居中」
          * 基准差着那 10px gutter + 高度差 = 9px。用 translate-y-[9px] 把
          * 按钮中线顶到 33（纯视觉位移，不改 flex 流、不推挤下方主按钮，
          * 拖拽条高度语义不变）。改内容卡标题栏几何时同步核这个偏移量。 */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          className="translate-y-[9px] text-muted-foreground [-webkit-app-region:no-drag] hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={toggleCollapsed}
        >
          {collapsed ? (
            <PanelLeft className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </Button>
      </div>
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

      {/* 底部只剩 user chip（独立「设置」按钮已并入 chip 的账户菜单，
        * 2026-07-05 用户要求）——设置连同偏好/订阅/帮助等都收进这个菜单，
        * rail 底部不再单列「设置」占一行。 */}
      <div className="mt-auto pt-3">
        {identity && (
          // user chip（原型 .user-chip）+ 账户菜单（2026-07-05）：一整行是
          // 菜单 trigger，头像首字母走品牌绿 tint（绿只给「身份/CTA/选中」
          // 点位的用色纪律）。右侧齿轮是「点这里能展开」的显式提示；点行
          // 任意处都开同一个向上弹出的账户菜单。
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                aria-label="账户菜单"
                className="h-11 w-full justify-start gap-2.5 px-2.5 hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/15 text-xs font-semibold text-sidebar-primary">
                  {identity.user.charAt(0).toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                  <span className="max-w-full truncate text-[12.5px] font-medium text-sidebar-foreground">
                    {identity.user}
                  </span>
                  <span className="max-w-full truncate text-[11px] font-normal text-muted-foreground">
                    {identity.backend} · 已连接
                  </span>
                </span>
                {/* 右端图标：设置齿轮做「可展开」的锚点提示。整行都是
                  * trigger，图标不单独绑 onClick（点它 = 点行 = 开菜单）。
                  * 装饰性，故 aria-hidden、pointer-events 交给外层 Button。 */}
                <Settings
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            {/* side="top"：chip 在 rail 最底，菜单必须向上弹（原型账户菜单
              * 从 chip 上方展开）。宽度贴齐 trigger（--radix-…-trigger-width）
              * 起步、下限 15rem，够放最长的「偏好设置 ›」不换行。 */}
            <DropdownMenuContent
              side="top"
              align="start"
              sideOffset={8}
              className="w-[--radix-dropdown-menu-trigger-width] min-w-[15rem]"
            >
              {/* 套餐信息区（占位数据，2026-07-05 用户确认先做占位——真实
                * 订阅/到期链路后续接入，届时把这段换成动态值）。默认「永久」
                * （用户要求，2026-07-05）：无到期日的套餐状态。 */}
              <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
                <span className="text-[11px] font-normal text-muted-foreground">
                  套餐到期
                </span>
                <span className="text-[13px] font-semibold text-sidebar-foreground">
                  永久
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {/* 设置：唯一有真实链路的项——走 canvas App 的 overlay 模式
                  * （?settings=1 → 全屏设置页）。shallow pushState：canvas 的
                  * isSettingsOverlay 用 useSearchParams 响应式读取，Next 的
                  * native history 集成同步它，overlay 即开——零刷新零 RSC
                  * 请求（关闭走 handleOverlayClose 的 history.back）。 */}
                <DropdownMenuItem onSelect={openSettings}>
                  <Settings />
                  设置
                </DropdownMenuItem>
                {/* 偏好设置：图3 带 › 子菜单箭头。子项是占位——真实偏好项
                  * （外观/语言等）大多已在设置页里，这里的子菜单先留空提示。 */}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Palette />
                    偏好设置
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onSelect={openSettings}>
                      在设置中调整
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {/* 以下均为占位项（用户确认，2026-07-05）：暂无对应功能。
                  * 刻意不用 disabled——disabled 会置灰（opacity-50）破坏图3
                  * 「所有项正常可读」的观感；改用 no-op onSelect 保持正常
                  * 外观且点击不做事。真实链路（订阅/帮助/更新日志/关于）
                  * 后续接入时把 noop 换成实际动作即可。 */}
                <DropdownMenuItem onSelect={noop}>
                  <Crown />
                  升级订阅
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={noop}>
                  <BookOpen />
                  帮助文档
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={noop}>
                  <FileClock />
                  更新日志
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={noop}>
                  <Info />
                  关于我们
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {/* 退出登录：destructive 红字（图3）。占位——尚无登录态，点击
                * no-op（同上，不 disabled 以保留醒目红字），接入账号体系后
                * 绑真实登出。 */}
              <DropdownMenuItem variant="destructive" onSelect={noop}>
                <LogOut />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </nav>
  )
}
