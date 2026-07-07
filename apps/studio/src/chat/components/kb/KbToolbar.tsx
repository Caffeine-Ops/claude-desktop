import React, { useState } from 'react'
import { useKbStore } from '../../stores/kb'
import { useT, useTFormat } from '../../i18n'
import { kbIcons } from './kbIcons'

/**
 * 顶部工具栏：导入（含工具门置灰）、新建产品线的批量迁移入口、构建进度。
 * `sel` 决定导入落点（当前选中的产品线/产品）；未选分类时点导入会提示先选/建分类，
 * 而不是静默导入到某个默认位置——写操作落点必须显式，不能猜。
 */
export function KbToolbar({ sel, readOnly, onImported }: {
  sel: { line: string; product: string | null } | null
  readOnly: boolean
  onImported: () => void
}): React.JSX.Element {
  const t = useT()
  const tFormat = useTFormat()
  const tooling = useKbStore((s) => s.tooling)
  const build = useKbStore((s) => s.build)
  const refresh = useKbStore((s) => s.refresh)
  const total = useKbStore((s) => s.total)
  const [busy, setBusy] = useState(false)

  const canImport = tooling?.markitdown !== false // null(未知)时不置灰，避免闪烁误锁
  const targetLine = sel?.line ?? ''
  const targetProduct = sel?.product ?? ''

  const doImport = async (paths: string[]): Promise<void> => {
    if (!paths.length || busy) return
    if (!targetLine) { alert(t('kbNewLine')); return } // 未选分类先建/选产品线
    setBusy(true)
    try {
      const r = await window.chatApi.kbImport({ paths, productLine: targetLine, product: targetProduct, overwrite: false })
      if (r.conflicted.length > 0 && confirm(tFormat('kbConflictPrompt', { n: r.conflicted.length }))) {
        // 冲突集是按 relPath 命中的一个子集，但这里选择整批 overwrite 重发——未冲突项
        // 已入库，overwrite 对它们是同内容覆盖，无害；换来的是不用在 renderer 侧重新拆分
        // plan（拆分逻辑已经在 main 侧 planImport 里，不重复实现一份）。
        await window.chatApi.kbImport({ paths, productLine: targetLine, product: targetProduct, overwrite: true })
      }
      await refresh()
      onImported()
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const pickAndImport = async (): Promise<void> => {
    const { paths } = await window.chatApi.kbPickImportFiles()
    await doImport(paths)
  }

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

  return (
    <div className="space-y-2 border-b border-border/50 px-4 py-2">
      <div className="flex items-center gap-2">
        {/* 只读库（远程托管，「本库由主编机管理」）整块隐藏写入口——与树分类图标/空态
            新建/文档行操作的 !readOnly 收敛一致。留 disabled 还会露一个灰按钮，
            与顶部只读横幅矛盾（横幅说别人管、按钮却在），所以直接不渲染。 */}
        {!readOnly && (
          <>
            <button type="button" disabled={!canImport || busy} onClick={() => void pickAndImport()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50">
              <kbIcons.import className="size-3.5" />{t('kbImport')}
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
