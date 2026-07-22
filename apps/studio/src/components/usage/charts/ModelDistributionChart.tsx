'use client'

import { useState } from 'react'

import type { UsageModelStat } from '@desktop-shared/ipc-channels'
import { DistributionBarChart, type DistributionMetric } from './DistributionBarChart'

export function ModelDistributionChart({ models, loading }: { models: UsageModelStat[]; loading: boolean }) {
  const [metric, setMetric] = useState<DistributionMetric>('tokens')
  return (
    <DistributionBarChart
      title="模型分布"
      metric={metric}
      onMetricChange={setMetric}
      loading={loading}
      data={models.map((m) => ({ label: m.model, tokens: m.totalTokens, actualCost: m.actualCost }))}
    />
  )
}
