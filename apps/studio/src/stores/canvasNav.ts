/**
 * 画布视图记忆 —— 跨面切换时保住「上次打开的工作画布视图」。
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
 * 放 src/stores（而非 chat/canvas 任一侧）的理由同 rail.ts：这是 AppRail 与
 * RailSessionList 两个根层组件共享的外壳态，塞进任一面的私有模块会造成跨面/
 * 循环 import（RailSessionList 由 AppRail 渲染）。模块级变量即可，无需 zustand
 * ——它不驱动渲染，只是切面时读写一次的一格记忆。
 */

let lastCanvasPath: string | null = null

/**
 * 覆盖 URL 切到聊天面前调用：记住当前画布 pathname（不含 query）。
 * 刻意只存 pathname：?settings=1/?kb=1 是 overlay 开关态，切走时开着、切回
 * 不该还原（canvas 的 parseRoute 也只吃 pathname）。已在 '/chat*' 则不记
 * （那是聊天面路径，不是画布视图）。
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
