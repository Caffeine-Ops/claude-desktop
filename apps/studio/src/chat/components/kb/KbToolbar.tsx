import React, { useState } from 'react'
import { useKbStore } from '../../stores/kb'
import { useT, useTFormat } from '../../i18n'
import { kbIcons } from './kbIcons'

/**
 * 顶部工具栏：同步本地文件夹（增量刷新）、空库时的批量迁移入口、构建进度、工具缺失提示。
 * 「导入/拖拽」单文件进货已按用户要求下线（2026-07-07）：本地文件夹是唯一真相，进货只走
 * 迁移/同步；单独导入的文件不在本地源里，下次同步会被当孤儿删掉，是个坑。
 */
export function KbToolbar({ readOnly }: {
  readOnly: boolean
}): React.JSX.Element {
  const t = useT()
  const tFormat = useTFormat()
  const tooling = useKbStore((s) => s.tooling)
  const build = useKbStore((s) => s.build)
  const refresh = useKbStore((s) => s.refresh)
  const total = useKbStore((s) => s.total)
  const [busy, setBusy] = useState(false)

  const migrate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await window.chatApi.kbMigrateFromFolder()
      if (r) { await refresh(); alert(tFormat('kbMigrateDone', { n: r.imported })) }
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err))
    } finally { setBusy(false) }
  }

  // 增量同步本地源文件夹（「刷新」）：把库对齐成本地当前状态（增/删/改），只重转变动件。
  const sync = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await window.chatApi.kbSyncFromLocal()
      if (r) { await refresh(); alert(tFormat('kbSyncDone', { a: r.added, u: r.updated, d: r.deleted })) }
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err))
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-2 border-b border-border/50 px-4 py-2">
      <div className="flex items-center gap-2">
        {/* 只读库（远程托管，「本库由主编机管理」）整块隐藏写入口——与树分类图标/空态
            新建/文档行操作的 !readOnly 收敛一致。留 disabled 还会露一个灰按钮，
            与顶部只读横幅矛盾（横幅说别人管、按钮却在），所以直接不渲染。 */}
        {!readOnly && (
          <>
            <button type="button" disabled={busy} onClick={() => void sync()} title={t('kbSyncLocalHint')}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12px] font-medium hover:bg-muted/60 disabled:opacity-50">
              <kbIcons.refresh className="size-3.5" />{t('kbSyncLocal')}
            </button>
            {total === 0 && (
              <button type="button" disabled={busy} onClick={() => void migrate()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12px] font-medium hover:bg-muted/60 disabled:opacity-50">
                {t('kbMigrateCta')}
              </button>
            )}
          </>
        )}
        {build?.running && (
          <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
            <kbIcons.refresh className="size-3.5 animate-spin" />
            {t('kbBuilding')}{build.phase ? ` ${build.phase.done}/${build.phase.total}` : ''}
          </span>
        )}
      </div>
      {/* 工具缺失横幅只对可写机有意义（只读机不本地构建、装不装 markitdown 无所谓）。 */}
      {!readOnly && tooling?.markitdown === false && (
        <p className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          <kbIcons.alert className="size-3.5 shrink-0" />{t('kbToolingMissing')}
        </p>
      )}
    </div>
  )
}
