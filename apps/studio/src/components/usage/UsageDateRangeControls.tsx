'use client'

import { CalendarDays } from 'lucide-react'

import { Input } from '@/src/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/src/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs'
import { computeDateRange, DATE_RANGE_PRESETS, type UsageDateRange, type UsageDateRangePresetKey } from './dateRangePresets'

/** "2026-07-22" → "07/22"，给下拉每行右侧的日期徽章用，不带年份省地方。 */
function shortDate(d: string): string {
  return d.slice(5).replace('-', '/')
}

/** 徽章文案：同一天显示单日，跨天显示"起–止"——照抄 chat composer 文件夹
 * 选择器每行右侧路径胶囊的信息密度（label 主文案 + 徽章给上下文），这里
 * 徽章给的上下文是这个预设实际落在哪几天，不用先选中才知道。 */
function rangeBadge(key: UsageDateRangePresetKey): string {
  const r = computeDateRange(key)
  return r.startDate === r.endDate ? shortDate(r.startDate) : `${shortDate(r.startDate)}–${shortDate(r.endDate)}`
}

export function UsageDateRangeControls({
  presetKey,
  range,
  granularity,
  onChangePreset,
  onChangeCustomRange,
  onChangeGranularity
}: {
  presetKey: UsageDateRangePresetKey | 'custom'
  range: UsageDateRange
  granularity: 'day' | 'hour'
  onChangePreset: (key: UsageDateRangePresetKey | 'custom') => void
  onChangeCustomRange: (range: UsageDateRange) => void
  onChangeGranularity: (granularity: 'day' | 'hour') => void
}) {
  // 收起态只显示预设名，不带日期徽章——Radix 的 SelectValue 不传 children
  // 时会直接拿选中项的完整内容当显示文本，徽章也会被一起吞进去挤爆胶囊
  // 宽度，必须显式喂给它一个干净的 label。
  const presetLabel = presetKey === 'custom' ? '自定义' : (DATE_RANGE_PRESETS.find((p) => p.key === presetKey)?.label ?? '')

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarDays className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] text-muted-foreground">时间范围：</span>
        <Select value={presetKey} onValueChange={(v) => onChangePreset(v as UsageDateRangePresetKey | 'custom')}>
          {/* 胶囊触发器——照抄 chat composer 文件夹选择器的形状（rounded-full），
              但不带它的 backdrop-blur：那套毛玻璃是为坐在半透明壁纸上调的，
              这里背后是设置页纯色 bg-card，糊上去只会看着脏、没有对应的
              「透出背景」效果可看。 */}
          <SelectTrigger size="sm" className="h-8 w-[136px] rounded-full px-3 hover:bg-hover data-[state=open]:bg-hover">
            <SelectValue>{presetLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent className="min-w-[228px] rounded-xl p-1.5">
            {DATE_RANGE_PRESETS.map((p) => (
              <SelectItem key={p.key} value={p.key} className="rounded-lg text-[13px]">
                <span className="flex w-full items-center justify-between gap-2">
                  <span>{p.label}</span>
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground/80">
                    {rangeBadge(p.key)}
                  </span>
                </span>
              </SelectItem>
            ))}
            <SelectItem value="custom" className="rounded-lg text-[13px]">
              自定义
            </SelectItem>
          </SelectContent>
        </Select>
        {presetKey === 'custom' ? (
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={range.startDate}
              max={range.endDate}
              onChange={(e) => onChangeCustomRange({ ...range, startDate: e.target.value })}
              className="h-8 w-[140px] text-xs"
            />
            <span className="text-muted-foreground">至</span>
            <Input
              type="date"
              value={range.endDate}
              min={range.startDate}
              onChange={(e) => onChangeCustomRange({ ...range, endDate: e.target.value })}
              className="h-8 w-[140px] text-xs"
            />
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground">粒度：</span>
        {/* 二选一改用分段胶囊而不是下拉——跟本页「按 Token / 按实际消费」
            （DistributionBarChart.tsx）、AppearanceSection 的「主题模式」
            是同一个 Tabs 组件，同类二元切换过去混用了 Select，两种写法
            并存在同一页里最扎眼。 */}
        <Tabs value={granularity} onValueChange={(v) => onChangeGranularity(v as 'day' | 'hour')}>
          <TabsList className="h-8 p-0.5">
            <TabsTrigger value="day" className="h-7 px-3 text-[12px]">
              按天
            </TabsTrigger>
            <TabsTrigger value="hour" className="h-7 px-3 text-[12px]">
              按小时
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </div>
  )
}
