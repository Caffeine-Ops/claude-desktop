/**
 * CanvasConfirm 的「演示驱动接口」注册表——回放 ui 轨与真实八项确认组件之间
 * 的唯一耦合点。同 imageEditDemoRegistry 的窄接口模式：组件在回放态挂载时
 * 注册一个 handle（方法体直接调组件内现有 setState 闭包），卸载时注销；
 * ReplayController 拿 handle 命令式驱动，handle 为 null 时短暂 buffering
 * 或放弃表演（聊天轨不受影响）。
 *
 * 与 imageEditDemoRegistry 的关键差异：CanvasConfirm 在回放态不 fetch
 * 真实 server（没有真实 server 在跑），而是用 manifest.meta.confirmSnapshots
 * 里的 result/recommendations/catalogs 做【离线初始化】——open(toolUseId)
 * 因此不只是「打开面板」，还要用 toolUseId 找到对应快照并把 cat/rec/stage
 * 灌进组件（等价于 live 路径里 tryBoot() 的 fetch 结果）。找不到快照（旧包
 * 没这个字段）时 open 是 no-op，ReplayController 据此判定放弃这段表演。
 */

export interface ConfirmDemoHandle {
  /** 用 toolUseId 定位快照、离线初始化 cat/rec/state/stage。快照缺失返回
   *  false（调用方据此放弃这段表演，不切「问题」tab）。 */
  open(toolUseId: string): boolean
  /** 把某个字段（枚举/文本）的当前值设为选中态（不管是卡片选中还是文本框
   *  内容）——对应 live 路径的 patch()，但绝不触发 /api/confirm。 */
  selectField(field: string, value: string): void
  /** 逐字表演一个文本字段（audience/content_divergence 等自由文本）。 */
  typeField(field: string, text: string): void
  /** tier1 → tier2 的过渡视觉（对应 live 路径 submitTier1 成功后的
   *  deriving 状态，但不 POST、不轮询——tier2 数据已经在快照里）。 */
  advanceTier2(): void
  /** 最终提交视觉（对应 live 路径 submitFinal 的 confirmed 状态，不 POST、
   *  不触发 /api/shutdown）。 */
  submitFinal(): void
}

let current: ConfirmDemoHandle | null = null
const readyListeners = new Set<() => void>()

export function registerConfirmDemoHandle(h: ConfirmDemoHandle): void {
  current = h
  for (const cb of readyListeners) cb()
}

export function unregisterConfirmDemoHandle(h?: ConfirmDemoHandle): void {
  if (h === undefined || current === h) current = null
}

export function getConfirmDemoHandle(): ConfirmDemoHandle | null {
  return current
}

export function onConfirmDemoReady(cb: () => void): () => void {
  readyListeners.add(cb)
  return () => readyListeners.delete(cb)
}
