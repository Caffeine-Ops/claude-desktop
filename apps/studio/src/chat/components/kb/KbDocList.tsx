import React from 'react'
import { useT } from '../../i18n'
import type { KbDocEntry } from '@desktop-shared/kbAdmin'
import { kbIcons } from './kbIcons'

function fmtSize(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function fmtTime(ms: number | null): string { return ms == null ? '—' : new Date(ms).toLocaleDateString() }

/**
 * 右侧文档列表——纯展示 + 行内动作。改结构类编辑（重命名/移动/删除）已按用户要求下线：
 * 应用内部是托管副本，改了不反映到本地原始文件夹，留着只会误导（2026-07-07）。整理回本地
 * 文件夹做、再重新导入。故行内只留三个无「改结构」副作用的动作：重试失败件、预览、打开原件
 * （重试只是重跑一遍转换，不改分类结构，仅可写库显示）。
 */
export function KbDocList({ docs, readOnly, onRetry, onOpen, onPreview }: {
  docs: KbDocEntry[]
  readOnly: boolean
  onRetry: (d: KbDocEntry) => void
  onOpen: (d: KbDocEntry) => void
  onPreview: (d: KbDocEntry) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="divide-y divide-border/50">
      {docs.map((d) => (
        <div key={d.relPath} className="flex items-center gap-3 px-3 py-2 text-[12.5px] hover:bg-hover/40">
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
            <kbIcons.doc className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">{d.title}</span>
          <span className="w-16 shrink-0 text-muted-foreground/70">{d.ext || '—'}</span>
          <span className="w-16 shrink-0 text-right text-muted-foreground/70">{fmtSize(d.sizeBytes)}</span>
          <span className="w-24 shrink-0 text-right text-muted-foreground/70">{fmtTime(d.importedAtMs)}</span>
          <span className={'w-20 shrink-0 text-right ' + (d.status === 'failed' ? 'text-destructive' : 'text-muted-foreground/80')}>
            {d.status === 'failed' ? t('kbStatusFailed') : t('kbStatusIndexed')}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground/70">
            {!readOnly && d.status === 'failed' && (
              <button type="button" title={t('kbRetry')} onClick={() => onRetry(d)} className="rounded p-1 hover:bg-hover hover:text-foreground"><kbIcons.retry className="size-3.5" /></button>
            )}
            <button type="button" title={t('kbPreview')} onClick={() => onPreview(d)} className="rounded p-1 hover:bg-hover hover:text-foreground"><kbIcons.doc className="size-3.5" /></button>
            <button type="button" title={t('kbOpenSource')} onClick={() => onOpen(d)} className="rounded p-1 hover:bg-hover hover:text-foreground"><kbIcons.open className="size-3.5" /></button>
          </span>
        </div>
      ))}
    </div>
  )
}
