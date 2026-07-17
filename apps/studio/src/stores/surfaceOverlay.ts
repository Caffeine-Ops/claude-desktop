/**
 * 「面开关」—— SurfaceHost 里挂在 chat/canvas 之上的**独立面**（插件市场
 * `?market=1`、知识库 `?kb=1`），机制统一收在这里。
 *
 * ## 形态：为什么是「第三/四个面」而不是全屏 overlay
 *
 * SurfaceHost 本身就渲染在 rail 右侧的 shell-stage 里（app/layout.tsx），所以
 * 一个面挂在它那一层天然就是「rail 常驻 + 右侧内容区换成它」——用户定稿的形态
 * （market 2026-07-17，kb 2026-07-17 跟齐）。对照组是**设置页**（`?settings=1`）：
 * 那个仍是 canvas App 内部 `fixed inset-0` 的全屏 overlay，逃出 stage 连 rail
 * 一起盖住，所以它必须自画一条 244px 导航 + 「返回应用」。知识库原本是设置页
 * 那一族，2026-07-17 改造成面之后，它自带的左导航收成顶栏 tabs、「返回应用」
 * 直接删除——rail 常驻，退出路径就是 rail 本身，不需要面内再放一个出口。
 *
 * ## 为什么是 query 而不是 pathname 路由
 *
 * SurfaceHost 只认 pathname 决定放映 chat 还是 canvas（`startsWith('/chat')`）。
 * 面若占 pathname（market 早期的 `/market` 路由），从聊天面点开就会把 pathname
 * 拽走 → SurfaceHost 翻到画布面 → rail tab 高亮从「智能助手」跳到「工作画布」，
 * 用户看到的是「点插件被踢去工作画布」（2026-07-17 实锤，同族事故见 2026-07-08
 * 设置页 pathname 假切换）。query 挂当前 pathname 则 pathname 全程不动：rail tab
 * 高亮、中段会话列表、data-surface 全不变，back() 剥参即回原面。
 *
 * ## 为什么两个面共用一个模块（2026-07-17 kb 跟齐时合并）
 *
 * market 单飞时踩过的两个坑，**每一个都是「必须两个面一起处理」的形状**：
 *   1. rail 的 surface tab 判「点的是不是当前面」时必须知道「有没有面盖着」
 *      ——只判 market 的话，知识库面开着时点「智能助手」会被判成 no-op，人困在
 *      面里出不去（见 AppRail 的 goSurface）；
 *   2. canvas 的 navigate() 故意保留整个 query（保 ?host=desktop / ?settings=1），
 *      面开关参数必须在那个唯一出口剥掉——只剥 market 的话，知识库面开着点
 *      「工作画布」，kb=1 跟着到目标路径，面继续盖着 = 死路。
 * 两个坑都是「漏掉一个面就复现」，所以真相源必须只有一个：加面只改 PARAM_BY_KIND
 * 一处，上面那些判定自动覆盖新面。
 *
 * 放 src/stores 的理由同 canvasNav.ts / rail.ts：AppRail（根层）、SurfaceHost
 * （根层）、FusionRuntimeProvider（chat 树的 `/plugins` 斜杠命令）、canvas/router
 * 四个跨面调用方共享，塞进任一面的私有模块会造成跨面 import。
 */

import { create } from 'zustand'

/** 面开关的种类。加面 = 往这里加一项 + 在 PARAM_BY_KIND 给它一个 query 参数名。 */
export type SurfaceOverlayKind = 'market' | 'kb'

/**
 * kind → query 参数名。**这是「哪些参数是面开关」的唯一真相源**：
 * closeSurfaceOverlay / stripSurfaceOverlayParams 都从它派生，所以新面天然
 * 被「切面剥参」「navigate 剥参」两条纪律覆盖，不用逐处补。
 *
 * ⚠️ 不含 `settings` —— 设置页是 canvas App 内部的全屏 overlay、跟着画布面走
 * （navigate 必须保住它，见 router.ts 注释），语义与这里的「盖在面之上的独立
 * 面」相反。别图省事把它并进来。
 */
const PARAM_BY_KIND: Record<SurfaceOverlayKind, string> = {
  market: 'market',
  kb: 'kb'
}

const ALL_KINDS = Object.keys(PARAM_BY_KIND) as SurfaceOverlayKind[]

