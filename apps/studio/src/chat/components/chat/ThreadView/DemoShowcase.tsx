/**
 * 首页空态的「看看它能做什么」演示区——内置演示录像（demo-replays 目录）
 * 的卡片网格，点卡片就地播放（openReplay 显式 path 不弹对话框 →
 * ReplayController 接管，观感与真实会话一致）。
 *
 * 数据驱动上架：main 扫描目录返回清单，空数组 → 整区不渲染（新装机没有
 * 内置演示时首页保持原样，不出现空壳标题）。视觉稿与三种封面骨架来自
 * docs/ui-prototype-home-demo-replay.html（2026-07-13 定稿）——封面刻意用
 * 抽象骨架示意而非真实截图：录像内容可被随时替换，截图会过期，骨架不会。
 */
'use client'

import { useEffect, useState } from 'react'
import type { ReplayDemoInfo } from '@desktop-shared/ipc-channels'

import { useT } from '../../../i18n'
import { ReplayController } from '../../../replay/ReplayController'

function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function DemoShowcase(): React.JSX.Element | null {
  const t = useT()
  const [demos, setDemos] = useState<ReplayDemoInfo[]>([])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    let cancelled = false
    window.chatApi
      .listReplayDemos()
      .then((r) => {
        if (!cancelled) setDemos(r.demos)
      })
      .catch((err: unknown) =>
        console.warn('[DemoShowcase] listReplayDemos failed:', err)
      )
    return () => {
      cancelled = true
    }
  }, [])

  if (demos.length === 0) return null

  const play = (d: ReplayDemoInfo): void => {
    void window.chatApi
      .openReplay({ path: d.path })
      .then((r) => {
        if (r.ok) ReplayController.start(r.meta, r.timeline)
        else if (!r.cancelled) console.warn('[DemoShowcase] open failed:', r.error)
      })
      .catch((err: unknown) => console.warn('[DemoShowcase] open error:', err))
  }

  return (
    <div className="mt-10">
      <div className="mb-3.5 flex items-baseline gap-2.5 px-0.5">
        <h2 className="text-[15px] font-semibold text-foreground">
          {t('demoShowcaseTitle')}
        </h2>
        <span className="text-[12.5px] text-muted-foreground">
          {t('demoShowcaseHint')}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3.5 max-[900px]:grid-cols-2 max-[620px]:grid-cols-1">
        {demos.map((d, i) => (
          <button
            key={d.path}
            type="button"
            onClick={() => play(d)}
            aria-label={`${t('demoShowcasePlay')}: ${d.title}`}
            className="group flex flex-col overflow-hidden rounded-[14px] border border-border/70 bg-card text-left transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-[3px] hover:border-border hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--accent))] active:-translate-y-px"
          >
            {/* 卡片配色跟主题色（2026-07-17 从写死品牌绿改 --accent）：
                这张卡是「点了会播放」的交互卡片，不是身份标识，颜色该
                随设置页选的主题色走。 */}
            <div className="relative aspect-video overflow-hidden bg-[radial-gradient(120%_90%_at_20%_0%,hsl(var(--accent)/0.07),transparent_55%)] p-4">
              <CoverSketch variant={i % 3} />
              {/* hover 播放钮 */}
              <div className="absolute inset-0 grid place-items-center bg-transparent transition-colors duration-200 group-hover:bg-foreground/5">
                <div className="grid size-11 scale-[0.92] place-items-center rounded-full bg-[hsl(var(--accent))] text-white shadow-[0_4px_14px_hsl(var(--accent)/0.45)] transition-transform duration-200 group-hover:scale-105">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                    <path d="M4.5 2.8v10.4c0 .8.9 1.3 1.6.9l8-5.2c.6-.4.6-1.4 0-1.8l-8-5.2c-.7-.4-1.6.1-1.6.9z" />
                  </svg>
                </div>
              </div>
              <span className="absolute bottom-2.5 right-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] tabular-nums text-white backdrop-blur-sm">
                {fmtDuration(d.virtualDurationMs)}
              </span>
            </div>
            <div className="px-3.5 pb-3.5 pt-3">
              <div className="mb-0.5 flex items-center gap-1.5">
                <span className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">
                  {d.title}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/[0.09] px-2 py-0.5 text-[10.5px] font-medium text-accent">
                  <span className="size-[5px] rounded-full bg-current" />
                  {t('demoShowcaseTag')}
                </span>
              </div>
              <div className="line-clamp-2 text-[12px] leading-normal text-muted-foreground">
                {d.description ??
                  `${d.messageCount} ${t('demoShowcaseFallbackDesc')}`}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 封面骨架：产品界面的抽象微缩示意（用户气泡 / 工具行 / 成果块），按卡片
 * 序号轮换三种构图。刻意不是真实截图（见组件头注释）。
 */
function CoverSketch({ variant }: { variant: number }): React.JSX.Element {
  const bubble = (
    <div className="h-3 w-[46%] self-end rounded-full bg-[hsl(var(--accent)/0.28)]" />
  )
  const toolRow = (
    <div className="flex h-[18px] w-[74%] items-center gap-1.5 rounded-md border border-border/60 bg-card px-2">
      <span className="size-[7px] rounded-full bg-[hsl(var(--accent))]" />
      <span className="h-1.5 flex-1 rounded-full bg-foreground/10" />
    </div>
  )
  const artifact = (label: string) => (
    <div className="mt-auto grid h-[34%] w-[58%] place-items-center rounded-lg border border-border/60 bg-card text-[9px] tracking-wide text-muted-foreground/80">
      {label}
    </div>
  )
  if (variant === 1) {
    return (
      <div className="flex h-full flex-col gap-1.5">
        {bubble}
        {toolRow}
        <div className="h-2 w-[80%] rounded-full bg-foreground/10" />
        {artifact('图片 · 标记 ①')}
      </div>
    )
  }
  if (variant === 2) {
    return (
      <div className="flex h-full flex-col gap-1.5">
        {bubble}
        {toolRow}
        {toolRow}
        {artifact('表格 + 图表')}
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col gap-1.5">
      {bubble}
      <div className="h-2 w-[60%] rounded-full bg-foreground/10" />
      {toolRow}
      {artifact('幻灯片 16:9')}
    </div>
  )
}
