/**
 * 方案埋点持久层（main 侧，M-0）。每次导出 append 一行 JSON 到
 * userData/proposal-metrics/metrics.jsonl——append-only、不外传、不参与会话/草稿生命周期。
 * 与 proposalDraftStore 的区别：草稿是「每会话一份、覆盖式」，埋点是「单文件、追加式」，
 * 故不走 LRU、不按 sessionId 分文件；但同样放进【专属子目录】（范式同 proposalDraftStore）。
 *
 * 路径惰性求值（metricsDir 内才调 app.getPath），避免模块加载期 "app not ready"。
 * 写失败由 IPC handler 兜 catch——埋点是旁路信号，绝不阻塞导出。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import type { ProposalMetricRecord } from '../../shared/proposal'

const metricsDir = (): string => join(app.getPath('userData'), 'proposal-metrics')
const metricsPath = (): string => join(metricsDir(), 'metrics.jsonl')

function ensureDir(): void {
  const dir = metricsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 追加一条埋点记录（一行 JSON）。文件不存在时 appendFile 自动创建。 */
export async function appendProposalMetric(record: ProposalMetricRecord): Promise<void> {
  ensureDir()
  await appendFile(metricsPath(), JSON.stringify(record) + '\n', 'utf8')
}
