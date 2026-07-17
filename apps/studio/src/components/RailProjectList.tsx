'use client'

/**
 * AppRail 的项目列表 —— 画布面（非 /chat 路径）时替换 RailSessionList
 * 出现在 rail 中段：rail 列表跟随当前 surface，聊天面列会话、画布面列
 * 项目（2026-07-04 用户要求）。
 *
 * 数据链路：直接 fetch `/api/projects`（dev 由 next.config rewrites 反代
 * daemon:7456，prod 由 app:// 协议 handler 反代——与 canvas 自己的
 * state/projects.ts listProjects 同一条通路）。**刻意不 import canvas 模块**：
 * rail 挂在根 layout（server 树），canvas 侧模块按约定一律视为「求值期可能
 * 触碰 window」，一个裸 fetch 不值得为复用打破这条铁律。
 *
 * 交互刻意比会话列表薄：只有「点击打开项目」——重命名/删除等管理动作
 * canvas 的项目页自己有完整 UI，rail 不重复。视觉语言（行高/分组标签/
 * 相对时间/选中态圆点）与 RailSessionList 逐项对齐，时间工具共用
 * railTime.ts 保证节奏同源。
 *
 * 选中态从 pathname 派生（/projects/:id 前缀，与 canvas router 的
 * buildPath 对齐）；导航走 canvas router 的 navigate()（动态 import——
 * canvas 树只听 popstate，Next 软导航它看不见，同 AppRail 画布 tab 的
 * 注释）。SSR/hydration 契约：初始 state 恒为空数组（服务端与客户端首帧
 * 同渲染 null），数据在 effect 里到位——不在渲染路径分支 window（见
 * errors/2026-07-04-useState初始化器分支window致hydration-mismatch）。
 */

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import type { Project } from '@open-design/contracts'

import { groupLabel, relativeTime } from '@/src/components/railTime'
import { ScrollArea } from '@/src/components/ui/scroll-area'
import { Button } from '@/src/components/ui/button'
import { useSurfaceOverlayStore } from '@/src/stores/surfaceOverlay'
import { cn } from '@/src/lib/utils'

/** 列表渲染项：分组标签与项目行拍平（与 RailSessionList 同构）。 */
type RailItem =
  | { kind: 'label'; key: string; text: string }
  | { kind: 'row'; key: string; project: Project }

function buildItems(projects: readonly Project[]): RailItem[] {
  const items: RailItem[] = []
  let lastGroup: string | null = null
  for (const p of projects) {
    const g = groupLabel(p.updatedAt)
    if (g !== lastGroup) {
      lastGroup = g
      items.push({ kind: 'label', key: `g:${g}`, text: g })
    }
    items.push({ kind: 'row', key: p.id, project: p })
  }
  return items
}

export function RailProjectList() {
  const pathname = usePathname()
  const [projects, setProjects] = useState<readonly Project[]>([])

  // 当前打开的项目 = /projects/:id 路径前缀（canvas router buildPath 的
  // 编码格式）。项目列表页（/projects 无 id）没有选中项。
  //
  // 有面（插件市场/知识库）盖着时一个项目都不高亮：同 RailSessionList 的
  // 理由——此刻内容区是那个面而不是那个项目，rail 的「当前位置」由该面入口
  // 按钮的选中态表达。点项目会走 canvas 的 navigate()，它自己会剥掉面开关
  // 参数（见其 stripSurfaceOverlayParams 注释），高亮随即回来。
  const overlayOpen = useSurfaceOverlayStore((s) => s.open !== null)
  const activeId = (() => {
    if (overlayOpen) return null
    const m = /^\/projects\/([^/]+)/.exec(pathname)
    return m ? decodeURIComponent(m[1]) : null
  })()

  const reload = useCallback(() => {
    void fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { projects?: Project[] } | null) => {
        if (!json?.projects) return
        setProjects([...json.projects].sort((a, b) => b.updatedAt - a.updatedAt))
      })
      .catch(() => {
        /* daemon 不可达（浏览器直开等）保持现状——空列表渲染 null，
           rail 上一块空白比一块假列表诚实（与 RailSessionList 同原则）。 */
      })
  }, [])

  // pathname 作依赖：进入画布面 / 画布内任意导航（含新建项目落到
  // /projects/:id）都触发一次轻量 reload，列表不需要专门的变更事件。
  useEffect(() => {
    reload()
  }, [reload, pathname])

  const openProject = useCallback((projectId: string) => {
    // canvas 树常驻 SurfaceHost 且只听 popstate——必须走它自己的
    // navigate()（pushState + 派发 popstate），Next 的 native history
    // 集成会同步 usePathname。动态 import 原因见 AppRail 画布 tab 注释。
    void import('@/src/canvas/router').then(({ navigate }) => {
      navigate({ kind: 'project', projectId, conversationId: null, fileName: null })
    })
  }, [])

  if (projects.length === 0) return null

  const items = buildItems(projects)

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-2">
      {/* [&>…]:block! 的原因见 RailSessionList：Radix Viewport 的
        * display:table 会让长名字把行撑出 rail 右缘。
        * 净空挪进 ul、不留在 ScrollArea 上（2026-07-17，同 RailSessionList 的
        * 修法）：ScrollArea 上的 px-1 是 overflow-x:hidden 的 Viewport **外面**
        * 的 padding，会把裁剪边界推回与行左缘重合，-mx-1 白扩、focus ring 左半
        * 被裁。挪进 ul 后 Viewport 左右缘各退 4px 成为真正的裁剪净空。
        * pr 同步 2→3：这里的 -mx-1 是**对称**的（不同于 RailSessionList 的
        * -ml-1/-mr-3），去掉 px-1 后 Viewport 右缘也外扩 4px，pr-2 会让行右缘
        * 跟着宽 4px；补成 pr-3 才把行右缘钉回原位。行几何左右都一分不变。 */}
      <ScrollArea className="-mx-1 min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
        <ul className="flex flex-col pl-1 pr-3">
          {items.map((item) =>
            item.kind === 'label' ? (
              <li
                key={item.key}
                className="px-3 pb-1.5 pt-5 text-[11px] font-medium text-muted-foreground/70 first:pt-1.5"
              >
                {item.text}
              </li>
            ) : (
              <li key={item.key}>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => openProject(item.project.id)}
                  title={item.project.name}
                  className={cn(
                    'relative flex h-8 w-full items-center justify-start gap-2 rounded-lg px-3 text-left text-[13px] font-normal transition-colors',
                    item.project.id === activeId
                      ? 'bg-sidebar-accent font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
                      : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground'
                  )}
                >
                  {/* 圆点恒占位只改色：条件插拔会推挤行内流造成切换抖动
                    *（RailSessionList 2026-07-04 同一教训）。 */}
                  <span
                    aria-hidden
                    className={cn(
                      'size-[5px] shrink-0 rounded-full transition-colors',
                      item.project.id === activeId ? 'bg-primary' : 'bg-transparent'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.project.name}</span>
                  <span className="shrink-0 text-[11px] font-normal text-muted-foreground/70">
                    {relativeTime(item.project.updatedAt)}
                  </span>
                </Button>
              </li>
            )
          )}
        </ul>
      </ScrollArea>
    </div>
  )
}
