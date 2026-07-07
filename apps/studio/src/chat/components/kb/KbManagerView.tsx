import React, { useEffect, useMemo, useState } from 'react'
import { useKbStore } from '../../stores/kb'
import { useT, useTFormat } from '../../i18n'
import { kbIcons } from './kbIcons'
import { KbDocList } from './KbDocList'
import { KbToolbar } from './KbToolbar'
import { KbPreviewModal } from './KbPreviewModal'
import type { KbDocEntry, KbProductLine } from '@desktop-shared/kbAdmin'

/**
 * 知识库管理页——与 SettingsView 同级的全屏视图（App.tsx 无条件挂载、open=false 时 null）。
 * 左：产品线/产品树（含分类 CRUD）；右：工具栏 + 选中节点的文档列表（含写操作 + 预览）。
 * 所有写操作走同一模式：调 chatApi → 成功后 refresh()（重拉树，index.json 是唯一真相源，
 * renderer 不本地乐观更新）→ 失败 alert(err.message)（main 侧 service 已把校验错误做成
 * 中文可读消息，renderer 不重复校验、不重复翻译）。
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
  const [sel, setSel] = useState<{ line: string; product: string | null } | null>(null)
  const [preview, setPreview] = useState<KbDocEntry | null>(null)

  useEffect(() => {
    if (!open) return
    const off = subscribeBuild()
    return off
  }, [open, subscribeBuild])

  const docs: KbDocEntry[] = useMemo(() => {
    if (!tree || !sel) return []
    const line = tree.lines.find((l) => l.name === sel.line)
    if (!line) return []
    if (sel.product === null) return line.rootDocs
    return line.products.find((p) => p.name === sel.product)?.docs ?? []
  }, [tree, sel])

  // ---- 文档级写操作（sel 一定有：这几个回调只会被列表里的行触发，列表来自选中节点）----
  const onDelete = async (d: KbDocEntry): Promise<void> => {
    if (!confirm(tFormat('kbConfirmDeleteDoc', { title: d.title }))) return
    try { await window.chatApi.kbDeleteDoc(d.relPath); await refresh() } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }
  const onRename = async (d: KbDocEntry): Promise<void> => {
    const name = prompt(t('kbRename'), d.title + d.ext)
    if (!name || name === d.title + d.ext) return
    try {
      // 重命名=同分类内移动改文件名，toProductLine/toProduct 原地不变。
      await window.chatApi.kbMoveDoc({ relPath: d.relPath, toProductLine: sel!.line, toProduct: sel!.product ?? '', newFileName: name })
      await refresh()
    } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }
  const onMove = async (d: KbDocEntry): Promise<void> => {
    const line = prompt(t('kbMove') + ' — ' + t('kbColTitle'), sel!.line)
    if (!line) return
    const product = prompt(t('kbNewProduct') + '（可空）', sel!.product ?? '') ?? ''
    try { await window.chatApi.kbMoveDoc({ relPath: d.relPath, toProductLine: line, toProduct: product }); await refresh() }
    catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }
  const onRetry = async (d: KbDocEntry): Promise<void> => {
    try { await window.chatApi.kbRetryDoc(d.relPath); await refresh() } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }

  // ---- 拖拽导入：容器整体接 drop，取文件系统真实路径（webUtils，非 File.path——
  // Electron 较新版本已移除 File.path，pathForFile 是 preload 里唯一合法取路径方式）----
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    if (readOnly || !sel?.line) return
    const paths: string[] = []
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = window.chatApi.pathForFile(f)
      if (p) paths.push(p)
    }
    if (!paths.length) return
    try {
      const r = await window.chatApi.kbImport({ paths, productLine: sel.line, product: sel.product ?? '', overwrite: false })
      if (r.conflicted.length && confirm(tFormat('kbConflictPrompt', { n: r.conflicted.length })))
        await window.chatApi.kbImport({ paths, productLine: sel.line, product: sel.product ?? '', overwrite: true })
      await refresh()
    } catch (err) { alert(String(err instanceof Error ? err.message : err)) }
  }

  // ---- 分类 CRUD：都以「prefix」为句柄（与 main 侧 kbStore.renameCategory/deleteCategory
  // 同一约定——线用线名，产品用 '线/品'，分隔符硬编码 '/' 是安全的：relPath 用 OS 分隔符，
  // 而本项目只发行 mac 包，OS 分隔符恒为 '/'）。重命名/删除后若命中当前选中节点，
  // 同步刷新 sel，否则选中态会挂在一个刚消失的名字上、右侧列表悄悄变空却看不出原因。----
  const newLine = async (): Promise<void> => {
    const name = prompt(t('kbNewLine'))
    if (!name) return
    try { await window.chatApi.kbCreateCategory({ productLine: name }); await refresh() }
    catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }
  const newProduct = async (lineName: string): Promise<void> => {
    const name = prompt(t('kbNewProduct'))
    if (!name) return
    try { await window.chatApi.kbCreateCategory({ productLine: lineName, product: name }); await refresh() }
    catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }
  const renameLine = async (lineName: string): Promise<void> => {
    const name = prompt(t('kbRename'), lineName)
    if (!name || name === lineName) return
    try {
      await window.chatApi.kbRenameCategory({ prefix: lineName, newName: name })
      await refresh()
      if (sel?.line === lineName) setSel({ line: name, product: sel.product })
    } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }
  const deleteLine = async (lineName: string): Promise<void> => {
    if (!confirm(tFormat('kbConfirmDeleteCat', { name: lineName }))) return
    try {
      await window.chatApi.kbDeleteCategory(lineName)
      await refresh()
      if (sel?.line === lineName) setSel(null)
    } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }
  const renameProduct = async (lineName: string, productName: string): Promise<void> => {
    const name = prompt(t('kbRename'), productName)
    if (!name || name === productName) return
    try {
      await window.chatApi.kbRenameCategory({ prefix: `${lineName}/${productName}`, newName: name })
      await refresh()
      if (sel?.line === lineName && sel.product === productName) setSel({ line: lineName, product: name })
    } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }
  const deleteProduct = async (lineName: string, productName: string): Promise<void> => {
    if (!confirm(tFormat('kbConfirmDeleteCat', { name: productName }))) return
    try {
      await window.chatApi.kbDeleteCategory(`${lineName}/${productName}`)
      await refresh()
      // 产品被删后落回其所属产品线的根文档视图，而不是清空选中——删产品不该把
      // 用户弹回空白页，同一产品线下大概率还有别的东西要看。
      if (sel?.line === lineName && sel.product === productName) setSel({ line: lineName, product: null })
    } catch (e) { alert(String(e instanceof Error ? e.message : e)) }
  }

  if (!open) return null

  const empty = !tree || tree.lines.length === 0

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
        // 空态但可写：给一条新建产品线的路，否则空库时用户连第一个分类都建不出来。
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground/70">
          <p>{t('kbManageEmpty')}</p>
          <button type="button" onClick={() => void newLine()}
            className="rounded-md border border-dashed border-border/70 px-3 py-1.5 text-[12.5px] text-muted-foreground hover:border-border hover:text-foreground">
            + {t('kbNewLine')}
          </button>
        </div>
      ) : empty ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground/70">{t('kbManageEmpty')}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav className="w-60 shrink-0 overflow-y-auto border-r border-border/50 p-2">
            {!readOnly && (
              <button type="button" onClick={() => void newLine()}
                className="mb-2 w-full rounded-md border border-dashed border-border/70 px-2 py-1 text-center text-[11.5px] text-muted-foreground hover:border-border hover:text-foreground">
                + {t('kbNewLine')}
              </button>
            )}
            {tree!.lines.map((line) => (
              <KbTreeNode key={line.name} line={line} sel={sel} onSelect={setSel} readOnly={readOnly}
                onNewProduct={newProduct} onRenameLine={renameLine} onDeleteLine={deleteLine}
                onRenameProduct={renameProduct} onDeleteProduct={deleteProduct} />
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col">
            <KbToolbar sel={sel} readOnly={readOnly} onImported={refresh} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sel ? (
                <KbDocList docs={docs} readOnly={readOnly}
                  onDelete={(d) => void onDelete(d)} onMove={(d) => void onMove(d)}
                  onRename={(d) => void onRename(d)} onRetry={(d) => void onRetry(d)}
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

function KbTreeNode({ line, sel, onSelect, readOnly, onNewProduct, onRenameLine, onDeleteLine, onRenameProduct, onDeleteProduct }: {
  line: KbProductLine
  sel: { line: string; product: string | null } | null
  onSelect: (s: { line: string; product: string | null }) => void
  readOnly: boolean
  onNewProduct: (lineName: string) => void
  onRenameLine: (lineName: string) => void
  onDeleteLine: (lineName: string) => void
  onRenameProduct: (lineName: string, productName: string) => void
  onDeleteProduct: (lineName: string, productName: string) => void
}): React.JSX.Element {
  const t = useT()
  const rowCls = (active: boolean): string =>
    'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px] ' +
    (active ? 'bg-accent/12 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')
  // 分类操作按钮只在 hover 时露出（group-hover）：常态下树要保持安静，别让每行都摆着
  // 三个小图标喧宾夺主——这是运维级低频操作，不是主路径。
  return (
    <div className="mb-1">
      <div className="group flex items-center">
        <button type="button" className={rowCls(sel?.line === line.name && sel.product === null) + ' flex-1'}
          onClick={() => onSelect({ line: line.name, product: null })}>
          <kbIcons.folder className="size-3.5 shrink-0" />
          <span className="truncate">{line.name}</span>
        </button>
        {!readOnly && (
          <span className="hidden shrink-0 items-center gap-0.5 pr-1 text-muted-foreground/60 group-hover:flex">
            <button type="button" title={t('kbNewProduct')} onClick={() => onNewProduct(line.name)}
              className="rounded px-1 py-0.5 text-[12px] leading-none hover:bg-muted hover:text-foreground">
              +
            </button>
            <button type="button" title={t('kbRename')} onClick={() => onRenameLine(line.name)}
              className="rounded p-1 hover:bg-muted hover:text-foreground">
              <kbIcons.edit className="size-3" />
            </button>
            <button type="button" title={t('kbDelete')} onClick={() => onDeleteLine(line.name)}
              className="rounded p-1 hover:bg-muted hover:text-destructive">
              <kbIcons.trash className="size-3" />
            </button>
          </span>
        )}
      </div>
      <div className="ml-4">
        {line.products.map((p) => (
          <div key={p.name} className="group flex items-center">
            <button type="button" className={rowCls(sel?.line === line.name && sel.product === p.name) + ' flex-1'}
              onClick={() => onSelect({ line: line.name, product: p.name })}>
              <kbIcons.folder className="size-3.5 shrink-0 opacity-70" />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground/50 group-hover:hidden">{p.docs.length}</span>
            </button>
            {!readOnly && (
              <span className="hidden shrink-0 items-center gap-0.5 pr-1 text-muted-foreground/60 group-hover:flex">
                <button type="button" title={t('kbRename')} onClick={() => onRenameProduct(line.name, p.name)}
                  className="rounded p-1 hover:bg-muted hover:text-foreground">
                  <kbIcons.edit className="size-3" />
                </button>
                <button type="button" title={t('kbDelete')} onClick={() => onDeleteProduct(line.name, p.name)}
                  className="rounded p-1 hover:bg-muted hover:text-destructive">
                  <kbIcons.trash className="size-3" />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
