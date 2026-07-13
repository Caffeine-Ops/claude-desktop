/**
 * 回放播放控制条——status !== 'idle' 时悬浮在 ThreadView 内容列底部中央
 * （贴底天然避开顶部 46px window-drag-strip，不需要 no-drag 挖洞）。
 * 全 shadcn 原语 + Tailwind utility；控制操作一律走 ReplayController 方法，
 * 本组件只读 replayStore，不直接写。
 *
 * z 序盖过 composer dock：回放期 composer 因 streaming 只读，但 done 态
 * streaming 已翻 false——控制条常驻在上方，既是「这是演示」的持续提示，
 * 也挡住误触发送的最顺手路径（真正的发送守卫在 FusionRuntimeProvider
 * onNew 的 replay: 早退）。
 */
'use client'

import { useState } from 'react'
import { Pause, Play, X } from 'lucide-react'

import { Button } from '@/src/components/ui/button'
import { Slider } from '@/src/components/ui/slider'
import { useT } from '../../i18n'
import { ReplayController } from '../../replay/ReplayController'
import { useReplayStore, type ReplaySpeed } from '../../replay/replayStore'

const SPEEDS: ReplaySpeed[] = [1, 2, 4, 8]

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function ReplayControlBar() {
  const t = useT()
  const status = useReplayStore((s) => s.status)
  const title = useReplayStore((s) => s.title)
  const positionMs = useReplayStore((s) => s.positionMs)
  const durationMs = useReplayStore((s) => s.durationMs)
  const speed = useReplayStore((s) => s.speed)
  // 拖动中的本地预览值：onValueChange 只更新预览、onValueCommit 才 seek——
  // 拖动过程中不能连发 seek（每次都是整段重建）。
  const [scrub, setScrub] = useState<number | null>(null)

  if (status === 'idle') return null

  const playing = status === 'playing'
  const pos = scrub ?? positionMs

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-[560px] items-center gap-3 rounded-full border border-border bg-background/95 py-2 pl-2 pr-3 shadow-lg backdrop-blur">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={playing ? t('replayPause') : t('replayPlay')}
          title={playing ? t('replayPause') : t('replayPlay')}
          className="shrink-0 rounded-full"
          onClick={() => (playing ? ReplayController.pause() : ReplayController.play())}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[11px] font-medium text-muted-foreground">
              {t('replayBadge')}
              {title ? ` · ${title}` : ''}
              {status === 'done' ? ` · ${t('replayDone')}` : ''}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/80">
              {fmt(pos)} / {fmt(durationMs)}
            </span>
          </div>
          <Slider
            value={[pos]}
            min={0}
            max={Math.max(durationMs, 1)}
            step={100}
            aria-label={t('replayBadge')}
            onValueChange={(v) => setScrub(v[0] ?? 0)}
            onValueCommit={(v) => {
              setScrub(null)
              ReplayController.seekTo(v[0] ?? 0)
            }}
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          aria-label={t('replaySpeed')}
          title={t('replaySpeed')}
          className="w-11 shrink-0 rounded-full font-mono text-[12px] tabular-nums"
          onClick={() => {
            const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
            ReplayController.setSpeed(next)
          }}
        >
          {speed}x
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('replayExit')}
          title={t('replayExit')}
          className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          onClick={() => ReplayController.exit()}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}
