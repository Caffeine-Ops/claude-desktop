/**
 * 画布 ⇄ 聊天切面的共享逻辑：切到聊天面的唯一入口（goChat）+ 跨面切换时
 * 保住「上次打开的工作画布视图」的一格记忆。
 *
 * 背景（2026-07-14，删多标签工作区顶栏的连带修复）：
 * chat 与 canvas 两面共用原生 History（pushState）切换。切到聊天面时用
 * pushState('/chat') 覆盖了 canvas 的当前 URL（如 '/project/xxx'），canvas
 * 之前的路径就丢在 history 里。多标签工作区顶栏还在时，用户能从 tab 栏点
 * 回刚才的项目；栏一删（顶栏统一），「切回上次画布视图」的能力就必须由这里
 * 接管：**所有「从画布切到聊天」的入口，覆盖 URL 前先调 rememberCanvasPath()
 * 记住画布 pathname**；切回画布时 AppRail 的 tab 用 parseRoute(getLastCanvasPath())
 * 还原，而非硬编码回首页。
 *
 * goChat 本身（2026-07-31 合并）：此前 AppRail 的 goChatShallow 与
 * RailSessionList 的本地 goChat 是两份独立实现，逐字对比后确认它们**始终
 * 是等价的**（唯一差异是要不要在已在聊天面时也调 rememberCanvasPath()——
 * 它自带 `!pathname.startsWith('/chat')` 守卫，调不调结果一样），两处并
 * 且没有理由不共享，遂收成一处，避免以后改动漂移出不一致。
 *
 * 放 src/stores（而非 chat/canvas 任一侧）的理由同 rail.ts：这是 AppRail 与
 * RailSessionList 两个根层组件共享的外壳态，塞进任一面的私有模块会造成跨面/
 * 循环 import（RailSessionList 由 AppRail 渲染）。模块级变量即可，无需 zustand
 * ——它不驱动渲染，只是切面时读写一次的一格记忆。
 */

import { hasSurfaceOverlay } from './surfaceOverlay'

let lastCanvasPath: string | null = null

/**
 * 覆盖 URL 切到聊天面前调用：记住当前画布 pathname（不含 query）。
 * 刻意只存 pathname：?market=1/?kb=1 是面开关态，切走时开着、切回不该还原
 * （canvas 的 parseRoute 也只吃 pathname）。设置页 2026-07-31 起是纯 store
 * 开关，压根不挂 URL，不在这个考虑范围内。已在 '/chat*' 则不记（那是聊天
 * 面路径，不是画布视图）。
 */
export function rememberCanvasPath(): void {
  const current = window.location.pathname
  if (!current.startsWith('/chat')) {
    lastCanvasPath = current
  }
}

/** 切回工作画布时读取：上次画布 pathname，从未离开过画布则为 null（回首页兜底）。 */
export function getLastCanvasPath(): string | null {
  return lastCanvasPath
}

/**
 * 切到聊天面的唯一入口——AppRail 的画布/聊天 tab 与 RailSessionList 的
 * 会话行点击共用。shallow pushState 而非 router.push：两面常驻
 * SurfaceHost、page 是空壳，Next 无需做任何导航工作。
 *
 * 已在聊天面**且**没有面（插件市场/知识库）盖着时才是真 no-op——面开关
 * 挂在当前 pathname 上，开在聊天面时 pathname 仍是 '/chat'，只判 pathname
 * 会让参数剥不掉、面继续盖着，用户点「没反应」（2026-07-17 实锤）。
 * pushState('/chat') 写死路径不带 query，天然剥掉所有面开关，不需要额外
 * closeSurfaceOverlay()。
 */
export function goChat(): void {
  if (window.location.pathname.startsWith('/chat') && !hasSurfaceOverlay()) return
  rememberCanvasPath()
  window.history.pushState(null, '', '/chat')
}
