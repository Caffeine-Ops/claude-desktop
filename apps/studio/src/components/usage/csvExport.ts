import type { UsageLogItem, UsageQueryFilters } from '@desktop-shared/ipc-channels'

/**
 * CSV 导出——照抄 sub2api 前端 `exportToCSV` 的逻辑（该页没有专门的导出
 * 接口）：按 pageSize=100 循环翻页拉完当前筛选条件下的**全量**数据（不受
 * 表格当前分页影响），拼表头 + 转义，交给 main 弹保存框落盘
 * （`window.chatApi.exportUsageCsv`，见 register.ts 的 USAGE_EXPORT_CSV）。
 */

const CSV_HEADERS = [
  '时间',
  'API密钥',
  '模型',
  '推理强度',
  '端点',
  'IP地址',
  '类型',
  '计费模式',
  '输入Token',
  '输出Token',
  '缓存读取Token',
  '缓存创建Token',
  '倍率',
  '实际费用',
  '标准费用',
  '首Token延迟(ms)',
  '总延迟(ms)'
]

/**
 * 转义单个字段：以 `=+-@\t\r` 开头的值先加 `'` 前缀中和公式注入风险
 * （Excel/表格软件打开时不会被当成公式执行）；含引号/逗号/换行的值再
 * 整体用双引号包裹（内部引号转义成 `""`）。
 */
function escapeCsvValue(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value)
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  if (!/["\n\r,]/.test(guarded)) return guarded
  return `"${guarded.replace(/"/g, '""')}"`
}

function usageLogToRow(item: UsageLogItem): Array<string | number> {
  return [
    item.createdAt,
    item.apiKey?.name ?? '',
    item.model,
    item.reasoningEffort ?? '',
    item.inboundEndpoint ?? '',
    item.ipAddress ?? '',
    item.requestType,
    item.billingMode ?? '',
    item.inputTokens,
    item.outputTokens,
    item.cacheReadTokens,
    item.cacheCreationTokens,
    item.rateMultiplier,
    item.actualCost,
    item.totalCost,
    item.firstTokenMs ?? '',
    item.durationMs ?? ''
  ]
}

const EXPORT_PAGE_SIZE = 100

export type ExportUsageCsvResult =
  | { ok: true; path: string | null }
  | { ok: false; error: string }

export async function exportUsageCsv(filters: UsageQueryFilters): Promise<ExportUsageCsvResult> {
  const api = window.chatApi
  if (!api) return { ok: false, error: '当前环境不支持导出' }

  const items: UsageLogItem[] = []
  let page = 1
  for (;;) {
    const result = await api.getUsageList({
      ...filters,
      page,
      pageSize: EXPORT_PAGE_SIZE,
      sortBy: 'created_at',
      sortOrder: 'desc'
    })
    if (!result.ok) return { ok: false, error: result.error }
    items.push(...result.data.items)
    if (items.length >= result.data.total || result.data.items.length === 0) break
    page += 1
  }

  const lines = [CSV_HEADERS.map(escapeCsvValue).join(',')]
  for (const item of items) {
    lines.push(usageLogToRow(item).map(escapeCsvValue).join(','))
  }
  // BOM（﻿）：Excel 打开 UTF-8 CSV 若无 BOM 会把中文列头/内容解析成乱码。
  const csv = '﻿' + lines.join('\r\n')
  const defaultFilename = `usage_${filters.startDate}_to_${filters.endDate}.csv`
  const result = await api.exportUsageCsv({ csv, defaultFilename })
  return { ok: true, path: result.path }
}
