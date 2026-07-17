'use client'

/**
 * 全局「有新版本」提示（左下角常驻卡片，2026-07-05 重设计），并兼任账户菜单
 * 「检查更新」的结论反馈（2026-07-16）。视觉为 V1「精修基线」
 * （docs/ui-prototype-update-toast.html，2026-07-16 用户定稿：小卡带常驻
 * 关闭钮；下载中主卡去掉「忽略此版本」按钮行，收起语义并进关闭 X）。
 *
 * 挂在 SurfaceHost 层（chat / canvas / 设置 overlay 之上都可见）——更新是
 * app 级事件，不属于任何一个面。数据经 window.chatApi 订阅 main 的
 * appUpdater 状态流。
 *
 * 时机（用户 2026-07-05 要求「发现新版就提示」）：不再等下载完，phase 进入
 * available/downloading 就浮现「发现新版本 + 后台下载中（进度）」；下载完
 * （ready）切成「已就绪 + 立即重启更新」。
 *
 * 「关掉了」的记忆分两份、按卡片各查各的（2026-07-17 修，别再合并回去）：
 * 进度卡的 X 只收起本次下载的进度显示，ready 时提示必须重弹；就绪卡的 X /
 * 「稍后」才是「忽略此版本」，本会话内不再打扰（之后直接退出应用时
 * autoInstallOnAppQuit 顺手装上）。合成单份的后果是下载中点一次 X 就把终点
 * 的「立即重启更新」永久吞掉——用户实锤过。
 *
 * 手动「检查更新」反馈（2026-07-16，用户实锤「点了像没功能」）：main 的
 * checkForUpdates 是静默触发（结论只进状态流），菜单栏那条 interactive 链路
 * 用的是原生对话框，账户菜单则一直没有任何结论反馈。现在 AppRail 只 dispatch
 * 一个同 document 事件桥 'od:manual-update-check'（机制同 od:cli-backend-changed），
 * 本组件统一接手：invoke 快照判定 → 等广播结论 → 左下角同位 transient 小卡。
 * 关键约束：**结论 toast 只对「刚发起的手动检查」弹**（manualPendingRef 门），
 * 后台自动检查（启动 15s + 每 3h）的 none/error 广播绝不打扰用户；发现新版
 * 时不弹小卡——主卡片本身就是结论反馈，只需解除同版本忽略让它必现。
 *
 * 自动收起 = JS 定时器驱动（reduced-motion 下动画关停也可靠收起），底部
 * 进度线是同时长的纯视觉动画；hover 暂停必须两边一起动——CSS 线经 .group
 * 暂停，JS 在 mouseEnter 清定时器、mouseLeave 重给完整时长并 lifeKey++ 让
 * 线 remount 从头播（悬停查看后重新计满，两边始终一致）。
 *
 * 本组件在 .chat-app 之外，canvas 的裸元素 reset 会命中裸 <button>——交互
 * 元素一律 shadcn Button（自带 data-slot 豁免），根层铁律同 AppRail。文案跟
 * 根层 idiom 走硬编码中文（根层无 i18n Provider，同 AppRail）。动画类
 * （od-toast-* / od-check-draw）定义在 globals.css。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, Info, RefreshCw, X } from 'lucide-react'

import { Button } from '@/src/components/ui/button'
import { cn } from '@/src/lib/utils'
import type { UpdaterState } from '@desktop-shared/ipc-channels'

/** 手动「检查更新」的过程/结论反馈（transient 小卡，与主卡片同浮层位）。 */
type ManualFeedback =
  | { kind: 'checking' }
  | { kind: 'none'; version: string }
  | { kind: 'error'; message: string | null }
  | { kind: 'unsupported' }

const FEEDBACK_DISMISS_MS = 4000
/** 失败信息要读一下，比「已是最新」多留一会儿。 */
const FEEDBACK_ERROR_DISMISS_MS = 8000
/** checking 的保险丝：electron-updater 正常必有结论广播（error 事件兜底），
 * 这只防「广播丢失致 spinner 永驻」，超时静默收起并解除 pending。 */
