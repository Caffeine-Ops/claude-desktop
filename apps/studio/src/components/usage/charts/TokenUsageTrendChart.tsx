'use client'

/**
 * 「Token 使用趋势」——单序列时间线（不像另外三个分布图那样有
 * 按Token/按实际消费切换，标题已经说明画的是 Token），用 dataviz 技能的
 * 单一 sequential 色相（hsl(var(--primary))，随用户主题色走，理由见
 * DistributionBarChart 头注释）：2px 线 + ~10% 透明度的面积 wash，
 * 端点/hover 用 recharts 内置 activeDot（r=4，直径 8px 达标）。
 */

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import type { UsageTrendPoint } from '@desktop-shared/ipc-channels'

function formatTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

function TrendTooltip({
  active,
  payload,
  label
}: {
  active?: boolean
  payload?: Array<{ payload: UsageTrendPoint }>
  label?: string
}) {
  if (!active || !payload || payload.length === 0) return null
  const datum = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="font-medium text-foreground">{label}</p>
      <p className="mt-0.5 text-muted-foreground">
        Token：<span className="font-semibold text-foreground">{datum.totalTokens.toLocaleString('zh-CN')}</span>
      </p>
      <p className="text-muted-foreground">
        请求：<span className="font-semibold text-foreground">{datum.requests.toLocaleString('zh-CN')}</span>
      </p>
    </div>
  )
}

export function TokenUsageTrendChart({ trend, loading }: { trend: UsageTrendPoint[]; loading: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-[13.5px] font-semibold text-foreground">Token 使用趋势</h3>
      <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        {trend.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-[13px] text-muted-foreground">
            暂无数据
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={trend} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={{ stroke: 'hsl(var(--border))' }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatTokens}
                width={44}
              />
              <Tooltip cursor={{ stroke: 'hsl(var(--border))' }} content={<TrendTooltip />} />
              <Area
                type="monotone"
                dataKey="totalTokens"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="hsl(var(--primary))"
                fillOpacity={0.1}
                dot={false}
                activeDot={{ r: 4, stroke: 'hsl(var(--card))', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
