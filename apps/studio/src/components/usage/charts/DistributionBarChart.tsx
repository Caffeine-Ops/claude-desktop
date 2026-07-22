'use client'

/**
 * 「模型分布/分组使用分布/端点分布」三个图表共用的横向 bar chart 展示层
 * ——三者形状相同（一组类目按某个数值维度排序取 Top N），只是数据来源
 * 不同，抽成一个共享组件避免三份近乎相同的图表代码。
 *
 * 配色按 dataviz 技能的规则：这是「同类目按量级排序」的单一数值比较，
 * 不是多系列身份区分，所以用单一 sequential 色相而不是分类调色板——
 * 单一色相不存在「相邻色相可辨识度」的问题，不需要跑 CVD 校验脚本。
 * 色相用 hsl(var(--primary))（用户主题色，随 appearance applier 变）而不是
 * 固定品牌绿——本图表是设置页里的常规内容，不是账户菜单套餐徽章那类
 * 「真·品牌时刻」，跟随主题色是本项目其余 UI 强调色的一贯用色纪律。
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs'

export type DistributionMetric = 'tokens' | 'actualCost'

export interface DistributionDatum {
  label: string
  tokens: number
  actualCost: number
}

const TOP_N = 8

function formatMetricValue(value: number, metric: DistributionMetric): string {
  if (metric === 'actualCost') return `$${value.toFixed(4)}`
  return value.toLocaleString('zh-CN')
}

function DistributionTooltip({
  active,
  payload,
  metric
}: {
  active?: boolean
  payload?: Array<{ payload: DistributionDatum }>
  metric: DistributionMetric
}) {
  if (!active || !payload || payload.length === 0) return null
  const datum = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="max-w-[220px] truncate font-medium text-foreground">{datum.label}</p>
      <p className="mt-0.5 text-muted-foreground">
        {metric === 'actualCost' ? '实际消费' : 'Token'}：
        <span className="font-semibold text-foreground">
          {formatMetricValue(metric === 'actualCost' ? datum.actualCost : datum.tokens, metric)}
        </span>
      </p>
    </div>
  )
}

export function DistributionBarChart({
  title,
  data,
  metric,
  onMetricChange,
  loading
}: {
  title: string
  data: DistributionDatum[]
  metric: DistributionMetric
  onMetricChange: (metric: DistributionMetric) => void
  loading: boolean
}) {
  const top = [...data]
    .sort((a, b) => (metric === 'actualCost' ? b.actualCost - a.actualCost : b.tokens - a.tokens))
    .slice(0, TOP_N)
    .reverse() // recharts 纵轴从下到上排列，reverse 让最大值排在最上面

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold text-foreground">{title}</h3>
        <Tabs value={metric} onValueChange={(v) => onMetricChange(v as DistributionMetric)}>
          <TabsList className="h-7 p-0.5">
            <TabsTrigger value="tokens" className="h-6 px-2 text-[11.5px]">
              按 Token
            </TabsTrigger>
            <TabsTrigger value="actualCost" className="h-6 px-2 text-[11.5px]">
              按实际消费
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        {top.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-[13px] text-muted-foreground">
            暂无数据
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={top} layout="vertical" margin={{ left: 4, right: 16, top: 4, bottom: 4 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                tickFormatter={(v: number) => formatMetricValue(v, metric)}
                axisLine={{ stroke: 'hsl(var(--border))' }}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={96}
                tick={{ fontSize: 11.5, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={{ stroke: 'hsl(var(--border))' }}
                tickLine={false}
                tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
              />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.5 }}
                content={<DistributionTooltip metric={metric} />}
              />
              <Bar
                dataKey={metric}
                fill="hsl(var(--primary))"
                radius={[0, 4, 4, 0]}
                barSize={20}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
