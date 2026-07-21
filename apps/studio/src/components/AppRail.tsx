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
  ArrowUpRight,
  BookOpen,
  Check,
  CircleArrowUp,
  CircleHelp,
  Copy,
  Image as ImageIcon,
  LogOut,
  MessageCircle,
  Moon,
  Palette,
  Plus,
  Puzzle,
  Settings,
  SquarePen,
  Sun
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { AuthUser } from '@desktop-shared/ipc-channels'
import { Button } from '@/src/components/ui/button'
import { RailProjectList } from '@/src/components/RailProjectList'
import { RailSessionList } from '@/src/components/RailSessionList'
import { useChatStore } from '@/src/chat/stores/chat'
import { useDialogStore } from '@/src/chat/stores/dialogs'
import { cn } from '@/src/lib/utils'
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { useAppearanceStore } from '@/src/chat/stores/appearance'
import { useUpgradeStore } from '@/src/stores/upgrade'
import { getLastCanvasPath, rememberCanvasPath } from '@/src/stores/canvasNav'
import {
  closeSurfaceOverlay,
  hasSurfaceOverlay,
  openSurfaceOverlay,
  useSurfaceOverlayStore
} from '@/src/stores/surfaceOverlay'

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
 * 记住离开工作画布时的 canvas 路径（模块级，跨 rail 重挂载存活）。
 * 背景（2026-07-14，删多标签工作区顶栏的连带修复）：切到聊天面时
 * goChatShallow 用 pushState('/chat') 覆盖了 canvas 的当前 URL（如
 * '/project/xxx'），canvas 之前的路径就丢了。切回工作画布若硬编码
 * navigate({home})，就回不到用户刚才打开的项目——多标签栏还在时，用户
 * 能从 tab 栏点回去，栏一删这个「回到上次画布视图」的能力就必须由这里
 * 接管：切走前记住画布路径，切回时 parseRoute 还原。'/chat*' 不记
 * （那是聊天面路径，不是画布视图）。 */
/**
 * 切到聊天面 —— **原生 pushState（shallow）**而非 router.push：两个面都
 * 常驻在 SurfaceHost、page 全是空壳，切换其实不需要 Next 做任何导航工作
 * （dev 下 router.push 的 RSC 请求 + 内部处理实测占 ~276ms EvaluateScript）。
 * Next 16 官方支持原生 History API：usePathname/useSearchParams 照常同步
 * （SurfaceHost 因此切面），但零 RSC fetch、零 page 切换。canvas 侧的
 * navigate() 本来就是同款机制。
 * 覆盖 URL 前先 rememberCanvasPath()，供画布 tab 切回时还原上次画布视图
 * （2026-07-14 删多标签栏连带修复，见 stores/canvasNav.ts）。
 */
function goChatShallow(): void {
  rememberCanvasPath()
  window.history.pushState(null, '', '/chat')
}

/**
 * rail 的两个 surface tab 的**唯一**导航入口（TabsTrigger 的 onClick，不是
 * Tabs 的 onValueChange——理由见调用处注释）。因为 onClick 无条件触发，这里
 * 必须自己判断「点的是不是当前面」，否则重复 pushState 会往历史里塞垃圾。
 *
 * 「有面开着」是这里的关键分支：此时 pathname 还停在原面（插件市场/知识库都是
 * 挂在它上面的 ?market=1 / ?kb=1 面开关），用户点当前面的 tab 意思是「关掉那个
 * 面回来」，不是 no-op。**判定必须覆盖所有面**——只判其中一个的话，另一个面开着
 * 时点当前 tab 什么也不会发生，人被困在面里出不去（2026-07-17 市场面实锤，
 * 见 errors/ 同日「市场面 rail 常驻暴露 overlay 与 tab 语义冲突」）。
 * hasSurfaceOverlay 从 PARAM_BY_KIND 派生，加面自动覆盖。
 */
function goSurface(value: 'chat' | 'canvas'): void {
  const onChat = window.location.pathname.startsWith('/chat')
  const overlayOpen = hasSurfaceOverlay()

  if (value === 'chat') {
    // 已经在聊天面、且没有面盖着 → 真 no-op（别重复 push 同一条 URL）
    if (onChat && !overlayOpen) return
    // goChatShallow 的 pushState('/chat') 写死路径不带 query，天然剥掉所有
    // 面开关参数，不需要额外 closeSurfaceOverlay()。
    goChatShallow()
    return
  }

  // → 工作画布
  if (!onChat && !overlayOpen) return // 已在画布面且无面盖着：no-op
  // 面开关由 canvas 的 navigate() 自己剥（它是所有画布导航的唯一出口，
  // 见 canvas/router.ts 的 stripSurfaceOverlayParams 注释），这里不用管。
  //
  // 工作画布不能走 Next <Link>：canvas 树常驻在 SurfaceHost（keep-alive），
  // 它的自制 router 只听 popstate——Next 软导航改了 URL 它不知道，视图不会
  // 更新。canvas.navigate 自己 pushState + 派发 popstate：canvas 切到目标视图，
  // Next 的 native history 集成同步 usePathname，SurfaceHost 随之切面。
  // 动态 import：canvas 模块求值期触碰 window，不能静态 import 进本组件
  // （layout SSR 会炸）；事件处理器内加载则安全。
  //
  // 还原上次画布视图（2026-07-14，删多标签栏连带修复）：切回工作画布时
  // parseRoute(lastCanvasPath) 还原用户离开前的项目/视图，而非硬编码回首页
  // （多标签栏删除后，「切回上次画布」的能力从 tab 栏转由这里接管，见
  // lastCanvasPath 注释）。无记录（首次进画布）才回首页兜底。
  void import('@/src/canvas/router').then(({ navigate, parseRoute }) => {
    const last = getLastCanvasPath()
    navigate(last ? parseRoute(last) : { kind: 'home', view: 'home' })
  })
}

