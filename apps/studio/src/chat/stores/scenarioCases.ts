import { create } from 'zustand'
import type { ScenarioCaseGallery } from '@desktop-shared/ipc-channels'

/**
 * 技能最佳实践案例的配置源。与 stores/scenarioCatalog 同一模式：
 *
 *   sub2api 管理端「客户端技能案例」页配 JSON
 *     → main 的 scenarioCasesService 在 login/冷启动时拉取、校验、落盘缓存
 *     → 本 store 经 SCENARIO_CASES_GET **读那份缓存**（不是发网络请求）
 *     → SkillCaseShowcase 按 composer 里当前技能过滤渲染
 *
 * 与场景目录的一个关键差异：**没有内置默认表**。gallery 为 null 就是"没有
 * 案例"，案例区整块不渲染——案例是运营内容，客户端不该自带一份。
 *
 * 模块加载时就 hydrate（理由同 scenarioCatalog：空态是最先看到的界面，等组件
 * 挂载再发 IPC 会先空一拍）。SSR 安全：初始 null，hydrate 只在浏览器侧发生。
 */

interface ScenarioCasesState {
  gallery: ScenarioCaseGallery | null
  setGallery: (gallery: ScenarioCaseGallery | null) => void
}

export const useScenarioCasesStore = create<ScenarioCasesState>()((set) => ({
  gallery: null,
  setGallery: (gallery) => set({ gallery })
}))

let hydrated = false

/** 读一次 main 侧缓存并订阅后续刷新。幂等。 */
export function hydrateScenarioCases(): void {
  if (hydrated) return
  const api = typeof window !== 'undefined' ? window.chatApi : undefined
  // 老 preload（升级前的窗口）没有这两个方法：静默跳过，案例区不显示即可。
  if (!api?.getScenarioCases) return
  hydrated = true

  void api
    .getScenarioCases()
    .then((res) => {
      if (res?.gallery) useScenarioCasesStore.getState().setGallery(res.gallery)
    })
    .catch((err: unknown) => {
      console.error('[scenarioCases] hydrate failed', err)
    })

  api.onScenarioCasesChanged?.((gallery) => {
    if (gallery) useScenarioCasesStore.getState().setGallery(gallery)
  })
}

hydrateScenarioCases()
