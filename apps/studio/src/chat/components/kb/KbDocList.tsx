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
 * 右侧文档列表——纯展示 + 行内动作回调。除 onOpen（真接 kbDocOpenSource）外，
 * 本 task（Task 6，只读浏览）传进来的都是桩函数 () => {}；写交互在 Task 7 接上。
 * readOnly 时收敛动作条：只留「预览」「打开原件」两个无副作用的查看动作。
 */
export function KbDocList({ docs, readOnly, onDelete, onMove, onRename, onRetry, onOpen, onPreview }: {
  docs: KbDocEntry[]
  readOnly: boolean
  onDelete: (d: KbDocEntry) => void
  onMove: (d: KbDocEntry) => void
  onRename: (d: KbDocEntry) => void
  onRetry: (d: KbDocEntry) => void
  onOpen: (d: KbDocEntry) => void
  onPreview: (d: KbDocEntry) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="divide-y divide-border/50">
      {docs.map((d) => (
        <div key={d.relPath} className="flex items-center gap-3 px-3 py-2 text-[12.5px] hover:bg-muted/40">
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
          {!readOnly && (
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground/70">
              {d.status === 'failed' && (
                <button type="button" title={t('kbRetry')} onClick={() => onRetry(d)} className="rounded p-1 hover:bg-muted hover:text-foreground"><kbIcons.retry className="size-3.5" /></button>
              )}
              <button type="button" title={t('kbPreview')} onClick={() => onPreview(d)} className="rounded p-1 hover:bg-muted hover:text-foreground"><kbIcons.doc className="size-3.5" /></button>
              <button type="button" title={t('kbOpenSource')} onClick={() => onOpen(d)} className="rounded p-1 hover:bg-muted hover:text-foreground"><kbIcons.open className="size-3.5" /></button>
              <button type="button" title={t('kbRename')} onClick={() => onRename(d)} className="rounded p-1 hover:bg-muted hover:text-foreground"><kbIcons.edit className="size-3.5" /></button>
              <button type="button" title={t('kbMove')} onClick={() => onMove(d)} className="rounded p-1 hover:bg-muted hover:text-foreground"><kbIcons.move className="size-3.5" /></button>
              <button type="button" title={t('kbDelete')} onClick={() => onDelete(d)} className="rounded p-1 hover:bg-muted hover:text-destructive"><kbIcons.trash className="size-3.5" /></button>
            </span>
          )}
          {readOnly && (
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground/70">
              <button type="button" title={t('kbPreview')} onClick={() => onPreview(d)} className="rounded p-1 hover:bg-muted hover:text-foreground"><kbIcons.doc className="size-3.5" /></button>
              <button type="button" title={t('kbOpenSource')} onClick={() => onOpen(d)} className="rounded p-1 hover:bg-muted hover:text-foreground"><kbIcons.open className="size-3.5" /></button>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
