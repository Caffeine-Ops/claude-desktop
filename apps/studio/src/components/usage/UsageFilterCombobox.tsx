'use client'

/**
 * 轻量可搜索下拉——用现成 Popover + Input 手写过滤列表，不引入 cmdk：
 * API 密钥/模型/分组的候选量级都是几十条封顶（keys 接口 page_size=100，
 * 模型/分组更少），不值得为这点数据量再加一个新依赖。
 */

import { Check, ChevronsUpDown, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/src/components/ui/button'
import { Input } from '@/src/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/src/components/ui/popover'
import { cn } from '@/src/lib/utils'

export interface UsageComboboxOption {
  value: string
  label: string
}

export function UsageFilterCombobox({
  label,
  options,
  value,
  onChange,
  placeholder = '请选择'
}: {
  label: string
  options: UsageComboboxOption[]
  value: string | null
  onChange: (value: string | null) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  const selected = options.find((o) => o.value === value) ?? null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full min-w-0 justify-between gap-1.5 px-3 font-normal"
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : placeholder}
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            {selected ? (
              <span
                role="button"
                aria-label={`清除${label}筛选`}
                data-slot="usage-combobox-clear"
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(null)
                }}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </span>
            ) : null}
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0">
        <div className="border-b p-1.5">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`搜索${label}…`}
            className="h-8"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">无匹配结果</p>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                data-slot="usage-combobox-item"
                onClick={() => {
                  onChange(option.value === value ? null : option.value)
                  setOpen(false)
                  setQuery('')
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                  option.value === value && 'bg-accent/60'
                )}
              >
                <Check
                  className={cn('size-3.5 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')}
                />
                <span className="truncate">{option.label}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
