import { create } from 'zustand'
import type { RuntimeComponentsState } from '@desktop-shared/runtimeComponents'

/**
 * 运行时组件（AI 引擎 / Python 环境）的安装状态，renderer 侧镜像。
 *
 * 这两个大件不再随安装包发布，首次启动时按需下载。**AI 引擎是必需品**——缺了
 * 整个应用不能聊天，所以门是不可关闭的（与 ppt-creator 那套「只挡 PPT 入口、
 * 可后台继续」刻意不同）。
 *
 * 状态的唯一真相在 main（只有它知道磁盘上装没装、engine 能不能起来），这里只是
 * 镜像：挂载时拉一次 + 订阅推送，不自己推导任何状态。
 *
 * `state: null` = 还没问过 main。**null 时不渲染门**：绝大多数用户早已就绪，
 * 闪一下门比晚一帧渲染界面糟得多。准确性靠 main 侧——它第一次被问起时会同步
 * 照一眼磁盘，所以第一次 resolve 就是准确结论，而那几毫秒里 splash 还压在上面。
 */

interface RuntimeComponentsStore {
  state: RuntimeComponentsState | null
  setState: (s: RuntimeComponentsState) => void
  /** 用户点了「使用系统 Claude 继续」后放行，本次会话内不再挡。 */
  bypassed: boolean
  bypass: () => void
}

export const useRuntimeComponentsStore = create<RuntimeComponentsStore>()((set) => ({
  state: null,
  setState: (state) => set({ state }),
  bypassed: false,
  bypass: () => set({ bypassed: true })
}))

let hydrated = false

/** 拉一次当前状态并订阅推送。模块加载时自动跑，幂等。 */
export function hydrateRuntimeComponents(): void {
  if (hydrated) return
  const api = typeof window !== 'undefined' ? window.chatApi : undefined
  if (!api?.getRuntimeComponentsState) return
  hydrated = true

  void api
    .getRuntimeComponentsState()
    .then((s) => {
      if (s) useRuntimeComponentsStore.getState().setState(s)
    })
    .catch(() => {
      // 拿不到状态就保持 null（不挡门）。真要缺组件，用户发第一条消息时
      // main 侧的 CHAT_SEND 守卫会触发 ensure，门那时会立起来。
    })

  api.onRuntimeComponentsState?.((s) => {
    if (s) useRuntimeComponentsStore.getState().setState(s)
  })
}

hydrateRuntimeComponents()

/** 门该不该挡：拿到过状态、必需组件没就绪、且用户没选择绕过。 */
export function shouldBlockOnComponents(
  state: RuntimeComponentsState | null,
  bypassed: boolean
): boolean {
  if (!state || bypassed) return false
  return !state.requiredReady
}
