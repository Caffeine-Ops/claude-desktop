'use client'

import { useState } from 'react'

import type { UsageGroupStat } from '@desktop-shared/ipc-channels'
import { DistributionBarChart, type DistributionMetric } from './DistributionBarChart'

export function GroupDistributionChart({ groups, loading }: { groups: UsageGroupStat[]; loading: boolean }) {
  const [metric, setMetric] = useState<DistributionMetric>('tokens')
  return (
    <DistributionBarChart
      title="分组使用分布"
      metric={metric}
      onMetricChange={setMetric}
      loading={loading}
      data={groups.map((g) => ({ label: g.groupName, tokens: g.totalTokens, actualCost: g.actualCost }))}
    />
  )
}
