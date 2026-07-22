/**
 * 分页明细表的列定义 + 列显隐持久化——从 UsageTable.tsx 抽出来，因为
 * 「列设置」下拉的触发按钮实际画在 UsageFilters.tsx 那一行（跟截图一致），
 * 两个文件都要认识同一份列清单，抽成共享模块避免定义两遍。
 */

export interface UsageTableColumnDef {
  key: string
  label: string
}

export const USAGE_TABLE_COLUMNS: UsageTableColumnDef[] = [
  { key: 'apiKey', label: 'API 密钥' },
  { key: 'model', label: '模型' },
  { key: 'reasoningEffort', label: '推理强度' },
  { key: 'inboundEndpoint', label: '端点' },
  { key: 'ipAddress', label: 'IP' },
  { key: 'group', label: '分组' },
  { key: 'requestType', label: '类型' },
  { key: 'billingMode', label: '计费模式' },
  { key: 'totalTokens', label: 'TOKEN' },
  { key: 'actualCost', label: '费用' },
  { key: 'durationMs', label: '延迟' },
  { key: 'createdAt', label: '时间' }
]

const STORAGE_KEY = 'claude-desktop:usage-table-columns'

export function loadVisibleColumns(): Set<string> {
  const all = new Set(USAGE_TABLE_COLUMNS.map((c) => c.key))
  if (typeof window === 'undefined') return all
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return all
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return all
    const valid = parsed.filter((k): k is string => typeof k === 'string' && all.has(k))
    return valid.length > 0 ? new Set(valid) : all
  } catch {
    return all
  }
}

export function saveVisibleColumns(keys: Set<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]))
  } catch {
    // 存储失败不影响功能——下次打开页面回落成全部列可见。
  }
}
