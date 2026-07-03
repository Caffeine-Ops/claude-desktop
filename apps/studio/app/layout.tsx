import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { AppRail } from '@/src/components/AppRail'
import './globals.css'

export const metadata: Metadata = {
  title: 'Claude Studio',
  description: '统一前端：聊天 + 设计工具'
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      {/* rail + 内容区的持久两栏骨架。overflow-hidden 让各路由自己管滚动
       *（聊天页的 .app 自带全高布局，canvas 是全高 iframe）。 */}
      <body className="flex h-screen overflow-hidden">
        <AppRail />
        <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      </body>
    </html>
  )
}
