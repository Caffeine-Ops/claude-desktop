'use client'

/**
 * 登录墙（AuthGate）——未登录时把整个应用盖在全屏登录页后面。
 *
 * 形态是 **overlay 而非条件渲染 children**：RailShell / SurfaceHost 两棵
 * 重型树照常挂载（keep-alive、engine warmup、appearance 桥都不受登录态
 * 影响），登录墙只是视觉+交互上的门。这样避免「等 auth 结论才挂树」引入
 * 的启动时序竞态（引擎 ready 推送早于渲染层订阅那类坑），登录成功一帧内
 * 放行、无重挂载。
 *
 * 状态机（renderer 本地）：
 *   unknown  —— 首次 getAuthState resolve 前。渲染纯底色遮罩防止未登录
 *               用户闪见 chat UI（启动时多半还压在 splash 下，遮罩是兜底）。
 *   browser  —— 无 window.chatApi（浏览器直开 dev）。登录不可用，直接放行
 *               ——与 AppRail identity 的「浏览器直开不渲染」同一诚实原则。
 *   signedIn / signedOut —— main 的结论（AUTH_GET_STATE + 广播）。
 *
 * ⚠️ useState 初始化器不分支 typeof window（SSR hydration 铁律）：初始
 * 恒为 unknown，两端首帧一致；chatApi 探测全部放 effect 里。
 *
 * 挂载位置：layout.tsx body 的最后一个子元素——DOM 顺序天然压过 stage
 * 内容；z-[9999] 与 UpdateReadyToast 同级，靠后渲染盖住它（登录墙起来时
 * 不该有任何可交互的 UI 露头）。
 */

import { useEffect, useState } from 'react'

import type { AuthState } from '@desktop-shared/ipc-channels'
import { LoginScreen } from '@/src/components/LoginScreen'

type GateState =
  | { status: 'unknown'; user: null }
  | { status: 'browser'; user: null }
  | AuthState

export function AuthGate() {
  const [state, setState] = useState<GateState>({ status: 'unknown', user: null })

  useEffect(() => {
    const api = window.chatApi
    // 浏览器直开（无 preload）：登录链路不存在，放行进 app。
    if (!api?.getAuthState) {
      setState({ status: 'browser', user: null })
      return
    }
    let alive = true
    void api
      .getAuthState()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch(() => {
        // IPC 意外失败按未登录处理——宁可多要求一次登录，不能让门卫
        // 卡死在 unknown 遮罩上把整个 app 焊死。
        if (alive) setState({ status: 'signedOut', user: null })
      })
    // 订阅 main 的迁移广播：别的窗口登录/退出、以及本窗口 logout 都从
    // 这里回流（登录成功另有 onSignedIn 直通，见下）。
    const unsubscribe = api.onAuthStateChanged((s) => {
      if (alive) setState(s)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  if (state.status === 'signedIn' || state.status === 'browser') return null

  if (state.status === 'unknown') {
    // 结论未到：纯底色遮罩（与窗口/rail 同面），不给登录表单也不透内容。
    return <div aria-hidden className="fixed inset-0 z-[9999] bg-sidebar" />
  }

  return (
    <LoginScreen
      // 登录成功直通：AUTH_LOGIN 的 resolve 值就是新快照，不等广播绕圈
      // （广播也会到，setState 幂等）。
      onSignedIn={(s) => setState(s)}
    />
  )
}