/* 账户菜单 V1「精修基准」（2026-07-07 二次定稿，原型见
 * docs/ui-prototype-account-menu.html；先定 V3 后用户改选 V1——绿只留
 * 套餐状态点与升级文字动作，渐变钮/头像圆随 V3 退役）的品牌绿墨色：
 * 绿一律派生自 --brand（HSL 三元组，tokens.css 已分亮/暗档），不硬编码
 * 第二套绿。亮档文字/图标压深 18%（亮底上纯 brand 绿对比不足，对应
 * 原型的 --green-deep #15803d）；暗档 brand 本身已提亮，直接用。 */
const brandInk =
  'text-[color-mix(in_srgb,hsl(var(--brand))_82%,#000)] dark:text-[hsl(var(--brand))]'

/**
 * 账户菜单「外观」行的浅色/深色两段切换（2026-07-07 对齐目标设计的
 * 行内 seg）。挂在 DropdownMenu 的 portal 里、.chat-app 之外——裸
 * <button> 会被 canvas reset 卡片化，必须带 data-slot 逃逸（老坑）。
 * 高亮：显式 light/dark 直接亮对应段；system 档按当前实际生效面
 * （html 的 .dark，菜单内容只在交互后经 portal 挂载，无 SSR 参与，
 * 渲染中读 document 安全）。点击写显式档，走 appearance store 完整
 * 链路（持久化 + 双标记 + 跨面广播，同登录页 ThemeToggle）。
 *
 * V1 形态：太阳/月亮 icon-only 段（24×22），选中态白卡浮起（暗档投影
 * 不可见，改前景浅底充当「凸起」）——V3 的绿浅底选中态随方案退役，
 * V1 里绿只属于套餐状态点和升级动作。
 */
function AppearanceSeg() {
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const setThemeMode = useAppearanceStore((s) => s.setThemeMode)
  const resolved =
    themeMode === 'system'
      ? document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'light'
      : themeMode
  const seg = (mode: 'light' | 'dark', Icon: typeof Sun, label: string) => (
    <button
      type="button"
      data-slot="appearance-seg"
      aria-label={label}
      title={label}
      onClick={() => setThemeMode(mode)}
      className={cn(
        'flex h-[22px] w-6 items-center justify-center rounded-[5px] transition-colors',
        resolved === mode
          ? 'bg-card text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.12)] dark:bg-foreground/15 dark:shadow-none'
          : 'text-muted-foreground/60 hover:text-muted-foreground'
      )}
    >
      <Icon className="size-[13px]" strokeWidth={1.75} />
    </button>
  )
  return (
    <div className="flex gap-[2px] rounded-[7px] bg-muted p-[2px]">
      {seg('light', Sun, '浅色')}
      {seg('dark', Moon, '深色')}
    </div>
  )
}

