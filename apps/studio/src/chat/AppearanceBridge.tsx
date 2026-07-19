'use client'

import { useEffect } from 'react'

import { hydrateAppearanceFromDaemon, useAppearanceStore } from './stores/appearance'
import { useApplyAppearance } from './stores/appearance.applier'
import { useApplyBackgroundArt } from './stores/backgroundArt.applier'

/**
 * 外观的**常驻**写手 + 同步桥。不渲染任何 DOM，只承载副作用。
 *
 * 为什么单独成一个组件、且必须挂在 SurfaceHost 而不是 chat/App.tsx
 * ----------------------------------------------------------------
 * 这两件事原本住在 chat/App.tsx（applier 的头注释还写着「Mounted once at
 * the App root」——那个前提早就不成立了）。但 chat 面**不是**常驻的：
 * SurfaceHost 的 `chatShowing = isChat && !settingsOverlay && !kbOverlay`,
 * 设置页/知识库页一开，chat 面整棵不渲染。于是两条链同时断掉：
 *
 *   1. `od:theme-mode-applied` 监听器随组件卸载 → canvas 写手在设置页里切
 *      主题时同帧广播的 themeMode **没人接** → chat store 停在旧档。
 *   2. applier 跟着走 → documentElement.style 上那批 inline token
 *      （--background/--card/--foreground…）冻在旧主题的值。
 *
 * 后果正是 2026-07-04 即时广播通道要根治的那个「切主题一点点变」：chat 面
 * 的主体颜色要等「daemon 写入 → od:appearance-changed → 再 GET」两次网络
 * 往返才跟上，而 .dark 类已经翻了——两批元素分家，看起来就是慢半拍/花斑。
 *
 * 实际上生产路径侥幸没踩到：SurfaceHost 有 keep-alive（visitedRef，面首次
 * 可见后永久保活），而冷启动必定先落 /chat（不带 query）把 chat 面挂上，
 * 监听器此后一直在岗。也就是说**这两条链的存活是「碰巧」依赖了别处的
 * keep-alive 策略**——改动 keep-alive、或新增一个「chat 面从未可见」的入口
 * （启动直达设置页、reload 时 ?settings=1 停在设置页，后者实测可复现）就会
 * 让它复发，且症状隐蔽（只有 chat 面颜色停在旧主题）。
 *
 * 挂到 SurfaceHost（由根 layout 渲染、跨路由保活）后，存活不再依赖任何面的
 * 可见性策略：与 UpdateReadyToast 并列在两个面的包装 div 之外，谁被
 * content-visibility 冻结都与它无关。
 *
 * 仍受 SurfaceHost `if (isProbe) return null` 管辖 —— /chat-probe 探针页两面
 * 都不渲染，本桥也不该跑，与迁移前的行为一致。
 */
export function AppearanceBridge(): null {
  useApplyAppearance()
  // Background-art (wallpaper) writer — same keep-alive-immune mount point
  // as the appearance applier above, same reason (see file header).
  useApplyBackgroundArt()

  // Adopt the daemon's shared appearance as the source of truth — once on
  // mount, then again every time main says it changed (APPEARANCE_CHANGED,
  // fired after ANY window edits appearance). The applier above has already
  // rendered the localStorage cache (no flash); the mount hydrate overwrites
  // it with the daemon copy when reachable, and the subscription keeps this
  // renderer in lockstep with a theme switch made in the settings overlay or
  // another tab — without it the change only landed here on a reload. No-op
  // when the daemon is offline (cache stays). main skips the window that made
  // the change, and hydrate's own isHydrating guard prevents an echo back.
  //
  // 另外必须监听同 document 的 'od:appearance-changed' window 事件：studio
  // 单视图形态下 canvas 面与 chat 面共存同一 webContents，canvas 入口切主题
  // 直连 daemon（PUT /api/app-config），main 毫不知情或按 skip-sender 跳过
  // 本 webContents——IPC 广播对「同屋对面」永远到不了。少了这条监听，chat
  // store 停在旧档、applier 留在 documentElement.style 的 inline token 会把
  // chat 面钉在旧配色（2026-07-04 暗色花斑事故）。事件由 canvas 的
  // syncConfigToDaemon 成功后 dispatch（src/canvas/state/config.ts）。
  useEffect(() => {
    void hydrateAppearanceFromDaemon()
    const onSameDocChange = () => {
      void hydrateAppearanceFromDaemon()
    }
    // 即时通道：canvas 写手每次落双标记都会同帧广播 themeMode（见
    // canvas/state/appearance.ts 的 dispatch 注释）。直接改本地 store——
    // applier（deps 含 themeMode）同帧重写 inline token，主题切换一拍完成，
    // 不必等下面那条「daemon 写入成功 → od:appearance-changed → 再 GET」的
    // 持久化校准链（慢两次网络往返，是 2026-07-04「切主题一点点变」分拍
    // 的根源）。「值相同不 set」断回声环：本桥 applier 触发的 canvas
    // 重 apply 会再次广播同值，此处直接忽略。
    const onThemeModeApplied = (e: Event) => {
      const mode = (e as CustomEvent<{ themeMode?: 'light' | 'dark' | 'system' }>).detail?.themeMode
      if (!mode) return
      const store = useAppearanceStore.getState()
      if (store.themeMode !== mode) store.setThemeMode(mode)
    }
    window.addEventListener('od:theme-mode-applied', onThemeModeApplied)
    window.addEventListener('od:appearance-changed', onSameDocChange)
    const offIpc = window.chatApi?.onAppearanceChanged?.(() => {
      void hydrateAppearanceFromDaemon()
    })
    return () => {
      window.removeEventListener('od:theme-mode-applied', onThemeModeApplied)
      window.removeEventListener('od:appearance-changed', onSameDocChange)
      offIpc?.()
    }
  }, [])

  return null
}
