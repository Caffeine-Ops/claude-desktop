import React, { useEffect, useMemo, useState } from 'react'
import { useKbStore } from '../../stores/kb'
import { useT, useTFormat } from '../../i18n'
import { kbIcons } from './kbIcons'
import { KbDocList } from './KbDocList'
import { KbToolbar } from './KbToolbar'
import { KbPreviewModal } from './KbPreviewModal'
import type { KbDocEntry, KbFolderNode } from '@desktop-shared/kbAdmin'

/**
 * 知识库管理页——与 SettingsView 同级的全屏视图（App.tsx 无条件挂载、open=false 时 null）。
 * 左：产品线/产品树（纯浏览/选择）；右：工具栏（导入/迁移/构建进度）+ 选中节点的文档列表。
 *
 * 「改结构」类编辑（分类/文档的 重命名·移动·删除·新建分类）已按用户要求下线（2026-07-07）：
 * 应用内部是从本地文件夹复制来的托管副本，在这里改动不会反映回本地原始文件夹，留着只会误导。
 * 整理请回本地文件夹里做、再走「导入/迁移」重新进货。故本页只保留「进货 + 浏览 + 重试失败件」。
 * 保留的写操作（导入/迁移/重试）走同一模式：调 chatApi → 成功后 refresh() → 失败 alert(err.message)。
 */
export function KbManagerView(): React.JSX.Element | null {
  const open = useKbStore((s) => s.open)
  const closeManager = useKbStore((s) => s.closeManager)
  const tree = useKbStore((s) => s.tree)
  const readOnly = useKbStore((s) => s.readOnly)
  const refresh = useKbStore((s) => s.refresh)
  const subscribeBuild = useKbStore((s) => s.subscribeBuild)
  const t = useT()
  const tFormat = useTFormat()
  const [sel, setSel] = useState<string | null>(null) // 选中文件夹的 path（n 级树，'/' 分隔）
  const [preview, setPreview] = useState<KbDocEntry | null>(null)

  useEffect(() => {
    if (!open) return
    const off = subscribeBuild()
    return off
  }, [open, subscribeBuild])

  const docs: KbDocEntry[] = useMemo(() => {
    if (!tree || sel === null) return []
    const find = (nodes: readonly KbFolderNode[]): KbFolderNode | undefined => {
      for (const n of nodes) { if (n.path === sel) return n; const f = find(n.folders); if (f) return f }
      return undefined
    }
    return find(tree.roots)?.docs ?? []
  }, [tree, sel])

  // ---- 重试失败件：只是重跑一遍转换（不改分类结构），失败行才显示。----
  const onRetry = async (d: KbDocEntry): Promise<void> => {
    try { await window.chatApi.kbRetryDoc(d.relPath); await refresh() } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }

  // ---- 拖拽导入：容器整体接 drop，取文件系统真实路径（webUtils，非 File.path——
  // Electron 较新版本已移除 File.path，pathForFile 是 preload 里唯一合法取路径方式）。
  // 落点是当前选中分类；无选中分类时静默忽略（导入只能进已有分类，新分类靠迁移带结构建）。----
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    if (readOnly || !sel) return
    const paths: string[] = []
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = window.chatApi.pathForFile(f)
      if (p) paths.push(p)
    }
    if (!paths.length) return
    // kbImport 仍是两级 API：取选中路径的前两段作 productLine/product 落点（深层选中会落到其前两级）。
    const segs = sel.split('/')
    const productLine = segs[0] ?? ''
    const product = segs[1] ?? ''
    try {
      const r = await window.chatApi.kbImport({ paths, productLine, product, overwrite: false })
      if (r.conflicted.length && confirm(tFormat('kbConflictPrompt', { n: r.conflicted.length })))
        await window.chatApi.kbImport({ paths, productLine, product, overwrite: true })
      await refresh()
    } catch (err) { alert(String(err instanceof Error ? err.message : err)) }
  }

  // 从旧资料文件夹批量导入（保结构）——空态的主进货路径。
  const migrateFromFolder = async (): Promise<void> => {
    try {
      const r = await window.chatApi.kbMigrateFromFolder()
      if (r) { await refresh(); alert(tFormat('kbMigrateDone', { n: r.imported })) }
    } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }

  if (!open) return null

  const empty = !tree || tree.roots.length === 0

  return (
    <div role="dialog" aria-modal="true" aria-label={t('kbManageTitle')}
      className="absolute inset-0 z-40 flex flex-col bg-background text-foreground"
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onDrop(e)}>
      <div className="flex items-center gap-3 border-b border-border/50 px-6 py-3">
        <button type="button" onClick={closeManager}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          <kbIcons.folder className="size-3.5" /><span>{t('backToApp')}</span>
        </button>
        <h1 className="text-[15px] font-semibold">{t('kbManageTitle')}</h1>
        {readOnly && <span className="ml-2 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t('kbManageReadOnly')}</span>}
      </div>

      {empty && !readOnly ? (
        // 空态但可写：进货入口=从旧资料文件夹批量导入（保结构建分类）。手动新建分类已下线，
        // 分类结构一律由导入的文件夹结构决定。
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground/70">
          <p>{t('kbManageEmpty')}</p>
          <button type="button" onClick={() => void migrateFromFolder()}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted/60">
            {t('kbMigrateCta')}
          </button>
        </div>
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground/70">{t('kbManageEmpty')}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav className="w-60 shrink-0 overflow-y-auto border-r border-border/50 p-2">
            {tree!.roots.map((node) => (
              <KbTreeNode key={node.path} node={node} sel={sel} onSelect={setSel} depth={0} />
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col">
            <KbToolbar sel={sel} readOnly={readOnly} onImported={refresh} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sel ? (
                <KbDocList docs={docs} readOnly={readOnly}
                  onRetry={(d) => void onRetry(d)}
                  onOpen={(d) => void window.chatApi.kbDocOpenSource(d.relPath)}
                  onPreview={(d) => setPreview(d)} />
              ) : (
                <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground/60">{t('kbManageTitle')}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {preview && <KbPreviewModal relPath={preview.relPath} title={preview.title} onClose={() => setPreview(null)} />}
    </div>
  )
}

/** 一个文件夹节点直属+所有后代文件总数（徽标显示，让父节点也能看出体量）。 */
function countDocs(node: KbFolderNode): number {
  return node.docs.length + node.folders.reduce((s, f) => s + countDocs(f), 0)
}

/**
 * 左侧 n 级文件夹树——纯浏览/选择（分类的 新建/重命名/删除 已下线，见文件头注释）。
 * 递归渲染：本文件夹一行（按 depth 缩进 + 文档数徽标），再递归渲染子文件夹。选中即在右侧列其直属文档。
 */
function KbTreeNode({ node, sel, onSelect, depth }: {
  node: KbFolderNode
  sel: string | null
  onSelect: (path: string) => void
  depth: number
}): React.JSX.Element {
  const rowCls = (active: boolean): string =>
    'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px] ' +
    (active ? 'bg-accent/12 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')
  return (
    <div>
      <button type="button" className={rowCls(sel === node.path)}
        style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onSelect(node.path)}>
        <kbIcons.folder className={'size-3.5 shrink-0' + (depth > 0 ? ' opacity-70' : '')} />
        <span className="truncate">{node.name}</span>
        <span className="ml-auto pl-1 text-[10px] text-muted-foreground/50">{countDocs(node)}</span>
      </button>
      {node.folders.map((c) => (
        <KbTreeNode key={c.path} node={c} sel={sel} onSelect={onSelect} depth={depth + 1} />
      ))}
    </div>
  )
}
