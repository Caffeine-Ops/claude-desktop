import { ClientApp } from './client-app'

/**
 * 工作画布（open-design SPA，迁移自 apps/web）的 optional catch-all 挂载点。
 *
 * canvas 的自制 router（src/canvas/router.ts）按**根路径制**读
 * window.location（'/'、'/projects'、'/project/:id'、'/marketplace'…），
 * 所以它必须挂在根 catch-all 上而不是 /canvas 前缀下——否则 184k 行里的
 * 每一处 pushState/href 都要改写。studio 自己的静态路由（/chat、
 * /chat-probe）在 Next 里天然优先于 catch-all，互不影响。
 *
 * 沿用 web 原版 app/[[...slug]]/page.tsx 的结构；generateStaticParams
 * 未搬——studio 只做桌面形态，不做 static export（架构决策见 README）。
 */
export default function Page() {
  return <ClientApp />
}
