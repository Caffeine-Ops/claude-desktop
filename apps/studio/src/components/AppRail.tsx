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
 * 会话列表刻意不放在 rail 里：迁入的聊天页（/chat 的 App 树）自带
 * ThreadListSidebar，rail 再放一份就是双份维护。设置走
 * tabApi.openSettingsWindow()——复用现有全窗设置 overlay（web
 * ?settings=1），零迁移成本。
 *
 * 渲染在根 layout（server 树）里，所以本组件不得在模块层触碰 window；
 * tabApi 只在事件处理器里访问并做存在判断（浏览器直开时是 undefined）。
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

const NAV_ITEMS: { href: string; label: string; icon: ReactNode }[] = [
  {
    href: '/chat',
    label: '智能助手',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 1 1 16.1-3.8Z" />
      </svg>
    )
  },
  {
    // canvas SPA 挂在根 catch-all（router 是根路径制，见 app/[[...slug]]），
    // 所以「工作画布」指 '/'。active 判定在下面特判。
    href: '/',
    label: '工作画布',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    )
  }
]

export function AppRail() {
  const pathname = usePathname()

  return (
    <nav className="flex h-full w-52 shrink-0 flex-col gap-1 border-r border-border bg-sidebar px-3 pb-4 pt-12">
      <Link
        href="/chat"
        className="mb-2 flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary"
      >
        <span className="text-base leading-none">+</span> 新对话
      </Link>

      {NAV_ITEMS.map((item) => {
        // '/chat*' 归聊天，其余一切路径（'/'、'/projects'、'/project/x'…）
        // 都是 canvas SPA 的地盘。
        const active =
          item.href === '/' ? !pathname.startsWith('/chat') : pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            className={
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm ' +
              (active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50')
            }
          >
            {item.icon}
            {item.label}
          </Link>
        )
      })}

      <div className="mt-4 px-3 text-xs text-muted-foreground">更多</div>
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/50"
        onClick={() => {
          // 复用现有全窗设置 overlay。浏览器直开（无 tabApi）时静默无效——
          // 设置本就依赖壳内 daemon 环境。
          void window.tabApi?.openSettingsWindow()
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
        设置
      </button>
    </nav>
  )
}
