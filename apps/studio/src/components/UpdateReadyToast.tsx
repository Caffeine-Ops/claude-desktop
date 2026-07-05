'use client'

/**
 * 全局「有新版本」提示（左下角常驻卡片，2026-07-05 重设计）。
 *
 * 挂在 SurfaceHost 层（chat / canvas / 设置 overlay 之上都可见）——更新是
 * app 级事件，不属于任何一个面。数据经 window.chatApi 订阅 main 的
 * appUpdater 状态流。
 *
 * 时机（用户 2026-07-05 要求「发现新版就提示」）：不再等下载完，phase 进入
 * available/downloading 就浮现「发现新版本 + 后台下载中（迷你进度）」；下载完
 * （ready）切成「已就绪 + 立即重启更新」。同一 availableVersion 用「忽略/关闭」
 * 记忆，本会话内不再打扰（忽略后直接退出应用时 autoInstallOnAppQuit 顺手装上）。
 *
 * 本组件在 .chat-app 之外，canvas 的裸元素 reset 会命中裸 <button>——交互
 * 元素一律 shadcn Button（自带 data-slot 豁免），根层铁律同 AppRail。文案跟
 * 根层 idiom 走硬编码中文（根层无 i18n Provider，同 AppRail）。
 */

import { useEffect, useState } from 'react'
import { Check, Download, RefreshCw, X } from 'lucide-react'

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

  const phase = state?.phase
  const version = state?.availableVersion ?? null
  // 发现新版（下载中）或已就绪都弹；同版本被忽略后不再出现。
  const isFound = phase === 'available' || phase === 'downloading'
  const isReady = phase === 'ready'
  const visible =
    (isFound || isReady) && version !== null && version !== dismissedVersion
  if (!visible) return null

  const dismiss = () => setDismissedVersion(version)
  const install = () => {
    void window.chatApi?.installUpdate?.()
  }
  const percent = state?.downloadPercent ?? 0

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-[9999] flex w-[336px] items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-[0_10px_34px_rgba(20,20,22,0.16),0_2px_8px_rgba(20,20,22,0.08)] dark:shadow-[0_14px_40px_rgba(0,0,0,0.5)]"
    >
      {/* 图标：发现新版=蓝色下载图标、就绪=品牌绿勾。 */}
      <div
        className={
          isReady
            ? 'flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--brand)]/12'
            : 'flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/12'
        }
      >
        {isReady ? (
          <Check aria-hidden="true" className="size-5 text-[var(--brand)]" />
        ) : (
          <Download aria-hidden="true" className="size-5 text-primary" />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-semibold text-foreground">
          {isReady ? `${version} 已就绪` : `发现新版本 ${version}`}
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {isReady
            ? '新版本已下载完成，重启应用即可完成更新。'
            : '正在后台下载，完成后可一键重启更新。'}
        </p>

        {/* 下载中显示迷你进度条（就绪时不显示）。 */}
        {isFound ? (
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}

        <div className="flex items-center gap-1 pt-2">
          {isReady ? (
            <>
              <Button
                size="sm"
                onClick={install}
                className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:bg-[var(--brand)]/90"
              >
                <RefreshCw aria-hidden="true" />
                立即重启更新
              </Button>
              <Button size="sm" variant="ghost" onClick={dismiss}>
                稍后
              </Button>
            </>
          ) : (
            // 下载中：包还没下完不能装，只给「忽略此版本」（同版本不再打扰）。
            <Button size="sm" variant="ghost" onClick={dismiss}>
              忽略此版本
            </Button>
          )}
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
