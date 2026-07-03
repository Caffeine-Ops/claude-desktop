/**
 * 工作画布路由的空壳 —— canvas 面的实体不在这里。
 *
 * canvas 的自制 router（src/canvas/router.ts）按**根路径制**读
 * window.location（'/'、'/projects'、'/project/:id'、'/marketplace'…），
 * 所以路由必须挂在根 optional catch-all 上——否则 184k 行里的每一处
 * pushState/href 都要改写。studio 自己的静态路由（/chat、/chat-probe）
 * 在 Next 里天然优先于 catch-all，互不影响。
 *
 * canvas App 本体常驻在根 layout 的 SurfaceHost 里（keep-alive：路由
 * 切换只翻显隐，不拆树不重挂，上百个预览 iframe 不再反复重载——切换
 * 卡顿的治本），本 page 仅承担路由命中。
 *
 * generateStaticParams 返回单个空 slug：static export 只产出一个
 * out/index.html 壳，其余深链由 app://studio handler 的 SPA fallback
 * 兜回这个壳再交客户端 router（appProtocol.ts ③）。
 */
export function generateStaticParams() {
  return [{ slug: [] }]
}

export default function Page() {
  return null
}
