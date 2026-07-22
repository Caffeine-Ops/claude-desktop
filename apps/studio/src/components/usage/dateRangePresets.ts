/**
 * 使用记录页的时间范围预设——纯函数，照抄 sub2api 前端
 * `DateRangePicker.vue`/`getGranularityForRange` 的语义：预设算出来的都是
 * 本地日历日（YYYY-MM-DD），不是精确到秒的时间戳；粒度按「起止日期天数差
 * ≤1 天 → 按小时」自动判定，用户可在下拉里手动覆盖。
 */

export type UsageDateRangePresetKey =
  | 'today'
  | 'yesterday'
  | 'last24Hours'
  | '7days'
  | '14days'
  | '30days'
  | 'thisMonth'
  | 'lastMonth'

export interface UsageDateRange {
  startDate: string
  endDate: string
}

export const DATE_RANGE_PRESETS: Array<{ key: UsageDateRangePresetKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'last24Hours', label: '近24小时' },
  { key: '7days', label: '近7天' },
  { key: '14days', label: '近14天' },
  { key: '30days', label: '近30天' },
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' }
]

function fmt(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, delta: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + delta)
  return next
}

export function computeDateRange(key: UsageDateRangePresetKey, now: Date = new Date()): UsageDateRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (key) {
    case 'today':
      return { startDate: fmt(today), endDate: fmt(today) }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { startDate: fmt(y), endDate: fmt(y) }
    }
    case 'last24Hours':
      return { startDate: fmt(addDays(today, -1)), endDate: fmt(today) }
    case '7days':
      return { startDate: fmt(addDays(today, -6)), endDate: fmt(today) }
    case '14days':
      return { startDate: fmt(addDays(today, -13)), endDate: fmt(today) }
    case '30days':
      return { startDate: fmt(addDays(today, -29)), endDate: fmt(today) }
    case 'thisMonth':
      return { startDate: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), endDate: fmt(today) }
    case 'lastMonth': {
      const lastMonthEnd = addDays(new Date(today.getFullYear(), today.getMonth(), 1), -1)
      const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1)
      return { startDate: fmt(lastMonthStart), endDate: fmt(lastMonthEnd) }
    }
  }
}

/** 起止日期（YYYY-MM-DD）的天数差，UTC 换算避开夏令时/本地时区的边界抖动。 */
export function daysBetween(startDate: string, endDate: string): number {
  const [sy, sm, sd] = startDate.split('-').map(Number)
  const [ey, em, ed] = endDate.split('-').map(Number)
  const start = Date.UTC(sy, sm - 1, sd)
  const end = Date.UTC(ey, em - 1, ed)
  return Math.round((end - start) / 86_400_000)
}

/** 跨度 ≤1 天 → 按小时，否则按天——初始粒度的自动判定，用户可在下拉里手动覆盖。 */
export function getGranularityForRange(startDate: string, endDate: string): 'day' | 'hour' {
  return daysBetween(startDate, endDate) <= 1 ? 'hour' : 'day'
}

export function resolveTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
