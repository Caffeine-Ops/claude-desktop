'use client'

import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Check, Loader2, X } from 'lucide-react'

import {
  describeComponent,
  formatBytes,
  formatEta,
  type ComponentStatus
} from '@desktop-shared/runtimeComponents'
import { shouldBlockOnComponents, useRuntimeComponentsStore } from '@/src/stores/runtimeComponents'
import { cn } from '@/src/lib/utils'
// login-* 背景/动效类与 --lg-* 主题变量（双档）。login.css 是组件级全局 CSS
// （LoginScreen 已 import 过一次），这里同一 webContents 内重复 import 是
// no-op，不会重复注入样式。
import './login.css'

/**
 * 运行时组件的全屏门（2026-07-29 首版，2026-07-30 改版为 HUD 分屏）。
 *
 * AI 引擎（CLI 二进制）不再随安装包发布，首次启动时下载。它是**必需品**——
 * 缺了整个应用不能聊天，所以这道门与 PptSkillGate 刻意不同：
 *
 *   ① **没有关闭 / 后台继续按钮**，不响应 Esc、不响应点遮罩。
 *   ② **遮罩不透明**。半透明会让用户看见底下的输入框然后去点，点不动只会以为
 *      应用卡了；不透明 + 与登录墙同一面色，视觉上就是「应用还没准备好」。
 *   ③ 只渲染 required 组件；可选的（Python 环境）在下面一行小字里交代。
 *   ④ **显示速率与剩余时间**。自建源出口带宽约 1.1MB/s 且所有用户共享，一次
 *      首装动辄一两分钟——没有 ETA 用户没法判断该等还是该重启。
 *
 * 视觉是 docs/ui-prototype-component-gate.html「B HUD 分屏」方案的落地
 * （2026-07-30）：与 LoginScreen 完全同骨架（左 44% 品牌面 + 右侧信息面，
 * 窄窗降级只剩右面），用户从登录墙走到这道门视觉零跳变。背景系统（网格 +
 * 双光晕呼吸 + 漂浮微粒）、轨道环、入场 stagger 均直接复用 login.css 的
 * `login-*` 类——与 LoginScreen 存在有意的样式重复（而非抽共享组件）：
 * 三处用量都不同（品牌面文案、轨道环是否算进度、状态行内容），过早抽象只会
 * 把「各自需要什么」的判断力弄丢。右面新增的 hero 大字读数（ETA/安装中/
 * 已中断）是本次改版唯一的新信息——取当前 required 组件里最活跃的一条
 * （实际上 schema 只有 cli 一个 required 组件）算出。
 *
 * 层级 z-[9990]：高于 UpgradeScreen(9980)（买不了一个还用不了的东西）、
 * **低于 AuthGate(9999)**（未登录该看到登录页；而且组件源地址的第三层来源是
 * sub2api 的 client-config，登录后才拉得到，因果上也是先登录再下载）、
 * 低于 UpdateReadyToast(10000)。
 *
 * 根层铁律：这棵树在 `.chat-app` 之外，canvas 的全局 reset 会命中裸
 * `<button>`——交互元素一律带 `data-slot` 逃逸。文案硬编码中文（根层无 i18n），
 * kicker/状态行的英文 mono 短语是装饰性视觉语言（同 LoginScreen 的
 * "System Ready"），不在 i18n 覆盖范围。
 *
 * **`--lg-*` 是类作用域变量，不是 :root 全局**（定义在 login.css 的
 * `.login-screen, .upgrade-screen, .component-gate` 选择器组，亮/暗各一组）。
 * 根节点必须挂 `component-gate` 类，否则每一条 `var(--lg-*)` 都解析失败、
 * 整条声明作废：遮罩变透明、首页穿透过来、卡片没底色——首版就是这样（2026-07-29
 * 修）。加新 lg token 消费者时照做，并在 login.css 两个选择器组各加一行。
 * 卡片用 `--lg-card-bg/-border/-shadow`（同订阅页卡片），**没有 `--lg-card`**。
 * 进度条/轨道环一律走 `--lg-green`（本作用域暗档专门提亮过，为的是在
 * 近黑的 `--lg-bg` 上够亮），不用全局 `--brand`——两者同值只是巧合，
 * `--brand` 暗档刻意没跟着提亮（配的是 `--card` 那种浅灰暗面，不是这里的
 * 近黑面），混用会在暗色首装门上显得发暗。
 */

