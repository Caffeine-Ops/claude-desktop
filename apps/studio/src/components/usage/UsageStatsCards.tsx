'use client'

import { Info } from 'lucide-react'
import type { ReactNode } from 'react'

import type { UsageStats } from '@desktop-shared/ipc-channels'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/src/components/ui/tooltip'
import { cn } from '@/src/lib/utils'

/** 表格（UsageTable.tsx）也用这三个格式化函数，统一数字/费用/耗时的展示口径，故导出。 */
export function formatCount(n: number): string {
  return n.toLocaleString('zh-CN')
}

export function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

/**
 * 数字方块——照抄 WorkflowAgentsView.tsx 的 metrics 网格样式（chat 面既有的
 * 「统计小方块」范式：`rounded-md border-border/55 bg-muted/20`，数字用
 * font-mono + tabular-nums 在上、muted 标签在下），不用彩色图标徽章——全项目
 * 找不到「每项数据配一个固定色图标」的先例，颜色只服务状态语义（如这里
 * 「总消费」数字本身用 emerald，同 WfStatusBadge 的「颜色给状态不给装饰」
 * 用色纪律），不是给每张卡片分配一个装饰性主题色。
 */
function StatTile({
  label,
  value,
  valueClassName,
  sub
}: {
  label: string
  value: string
  valueClassName?: string
  sub?: ReactNode
}) {
  return (
    <div className="rounded-md border border-border/55 bg-muted/20 px-3 py-2.5">
      <div className={cn('font-mono text-[20px] font-semibold leading-none tabular-nums text-foreground', valueClassName)}>
        {value}
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground">{label}</div>
      {sub ? <div className="mt-1 truncate text-[10.5px] text-muted-foreground/80">{sub}</div> : null}
    </div>
  )
}

export function UsageStatsCards({ stats, loading }: { stats: UsageStats | null; loading: boolean }) {
  const s: UsageStats = stats ?? {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    totalActualCost: 0,
    averageDurationMs: 0,
    endpoints: []
  }
  const totalCache = s.totalCacheCreationTokens + s.totalCacheReadTokens

  return (
    // 设置页内容面固定 max-w-[760px]（见 SettingsDialogV2 内容卡注释），container
    // 只有 ~680px 可用宽度——grid-cols-4 在宽窗口下会被视口断点误判为该展开
    // （Tailwind 断点认视口宽度，不认父容器宽度），四块挤进 680px 会溢出/截断。
    // 固定 2 列，不随视口断点变化。
    <div className={cn('grid grid-cols-2 gap-2', loading && 'opacity-60')}>
      <StatTile label="总请求数" value={formatCount(s.totalRequests)} sub="所选范围内" />
      <StatTile
        label="总 Token"
        value={formatCount(s.totalTokens)}
        sub={
          <span className="inline-flex items-center gap-1">
            输入: {formatCount(s.totalInputTokens)} / 输出: {formatCount(s.totalOutputTokens)} / 缓存:{' '}
            {formatCount(totalCache)}
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="size-3 shrink-0 cursor-help opacity-70" />
              </TooltipTrigger>
              <TooltipContent>
                创建: {formatCount(s.totalCacheCreationTokens)} / 读取: {formatCount(s.totalCacheReadTokens)}
              </TooltipContent>
            </Tooltip>
          </span>
        }
      />
      <StatTile
        label="总消费"
        value={formatCost(s.totalActualCost)}
        valueClassName="text-emerald-600 dark:text-emerald-400"
        sub={
          <>
            标准 <span className="line-through">{formatCost(s.totalCost)}</span>
          </>
        }
      />
      <StatTile label="平均耗时" value={formatDuration(s.averageDurationMs)} />
    </div>
  )
}
