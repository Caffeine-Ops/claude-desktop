import type { Metadata } from 'next'
import { Suspense, type ReactNode } from 'react'
import { AuthGate } from '@/src/components/AuthGate'
import { RailShell } from '@/src/components/RailShell'
import { SurfaceHost } from '@/src/components/SurfaceHost'
import { UpgradeScreen } from '@/src/components/UpgradeScreen'
import './globals.css'
// canvas（迁移自 apps/web）的两个样式入口，沿用 web 原版 layout.tsx 的
// JS-import 方式——不能并进 globals.css 的 @import 链（位置违规会被静默
// 丢弃，见 globals.css 尾部注释）。顺序在 globals.css 之后：canvas 的
// 手写 CSS 要能覆盖 chat 链的 preflight。
import '@/src/canvas/index.css'
import '@/src/canvas/styles/home/index.css'

export const metadata: Metadata = {
  title: 'Claude Studio',
  description: '统一前端：聊天 + 设计工具'
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      {/* rail + 内容区的持久两栏骨架。overflow-hidden 让各路由自己管滚动
       *（聊天页的 .app 自带全高布局，canvas 是全高 iframe）。
       * bg-sidebar：rail 与窗口背景同面（原型 --rail-bg == shell root），
       * 右侧内容面平铺其上、靠左缘 hairline 分隔（2026-07-08 平铺化，
       * 见 globals.css .shell-content-card 注释）。 */}
      <body className="flex h-screen overflow-hidden bg-sidebar">
        {/* rail 外壳：展开态放回 w-61 常驻列，收起态宽度收成 0（内容面
         * flex-1 补满）+ hover 左边缘浮出。见 RailShell 头注释。 */}
        <RailShell />
        {/* 右侧舞台（原型 .stage）：平铺无 gutter（2026-07-08 去浮卡化，
         * 旧版上/右/下各 10px 呼吸 + 圆角阴影浮卡）。内容面样式在
         * globals.css 的 .shell-content-card。chat 与 canvas 两棵重型树
         * 常驻面内的 SurfaceHost（layout 跨路由保活，切换只翻显隐——见其
         * 头注释），面是两面共用的壳层元素，切面时本身纹丝不动。children
         * 是空壳 page（仅承担路由命中，chat-probe 除外）。 */}
        <div className="shell-stage">
          <div className="shell-content-card">
            {children}
            {/* Suspense：SurfaceHost 用 useSearchParams（settings=1 判定），
             * 静态预渲染要求它在 Suspense 边界内（否则 _not-found 等页的
             * prerender 直接报错）。fallback null——SurfaceHost 本来就是
             * 纯客户端表面。 */}
            <Suspense fallback={null}>
              <SurfaceHost />
            </Suspense>
          </div>
        </div>
        {/* 订阅购买页 overlay（z-9980）：账户菜单「升级订阅」打开，
         * 开关在 src/stores/upgrade.ts。挂在 AuthGate 之前——登出时
         * 登录墙（z-9999 + DOM 更靠后）必须盖得住它。 */}
        <UpgradeScreen />
        {/* 登录墙：body 最后一个子元素——未登录时全屏盖住 rail + 舞台
         * （两棵树照常挂载，墙只是视觉+交互门禁，见 AuthGate 头注释）。 */}
        <AuthGate />
      </body>
    </html>
  )
}