/**
 * 当前放映的面 —— URL 的**镜像**，唯一写手是 SurfaceHost（它已在 Suspense
 * 内、用 useSearchParams 响应式读参）。给 rail 订阅用：「插件」「知识库」按钮
 * 的选中态、会话/项目列表的取消选中都要随它翻。
 *
 * 为什么镜像而不让 rail 自己 useSearchParams：rail 渲染在根 layout 的
 * RailShell 里、**不在任何 Suspense 边界内**，加 useSearchParams 会让
 * static export 的 prerender 直接报错（见 SurfaceHost 的 Suspense 注释）；
 * 给 RailShell 包 Suspense 又会让 rail 首屏落到 fallback、hydrate 后才出现，
 * 白闪一下。镜像 store 让 rail 零成本订阅，URL 仍是唯一真相源。
 *
 * 渲染读 store、事件处理器读 URL（currentSurfaceOverlay）——后者同步准确，
 * 前者有一帧 useEffect 延迟，但只影响高亮，无感。
 */
export const useSurfaceOverlayStore = create<{ open: SurfaceOverlayKind | null }>(
  () => ({ open: null })
)

/** 打开一个面（rail 的「插件」「知识库」按钮 + `/plugins` 斜杠命令共用）。 */
export function openSurfaceOverlay(kind: SurfaceOverlayKind): void {
  const url = new URL(window.location.href)
  // 先剥掉别的面再开这个：两个面互斥（SurfaceHost 也是这么判的），URL 上
  // 同时挂两个参数会让「back() 剥掉一个还剩一个」变成一次莫名其妙的换面。
  for (const k of ALL_KINDS) {
    if (k !== kind) url.searchParams.delete(PARAM_BY_KIND[k])
  }
  url.searchParams.set(PARAM_BY_KIND[kind], '1')
  // 用 URL API 合并 query，保住 ?host=desktop 之类 boot 参数（同 openSettings）
  window.history.pushState(null, '', url.pathname + url.search)
}

/** 当前 URL 上开着哪个面（没有则 null）。事件处理器里同步读，比 store 准。 */
export function currentSurfaceOverlay(): SurfaceOverlayKind | null {
  const params = new URLSearchParams(window.location.search)
  return ALL_KINDS.find((k) => params.get(PARAM_BY_KIND[k]) === '1') ?? null
}

/** 有面开着没有（rail 的 surface tab 判断要不要顺手关掉它）。 */
export function hasSurfaceOverlay(): boolean {
  return currentSurfaceOverlay() !== null
}

/**
 * 剥掉所有面开关参数 —— **replaceState**（不产生历史条目）：调用方紧接着多半要
 * pushState 导航到别处，这里再 push 一条只会让 back() 多按一次。
 *
 * 为什么需要显式剥而不是靠导航自然覆盖：canvas 的 navigate()
 * （src/canvas/router.ts）**故意保留整个 query string**（保住 ?host=desktop
 * 与 ?settings=1，见其注释），面开关会被一起带到目标路径上——「切到工作画布，
 * 插件市场跟着过去了」。goChatShallow 那边是 pushState('/chat') 写死路径、
 * 不带 query，天然剥掉，不需要这个。
 */
export function closeSurfaceOverlay(): void {
  if (!hasSurfaceOverlay()) return
  const url = new URL(window.location.href)
  for (const k of ALL_KINDS) url.searchParams.delete(PARAM_BY_KIND[k])
  window.history.replaceState(null, '', url.pathname + url.search)
}

/**
 * 从 query string 里剥掉所有面开关参数，保留其余（含 `?` 前缀，空则返回 ''）。
 * canvas 的 navigate() 专用——它是所有画布导航的唯一出口，理由见那边注释。
 */
export function stripSurfaceOverlayParams(search: string): string {
  const params = new URLSearchParams(search)
  let touched = false
  for (const k of ALL_KINDS) {
    if (params.has(PARAM_BY_KIND[k])) {
      params.delete(PARAM_BY_KIND[k])
      touched = true
    }
  }
  // 没命中就原样返回：navigate 的 early-return 拿它与 window.location.search
  // 做**字符串**比较，URLSearchParams 重新序列化可能改写编码（如 %20 ↔ +）
  // 让「其实没变」被判成变了。
  if (!touched) return search
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}
