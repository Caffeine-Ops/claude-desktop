import type {
  UsageEndpointStat,
  UsageFilterOptions,
  UsageFilterOptionsResult,
  UsageGroupStat,
  UsageListData,
  UsageListQuery,
  UsageListResult,
  UsageLogItem,
  UsageLogRef,
  UsageModelStat,
  UsageModelsData,
  UsageModelsResult,
  UsageQueryFilters,
  UsageSnapshot,
  UsageSnapshotResult,
  UsageStats,
  UsageStatsResult,
  UsageTrendPoint
} from '../../shared/ipc-channels'
import { authedGet, translateError } from './authService'

/**
 * 使用记录页（对接 sub2api `/api/v1/usage*`）的数据层——只做「拼 query →
 * 调 authedGet → snake_case 转 camelCase」，不含任何 UI 状态（筛选器/分页
 * 态全在 renderer 的 UsageScreen 里）。五个接口分工见各自导出函数的注释；
 * 字段树对齐调研时核对过的 sub2api handler json tag。
 *
 * 认证一律交给 {@link authedGet}：它负责 access token 续期（24h TTL，这一页
 * 常在冷启动后第一个被打开）、401 重放、以及未登录时统一回
 * `{ ok: false, reason: 'NOT_SIGNED_IN' }`——所以这里不再自己取 token 判空，
 * 错误文案统一过 {@link translateError}（曾经直出 `result.message`，token
 * 过期时用户看到的是后端原样的英文 "Token has expired"）。
 */

/** 把 UsageQueryFilters 的可选字段拼进 query，跳过 undefined。 */
function appendFilters(params: URLSearchParams, filters: UsageQueryFilters): void {
  params.set('start_date', filters.startDate)
  params.set('end_date', filters.endDate)
  params.set('timezone', filters.timezone)
  if (filters.apiKeyId !== undefined) params.set('api_key_id', String(filters.apiKeyId))
  if (filters.groupId !== undefined) params.set('group_id', String(filters.groupId))
  if (filters.model !== undefined && filters.model !== '') params.set('model', filters.model)
  if (filters.requestType !== undefined) params.set('request_type', filters.requestType)
  if (filters.billingType !== undefined) params.set('billing_type', String(filters.billingType))
  if (filters.billingMode !== undefined) params.set('billing_mode', filters.billingMode)
}

// ── raw sub2api 响应形状（snake_case，仅本文件内部使用）──

interface RawEndpointStat {
  endpoint: string
  requests: number
  total_tokens: number
  cost: number
  actual_cost: number
}

interface RawUsageStats {
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_creation_tokens: number
  total_cache_read_tokens: number
  total_tokens: number
  total_cost: number
  total_actual_cost: number
  average_duration_ms: number
  endpoints?: RawEndpointStat[] | null
}

interface RawModelStat {
  model: string
  requests: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens: number
  cost: number
  actual_cost: number
}

interface RawModelsData {
  models: RawModelStat[]
  start_date: string
  end_date: string
}

interface RawGroupStat {
  group_id: number
  group_name: string
  requests: number
  total_tokens: number
  cost: number
  actual_cost: number
}

interface RawTrendPoint {
  date: string
  requests: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens: number
  cost: number
  actual_cost: number
}

interface RawSnapshot {
  start_date: string
  end_date: string
  granularity: string
  trend?: RawTrendPoint[] | null
  groups?: RawGroupStat[] | null
}

interface RawLogRef {
  id: number
  name: string
}

interface RawUsageLog {
  id: number
  request_id: string
  model: string
  reasoning_effort?: string | null
  inbound_endpoint?: string | null
  ip_address?: string | null
  request_type: string
  billing_mode?: string | null
  billing_type: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  rate_multiplier: number
  total_cost: number
  actual_cost: number
  duration_ms: number | null
  first_token_ms: number | null
  created_at: string
  api_key?: RawLogRef | null
  group?: RawLogRef | null
}

interface RawListData {
  items: RawUsageLog[]
  total: number
  page: number
  page_size: number
  pages: number
}

interface RawApiKey {
  id: number
  name: string
}

interface RawGroup {
  id: number
  name: string
}

// ── mappers ──

function mapEndpointStat(r: RawEndpointStat): UsageEndpointStat {
  return {
    endpoint: r.endpoint,
    requests: r.requests,
    totalTokens: r.total_tokens,
    cost: r.cost,
    actualCost: r.actual_cost
  }
}

function mapModelStat(r: RawModelStat): UsageModelStat {
  return {
    model: r.model,
    requests: r.requests,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    totalTokens: r.total_tokens,
    cost: r.cost,
    actualCost: r.actual_cost
  }
}

function mapGroupStat(r: RawGroupStat): UsageGroupStat {
  return {
    groupId: r.group_id,
    groupName: r.group_name,
    requests: r.requests,
    totalTokens: r.total_tokens,
    cost: r.cost,
    actualCost: r.actual_cost
  }
}

function mapTrendPoint(r: RawTrendPoint): UsageTrendPoint {
  return {
    date: r.date,
    requests: r.requests,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    totalTokens: r.total_tokens,
    cost: r.cost,
    actualCost: r.actual_cost
  }
}

function mapLogRef(r?: RawLogRef | null): UsageLogRef | null {
  return r ? { id: r.id, name: r.name } : null
}

