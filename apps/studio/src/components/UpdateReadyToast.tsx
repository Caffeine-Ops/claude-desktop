'use client'

/**
 * 全局「新版本已就绪」提示（左下角常驻卡片）。
 *
 * 挂在 SurfaceHost 层（chat / canvas / 设置 overlay 之上都可见）——更新
 * 就绪是 app 级事件，不属于任何一个面。数据经 window.chatApi 订阅 main
 * 的 appUpdater 状态流，phase 进入 'ready' 时浮现；「稍后」按 available
 * 版本号记忆关闭（同一版本本会话内不再打扰；忽略后直接退出应用时
 * autoInstallOnAppQuit 也会顺手装上）。
 *
 * 本组件在 .chat-app 之外，canvas 的裸元素 reset 会命中裸 <button>——
 * 交互元素一律 shadcn Button（自带 data-slot 豁免），根层铁律同 AppRail。
 * 文案跟根层 idiom 走硬编码中文（根层无 i18n Provider，同 AppRail）。
 */

import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'

import { Button } from '@/src/components/ui/button'
import type { UpdaterState } from '@desktop-shared/ipc-channels'

export function UpdateReadyToast() {
  const [state, setState] = useState<UpdaterState | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  useEffect(() => {
    const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined
    if (!chatApi?.getUpdaterState) return
    let alive = true
    void chatApi.getUpdaterState().then((s) => {
      if (alive) setState(s)
    })
    const unsubscribe = chatApi.onUpdaterStateChanged((s) => {
      if (alive) setState(s)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const version = state?.availableVersion ?? null
  const visible = state?.phase === 'ready' && version !== null && version !== dismissedVersion
  if (!visible) return null

  const dismiss = () => setDismissedVersion(version)
  const install = () => {
    void window.chatApi?.installUpdate?.()
  }

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-[9999] flex w-80 items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-lg"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--brand)]/12">
        <RefreshCw aria-hidden="true" className="size-5 text-[var(--brand)]" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-semibold text-foreground">v{version} 可更新！</div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          新版本已准备就绪，你可以现在更新或稍后再更新。
        </p>
        <div className="flex items-center gap-1 pt-1.5">
          <Button size="sm" onClick={install}>
            更新
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            稍后
          </Button>
        </div>
      </div>
      <Button
        size="icon"
        variant="ghost"
        aria-label="关闭"
        onClick={dismiss}
        className="-mr-1.5 -mt-1.5 size-7 shrink-0 text-muted-foreground"
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
    </div>
  )
}
