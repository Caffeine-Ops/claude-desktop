'use client'

import dynamic from 'next/dynamic'

// 与 web 原版 client-app.tsx 同构：canvas SPA 全树读 localStorage /
// window.location，整体 opt-out 静态渲染（与 /chat 的挂载策略一致）。
const App = dynamic(() => import('@/src/canvas/App').then((m) => m.App), {
  ssr: false,
  loading: () => <div className="od-loading-shell">加载工作画布…</div>
})

export function ClientApp() {
  return <App />
}