/** 入场 stagger 的公共 animation，同 LoginScreen 的 RISE 常量。 */
const RISE = 'animate-[login-rise_.6s_cubic-bezier(0.32,0.72,0,1)_both]'

/** 漂浮微粒错落参数（left% / 时长s / 延迟s / 尺寸px），同 LoginScreen 的 5 颗。 */
const MOTES: Array<[number, number, number, number]> = [
  [18, 16, 0, 3],
  [36, 21, 4, 2],
  [58, 14, 8, 3],
  [74, 24, 2, 2],
  [88, 18, 11, 3]
]

/** 组件行左侧状态徽标：待开始 / 进行中 / 完成 / 失败。 */
function RowGlyph({ phase }: { phase: ComponentStatus['phase'] }): React.JSX.Element {
  if (phase === 'error') {
    return (
      <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full bg-[color:var(--lg-error)]/12 text-[color:var(--lg-error)]">
        <X className="size-3" strokeWidth={3} />
      </span>
    )
  }
  if (phase === 'ready') {
    return (
      <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full bg-[color:var(--lg-green)]/14 text-[color:var(--lg-green)]">
        <Check className="size-3" strokeWidth={3} />
      </span>
    )
  }
  if (phase === 'idle') {
    return <span className="mt-0.5 size-[22px] shrink-0 rounded-full border-[1.5px] border-[color:var(--lg-line)]" />
  }
  // checking / downloading / verifying / installing —— 都是「进行中」。
  return (
    <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center text-[color:var(--lg-green)]">
      <Loader2 className="size-[15px] animate-spin" strokeWidth={2.5} />
    </span>
  )
}

