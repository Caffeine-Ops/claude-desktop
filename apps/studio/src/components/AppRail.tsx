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
import { RailSessionList } from '@/src/components/RailSessionList'
import { cn } from '@/src/lib/utils'

const NAV_ITEMS: { href: string; label: string; icon: ReactNode }[] = [
  {
    href: '/chat',
    label: '智能助手',
    icon: <MessageCircle className="size-4" />
  },
  {
    // canvas SPA 挂在根 catch-all（router 是根路径制，见 app/[[...slug]]），
    // 所以「工作画布」指 '/'。active 判定在下面特判。
    href: '/',
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
    <nav className="flex h-full w-61 shrink-0 flex-col gap-1 bg-sidebar px-3 pb-3">
      <Button
        variant="ghost"
        className="mb-2 justify-start gap-2 bg-sidebar-primary/12 px-3 text-sidebar-primary hover:bg-sidebar-primary/18 hover:text-sidebar-primary"
        onClick={() => {
          // 新对话 = 切到「新会话」再进聊天路由。sessionId null 的
          // SWITCH_REQUEST 经 main 正规化后由 chat 的 FusionRuntimeProvider
          // 接住（onSwitchToNewThread）；浏览器直开无 chatApi 时退化为纯导航。
          void window.tabApi?.switchShellSession?.(null)
          if (!pathname.startsWith('/chat')) goChatShallow()
        }}
      >
        <Plus className="size-4" /> 新对话
      </Button>

      {NAV_ITEMS.map((item) => {
        // '/chat*' 归聊天，其余一切路径（'/'、'/projects'、'/project/x'…）
        // 都是 canvas SPA 的地盘。
        const active =
          item.href === '/' ? !pathname.startsWith('/chat') : pathname.startsWith(item.href)
        const pillClass = cn(
          'justify-start gap-2 px-3',
          // 中性灰选中——绿 accent 只留给「新对话」CTA 和会话选中态
          // （原型的用色纪律），nav pill 不抢。旧 bg-accent 是全局蓝，
          // 压在灰 rail 上像个异物，一并退役。hover 用 rail 专属的
          // sidebar-accent（比 ghost 默认的 muted 深一档，灰 rail 上才有
          // 可见反馈）；active 态显式锁同色，免得 hover 被 ghost 默认变浅。
          active
            ? 'bg-sidebar-accent font-medium text-sidebar-foreground hover:bg-sidebar-accent'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
        )
        return (
          <Button
            key={item.href}
            variant="ghost"
            className={pillClass}
            onClick={() => {
              if (item.href === '/') {
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
            {item.icon}
            {item.label}
          </Button>
        )
      })}

      {/* 会话列表占据 rail 中段的全部剩余高度（内部自带 ScrollArea）。 */}
      <RailSessionList />

      <div className="mt-auto flex flex-col gap-1 pt-4">
        <div className="px-3 text-xs text-muted-foreground">更多</div>
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
      </div>
    </nav>
  )
}