const CHECKING_TIMEOUT_MS = 25000
/** 退场动画时长（od-toast-leave），播完才真清 state。 */
const LEAVE_MS = 220

/** 三层投影（原型 --toast-shadow）：ambient 大扩散 + key 近投影 + 1px 边缘
 * 定形环（替代 border，避免和投影叠出双线）。暗档换深值。 */
const TOAST_SHADOW =
  'shadow-[0_12px_36px_rgba(18,18,23,0.13),0_3px_10px_rgba(18,18,23,0.07),0_0_0_1px_hsl(var(--border)/0.9)] dark:shadow-[0_16px_44px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.35),0_0_0_1px_hsl(var(--border))]'

/** checking 态的圆环 spinner：淡整环 + 1/4 实弧（比 lucide Loader2 的
 * 断点环更细腻，原型定稿形态）。 */
function SpinnerRing() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      className="size-3.5 animate-spin"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" opacity={0.18} />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  )
}

export function UpdateReadyToast() {
  const [state, setState] = useState<UpdaterState | null>(null)
  // 「关掉了」的记忆按卡片分家成两份（2026-07-17）。此前是单份 dismissedVersion
  // 被两张卡片共用，而 X 在两张卡上都在：用户在下载中点 X 收起进度条 → 记忆被
  // 写成当前版本 → 下载完 phase 进 ready 时被同一个判据挡掉，「立即重启更新」
  // 永远不出现（用户实锤）。两个动作的语义本就不同，不能共用一份记忆：
  //  - 进度卡的 X =「知道在下了，别挡着」，只对本次下载有效，ready 必须重弹；
  //  - 就绪卡的 X /「稍后」=「这个版本先不装」，本会话不再打扰（用户之后直接
  //    退出应用时 autoInstallOnAppQuit 会顺手装上，不会丢更新）。
  const [dismissedProgressVersion, setDismissedProgressVersion] = useState<string | null>(null)
  const [dismissedReadyVersion, setDismissedReadyVersion] = useState<string | null>(null)
  // 小卡状态：内容 + 自动收起时长（null = 不自动收起，checking 用）。
  const [manualFeedback, setManualFeedback] = useState<{
    fb: ManualFeedback
    duration: number | null
  } | null>(null)
  // 退场中标记：置 true 播 od-toast-leave，LEAVE_MS 后真清。
  const [feedbackLeaving, setFeedbackLeaving] = useState(false)
  // 进度线的 remount key：hover 离开后 +1 让线从头播（与重置的定时器一致）。
  const [lifeKey, setLifeKey] = useState(0)

  // 手动检查在途标记 + 三个定时器全用 ref：订阅 effect 都是挂载一次的
  // deps 稳定闭包，handler 只碰 ref 和稳定 setState，不受陈旧闭包影响。
  const manualPendingRef = useRef(false)
  const lifeTimerRef = useRef<number | null>(null) // 自动收起
  const leaveTimerRef = useRef<number | null>(null) // 退场动画收尾
  const pendingTimeoutRef = useRef<number | null>(null) // checking 保险丝

  const clearLifeTimer = useCallback(() => {
    if (lifeTimerRef.current !== null) {
      window.clearTimeout(lifeTimerRef.current)
      lifeTimerRef.current = null
    }
  }, [])
  const clearPendingTimeout = useCallback(() => {
    if (pendingTimeoutRef.current !== null) {
      window.clearTimeout(pendingTimeoutRef.current)
      pendingTimeoutRef.current = null
    }
  }, [])

  /** 收起小卡：先播退场再清 state。清 life 定时器防重入。 */
  const dismissFeedback = useCallback(() => {
    clearLifeTimer()
    if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current)
    setFeedbackLeaving(true)
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null
      setFeedbackLeaving(false)
      setManualFeedback(null)
    }, LEAVE_MS)
  }, [clearLifeTimer])

  /** 换发小卡：取消未完成的退场（新反馈要顶上来），重置 life 定时器。 */
  const setFeedback = useCallback(
    (fb: ManualFeedback | null, autoClearMs?: number) => {
      clearLifeTimer()
      if (leaveTimerRef.current !== null) {
        window.clearTimeout(leaveTimerRef.current)
        leaveTimerRef.current = null
        setFeedbackLeaving(false)
      }
      if (!fb) {
        setManualFeedback(null)
        return
      }
      setManualFeedback({ fb, duration: autoClearMs ?? null })
      setLifeKey((k) => k + 1)
      if (autoClearMs) {
        lifeTimerRef.current = window.setTimeout(() => {
          lifeTimerRef.current = null
          dismissFeedback()
        }, autoClearMs)
      }
    },
    [clearLifeTimer, dismissFeedback]
  )

  useEffect(() => {
    const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined
    if (!chatApi?.getUpdaterState) return
    let alive = true
    void chatApi.getUpdaterState().then((s) => {
      if (alive) setState(s)
    })
    const unsubscribe = chatApi.onUpdaterStateChanged((s) => {
      if (!alive) return
      setState(s)
      // 手动检查的结论消费：只有 pending 门开着才弹 toast——后台自动检查
      // 的同款广播从这里安静滑过。
      if (!manualPendingRef.current) return
      if (s.phase === 'none') {
        manualPendingRef.current = false
        clearPendingTimeout()
        setFeedback({ kind: 'none', version: s.currentVersion }, FEEDBACK_DISMISS_MS)
      } else if (s.phase === 'error') {
        manualPendingRef.current = false
        clearPendingTimeout()
        setFeedback({ kind: 'error', message: s.errorMessage }, FEEDBACK_ERROR_DISMISS_MS)
      } else if (s.phase === 'available' || s.phase === 'downloading' || s.phase === 'ready') {
        // 发现新版：主卡片就是结论反馈。收掉小卡并解除两份忽略记忆（用户刚
        // 亲手点了「检查更新」= 明确想看结论，之前收起过什么都不该挡着），
        // 让主卡必现。
        manualPendingRef.current = false
        clearPendingTimeout()
        setFeedback(null)
        setDismissedProgressVersion(null)
        setDismissedReadyVersion(null)
      }
      // checking 等中间态：保持 spinner，不消费。
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [setFeedback, clearPendingTimeout])

  // 账户菜单「检查更新」的入口（AppRail dispatch 的同 document 事件桥）。
  // 全部逻辑收拢在本组件：AppRail 保持哑触发，不直连 chatApi。
  useEffect(() => {
    const onManualCheck = () => {
      const api = window.chatApi
      if (!api?.checkForUpdates) return
      // 先立即上 spinner——即刻可见的反馈是这次改造的核心诉求；快照回来前
      // 关掉 pending 门，防上一轮残留把无关广播误当本次结论。
      manualPendingRef.current = false
      clearPendingTimeout()
      setFeedback({ kind: 'checking' })
      void api.checkForUpdates().then((snap) => {
        if (!snap.supported) {
          // dev / unpackaged：main 侧是 no-op，唯一反馈只能出在这里。
          setFeedback({ kind: 'unsupported' }, FEEDBACK_DISMISS_MS)
          return
        }
        if (snap.phase === 'available' || snap.phase === 'downloading' || snap.phase === 'ready') {
          // main 的 early-return 快照就是结论（下载在途/已就绪时不会再有
          // 「本次检查」的广播）：直接唤起主卡片，同样解除两份忽略记忆。
          setFeedback(null)
          setDismissedProgressVersion(null)
          setDismissedReadyVersion(null)
          return
        }
        // checking（新发起，或撞上在途检查）：开 pending 门等广播结论。
        manualPendingRef.current = true
        clearPendingTimeout()
        pendingTimeoutRef.current = window.setTimeout(() => {
          pendingTimeoutRef.current = null
          if (manualPendingRef.current) {
            manualPendingRef.current = false
            dismissFeedback()
          }
        }, CHECKING_TIMEOUT_MS)
      })
    }
    window.addEventListener('od:manual-update-check', onManualCheck)
    return () => {
      window.removeEventListener('od:manual-update-check', onManualCheck)
      clearLifeTimer()
      clearPendingTimeout()
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current)
    }
  }, [setFeedback, dismissFeedback, clearLifeTimer, clearPendingTimeout])

  // ── 小卡（transient 反馈）：与主卡片同浮层位、天然互斥（这些状态下
  // phase 必不在 available/downloading/ready；发现新版时小卡已被清）。──
  if (manualFeedback) {
    const { fb, duration } = manualFeedback

    // 小卡 X = 不想再看了：连 checking 的结论一起放弃（关掉 pending 门，
    // 迟到的广播不再弹）；检查本身继续在 main 后台走完，状态流照常更新。
    const closeFeedback = () => {
      manualPendingRef.current = false
      clearPendingTimeout()
      dismissFeedback()
    }
    // hover 暂停自动收起：CSS 线经 .group:hover 暂停（globals.css），JS 定时
    // 器这里同步清掉；离开后重给完整时长 + lifeKey++ 让线从头播，两边一致。
    const pauseLife = () => {
      if (duration) clearLifeTimer()
    }
    const resumeLife = () => {
      if (!duration || feedbackLeaving) return
      clearLifeTimer()
      setLifeKey((k) => k + 1)
      lifeTimerRef.current = window.setTimeout(() => {
        lifeTimerRef.current = null
        dismissFeedback()
      }, duration)
    }

    const tint = {
      checking: 'bg-primary/10 text-primary',
      none: 'bg-[hsl(var(--brand)/0.13)] text-[hsl(var(--brand))]',
      error: 'bg-destructive/10 text-destructive',
      unsupported: 'bg-muted text-muted-foreground'
    }[fb.kind]
    const lifeColor = {
      checking: '',
      none: 'bg-[hsl(var(--brand))]',
      error: 'bg-destructive',
      unsupported: 'bg-muted-foreground'
    }[fb.kind]

    return (
      <div
        role="status"
        onMouseEnter={pauseLife}
        onMouseLeave={resumeLife}
        className={cn(
          'group fixed bottom-4 left-4 z-[9999] flex max-w-[336px] items-center gap-[11px] overflow-hidden rounded-[13px] bg-card py-3 pl-3 pr-4',
          TOAST_SHADOW,
          feedbackLeaving ? 'od-toast-leave' : 'od-toast-enter'
        )}
      >
        <span className={cn('grid size-[26px] shrink-0 place-items-center rounded-lg', tint)}>
          {fb.kind === 'checking' && <SpinnerRing />}
          {fb.kind === 'none' && (
            <Check aria-hidden="true" strokeWidth={2.6} className="od-check-draw size-3.5" />
          )}
          {fb.kind === 'error' && (
            <AlertTriangle aria-hidden="true" strokeWidth={2.2} className="size-3.5" />
          )}
          {fb.kind === 'unsupported' && (
            <Info aria-hidden="true" strokeWidth={2.2} className="size-3.5" />
          )}
        </span>
        <span className="min-w-0 text-[13px] leading-[1.55] text-card-foreground">
          {fb.kind === 'checking' && '正在检查更新…'}
          {fb.kind === 'none' && `已是最新版本 v${fb.version}`}
          {fb.kind === 'error' && '检查更新失败'}
          {fb.kind === 'unsupported' && '开发模式下无法检查更新'}
          {fb.kind === 'error' ? (
            <span className="mt-px block truncate text-[11.5px] text-muted-foreground">
              {fb.message ?? '请稍后再试'}
            </span>
          ) : null}
          {fb.kind === 'unsupported' ? (
            <span className="mt-px block text-[11.5px] text-muted-foreground">
              打包安装后可用
            </span>
          ) : null}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="关闭"
          onClick={closeFeedback}
          className="-mr-[5px] ml-px size-[22px] shrink-0 rounded-md text-muted-foreground/65 hover:bg-hover hover:text-foreground"
        >
          <X className="size-3" />
        </Button>
        {duration ? (
          <span
            key={lifeKey}
            aria-hidden
            className={cn(
              'od-toast-life absolute bottom-0 left-0 h-0.5 w-full opacity-[0.22]',
              lifeColor
            )}
            style={{ animationDuration: `${duration}ms` }}
          />
        ) : null}
      </div>
    )
  }

  // ── 主卡片（发现新版 / 已就绪）─────────────────────────────────
  const phase = state?.phase
  const version = state?.availableVersion ?? null
  // 发现新版（下载中）或已就绪都弹，但**各查各的记忆**：进度卡被收起绝不影响
  // 就绪卡浮现——「重启装上」是这条链路的终点，不能被半途的收起动作吞掉
  // （见 state 声明处注释）。
  const isFound = phase === 'available' || phase === 'downloading'
  const isReady = phase === 'ready'
  const visible =
    version !== null &&
    (isReady
      ? version !== dismissedReadyVersion
      : isFound && version !== dismissedProgressVersion)
  if (!visible) return null

  // 同一个 X 在两张卡上写不同的记忆：就绪卡（含「稍后」按钮）写忽略记忆，
  // 进度卡只写「本次下载别挡着」。
  const dismiss = () =>
    isReady ? setDismissedReadyVersion(version) : setDismissedProgressVersion(version)
  const install = () => {
    void window.chatApi?.installUpdate?.()
  }
  const percent = state?.downloadPercent ?? 0

  return (
    <div
      role="status"
      className={cn(
        'od-toast-enter fixed bottom-4 left-4 z-[9999] flex w-[336px] items-start gap-3 rounded-[14px] bg-card p-4',
        TOAST_SHADOW
      )}
    >
      {/* 图标：下载中 = 主题色下载图标、就绪 = 品牌绿描线勾。brand 是 HSL
        * 三元组 token，必须 hsl() 包裹（AppRail 同款写法）。 */}
      <div
        className={cn(
          'grid size-[38px] shrink-0 place-items-center rounded-[11px]',
          isReady
            ? 'bg-[hsl(var(--brand)/0.13)] text-[hsl(var(--brand))]'
            : 'bg-primary/10 text-primary'
        )}
      >
        {isReady ? (
          <Check aria-hidden="true" strokeWidth={2.4} className="od-check-draw size-[18px]" />
        ) : (
          <Download aria-hidden="true" className="size-[18px]" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold tracking-[-0.1px] text-foreground">
          {isReady ? `${version} 已就绪` : `发现新版本 ${version}`}
        </div>
        <p className="mt-[3px] text-[12.5px] leading-relaxed text-muted-foreground">
          {isReady
            ? '新版本已下载完成，重启应用即可完成更新。'
            : '正在后台下载，完成后可一键重启更新。'}
        </p>

        {/* 下载进度：4px 圆角轨 + 平滑 width 过渡 + 等宽百分比。下载中卡片
          * 无按钮行（2026-07-16 用户定稿）——「忽略此版本」语义并进右上角
          * 关闭 X（dismiss 记忆机制不变）。 */}
        {isFound ? (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-[450ms] ease-[cubic-bezier(0.3,0.7,0.3,1)]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="min-w-[30px] text-right text-[11px] tabular-nums text-muted-foreground">
              {percent}%
            </span>
          </div>
        ) : null}

        {isReady ? (
          <div className="mt-3 flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={install}
              className="bg-[hsl(var(--brand))] text-[hsl(var(--brand-foreground))] shadow-[0_1px_2px_hsl(var(--brand)/0.4),inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-[hsl(var(--brand)/0.9)]"
            >
              <RefreshCw aria-hidden="true" />
              立即重启更新
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              稍后
            </Button>
          </div>
        ) : null}
      </div>

      <Button
        size="icon"
        variant="ghost"
        aria-label="关闭"
        onClick={dismiss}
        className="-mr-1.5 -mt-1.5 size-7 shrink-0 rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
    </div>
  )
}
