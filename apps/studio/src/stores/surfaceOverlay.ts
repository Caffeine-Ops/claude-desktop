/**
 * 「面开关」—— SurfaceHost 里挂在 chat/canvas 之上的**独立面**（插件市场
 * `?market=1`、知识库 `?kb=1`），机制统一收在这里。**设置页 overlay 状态
 * 也放这个文件**（见下方 `useSettingsOverlayStore`），但它 2026-07-31 起
 * 已经不是「面开关」的一种——它是纯内存开关，不挂 query，理由见其头注释。
 *
 * ## 形态：为什么是「第三/四个面」而不是全屏 overlay
 *
 * SurfaceHost 本身就渲染在 rail 右侧的 shell-stage 里（app/layout.tsx），所以
 * 一个面挂在它那一层天然就是「rail 常驻 + 右侧内容区换成它」——用户定稿的形态
 * （market 2026-07-17，kb 2026-07-17 跟齐）。对照组是**设置页**：那仍是
 * canvas App 内部 `fixed inset-0` 的全屏 overlay，逃出 stage 连 rail 一起
 * 盖住，所以它必须自画一条 244px 导航 + 「返回应用」。知识库原本是设置页
 * 那一族，2026-07-17 改造成面之后，它自带的左导航收成顶栏 tabs、「返回应用」
 * 直接删除——rail 常驻，退出路径就是 rail 本身，不需要面内再放一个出口。
 * 设置页 2026-07-31 没有跟着改造成面（原因见 `useSettingsOverlayStore` 头
 * 注释），但把「关闭」的语义从「URL 回退」改成了同款「纯状态开关」。
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
 *   2. canvas 的 navigate() 故意保留整个 query（保 ?host=desktop），面开关
 *      参数必须在那个唯一出口剥掉——只剥 market 的话，知识库面开着点
 *      「工作画布」，kb=1 跟着到目标路径，面继续盖着 = 死路。
 * 两个坑都是「漏掉一个面就复现」，所以真相源必须只有一个：加面只改 PARAM_BY_KIND
 * 一处，上面那些判定自动覆盖新面。
 *
 * 放 src/stores 的理由同 canvasNav.ts / rail.ts：AppRail（根层）、SurfaceHost
 * （根层）、FusionRuntimeProvider（chat 树的 `/plugins` 斜杠命令）、canvas/router、
 * chat/App.tsx（菜单栏「设置」IPC，2026-07-31 起统一落这里）五个跨面调用方
 * 共享，塞进任一面的私有模块会造成跨面 import。
 */

import { create } from 'zustand'

/** 面开关的种类。加面 = 往这里加一项 + 在 PARAM_BY_KIND 给它一个 query 参数名。 */
export type SurfaceOverlayKind = 'market' | 'kb'

