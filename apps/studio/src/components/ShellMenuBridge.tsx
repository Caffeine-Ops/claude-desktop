'use client'

import { useEffect } from 'react'

import { useDialogStore } from '@/src/chat/stores/dialogs'
import { getLastCanvasPath, goChat } from '@/src/stores/canvasNav'
import { useRailStore } from '@/src/stores/rail'
import { closeSurfaceOverlay } from '@/src/stores/surfaceOverlay'

/**
 * 菜单栏动作的**根层**分发端（2026-09-30 随键盘快捷键新建）。
 *
 * 为什么不能全塞进 chat/App.tsx（原本唯一的分发端）：动作的执行代码分住
 * 两棵树。新对话 / 切侧栏 / 切面的真身在 src/stores 与根 layout（AppRail、
 * RailShell 都是根层组件，chat 树看不见它们）；设置 / 日志 / 语言 / 导出
 * 才在 chat 树里。所以按归属拆成两个订阅端，各接各的。
 *
 * 多订阅端是安全的：preload 的 onShellMenuAction 每调一次就注册一个独立的
 * ipcRenderer 监听器，两端互不干扰，各自只处理自己认得的 action。
 *
 * 本组件不渲染任何东西，挂在根 layout 里只为拿到「组件挂载/卸载」这个生命
 * 周期来管监听器的注册与摘除。
 */
export function ShellMenuBridge(): null {
  useEffect(() => {
    if (!window.chatApi?.onShellMenuAction) return
    return window.chatApi.onShellMenuAction((action) => {
      switch (action) {
        case 'new-chat':
          // 与 rail 主按钮同一套动作，外加一步切面：菜单文案写的是「新对话」，
          // 那在画布面按 ⌘N 也该给出一个新对话（rail 那颗按钮是跟随当前面的
          // ——它在画布面显示「新画布」，语义本来就不同）。
          //
          // goChat() 用 pushState('/chat') 覆盖 URL，天然剥掉面开关参数；
          // 已在聊天面时它是 no-op，所以还要显式 closeSurfaceOverlay()——
          // 面（插件市场/知识库）盖着的话，新会话建好了却被面挡住，用户会
          // 以为「点了没反应」（2026-07-17 同族陷阱）。
          goChat()
          closeSurfaceOverlay()
          void window.tabApi?.switchShellSession?.(null)
          break

        case 'open-search': {
          // ⌘K。2026-09-30 从 chat/App.tsx 搬到根层**就是为了这一步切面**：
          // 弹窗住在 chat 树（SurfaceHost keep-alive，画布面时它仍挂载但不
          // 可见），此前直接 openDialog 会在看不见的树里开一个弹窗，表现为
          // 「画布面按 ⌘K 没反应」。先切到聊天面再开，两面行为就一致了。
          //
          // 保留**开/关切换**语义（原 SessionSearchDialog 里那个监听就是
          // toggle）：再按一次 ⌘K 关掉是用户已有的肌肉记忆，不因为入口搬
          // 家而变。弹窗开着时必然已在聊天面，所以关的分支不用切面。
          const dialogs = useDialogStore.getState()
          if (dialogs.open === 'search') {
            dialogs.closeDialog()
          } else {
            goChat()
            dialogs.openDialog('search')
          }
          break
        }

        case 'toggle-sidebar':
          // 等价于常驻顶栏那颗开关钮。peek（hover 浮出）是 RailShell 的本地
          // 态、与折叠意图无关，这里不碰。
          useRailStore.getState().toggle()
          break

        case 'go-chat':
          goChat()
          break

        case 'go-canvas':
          // 与 AppRail 的画布入口逐字同逻辑：canvas 树常驻且用自制 router
          // （只听 popstate），必须走它的 navigate 而不是 Next 软导航，否则
          // URL 变了而画布视图不动。动态 import 是硬要求——canvas 模块求值
          // 期就碰 window，静态 import 进根层组件会让 layout 的 SSR 炸。
          // 还原上次画布视图，无记录才回首页兜底。
          void import('@/src/canvas/router').then(({ navigate, parseRoute }) => {
            const last = getLastCanvasPath()
            navigate(last ? parseRoute(last) : { kind: 'home', view: 'home' })
          })
          break

        // 其余动作（设置/日志/语言/导出）归 chat 树的分发端，这里不认。
        default:
          break
      }
    })
  }, [])

  return null
}
