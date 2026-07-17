import { create } from 'zustand'
import { initialComponentState, type ComponentState, type ComponentTable } from '@desktop-shared/componentDownload'

// 通用「组件状态表」前端镜像。main 的 componentOrchestrator.ts 是唯一写手，经 COMPONENT_STATUS_GET
// 快照 + COMPONENT_STATUS 广播同步到这里；四个消费方（ComponentsSection / ComponentPrompt /
// KbToolbar / KbToolingCard）都从这一个 store 派生渲染，不各自维护本地态。
//
// 为什么消费方必须订阅整表 `(s) => s.table`，不能改成别的切法（订阅写法铁律）：
//   - `(s) => s.stateOf`——函数引用永远不变（zustand 用 Object.is 比较选择器返回值），选它等于
//     没订阅任何会变的东西：广播推来新进度时组件不会重渲染，进度条卡死不动。
//   - `(s) => s.stateOf(id)`——stateOf 对表里没有的 id 现建一个 initialComponentState 对象兜底，
//     每次调用都是新引用，Object.is 恒 false，导致表里任何一格的更新（哪怕是别的组件）都触发
//     本组件重渲染。
//   订阅 table 本身、在消费方（或调用处）里用 `table[id] ?? initialComponentState(id)` 派生单个
//   组件的状态，是唯一两头都对的写法：table 引用只在真正变化时更新，拿到的又是最新值。
//
// 为什么需要 `loaded`：
//   `table` 初始是 `{}`，而所有消费方一律用 `table[id] ?? initialComponentState(id)`（＝'idle'）
//   兜底缺失的 id——这让「数据还没到（componentStatusGet() 还没 resolve）」和「探测结论：真的
//   没装」在 UI 上渲染成完全相同的一态。真实故障：冷启动后立刻点「同步」，此时 table 还是空表，
//   markitdown 兜底成 idle（≠ready）触发 KbToolbar 的功能门，同步被静默拦掉——即便用户机器上
//   markitdown 装得好好的。`loaded` 就是那层区分：初始 false，componentStatusGet() 的首个快照
//   落地（或任意一次广播先到达）后置 true。消费方里「依据『没装』这个结论去拦用户操作或亮警告」
//   的地方必须额外加 `loaded &&` 一道；只是渲染 ready 态本身（不否定任何结论）不需要。
interface ComponentsState {
  table: ComponentTable
  /** 首个快照/广播是否已落地——见上方「为什么需要 loaded」。未加载前所有单件派生态都不可信。 */
  loaded: boolean
  init: () => () => void
  stateOf: (id: string) => ComponentState
}

// 首个快照只拉一次：多个消费方各自 init() 时会撞上同一个 module-level in-flight promise 而不是
// 各发一次 COMPONENT_STATUS_GET——该 handler 在 main 侧每次都要跑 refreshComponentInstalled()
// （detectTooling() 最坏约 8s 同步阻塞整个主进程，见 componentOrchestrator.ts 头注释），冷开一个
// 挂了全部四个消费方的页面本会背靠背发 2~3 次完整探测。订阅（onComponentStatus）不受影响，依旧
// 每个消费方各自注册/退订——那部分是对的，去重只管快照这一发。resolve 后清空 in-flight，保证下一
// 次真正需要刷新（例如很久之后重新挂载）时还能再发一次，不会被永久钉死成「只发一次」。
let snapshotInFlight: Promise<ComponentTable> | null = null
function fetchSnapshotOnce(): Promise<ComponentTable> {
  if (!snapshotInFlight) {
    snapshotInFlight = window.chatApi.componentStatusGet().finally(() => {
      snapshotInFlight = null
    })
  }
  return snapshotInFlight
}

export const useComponentStore = create<ComponentsState>((set, get) => ({
  table: {},
  loaded: false,
  init: () => {
    // .catch 必须有（复审 Minor）：componentStatusGet() 走 IPC，handler 内部若抛错（reject）,
    // 光 .then 不接 catch 就是「这个 promise 永远不会把 loaded 推成 true」+ 一条 unhandled
    // rejection。本轮新加的 loaded 守卫把后果从「三行误显示成可下载」放大成「组件中心永久卡
    // 在『正在检测组件状态…』、KbToolbar 的缺模型引导和 KbToolingCard 永久不出现」——从「误导」
    // 升级成「功能不可达」。这里选择 fail-open（吞掉错误、直接把 loaded 置 true，表维持上次的
    // 值/空表），与 `loaded` 守卫本身「宁可放行也不误拦」的取向一致：派生态会退回 idle，功能门
    // 顶多再提示一次装组件，好过永久卡死。发生概率很低（detectTooling 内部把每个探针都
    // try/catch 吞了，见 componentOrchestrator.ts），但一旦发生代价被放大了，所以值得兜底。
    void fetchSnapshotOnce()
      .then((t) => set({ table: t, loaded: true }))
      .catch(() => set({ loaded: true }))
    const off = window.chatApi.onComponentStatus((t) => set({ table: t, loaded: true }))
    return off
  },
  stateOf: (id) => get().table[id] ?? initialComponentState(id),
}))
