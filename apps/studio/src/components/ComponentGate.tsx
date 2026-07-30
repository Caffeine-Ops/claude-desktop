'use client'

import { useEffect, useState } from 'react'
import { motion } from 'motion/react'

import {
  describeComponent,
  formatBytes,
  formatEta,
  type ComponentStatus
} from '@desktop-shared/runtimeComponents'
import { shouldBlockOnComponents, useRuntimeComponentsStore } from '@/src/stores/runtimeComponents'

/**
 * 运行时组件的全屏门（2026-07-29）。
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
 * 层级 z-[9990]：高于 UpgradeScreen(9980)（买不了一个还用不了的东西）、
 * **低于 AuthGate(9999)**（未登录该看到登录页；而且组件源地址的第三层来源是
 * sub2api 的 client-config，登录后才拉得到，因果上也是先登录再下载）、
 * 低于 UpdateReadyToast(10000)。
 *
 * 根层铁律：这棵树在 `.chat-app` 之外，canvas 的全局 reset 会命中裸
 * `<button>`——交互元素一律带 `data-slot` 逃逸。文案硬编码中文（根层无 i18n）。
 *
 * **`--lg-*` 是类作用域变量，不是 :root 全局**（定义在 login.css 的
 * `.login-screen, .upgrade-screen, .component-gate` 选择器组，亮/暗各一组）。
 * 根节点必须挂 `component-gate` 类，否则每一条 `var(--lg-*)` 都解析失败、
 * 整条声明作废：遮罩变透明、首页穿透过来、卡片没底色——首版就是这样（2026-07-29
 * 修）。加新 lg token 消费者时照做，并在 login.css 两个选择器组各加一行。
 * 卡片用 `--lg-card-bg/-border/-shadow`（同订阅页卡片），**没有 `--lg-card`**。
 */

function ComponentRow({ c }: { c: ComponentStatus }): React.JSX.Element {
  const pct = c.total > 0 ? Math.min(100, Math.round((c.done / c.total) * 100)) : null
  const eta = c.phase === 'downloading' ? formatEta(c.total - c.done, c.bytesPerSecond) : ''
  const speed = c.phase === 'downloading' && c.bytesPerSecond > 0 ? `${formatBytes(c.bytesPerSecond)}/s` : ''
  const size = c.total > 0 ? `${formatBytes(c.done)} / ${formatBytes(c.total)}` : ''
  const line = [size, speed, eta].filter(Boolean).join(' · ')

  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-[color:var(--lg-ink)]">{describeComponent(c.id)}</span>
        {pct !== null && c.phase !== 'ready' && (
          <span className="text-[12px] tabular-nums text-[color:var(--lg-ink-2)]">{pct}%</span>
        )}
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--lg-line)]">
        {/* 总量已知走确定进度；未知则一条循环滑块——不要用假百分比糊弄，
            用户等几分钟时最恨看到进度条钉在某个数字上。 */}
        {pct !== null ? (
          <motion.div
            className="h-full rounded-full bg-brand"
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          />
        ) : (
          <motion.div
            className="h-full w-1/3 rounded-full bg-brand"
            animate={{ x: ['-100%', '300%'] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </div>

      <div className="mt-1.5 text-[12px] text-[color:var(--lg-ink-2)]">{c.detail || line}</div>
      {line && c.detail ? (
        <div className="mt-0.5 text-[12px] tabular-nums text-[color:var(--lg-ink-2)]/70">{line}</div>
      ) : null}
    </div>
  )
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

  return (
    <div className="component-gate fixed inset-0 z-[9990] flex items-center justify-center bg-[color:var(--lg-bg)]">
      {/* 全屏层盖住了根 layout 的 .window-drag-strip，自带一条拖拽条，
          否则整个窗口在门开着时拖不动（Login/Upgrade 同样处理）。 */}
      <div className="absolute inset-x-0 top-0 h-12 [-webkit-app-region:drag]" />

      <div className="w-[420px] rounded-2xl border border-[color:var(--lg-card-border)] bg-[color:var(--lg-card-bg)] p-7 shadow-[var(--lg-card-shadow)]">
        <div className="text-[15px] font-semibold text-[color:var(--lg-ink)]">
          {isError ? '组件准备失败' : busy ? '正在准备运行环境' : '正在检查运行环境'}
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[color:var(--lg-ink-2)]">
          {isError
            ? '下载没有完成，应用暂时无法使用。'
            : '首次启动需要下载一次核心组件，之后不再需要。'}
        </p>

        {isError ? (
          <div className="mt-4 rounded-lg bg-[color:var(--lg-line)]/40 p-3">
            {failed.map((c) => (
              <p key={c.id} className="text-[12px] leading-relaxed text-[color:var(--lg-ink-2)]">
                <span className="font-medium text-[color:var(--lg-ink)]">{describeComponent(c.id)}</span>
                ：{c.error}
              </p>
            ))}
          </div>
        ) : (
          required.map((c) => <ComponentRow key={c.id} c={c} />)
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
              className="w-full rounded-lg bg-brand px-3.5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
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
                className="w-full rounded-lg border border-[color:var(--lg-line)] px-3.5 py-2.5 text-[13px] font-medium text-[color:var(--lg-ink)] transition-colors hover:bg-[color:var(--lg-line)]/40"
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
  )
}
