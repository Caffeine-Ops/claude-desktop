'use client'

import { Columns3, Download, Loader2, RotateCcw } from 'lucide-react'

import { Button } from '@/src/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/src/components/ui/select'
import { UsageFilterCombobox, type UsageComboboxOption } from './UsageFilterCombobox'
import { USAGE_TABLE_COLUMNS } from './usageTableColumns'

const REQUEST_TYPE_OPTIONS = [
  { value: 'sync', label: '同步' },
  { value: 'stream', label: '流式' },
  { value: 'ws_v2', label: 'WebSocket' },
  { value: 'cyber', label: 'Cyber' }
]

const BILLING_TYPE_OPTIONS = [
  { value: '0', label: '余额' },
  { value: '1', label: '订阅' }
]

const BILLING_MODE_OPTIONS = [
  { value: 'token', label: '按 Token' },
  { value: 'per_request', label: '按请求' },
  { value: 'image', label: '按图片' },
  { value: 'video', label: '按视频' }
]

export interface UsageFilterValues {
  apiKeyId: number | null
  model: string | null
  groupId: number | null
  requestType: string | null
  billingType: number | null
  billingMode: string | null
}

export function UsageFilters({
  apiKeyOptions,
  modelOptions,
  groupOptions,
  values,
  onChange,
  visibleColumns,
  onToggleColumn,
  onRefresh,
  onReset,
  onExportCsv,
  exporting
}: {
  apiKeyOptions: UsageComboboxOption[]
  modelOptions: UsageComboboxOption[]
  groupOptions: UsageComboboxOption[]
  values: UsageFilterValues
  onChange: (next: UsageFilterValues) => void
  visibleColumns: Set<string>
  onToggleColumn: (key: string, visible: boolean) => void
  onRefresh: () => void
  onReset: () => void
  onExportCsv: () => void
  exporting: boolean
}) {
  return (
    <div className="flex flex-wrap items-end gap-2.5">
      <div className="min-w-[150px] flex-1">
        <p className="mb-1 text-[12px] text-muted-foreground">API 密钥</p>
        <UsageFilterCombobox
          label="API 密钥"
          options={apiKeyOptions}
          value={values.apiKeyId === null ? null : String(values.apiKeyId)}
          onChange={(v) => onChange({ ...values, apiKeyId: v === null ? null : Number(v) })}
        />
      </div>
      <div className="min-w-[150px] flex-1">
        <p className="mb-1 text-[12px] text-muted-foreground">模型</p>
        <UsageFilterCombobox
          label="模型"
          options={modelOptions}
          value={values.model}
          onChange={(v) => onChange({ ...values, model: v })}
        />
      </div>
      <div className="min-w-[150px] flex-1">
        <p className="mb-1 text-[12px] text-muted-foreground">分组</p>
        <UsageFilterCombobox
          label="分组"
          options={groupOptions}
          value={values.groupId === null ? null : String(values.groupId)}
          onChange={(v) => onChange({ ...values, groupId: v === null ? null : Number(v) })}
        />
      </div>
      <div className="min-w-[130px] flex-1">
        <p className="mb-1 text-[12px] text-muted-foreground">类型</p>
        <Select
          value={values.requestType ?? '__all__'}
          onValueChange={(v) => onChange({ ...values, requestType: v === '__all__' ? null : v })}
        >
          <SelectTrigger className="h-9 w-full"><SelectValue placeholder="请选择" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部类型</SelectItem>
            {REQUEST_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-[130px] flex-1">
        <p className="mb-1 text-[12px] text-muted-foreground">计费类型</p>
        <Select
          value={values.billingType === null ? '__all__' : String(values.billingType)}
          onValueChange={(v) => onChange({ ...values, billingType: v === '__all__' ? null : Number(v) })}
        >
          <SelectTrigger className="h-9 w-full"><SelectValue placeholder="全部计费类型" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部计费类型</SelectItem>
            {BILLING_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-[130px] flex-1">
        <p className="mb-1 text-[12px] text-muted-foreground">计费模式</p>
        <Select
          value={values.billingMode ?? '__all__'}
          onValueChange={(v) => onChange({ ...values, billingMode: v === '__all__' ? null : v })}
        >
          <SelectTrigger className="h-9 w-full"><SelectValue placeholder="全部计费模式" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部计费模式</SelectItem>
            {BILLING_MODE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} className="h-9">
          刷新
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onReset} className="h-9">
          <RotateCcw className="size-3.5" />
          重置
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-9">
              <Columns3 className="size-3.5" />
              列设置
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {USAGE_TABLE_COLUMNS.map((col) => (
              <DropdownMenuCheckboxItem
                key={col.key}
                checked={visibleColumns.has(col.key)}
                onCheckedChange={(checked) => onToggleColumn(col.key, checked === true)}
                onSelect={(e) => e.preventDefault()}
              >
                {col.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" size="sm" onClick={onExportCsv} disabled={exporting} className="h-9">
          {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          导出 CSV
        </Button>
      </div>
    </div>
  )
}
