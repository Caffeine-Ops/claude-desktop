'use client'

import { useState } from 'react'

import type { UsageEndpointStat } from '@desktop-shared/ipc-channels'
import { DistributionBarChart, type DistributionMetric } from './DistributionBarChart'

export function EndpointDistributionChart({
  endpoints,
  loading
}: {
  endpoints: UsageEndpointStat[]
  loading: boolean
}) {
  const [metric, setMetric] = useState<DistributionMetric>('tokens')
  return (
    <DistributionBarChart
      title="端点分布"
      metric={metric}
      onMetricChange={setMetric}
      loading={loading}
      data={endpoints.map((e) => ({ label: e.endpoint, tokens: e.totalTokens, actualCost: e.actualCost }))}
    />
  )
}
