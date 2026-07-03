'use client'

/**
 * 聊天路由 —— desktop renderer 迁移后的挂载点。
 *
 * 两层包装，各管一件事：
 *
 *  - **dynamic + ssr:false**：迁入的 App 树（src/chat/）是原 Vite SPA 代码，
 *    stores/组件里有模块求值期就触碰 window/localStorage 的路径。关掉 SSR/
 *    prerender 让这些模块只在浏览器求值——行为与原 Vite 环境完全等价，
 *    也免去逐文件排查「window is not defined」。
 *
 *  - **HostGate**：window.chatApi 的宿主门。类型上 chatApi 声明为非可选
 *    （见 src/types/window.d.ts 的注释），运行时浏览器直开是 undefined——
 *    gate 不过就不渲染 App，保证类型谎言永不兑现。
 */

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'

const ChatApp = dynamic(() => import('@/src/chat/App'), {
  ssr: false,
  loading: () => <div className="flex min-h-screen items-center justify-center text-sm opacity-60">加载聊天界面…</div>
})

export default function ChatPage() {
  // null = 检测中（首帧，避免 SSR/CSR 文案闪烁）
  const [hosted, setHosted] = useState<boolean | null>(null)

  useEffect(() => {
    const ok = typeof window.chatApi !== 'undefined'
    setHosted(ok)
    if (ok) {
      // main.css 的聊天表面规则挂在 html[data-surface='chat'] 上（透明根
      // 背景等）。原 main.tsx 在模块求值期打标；这里等价地在挂载时打。
      document.documentElement.dataset.surface = 'chat'
      return () => {
        delete document.documentElement.dataset.surface
      }
    }
    return undefined
  }, [])

  if (hosted === null) return null
  if (!hosted) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 text-sm">
        <p>聊天功能需要在桌面应用内使用。</p>
        <p className="opacity-60">这是浏览器直开的 studio（未注入 chatApi）。</p>
      </main>
    )
  }
  return <ChatApp />
}
