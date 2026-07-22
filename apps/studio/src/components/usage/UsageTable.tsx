'use client'

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import type { UsageLogItem } from '@desktop-shared/ipc-channels'
import { Button } from '@/src/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/src/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/src/components/ui/table'
import { cn } from '@/src/lib/utils'
import { formatCost, formatCount, formatDuration } from './UsageStatsCards'
import { USAGE_TABLE_COLUMNS } from './usageTableColumns'

const PAGE_SIZE_OPTIONS = [20, 50, 100]

/** 三个真实对应后端列的字段——只有这几列可点击排序（同 usageService.ts 的 sort_by 直通约定）。 */
const SORTABLE_COLUMN_TO_FIELD: Record<string, string> = {
  createdAt: 'created_at',
  actualCost: 'actual_cost',
  durationMs: 'duration_ms'
}

function renderCell(item: UsageLogItem, key: string): ReactNode {
  switch (key) {
    case 'apiKey':
      return item.apiKey?.name ?? '—'
    case 'model':
      return item.model
    case 'reasoningEffort':
      return item.reasoningEffort ?? '—'
    case 'inboundEndpoint':
      return item.inboundEndpoint ?? '—'
    case 'ipAddress':
      return item.ipAddress ?? '—'
    case 'group':
      return item.group?.name ?? '—'
    case 'requestType':
      return item.requestType
    case 'billingMode':
      return item.billingMode ?? '—'
    case 'totalTokens':
      return formatCount(item.totalTokens)
    case 'actualCost':
      return formatCost(item.actualCost)
    case 'durationMs':
      return item.durationMs === null ? '—' : formatDuration(item.durationMs)
    case 'createdAt':
      return new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })
    default:
      return null
  }
}

export function UsageTable({
  items,
  total,
  page,
  pageSize,
  loading,
  visibleColumns,
  sortBy,
  sortOrder,
  onSortChange,
  onPageChange,
  onPageSizeChange
}: {
  items: UsageLogItem[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  visibleColumns: Set<string>
  sortBy: string
  sortOrder: 'asc' | 'desc'
  onSortChange: (sortBy: string, sortOrder: 'asc' | 'desc') => void
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}) {
  const columns = USAGE_TABLE_COLUMNS.filter((c) => visibleColumns.has(c.key))
  const pages = Math.max(1, Math.ceil(total / pageSize))

  const handleHeaderClick = (key: string) => {
    const field = SORTABLE_COLUMN_TO_FIELD[key]
    if (!field) return
    if (sortBy === field) {
      onSortChange(field, sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      onSortChange(field, 'desc')
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className={cn('overflow-x-auto', loading && 'opacity-60 transition-opacity')}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((col) => {
                const field = SORTABLE_COLUMN_TO_FIELD[col.key]
                const active = field && sortBy === field
                return (
                  <TableHead
                    key={col.key}
                    onClick={field ? () => handleHeaderClick(col.key) : undefined}
                    className={cn('whitespace-nowrap text-[12px]', field && 'cursor-pointer select-none')}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {field ? (
                        active ? (
                          sortOrder === 'asc' ? (
                            <ArrowUp className="size-3" />
                          ) : (
                            <ArrowDown className="size-3" />
                          )
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" />
                        )
                      ) : null}
                    </span>
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-[13px] text-muted-foreground">
                  暂无数据
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  {columns.map((col) => (
                    <TableCell key={col.key} className="text-[12.5px] text-foreground">
                      {renderCell(item, col.key)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2.5">
        <p className="text-[12px] text-muted-foreground">
          共 {formatCount(total)} 条 · 第 {page}/{pages} 页
        </p>
        <div className="flex items-center gap-2">
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger size="sm" className="h-7 w-[86px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} 条/页
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={page >= pages}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