export function AppRail({ overlay = false }: { overlay?: boolean } = {}) {
  const pathname = usePathname()
  // 侧栏开关不在本组件里（2026-07-16 用户参照 Codex 定稿）：开关是
  // RailShell 的**常驻 fixed 按钮**（portal 到 body、钉死红绿灯右侧），
  // 不随 rail 卸载/滑动——此前开关挂在本组件顶栏里，收起时随 AppRail
  // 卸载、peek 浮出时随 overlay 滑动，按钮在动画中跟着跑，位置连续性
  // 破功。折叠状态见 src/stores/rail.ts（RailShell 消费）。
  // '/chat*' 归聊天面，其余一切路径都是 canvas 的地盘——rail 上所有
  // 「跟随当前 surface」的元素（顶部主按钮 / Tabs 选中态 / 中段列表）
  // 都从这一个判定派生。
  const isChat = pathname.startsWith('/chat')
  // 当前开着哪个面（?market=1 / ?kb=1 的镜像，写手是 SurfaceHost）——驱动
  //「插件」「知识库」两个按钮的选中态。不用 useSearchParams：rail 不在
  // Suspense 内，理由见 stores/surfaceOverlay.ts 的 useSurfaceOverlayStore 注释。
  const overlayOpen = useSurfaceOverlayStore((s) => s.open)
  // 「新对话/新画布」主按钮的选中态：当前就停在它指向的那个目的地时点亮，
  // 与「插件」按钮同一套视觉（都是 rail 上的目的地）。
  //  - 聊天面：**空态 = 有 id 没消息**，不是 sessionId === null。
  //    `switchShellSession(null)` 的语义是「让 main mint 一个新 session」
  //    （见 TabBar 的注释），点完「新对话」store 里的 sessionId 是那个**新会话
  //    的 id**、不是 null——按 null 判定会永远点不亮（2026-07-17 实测栽过）。
  //    真正的空态信号与 ThreadView 同源（`messages.length > 0` 的 hasMessages，
  //    那边注释也写着「新会话（有 id 没消息）」），这里取它的反面。
  //    与 rail 会话行高亮天然互斥：新会话没消息、不进历史列表，那边自然无高亮。
  //  - 画布面：canvas 首页（buildPath({kind:'home',view:'home'}) === '/'）就是
  //    「新画布」落点。
  //  - 有面（插件市场/知识库）盖着时两个都不亮——此刻的目的地是那个面，选中
  //    态归它自己的入口按钮。
  //
  // selector 直接返回 boolean（不是整个 messages 数组）：只有空/非空翻转时才
  // 重渲染 rail，流式追加消息不会把 rail 一起拖着重渲染。
  const chatIsEmpty = useChatStore((s) => s.messages.length === 0)
  const newTargetActive = !overlayOpen && (isChat ? chatIsEmpty : pathname === '/')

  // surface 切换的「毛玻璃浮起 thumb」（2026-07-20，替换 07-18 静态毛玻璃）：
  // thumb 横滑由内联 transition 管，这里只驱动**切面瞬间的一次呼吸缩放**。
  // 用 ref diff 而非监听挂载——AppRail 会跨侧栏收起/peek/切会话重挂载（见
  // 上方侧栏开关注释），若绑挂载或 data-state 会在每次重挂载误播呼吸。首帧
  // prevSurfaceRef === 当前面、不脉冲（thumb 静止在初始段）；只有 isChat 真
  // 翻转才 setThumbPulse(true)，480ms 后落定以便下次切面重播。
  const activeSurface = isChat ? 'chat' : 'canvas'
  const [thumbPulse, setThumbPulse] = useState(false)
  const prevSurfaceRef = useRef(activeSurface)
  useEffect(() => {
    if (prevSurfaceRef.current === activeSurface) return
    prevSurfaceRef.current = activeSurface
    setThumbPulse(true)
    const t = setTimeout(() => setThumbPulse(false), 480)
    return () => clearTimeout(t)
  }, [activeSurface])

  // 底部 user chip 的真实数据：OS 用户名（preload 启动时 os.userInfo() 读定，
  // 同步属性）+ 当前 CLI 后端（bundled → fusion-code / system → Claude Code）。
  // 浏览器直开无 chatApi 时 identity 保持 null，chip 整个不渲染——rail 上
  // 一块空比一块假身份诚实（与 RailSessionList 空态同一原则）。
  const [identity, setIdentity] = useState<{ user: string; backend: string } | null>(null)
  // 登录用户（AuthGate 放行后必有值；退出登录的广播会把它清回 null，
  // 但那一刻登录墙也同时立起，用户看不到回退后的 chip）。展示优先级：
  // authUser.name > OS 用户名——账号体系上线后 chip 显示的是「你登录的
  // 谁」而不是「这台机器叫什么」。
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  useEffect(() => {
    const api = window.chatApi
    if (!api?.getAuthState) return
    let alive = true
    void api.getAuthState().then((s) => {
      if (alive) setAuthUser(s.user)
    })
    const unsubscribe = api.onAuthStateChanged((s) => {
      if (alive) setAuthUser(s.user)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    const api = window.chatApi
    if (!api) return
    const user = api.osUser || '本机用户'
    const backendLabel = (mode: string) =>
      mode === 'system' ? 'Claude Code' : 'fusion-code'
    setIdentity({ user, backend: 'fusion-code' })
    api
      .getCliBackend()
      .then((s) => {
        setIdentity({ user, backend: backendLabel(s.mode) })
      })
      .catch(() => {
        /* 检测失败保持默认 fusion-code 文案，不打断 rail 渲染 */
      })

    // 后端在设置页切换后，chip 文案要跟着翻——设置页切换成功即派
    // 'od:cli-backend-changed'（携新状态），rail 与设置页同一个 studio
    // webContents，就地接住用 detail.mode 更新文案。不依赖 IPC 广播，
    // 是同 document 的 window 事件桥（同 od:appearance-changed 机制）。
    const onBackendChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: string }>).detail
      if (detail?.mode) {
        setIdentity({ user, backend: backendLabel(detail.mode) })
      }
    }
    window.addEventListener('od:cli-backend-changed', onBackendChanged)
    return () => {
      window.removeEventListener('od:cli-backend-changed', onBackendChanged)
    }
  }, [])

  // 打开设置 overlay（?settings=1）——账户菜单里「设置」与「偏好设置」子项
  // 共用这一个入口，机制见调用处注释（shallow pushState + canvas 响应式读参）。
  //
  // 参数挂在**当前 URL** 上而不是跳 '/?settings=1'：设置是 overlay，不是
  // 面切换——pathname 保持不动，rail tab 高亮 / 中段列表 / data-surface
  // 全程不变，关闭 back() 剥参回到原地。旧方案把 pathname 拽到 '/'，rail
  // 在全屏设置页底下默默切到画布态，「返回应用」揭开的瞬间 tab 再从
  // 工作画布翻回智能助手——一次可见的假切换（2026-07-08 用户实锤）。
  // settings=1 时由 SurfaceHost 强制放映 canvas 面（设置页的宿主），与
  // pathname 解耦。用 URL API 合并 query，保住 ?host=desktop 之类 boot 参数。
  const openSettings = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('settings', '1')
    window.history.pushState(null, '', url.pathname + url.search)
  }
  // 打开订阅购买页 overlay（UpgradeScreen 常驻根 layout，store 翻开关即现）。
  const setUpgradeOpen = useUpgradeStore((s) => s.setOpen)
  const openUpgrade = () => setUpgradeOpen(true)

  // 复制登录邮箱（账户菜单用户名区的复制钮）。copied 驱动图标短暂变勾
  // 作成功反馈；按钮不是 menu item，点击不关菜单。
  const [copied, setCopied] = useState(false)
  const copyEmail = () => {
    const email = authUser?.email
    if (!email) return
    void navigator.clipboard
      .writeText(email)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  // 手动检查更新：哑触发——dispatch 同 document 事件桥（机制同
  // od:cli-backend-changed），UpdateReadyToast 统一接手：invoke + 快照判定 +
  // 等广播结论 + 左下角 toast 反馈（检查中/已是最新/失败/开发模式不支持；
  // 发现新版则唤起其主卡片）。此前这里直连 chatApi.checkForUpdates() 静默
  // 触发，「已是最新/失败/dev」三种结论毫无反馈，用户实锤「点了像没功能」
  // （2026-07-16）。逻辑收拢在 UpdateReadyToast 一处，这里不再直连 chatApi。
  const checkUpdates = () => {
    window.dispatchEvent(new CustomEvent('od:manual-update-check'))
  }

  return (
    // 分界线 rail（2026-07-08 二次定稿，原型 docs/ui-prototype-shell-refined.html
    // 形态 3「分界线」）：--sidebar 灰实面，与近白内容面之间由
    // .shell-content-card 的左缘竖线定边界（globals.css）。同日上午的
    // 「毛玻璃」形态（bg-sidebar/40 + backdrop-blur + body 主题色光斑壁纸）
    // 用户真机看过定「太丑」退役——**当时否决的是「blur + 主题色光斑」组合**。
    // 2026-07-19 用户在背景图换肤功能正式做好之后重新要求 rail 加毛玻璃，
    // 这次明确排除光斑，只要半透明 + backdrop-blur：见 background-art.css
    // 的 `html[data-bg-art] .app-rail` 规则（背景图关闭时这里仍是不透明
    // bg-sidebar，同下面 utility 类，只有开着壁纸换肤才切换成玻璃态）。
    // 光斑效果依旧不加回。
    // 无右边框：分界线由内容面左缘承担，rail 自己不画线（两条会叠粗）。
    // 宽度对齐原型 --sidebar-w: 244px（旧值 220 给不下「标题 + 相对时间」
    // 的会话行）。
    // ⚠️ w-61（244px）与设置页 V2 的 --sv2-sidebar-w（settings-v2.css）配对：
    // 设置页是全屏 overlay、自己画 rail + 浮卡，两边宽度不等则切换
    // 设置 ↔ 聊天时内容卡左边缘跳动。改宽度必须两处同步。
    // app-rail：语义类名，仅供 background-art.css 在背景图换肤开启时把这层
    // 从不透明 bg-sidebar 转半透明（html[data-bg-art] .app-rail）。不参与
    // 样式本身（样式仍是下面这串 Tailwind utility），只是给那条规则一个稳定
    // 挂点——rail 之前没有语义类名，只能靠 utility 类名选中，容易和其它同
    // utility 的元素一起被误选。
    //
    // overlay 分支不挂 app-rail 类、直接 bg-transparent（2026-07-19，用户
    // 点名要求收起态浮出面板也要毛玻璃）：真正的玻璃底色 + backdrop-blur
    // 画在 RailShell.tsx 的 fixed 包裹 div 上（那层背后是真实聊天/画布内容，
    // 不是像本组件平时那样只挡在壁纸前面，所以不挂靠 data-bg-art、始终
    // 生效）。⚠️ 这里必须把 app-rail 类也摘掉，不能只把 bg-sidebar 换成
    // bg-transparent——开着壁纸换肤时 `html[data-bg-art] .app-rail` 规则
    // 的 specificity (0,2,1) 会压过 bg-transparent 这个 utility (0,1,0)，
    // 照样把 nav 自己的半透明+blur 糊上去，跟包裹 div 的玻璃层嵌套 backdrop-
    // filter 叠两次（CDP 真机验证过：开着壁纸时 nav 计算出的背景不是
    // transparent 而是 hsl(var(--sidebar)/0.55)，就是这条规则赢的）。摘掉
    // class 后这条规则对 overlay 态零命中，绘制职责完全交给外层包裹 div。
    <nav
      className={cn(
        'flex h-full w-61 shrink-0 flex-col gap-1 px-3 pb-3',
        overlay ? 'bg-transparent' : 'app-rail bg-sidebar'
      )}
    >
      {/* 顶部 48px：macOS 红绿灯的净空 + 窗口拖拽面（原型 .traffic）。
        * 原来是 nav 的 pt-12 padding——padding 不能标 app-region，改成
        * 实体条后这块「空白」真的能拖动窗口。收起/展开按钮叠在这条的
        * 右端：整条仍是 drag 区，按钮自身标 no-drag 才点得动（否则
        * Electron 按 layout box 注册拖拽区，点击被窗口拖拽吞掉）。
        *
        * ⚠️ overlay 形态（收起态 hover 浮出）**必须关掉 drag**：macOS 上
        * drag 区是 non-client——真实鼠标一进这条，renderer 不再收 mousemove
        * 且被合成一次 mouse-leave → RailShell overlay 的 onMouseLeave 立刻
        * fire → peek=false → 面板当着用户的面缩回，顶部「展开钉住」按钮
        * 永远点不到（2026-07-06 实锤，机制同「三图标点不动」那次）。而且
        * app-region 矩形按 DOM 遍历顺序注册：外层容器标 no-drag 也会被这条
        * 后遍历的 drag 重新填回，所以洞必须在这里挖，标 prop 不标 CSS 覆盖。
        * 悬浮面板本就是移出即消失的瞬态 UI，拖窗口语义在此无意义。 */}
      {/* 侧栏开关**不在这条里**（2026-07-16 Codex 定稿）：它是 RailShell
        * 的常驻 fixed 按钮，恰好浮在这条的 x=100 处——本条只剩红绿灯净空
        * 与窗口拖拽职责，开关钮自带 no-drag 挖洞（portal 到 body 末尾，
        * 后注册稳压这条 drag）。 */}
      <div
        className={cn(
          'relative flex h-12 shrink-0 items-center gap-0.5',
          overlay ? '[-webkit-app-region:no-drag]' : '[-webkit-app-region:drag]'
        )}
      />
      {/* 顶部主按钮跟随当前 surface（2026-07-04 用户要求）：
        *  - 聊天面「新对话」= 切到「新会话」再进聊天路由。sessionId null 的
        *    SWITCH_REQUEST 经 main 正规化后由 chat 的 FusionRuntimeProvider
        *    接住（onSwitchToNewThread）；浏览器直开无 chatApi 时退化为纯导航。
        *  - 画布面「新画布」= 回 canvas 主页（说说你的需求吧 composer 就是
        *    「新建」的入口，canvas 没有独立的空白新建页）。走 canvas router
        *    的 navigate（动态 import 原因见下方画布 tab 注释）；已在主页时
        *    navigate 同路径早退，点击为无害 no-op。 */}
      {/* 主按钮强调色用 --primary（用户主题色，appearance applier 写入）——
        * rail 的「CTA/选中/身份点位」随主题色走（2026-07-08 用户定稿，此前
        * 钉品牌绿 --sidebar-primary）。品牌绿只保留给账户菜单的套餐语义。 */}
      {/* 搜索不在本行（2026-07-16 用户定稿）：搜索钮住在 RailShell 的常驻
        * 顶栏按钮组里（开关右侧、两态恒显、永不移动），rail 内容区不再
        * 重复放搜索入口。 */}
      <Button
        variant="ghost"
        className={cn(
          'mb-2 justify-start gap-2 px-3',
          // 绿色 tint 退役（2026-07-08 的 bg-primary/12 + text-primary，
          // 2026-07-17 用户要求去掉）：rail 上的绿只留给「真·品牌时刻」，
          // 一个常驻导航按钮不该长期占用主题色。现在与「知识库」「插件」
          // 同一套 ghost 视觉，**选中态也与「插件」逐字一致**——三者都是
          // 「rail 上的目的地」，选中语义该长一个样。
          newTargetActive
            ? 'bg-sidebar-accent font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
        )}
        onClick={() => {
          if (isChat) {
            // 面（插件市场/知识库）盖着就先掀掉：switchShellSession 只切
            // runtime、**不导航**，不掀的话新会话建好了却被面盖住，用户以为
            //「点了没反应」（2026-07-17 同族陷阱，见 stores/surfaceOverlay.ts）。
            // 没盖着时 closeSurfaceOverlay 是 no-op，且它用 replaceState 不塞
            // 历史——「新对话」是个动作不是导航，本来就不该产生历史条目。
            closeSurfaceOverlay()
            void window.tabApi?.switchShellSession?.(null)
          } else {
            // canvas 的 navigate() 自己会剥掉面开关，这边不用管。
            void import('@/src/canvas/router').then(({ navigate }) => {
              navigate({ kind: 'home', view: 'home' })
            })
          }
        }}
      >
        {/* SquarePen 而非 Plus（2026-07-17 用户要求换掉裸 + 号）：这颗是
          * 「开一个新的写作面」，不是往列表里加一项——ChatGPT/Claude 的
          * 新建对话都用这个图标，视觉重量也比裸 + 饱满。下方「新建项目」
          * 保留 Plus 是刻意的：那才是真·往列表加一条。 */}
        <SquarePen className="size-4" /> {isChat ? '新对话' : '新画布'}
      </Button>
      {/* 知识库 / 插件 —— rail 上的两个「面入口」，**除了图标与文案完全同构**
        * （2026-07-17 用户要求知识库「改造成跟插件页面交互一样」）。
        *
        * 两点纪律，两个按钮都遵守：
        *  - **不按当前面分流**：两个 surface 共用同一个入口、开同一个面
        *    （?market=1 / ?kb=1 → SurfaceHost 的独立面，rail 常驻、右侧内容区
        *    换成它）。知识库此前有 `isChat &&` 门控（那时它是盖住 rail 的全屏
        *    overlay，画布面有没有入口无所谓）；抬成面之后必须两面都在——否则
        *    在知识库面上点「工作画布」，入口按钮跟着消失，rail 上再没有任何
        *    东西指示「我刚才在知识库」。
        *  - **选中态是必需品不是装饰**：面开着 = 这个入口就是「当前所在」。
        *    会话/项目列表那边此刻已取消高亮（见 RailSessionList 的 activeId），
        *    没有这个选中态整个 rail 看不出当前位置。点会话/切面关掉面后自动
        *    回落普通态。
        *
        * 早期版本插件入口 navigate 到 canvas 的 `/market` 路由：pathname 一被
        * 拽走 SurfaceHost 就翻到画布面，用户在聊天面点插件会被踢去工作画布
        *（2026-07-17 实锤，同 2026-07-08 设置页 pathname 假切换那一族）。现在
        * 两个入口与 openSettings 同为「query 挂当前 pathname」，pathname 全程
        * 不动。机制与形态取舍见 stores/surfaceOverlay.ts。
        *
        * **插件例外（2026-07-20 用户要求）**：上面「不按当前面分流」的纪律
        * 对知识库依旧成立，但插件入口现在只在聊天面显示——画布面本来就是
        * 「工作」场景，用户明确不想在这里看到插件入口。这条 filter 只挑掉
        * `market`，`kb` 不受影响，两面都在的原有行为对知识库继续有效。因为
        * `market` 面只能从聊天面进入，画布面点会话/切回聊天面时如果之前正
        * 巧开着插件面，`overlayOpen==='market'` 的选中态判断（下面
        * `overlayOpen === kind`）不会因为按钮消失而出问题——按钮本来就不在
        * DOM 里，没有悬空选中态可言。 */}
      {(
        [
          { kind: 'kb', icon: BookOpen, label: '知识库' },
          { kind: 'market', icon: Puzzle, label: '插件' }
        ] as const
      )
        .filter(({ kind }) => kind !== 'market' || isChat)
        .map(({ kind, icon: Icon, label }) => (
        <Button
          key={kind}
          variant="ghost"
          className={cn(
            'mb-2 justify-start gap-2 px-3',
            overlayOpen === kind
              ? 'bg-sidebar-accent font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
          )}
          onClick={() => openSurfaceOverlay(kind)}
        >
          <Icon className="size-4" /> {label}
        </Button>
      ))}
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
      {/* 选中态仍按 pathname 派生：市场面（?market=1）开着时高亮**保持原面**
        * ——它是挂在当前 pathname 上的 overlay，语义上是「我在智能助手，顺手
        * 开了插件市场」，同 settings=1/kb=1 的既定取向（见 openSettings 注释）。 */}
      <Tabs value={activeSurface}>
        {/* 「毛玻璃浮起」segmented（2026-07-20，替换 07-18 的静态毛玻璃；先出
          * HTML 原型六选一后定稿）：选中态不再靠 radix 每段各自淡入，而是一块
          * **绝对定位的滑动 thumb**——半透明白玻璃卡 + 抬升阴影，用带回弹的
          * spring 曲线在两段间横滑，切面瞬间做一次呼吸缩放（thumbPulse）。
          *
          * 只动这一处用法，不改 ui/tabs.tsx 基件（改基件牵动全项目所有 Tabs）：
          *  · TabsList 加 relative 当 thumb 定位锚点；w-full 是布局适配。
          *  · 毛玻璃的模糊**只留轨道这一层**——thumb 半透明即可「透出」底下这层
          *    模糊，thumb 自己**不再叠 backdrop-filter**（嵌套两层会叠糊发灰，
          *    errors 07-19 踩过）。
          *  · thumb 的 w-[calc(50%-3px)] / translate-x-full 与基件 p-[3px] +
          *    flex-1 均分**精确对齐**（left:3px 贴左段左缘，平移一个自身宽正好
          *    落到右段，两侧各留 3px）——改基件 padding 会破坏这个对齐。
          *  · trigger 的 active 底/阴影/边框用 important 中和（背景交给 thumb），
          *    只保留基件的 text-foreground（选中字变亮）与 focus 环。
          *
          * 2026-07-20 补（亮色主题下用户报「没有毛玻璃效果」）：上面说的
          * 「嵌套两层会叠糊」这条纪律漏用到了再上一层——TabsList 本身也是
          * `.app-rail` 的后代，壁纸开启时 `.app-rail` 自己已经是
          * `backdrop-filter: blur(20px)...`（background-art.css），TabsList
          * 原来还叠一层自己的 backdrop-blur-xl，等于**两层嵌套**，跟 thumb
          * 那条踩过的坑是同一个问题只是换了一层。双重模糊把壁纸纹理磨得比
          * 单层更平，亮色壁纸+浅色 bg-muted/55 混合后剩下的层次差本来就小，
          * 磨没了就成了一块看不出玻璃感的灰白色块（暗色主题因为底色深、
          * 层次差天然大，双重模糊还没磨到看不出的地步，所以只在亮色下更
          * 明显）。摘掉 TabsList 自己的 backdrop-blur/saturate，只留 rail
          * 自身那层——bg-muted/55 的半透明色仍在，透出的是 rail 那层已经
          * 模糊好的结果，不需要再模糊第二次。 */}
        <TabsList className="relative w-full bg-muted/55">
          {/* 滑动 thumb：纯装饰（aria-hidden），z-0 垫在 trigger 文字之下。外层
            * 管横滑（translateX + spring transition），内层 fill 管玻璃观感与
            * 呼吸缩放——两层各走各的 transform（外 translateX / 内 scale）互不
            * 覆盖。data-active 驱动 translate-x-full；motion-reduce 关横滑。 */}
          <span
            aria-hidden
            data-active={activeSurface}
            className="pointer-events-none absolute inset-y-[3px] left-[3px] z-0 w-[calc(50%-3px)] translate-x-0 will-change-transform transition-transform duration-[440ms] ease-[cubic-bezier(0.34,1.42,0.5,1)] data-[active=canvas]:translate-x-full motion-reduce:transition-none"
          >
            <span
              // 抬升阴影 + inset 高光在 globals.css 的 .surface-thumb-fill 里
              // （不用 Tailwind arbitrary shadow——v4 的 --tw-shadow-color 替换会
              // 把复杂逗号阴影值静默清成 transparent，见该文件注释）。
              className={cn(
                'surface-thumb-fill block size-full rounded-md border border-black/[0.06] bg-white/75',
                'dark:border-white/[0.14] dark:bg-white/[0.12]',
                thumbPulse && 'is-moving'
              )}
            />
          </span>
          {SURFACE_TABS.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              // 导航走 **onClick 而非 Tabs 的 onValueChange**（2026-07-17）：
              // onValueChange 只在 value 真的变化时触发，而 value 由 pathname
              // 派生——市场面开在聊天面上时（/chat?market=1）value 仍是 'chat'，
              // 用户点「智能助手」想回聊天，onValueChange 不触发、什么也不会
              // 发生，人被困在市场面里出不去（rail 常驻才暴露的死路：知识库/
              // 设置盖住了 rail，用户只能走它们自带的「返回应用」，撞不到这个）。
              // onClick 每次点击都跑，由 goSurface 自己判断该做什么。
              onClick={() => goSurface(item.value)}
              className="relative z-10 data-[state=active]:bg-transparent! data-[state=active]:shadow-none! dark:data-[state=active]:border-transparent! dark:data-[state=active]:bg-transparent!"
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
                // focus-visible:ring-0：Radix 菜单关闭会把焦点还给 trigger，
                // 且常判为 :focus-visible——shadcn Button 默认的 3px ring 让
                // chip 每次关菜单后都亮一整圈（用户 2026-07-07 要求去掉）。
                // 开启态视觉反馈由 data-[state=open] 底色承担，不靠焦点环。
                // hover/open 底透明化（2026-07-20 用户点名要求）：原来是纯
                // 实底 bg-sidebar-accent，跟壁纸开启时已经玻璃化的 rail 自身
                // （backdrop-blur-xl，见 background-art.css 的 .app-rail 规则）
                // 拼在一起显得突兀——一块磨砂里嵌一块完全不透明的实心矩形。
                // 这里只加透明度、不再叠一层 backdrop-filter：rail 容器自己
                // 已经是模糊层，子元素只要半透明就能透出那层模糊结果，两层都
                // 上 backdrop-filter 会重复模糊糊成一团（RailShell.tsx 头
                // 注释踩过的同一条纪律）。
                className="h-11 w-full justify-start gap-2.5 px-2.5 hover:bg-sidebar-accent/70 focus-visible:ring-0 data-[state=open]:bg-sidebar-accent/70"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                  {(authUser?.name ?? identity.user).charAt(0).toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                  <span className="max-w-full truncate text-[12.5px] font-medium text-sidebar-foreground">
                    {authUser?.name ?? identity.user}
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
            {/* side="top"：chip 在 rail 最底，菜单必须向上弹。2026-07-07
              * 二次定稿 V1「精修基准」（原型 docs/ui-prototype-account-menu.html，
              * 用户先选 V3 后改选 V1）：无头像圆，用户名 13.5 semibold + 邮箱
              * 副行直接撑层级；套餐行用光圈绿点表状态、「升级」降为绿字动作
              * （黑 pill / 绿渐变钮两代权重过载方案先后退役）；外观 seg 收成
              * 太阳/月亮 icon 段。结构=用户名区 → 套餐行 → sep → 设置/外观/
              * 帮助/检查更新 → sep → 退出登录（普通色）；用户名区与套餐行
              * 之间刻意无分隔线——V1 靠密度分区，通栏线只切功能组。 */}
            <DropdownMenuContent
              side="top"
              align="start"
              sideOffset={8}
              // 玻璃质感（2026-07-18，用户参考 macOS「打开方式」原生毛玻璃菜单
              // 定稿）：只在这一个实例上把基件的 bg-popover 实底换成半透明 +
              // backdrop-blur + saturate（token 仍是 --popover，颜色本身没动，
              // 只是材质从纸变成玻璃）。刻意不动 ui/dropdown-menu.tsx 基件或
              // menus.css 的统一实底皮肤——那是 2026-07-08 全项目菜单定稿，
              // 影响 ~15 个 canvas 菜单，本次需求只针对账户菜单这一处。
              //
              // 效果偏弱补强（2026-07-20 用户截图报「毛玻璃效果不是很强」）：
              // 首版自定义了几处跟 ui/dropdown-menu.tsx 基件不一致的数值——
              // /70 不透明度（基件 /55，更实）、border-border/40（基件固定
              // border-white/15，语义色边框在浅色 popover 上对比弱）、shadow
              // 丢了基件的 inset 顶部白高光（玻璃的镜面反光线索）。这几处
              // 独立看都不算错，但叠在一起就是 ui/dropdown-menu.tsx 头注释
              // 警告过的「不提亮混合看不出透视」同族问题——这次是浅色
              // popover 叠浅色壁纸失效，跟暗色版重命名弹窗那次对称。修法：
              // 不透明度/边框/高光三处对齐基件已验证过的配方，只保留
              // blur-2xl 这一处「更 frosted」的刻意差异化（呼应 macOS 原生
              // 菜单的浓雾感，不是本次要修的部分）。backdrop-brightness-125
              // 按 twMerge 语义本会从基件继承（跟这条 override 没有任何类名
              // 冲突），但不写出来等于把「这条菜单为什么看得出玻璃」的关键
              // 变量藏进另一个文件，故意显式重复声明一遍。
              className="w-[256px] rounded-[14px] border border-white/15 bg-popover/55 p-[5px] shadow-[0_16px_50px_rgba(0,0,0,.14),0_2px_8px_rgba(0,0,0,.06),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl backdrop-saturate-150 backdrop-brightness-100 dark:backdrop-brightness-125"
            >
              {/* 用户名区：名字行（复制钮贴名字，copied 短暂变勾，非 menu
                * item 点击不关菜单）+ 邮箱副行（浏览器直开无 authUser 时不
                * 渲染，不摆假数据）。 */}
              <div className="flex flex-col gap-px px-[9px] pb-[5px] pt-2">
                <span className="flex items-center gap-1">
                  <span className="truncate text-[13.5px] font-semibold tracking-[-0.2px] text-foreground">
                    {authUser?.name ?? identity.user}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="复制邮箱"
                    onClick={copyEmail}
                    className="size-5 shrink-0 text-muted-foreground/70 hover:text-foreground"
                  >
                    {copied ? (
                      <Check className="size-3" strokeWidth={2.5} />
                    ) : (
                      <Copy className="size-3" strokeWidth={1.75} />
                    )}
                  </Button>
                </span>
                {authUser?.email ? (
                  <span className="truncate text-[11.5px] text-muted-foreground">
                    {authUser.email}
                  </span>
                ) : null}
              </div>
              {/* 套餐行：光圈绿点（状态语义：账号有效）+ 套餐名（authService
                * 下发，占位固定「基础版」）+「升级」绿字动作 → 订阅购买页。
                * 行本身不可点，只有升级钮是动作（非 menu item，不关菜单的
                * 语义在这里不适用——openUpgrade 开的是全屏 overlay，menu
                * 随焦点转移自然关闭）。 */}
              <div className="flex items-center gap-2 pb-[7px] pl-[11px] pr-[7px] pt-[5px]">
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full bg-[hsl(var(--brand))] shadow-[0_0_0_3px_hsl(var(--brand)/0.12)]"
                />
                <span className="flex-1 truncate text-[12.5px] text-muted-foreground">
                  {authUser?.plan.name ?? '基础版'}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={openUpgrade}
                  className={cn(
                    'h-auto gap-[3px] rounded-full py-[3px] pl-[9px] pr-2 text-xs font-medium',
                    brandInk,
                    'hover:bg-[hsl(var(--brand)/0.12)] hover:text-[color-mix(in_srgb,hsl(var(--brand))_82%,#000)] dark:hover:text-[hsl(var(--brand))]'
                  )}
                >
                  升级
                  <ArrowUpRight className="size-[11px]" strokeWidth={2} />
                </Button>
              </div>
              <DropdownMenuSeparator className="mx-2 bg-border/70" />
              <DropdownMenuGroup>
                {/* 设置：走 canvas App 的 overlay 模式（?settings=1 → 全屏
                  * 设置页）。shallow pushState：canvas 的 isSettingsOverlay
                  * 用 useSearchParams 响应式读取，overlay 即开零刷新。 */}
                <DropdownMenuItem
                  onSelect={openSettings}
                  className="gap-2.5 rounded-[9px] px-2.5 py-[7px] text-[13px]"
                >
                  <Settings strokeWidth={1.75} />
                  设置
                </DropdownMenuItem>
                {/* 外观行：非 menu item（点 seg 切主题不关菜单），行内
                  * 浅色/深色两段切换（AppearanceSeg）。 */}
                <div className="flex items-center justify-between py-1 pl-2.5 pr-[7px]">
                  <span className="flex items-center gap-2.5 text-[13px] text-foreground">
                    <Palette className="size-4 text-muted-foreground" strokeWidth={1.75} />
                    外观
                  </span>
                  <AppearanceSeg />
                </div>
                {/* 帮助与反馈：打开全局反馈弹窗（useDialogStore('feedback')，
                  * 组件挂在 canvas/AppRoot.tsx，与设置页 about 区共用同一实例）。 */}
                <DropdownMenuItem
                  onSelect={() => useDialogStore.getState().openDialog('feedback')}
                  className="gap-2.5 rounded-[9px] px-2.5 py-[7px] text-[13px]"
                >
                  <CircleHelp strokeWidth={1.75} />
                  帮助与反馈
                </DropdownMenuItem>
                {/* 检查更新：真实链路（chatApi.checkForUpdates），结果由
                  * UpdateReadyToast / 设置页更新区展示（见 checkUpdates）。 */}
                <DropdownMenuItem
                  onSelect={checkUpdates}
                  className="gap-2.5 rounded-[9px] px-2.5 py-[7px] text-[13px]"
                >
                  <CircleArrowUp strokeWidth={1.75} />
                  检查更新
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="mx-2 bg-border/70" />
              {/* 退出登录：真实登出。main 删 auth.json + 广播 signedOut →
                * AuthGate 立起登录墙。普通墨色（2026-07-07 对齐目标设计，
                * 不再用 destructive 红）。 */}
              <DropdownMenuItem
                onSelect={() => {
                  void window.chatApi?.logout?.()
                }}
                className="gap-2.5 rounded-[9px] px-2.5 py-[7px] text-[13px]"
              >
                <LogOut strokeWidth={1.75} />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </nav>
  )
}