function mapUsageLog(r: RawUsageLog): UsageLogItem {
  return {
    id: r.id,
    requestId: r.request_id,
    model: r.model,
    reasoningEffort: r.reasoning_effort ?? null,
    inboundEndpoint: r.inbound_endpoint ?? null,
    ipAddress: r.ip_address ?? null,
    requestType: r.request_type,
    billingMode: r.billing_mode ?? null,
    billingType: r.billing_type,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    totalTokens:
      r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens,
    rateMultiplier: r.rate_multiplier,
    totalCost: r.total_cost,
    actualCost: r.actual_cost,
    durationMs: r.duration_ms,
    firstTokenMs: r.first_token_ms,
    createdAt: r.created_at,
    apiKey: mapLogRef(r.api_key),
    group: mapLogRef(r.group)
  }
}

/** 筛选器下拉数据源：API 密钥（取前 100 条）+ 全部可用分组。 */
export async function getUsageFilterOptions(): Promise<UsageFilterOptionsResult> {
  const [keysResult, groupsResult] = await Promise.all([
    authedGet<{ items: RawApiKey[] }>('/api/v1/keys?page=1&page_size=100'),
    authedGet<RawGroup[]>('/api/v1/groups/available')
  ])
  if (!keysResult.ok) {
    return {
      ok: false,
      error: translateError(keysResult.reason, keysResult.message, '加载 API 密钥列表失败')
    }
  }
  const data: UsageFilterOptions = {
    apiKeys: keysResult.data.items.map((k) => ({ id: k.id, name: k.name })),
    // 分组接口失败时回落空数组而不是整体失败——「分组」筛选项缺失不该
    // 挡住整个筛选器区渲染，用户还能用其它维度筛选。
    groups: groupsResult.ok ? groupsResult.data.map((g) => ({ id: g.id, name: g.name })) : []
  }
  return { ok: true, data }
}

/** 统计卡片 + 端点分布（sub2api `GET /usage/stats`）。 */
export async function getUsageStats(filters: UsageQueryFilters): Promise<UsageStatsResult> {
  const params = new URLSearchParams()
  appendFilters(params, filters)
  const result = await authedGet<RawUsageStats>(`/api/v1/usage/stats?${params}`)
  if (!result.ok) {
    return { ok: false, error: translateError(result.reason, result.message, '加载统计数据失败') }
  }

  const r = result.data
  const stats: UsageStats = {
    totalRequests: r.total_requests,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    totalCacheCreationTokens: r.total_cache_creation_tokens,
    totalCacheReadTokens: r.total_cache_read_tokens,
    totalTokens: r.total_tokens,
    totalCost: r.total_cost,
    totalActualCost: r.total_actual_cost,
    averageDurationMs: r.average_duration_ms,
    endpoints: (r.endpoints ?? []).map(mapEndpointStat)
  }
  return { ok: true, data: stats }
}

/** 「模型分布」图表数据（sub2api `GET /usage/dashboard/models`）。 */
export async function getUsageModels(filters: UsageQueryFilters): Promise<UsageModelsResult> {
  const params = new URLSearchParams()
  appendFilters(params, filters)
  const result = await authedGet<RawModelsData>(`/api/v1/usage/dashboard/models?${params}`)
  if (!result.ok) {
    return { ok: false, error: translateError(result.reason, result.message, '加载模型分布失败') }
  }

  const data: UsageModelsData = {
    models: result.data.models.map(mapModelStat),
    startDate: result.data.start_date,
    endDate: result.data.end_date
  }
  return { ok: true, data }
}

/**
 * 「Token 使用趋势」+「分组使用分布」（sub2api `GET /usage/dashboard/snapshot-v2`）。
 * 固定 `include_trend=true`/`include_group_stats=true`/`include_model_stats=false`
 * ——模型分布走 {@link getUsageModels} 单独拉，这里不重复取。
 */
export async function getUsageSnapshot(
  filters: UsageQueryFilters,
  granularity: 'day' | 'hour'
): Promise<UsageSnapshotResult> {
  const params = new URLSearchParams()
  appendFilters(params, filters)
  params.set('granularity', granularity)
  params.set('include_trend', 'true')
  params.set('include_model_stats', 'false')
  params.set('include_group_stats', 'true')
  const result = await authedGet<RawSnapshot>(`/api/v1/usage/dashboard/snapshot-v2?${params}`)
  if (!result.ok) {
    return { ok: false, error: translateError(result.reason, result.message, '加载趋势数据失败') }
  }

  const r = result.data
  const snapshot: UsageSnapshot = {
    startDate: r.start_date,
    endDate: r.end_date,
    granularity: r.granularity === 'hour' ? 'hour' : 'day',
    trend: (r.trend ?? []).map(mapTrendPoint),
    groups: (r.groups ?? []).map(mapGroupStat)
  }
  return { ok: true, data: snapshot }
}

/** 分页明细表（sub2api `GET /usage`）；CSV 导出复用这一个函数循环翻页拉全量。 */
export async function getUsageList(query: UsageListQuery): Promise<UsageListResult> {
  const params = new URLSearchParams()
  appendFilters(params, query)
  params.set('page', String(query.page))
  params.set('page_size', String(query.pageSize))
  if (query.sortBy) params.set('sort_by', query.sortBy)
  if (query.sortOrder) params.set('sort_order', query.sortOrder)
  const result = await authedGet<RawListData>(`/api/v1/usage?${params}`)
  if (!result.ok) {
    return { ok: false, error: translateError(result.reason, result.message, '加载明细列表失败') }
  }

  const r = result.data
  const data: UsageListData = {
    items: r.items.map(mapUsageLog),
    total: r.total,
    page: r.page,
    pageSize: r.page_size,
    pages: r.pages
  }
  return { ok: true, data }
}