/**
 * kind → query 参数名。**这是「哪些参数是面开关」的唯一真相源**：
 * closeSurfaceOverlay / stripSurfaceOverlayParams 都从它派生，所以新面天然
 * 被「切面剥参」「navigate 剥参」两条纪律覆盖，不用逐处补。
 *
 * ⚠️ 不含 `settings` —— 设置页 2026-07-31 起已经不挂 query 了（见下方
 * `useSettingsOverlayStore`），跟这里的「盖在面之上的独立面」完全是两套
 * 机制，不存在「该不该并进来」的问题。
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

/**
 * 设置页开着没有 —— **2026-07-31 起是真相源，不再是 URL 镜像**。
 *
 * ## 三套设置入口现状地图（重构前先看这个，别猜）
 *
 * 应用里有三条互不相通的「打开设置」路径，本 store 只管第一条：
 *   1. **本 store**（rail 齿轮 `AppRail.openSettings` / 菜单栏「设置」IPC /
 *      Cmd+,）→ canvas App 的全屏 overlay（`SettingsDialogV2`）。
 *   2. canvas App 内部的 `settingsOpen` state（`MemoryToast`「打开记忆」等
 *      需要带 section 定位的入口）→ 同一个 `SettingsDialogV2` 组件，但走
 *      内嵌 dialog 分支，不经本 store，本次重构未动它。
 *   3. chat 树遗留的 `chat/stores/settings.ts`（`SettingsView` 组件）——
 *      2026-07-31 起菜单栏「设置」已改接第 1 条，这条只剩
 *      `ProposalPaper.tsx` 一个「去设置」直达入口，标记待退役。
 *
 * ## 为什么从「URL 镜像」改成「纯内存真相源」（2026-07-31）
 *
 * 旧机制：`?settings=1` 挂在当前 pathname 上，SurfaceHost 读 `useSearchParams`
 * 得出 `settingsOverlay`、镜像进本 store 供 RailShell 订阅；关闭 =
 * `history.back()`。这套机制有一个结构性漏洞：canvas 是 keep-alive 常驻的
 * （SurfaceHost 用 `content-visibility` 隐藏而非卸载），隐藏树里的程序化
 * `navigate()`（比如项目被删后的兜底跳转）照样会往 history 栈里塞条目——
 * 「返回应用」的落点因此**依赖一个用户看不见、随时可能被悄悄改写的历史栈
 * 形状**。真实症状：自动化页点「打开对话」后返回按钮彻底失效（防重入锁被
 * 永久闩死）；智能助手⇄工作画布来回切换后开设置，「返回应用」落到了错的面。
 * 每多一个「从设置页跳出去」的 handler 忘记剥 `?settings=1`，就再复现一次
 * ——已经出过三次。
 *
 * 新机制：改仿照 `stores/upgrade.ts`（本项目里「overlay 用内存 store 而非
 * URL query」的既有先例，其头注释原话：「query 驱动还要处理导航保留 query
 * 关不掉的剥参问题，store 一个布尔最稳」）。关闭 = `setState({open:false})`，
 * 一次 React commit 内完成，**不依赖、也不可能被任何历史栈状态干扰**——
 * 上面两个真实症状按构造不可能再发生，不需要防重入锁、不需要超时兜底。
 *
 * 代价（用户已确认可接受）：开着设置页时 reload/重启应用，会回到底下的
 * 页面而不是停在设置页——这本来就是 `AppearanceBridge.tsx` 头注释点名的
 * 一个隐患复发入口（chat 面从未挂载导致主题同步监听器缺席），关掉它是
 * 额外收益，不只是妥协。
 *
 * 浏览器 back/前进：Electron 壳内没有任何用户可达的触发器（已核实无
 * swipe/app-command/菜单 back 接线），设置不进历史因此无感。`bun dev:next`
 * 用真浏览器开发时，浏览器自带的 back 按钮/手势会在设置页底下静默切走
 * pathname（store 不受影响，UI 仍显示设置页）——这是 dev-only 的已知限制，
 * 不要用浏览器 back 驱动设置相关的 CDP 回归脚本。
 *
 * 为什么单独一个 store 而不是并进 useSurfaceOverlayStore：设置页不是面开关
 * （理由见 PARAM_BY_KIND 注释），把它塞进 `open` 那个联合类型会让「当前放映
 * 哪个面」凭空多出一个不是面的取值，rail 里所有 `open === 'market'` 式的判定
 * 都得跟着改。两个 store 并列、各自语义干净。
 *
 * 为什么需要它：RailShell 的常驻按钮组是 portal 到 body 末尾的 fixed 元素
 * （z-[140]），而设置页是 canvas 树内部的全屏 overlay、层级压不过它——设置页
 * 揭开时那组按钮会浮在设置页导航栏上（2026-07-30 用户反馈）。它们指向的东西
 * （rail 折叠态、会话搜索、新建会话）此刻全被设置页盖着，显示出来纯属干扰，
 * 故整组按 settings 隐藏。判定不能在 RailShell 里自己 useSearchParams——它不
 * 在 Suspense 内，理由同上一个 store。
 */
export const useSettingsOverlayStore = create<{ open: boolean }>(() => ({ open: false }))

/**
 * 打开设置页。**先关掉市场/知识库面**（`closeSurfaceOverlay`）再开：市场/
 * 知识库面开着时点设置，若不剥掉，设置页会被那个面盖住、RailShell 的常驻
 * 按钮组又已经因 settingsShowing 隐藏——用户看到的是「按钮消失了、设置没
 * 出来」（旧 URL 机制下的既有缺口，两个 store 从未真正互斥过，这次一并
 * 收口）。
 */
export function openSettingsOverlay(): void {
  closeSurfaceOverlay()
  useSettingsOverlayStore.setState({ open: true })
}

/** 关闭设置页。幂等——连点/连按 Esc 无需防重入。 */
export function closeSettingsOverlay(): void {
  useSettingsOverlayStore.setState({ open: false })
}

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
 * （src/canvas/router.ts）**故意保留整个 query string**（保住 ?host=desktop，
 * 见其注释），面开关会被一起带到目标路径上——「切到工作画布，插件市场跟着
 * 过去了」。goChatShallow 那边是 pushState('/chat') 写死路径、不带 query，
 * 天然剥掉，不需要这个。
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