function RequiredRow({ c }: { c: ComponentStatus }): React.JSX.Element {
  const pct = c.total > 0 ? Math.min(1, c.done / c.total) : null
  const eta = c.phase === 'downloading' ? formatEta(c.total - c.done, c.bytesPerSecond) : ''
  const speed =
    (c.phase === 'downloading' || c.phase === 'installing') && c.bytesPerSecond > 0
      ? `${formatBytes(c.bytesPerSecond)}/s`
      : ''
  const size = c.total > 0 ? `${formatBytes(c.done)} / ${formatBytes(c.total)}` : ''
  const line = [size, speed, eta].filter(Boolean).join(' · ')
  const isErr = c.phase === 'error'

  return (
    <div className="flex gap-3 py-3.5 first:pt-0 last:pb-0">
      <RowGlyph phase={c.phase} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2.5">
          <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-[color:var(--lg-ink)]">
            {describeComponent(c.id)}
            <span className="rounded-full border border-[color:var(--lg-green)]/35 bg-[color:var(--lg-green)]/[0.06] px-[7px] py-[2px] text-[10px] font-medium tracking-[.3px] text-[color:var(--lg-green)]">
              必需
            </span>
          </span>
          {size ? (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--lg-ink-3)]">{size}</span>
          ) : null}
        </div>

        {/* 总量已知走确定进度；未知则一条循环滑块——不要用假百分比糊弄，
            用户等几分钟时最恨看到进度条钉在某个数字上。 */}
        <div className="mt-2 h-[5px] w-full overflow-hidden rounded-full bg-[color:var(--lg-line)]/80">
          {pct !== null ? (
            <motion.div
              className={cn(
                'h-full rounded-full',
                isErr
                  ? 'bg-[color:var(--lg-error)]/55'
                  : 'bg-gradient-to-r from-[color:var(--lg-green)] to-[color:var(--lg-green-deep)] shadow-[0_0_10px_rgba(22,163,74,.35)]'
              )}
              animate={{ width: `${pct * 100}%` }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            />
          ) : (
            <motion.div
              className="h-full w-1/3 rounded-full bg-gradient-to-r from-[color:var(--lg-green)] to-[color:var(--lg-green-deep)]"
              animate={{ x: ['-110%', '330%'] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
        </div>

        <div
          className={cn(
            'mt-1.5 text-[12px] leading-relaxed',
            isErr ? 'text-[color:var(--lg-error)]' : 'text-[color:var(--lg-ink-2)]'
          )}
        >
          {c.detail || line || '正在检查已安装的版本…'}
        </div>
      </div>
    </div>
  )
}

/** 右面 hero 大字读数：checking/downloading/installing/error 四态各自的主标签+主数值+副注。 */
function heroFor(c: ComponentStatus | undefined): { cap: string; val: string; note: string; err: boolean } {
  if (!c) return { cap: '', val: '', note: '', err: false }
  switch (c.phase) {
    case 'error': {
      const note = c.attempt > 0 ? `已自动重试 ${c.attempt} 次` : ''
      return { cap: 'Interrupted', val: '已中断', note, err: true }
    }
    case 'downloading': {
      const eta = formatEta(c.total - c.done, c.bytesPerSecond)
      const speed = c.bytesPerSecond > 0 ? `${formatBytes(c.bytesPerSecond)}/s` : ''
      const total = c.total > 0 ? `共 ${formatBytes(c.total)}` : ''
      return { cap: '预计剩余', val: eta || '计算中…', note: [speed, total].filter(Boolean).join(' · '), err: false }
    }
    case 'verifying':
    case 'installing':
      return { cap: 'Installing', val: '安装中', note: '', err: false }
    default:
      return { cap: 'Checking', val: '检查中', note: '', err: false }
  }
}

/** 左面底部 mono 状态行文案（装饰性英文，同 LoginScreen 的 "System Ready"）。 */
function statusLabel(phase: ComponentStatus['phase'] | undefined, isError: boolean): string {
  if (isError) return 'Setup Interrupted'
  switch (phase) {
    case 'downloading':
      return 'Downloading Components'
    case 'verifying':
      return 'Verifying Download'
    case 'installing':
      return 'Installing Components'
    case 'checking':
      return 'Checking Components'
    default:
      return 'Preparing Components'
  }
}

export function ComponentGate(): React.JSX.Element | null {
  const state = useRuntimeComponentsStore((s) => s.state)
  const bypassed = useRuntimeComponentsStore((s) => s.bypassed)
  const bypass = useRuntimeComponentsStore((s) => s.bypass)
  /** 系统是否装了 claude——决定错误态给不给「用系统 Claude 继续」这个次出口。 */
  const [systemClaude, setSystemClaude] = useState<{ path: string; version: string | null } | null>(null)

  const blocking = shouldBlockOnComponents(state, bypassed)

  useEffect(() => {
    if (!blocking) return
    // 只在真的挡住时才去探测：detectSystemClaude 会 spawn 一次 `claude --version`，
    // 没必要在绝大多数「早就就绪」的启动里白花这个开销。
    void window.chatApi?.getCliBackend?.().then((s) => {
      setSystemClaude(s?.systemInfo ?? null)
    }).catch(() => setSystemClaude(null))
  }, [blocking])

  if (!blocking || !state) return null

  const required = state.components.filter((c) => c.required)
  const optional = state.components.filter((c) => !c.required && c.phase !== 'ready' && c.phase !== 'idle')
  const failed = required.filter((c) => c.phase === 'error')
  const isError = failed.length > 0
  const busy = required.some((c) => c.phase === 'downloading' || c.phase === 'verifying' || c.phase === 'installing')

  // hero 读数取当前最活跃的 required 组件（idle 尚未开始检查，跳过它找下一条）。
  // schema 目前只有 cli 一个 required 组件，这里的 find 是防御性写法，不是为了
  // 真的支持多 required 组件的聚合展示。
  const primary = required.find((c) => c.phase !== 'idle') ?? required[0]
  const hero = heroFor(primary)

  return (
    <div className="component-gate fixed inset-0 z-[9990] overflow-hidden bg-[color:var(--lg-bg)] transition-colors duration-300">
      {/* 背景系统：与 LoginScreen 同款（网格 + 双光晕呼吸 + 漂浮微粒），
          纯装饰层——aria-hidden + pointer-events 穿透。 */}
      <div
        aria-hidden
        className="login-glow-main pointer-events-none absolute -bottom-[46%] left-1/2 h-[640px] w-[1000px] -translate-x-1/2"
      />
      <div
        aria-hidden
        className="login-glow-side pointer-events-none absolute -right-[18%] -top-[30%] h-[520px] w-[660px]"
      />
      <div aria-hidden className="login-grid pointer-events-none absolute inset-0" />
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {MOTES.map(([left, dur, delay, size], i) => (
          <span
            key={i}
            className="login-mote"
            style={{
              left: `${left}%`,
              width: size,
              height: size,
              animationDuration: `${dur}s`,
              animationDelay: `${delay}s`
            }}
          />
        ))}
      </div>

      {/* 全屏层盖住了根 layout 的 .window-drag-strip，自带一条拖拽条，
          否则整个窗口在门开着时拖不动（Login/Upgrade 同样处理）。 */}
      <div className="absolute inset-x-0 top-0 z-10 h-12 [-webkit-app-region:drag]" />

      <div className="relative flex h-full">
        {/* ── 左：品牌面（窄窗降级隐藏，右侧信息面永远可用）── */}
        <aside className="hidden w-[44%] flex-col border-r border-[color:var(--lg-pane-border)] bg-[radial-gradient(ellipse_80%_60%_at_50%_46%,var(--lg-pane-glow),transparent_70%)] px-12 pb-9 pt-[60px] transition-colors duration-300 md:flex">
          <div className={cn(RISE, 'flex items-center gap-2.5')}>
            <img
              src="/app-icon.png"
              alt=""
              draggable={false}
              className="-my-[3px] -ml-[3px] size-9 shrink-0 [filter:var(--lg-mark-glow)]"
            />
            <span className="text-[15px] font-semibold tracking-[-0.2px] text-[color:var(--lg-ink)]">Cowork</span>
          </div>

          {/* 轨道环：纯装饰的「系统运转中」隐喻，同登录页——不承载真实进度
              （真实进度在右侧 hero 读数与组件行），双环反向慢转 + 中心
              发光核不随状态改变。 */}
          <div aria-hidden className={cn(RISE, '[animation-delay:.1s]', 'relative m-auto size-60')}>
            <div className="login-ring" />
            <div className="login-ring login-ring-inner" />
            <img
              src="/app-icon.png"
              alt=""
              draggable={false}
              className="absolute inset-0 m-auto size-[116px] [filter:var(--lg-core-glow)]"
            />
          </div>

          <div className={cn(RISE, '[animation-delay:.2s]', 'mb-auto text-center')}>
            <h2 className="text-[26px] font-semibold leading-[1.3] tracking-[-0.4px] text-[color:var(--lg-ink)]">
              第一次启动
              <br />
              正在装好你的 AI 工作台
            </h2>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-[color:var(--lg-ink-2)]">
              只需要这一次
              <br />
              之后打开即用
            </p>
          </div>

          <div
            className={cn(
              RISE,
              '[animation-delay:.3s]',
              'mt-10 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[1.5px] text-[color:var(--lg-ink-3)]'
            )}
          >
            <i
              className={cn(
                'login-pulse size-1.5 rounded-full',
                isError
                  ? 'bg-[color:var(--lg-error)] shadow-[0_0_8px_rgba(217,48,37,.5)]'
                  : 'bg-[color:var(--lg-dot-outer)] shadow-[0_0_8px_var(--lg-dot-glow-outer)]'
              )}
            />
            {statusLabel(primary?.phase, isError)}
          </div>
        </aside>

        {/* ── 右：信息面 ── */}
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-6">
          <div className="w-[360px]">
            <div className="mb-[22px]">
              <div className={cn(RISE, 'mb-3.5')}>
                <span className="inline-flex items-center gap-2 font-mono text-[10.5px] font-medium uppercase tracking-[3px] text-[color:var(--lg-green)]/85 after:h-px after:w-[22px] after:bg-gradient-to-r after:from-[color:var(--lg-green)]/50 after:to-transparent">
                  First-Run Setup
                </span>
              </div>
              <h1
                className={cn(
                  RISE,
                  '[animation-delay:.07s]',
                  'text-[26px] font-semibold leading-[1.2] tracking-[-0.4px] text-[color:var(--lg-ink)]'
                )}
              >
                {isError ? '组件准备失败' : busy ? '正在准备运行环境' : '正在检查运行环境'}
              </h1>
              <p
                className={cn(
                  RISE,
                  '[animation-delay:.14s]',
                  'mt-2.5 text-[13.5px] leading-relaxed text-[color:var(--lg-ink-2)]'
                )}
              >
                {isError
                  ? '下载没有完成，应用暂时无法使用。'
                  : '首次启动需要下载一次核心组件，之后不再需要。'}
              </p>
            </div>

            {/* hero 大字读数：预计剩余时间 / 安装中 / 已中断——用户视线第一
                落点，回答「还要多久」这个首装期最迫切的问题。 */}
            {primary && hero.val ? (
              <div className={cn(RISE, '[animation-delay:.2s]', 'mb-[18px]')}>
                <div className="font-mono text-[10.5px] uppercase tracking-[2px] text-[color:var(--lg-ink-3)]">
                  {hero.cap}
                </div>
                <div
                  className={cn(
                    'mt-1.5 text-[36px] font-semibold leading-[1.1] tracking-[-1px] tabular-nums',
                    hero.err ? 'text-[color:var(--lg-error)]' : 'text-[color:var(--lg-ink)]'
                  )}
                >
                  {hero.val}
                </div>
                {hero.note ? <div className="mt-1 text-[12px] text-[color:var(--lg-ink-3)]">{hero.note}</div> : null}
              </div>
            ) : null}

            <div className={cn(RISE, '[animation-delay:.26s]')}>
              {isError ? (
                <div className="rounded-lg bg-[color:var(--lg-line)]/40 p-3">
                  {failed.map((c) => (
                    <p key={c.id} className="text-[12px] leading-relaxed text-[color:var(--lg-ink-2)]">
                      <span className="font-medium text-[color:var(--lg-ink)]">{describeComponent(c.id)}</span>：
                      {c.error}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="divide-y divide-[color:var(--lg-line)]/50">
                  {required.map((c) => (
                    <RequiredRow key={c.id} c={c} />
                  ))}
                </div>
              )}

              {optional.length > 0 && !isError && (
                <p className="mt-4 text-[12px] text-[color:var(--lg-ink-2)]/70">
                  正在后台准备{optional.map((c) => describeComponent(c.id)).join('、')}，不影响使用。
                </p>
              )}

              {isError && (
                <div className="mt-5 flex flex-col gap-2">
                  <button
                    type="button"
                    data-slot="component-gate-retry"
                    onClick={() => {
                      void window.chatApi?.ensureRuntimeComponents?.(true)
                    }}
                    className="login-sheen relative h-11 w-full overflow-hidden rounded-lg bg-gradient-to-br from-[color:var(--lg-green)] to-[color:var(--lg-green-deep)] text-[13px] font-semibold text-[color:var(--lg-green-fg)] shadow-[var(--lg-btn-shadow)] transition-[filter,box-shadow] hover:brightness-[1.07] hover:shadow-[var(--lg-btn-shadow-hover)] active:scale-[.985]"
                  >
                    重试下载
                  </button>

                  {/* 仅在真探到系统 claude 时才给这个出口。
                      **刻意不自动切换**：systemBackendEnv() 会剥掉注入的 ANTHROPIC_*，
                      静默切过去等于让用户悄悄跑到自己的 Anthropic 账号上——账单和模型
                      都变了却毫无提示。所以必须是用户显式选择，且文案写清后果。 */}
                  {systemClaude && (
                    <button
                      type="button"
                      data-slot="component-gate-use-system"
                      onClick={() => {
                        void window.chatApi?.setCliBackend?.({ mode: 'system' }).then(() => bypass())
                      }}
                      className="h-11 w-full rounded-lg border border-[color:var(--lg-line)] text-[13px] font-medium text-[color:var(--lg-ink)] transition-colors hover:border-[color:var(--lg-line-hover)] hover:bg-[color:var(--lg-line)]/40"
                    >
                      使用本机已安装的 Claude 继续
                    </button>
                  )}
                  <p className="text-[12px] leading-relaxed text-[color:var(--lg-ink-2)]/70">
                    {systemClaude
                      ? '将使用你本机安装的 Claude Code 与你自己的 Anthropic 账号，模型和计费都以该账号为准。'
                      : '若反复失败，请检查网络后重启应用。'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
