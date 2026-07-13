/**
 * ImageEditPanel 的「演示驱动接口」注册表——回放 ui 轨与真实面板组件之间
 * 的唯一耦合点。
 *
 * 为什么是窄接口而不是状态提升：面板的标记/草稿/额外编辑全是组件局部
 * useState（903 行组件，见 ImageEditPanel.tsx），把 8 个 state 抽进 zustand
 * 只为回放表演不值得。面板挂载且原图 dataUrl 就绪后注册一个 handle
 * （方法体直接调组件内现有 setState 闭包），卸载/换图注销；回放
 * ReplayController 拿 handle 命令式驱动。handle 为 null = 面板未就绪，
 * controller 侧短暂 buffering 或放弃表演（聊天轨不受影响）。
 *
 * 注意 pressSend 的契约：只做视觉（按压态 + 延迟关面板），绝不经过组件的
 * send()/dispatchChatTurn——回放里的「发送结果」由 chat 轨的 user_message
 * item 提供。
 */

export interface ImageEditDemoHandle {
  /** 在 (x,y) 落一个标记（带 w/h = 框选）并弹出输入条。坐标是图内百分比。 */
  addMarker(x: number, y: number, w?: number, h?: number): void
  /** 设输入条草稿全文（逐字表演 = 连续调用递增前缀）。 */
  setDraftText(text: string): void
  /** 提交草稿（写回 marker.note、收起输入条）。 */
  commitDraft(): void
  /** 设底栏「额外编辑」输入框全文。 */
  setExtraText(text: string): void
  /** 发送按钮按压视觉 + 延迟 closeEditor。纯视觉，不发任何消息。 */
  pressSend(): void
}

let current: ImageEditDemoHandle | null = null
const readyListeners = new Set<() => void>()

export function registerImageEditDemoHandle(h: ImageEditDemoHandle): void {
  current = h
  for (const cb of readyListeners) cb()
}

export function unregisterImageEditDemoHandle(h?: ImageEditDemoHandle): void {
  // 带参形式防注销竞态：换图时新 effect 的注册可能先于旧 effect 的清理跑，
  // 无条件置 null 会把刚注册的新 handle 一起拔掉。
  if (h === undefined || current === h) current = null
}

export function getImageEditDemoHandle(): ImageEditDemoHandle | null {
  return current
}

/** handle 注册时回调（回放 buffering 等就绪用）。返回取消订阅函数。 */
export function onImageEditDemoReady(cb: () => void): () => void {
  readyListeners.add(cb)
  return () => readyListeners.delete(cb)
}
