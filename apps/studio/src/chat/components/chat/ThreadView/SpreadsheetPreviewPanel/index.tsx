import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Minus, Plus, RotateCw, X } from 'lucide-react'

import { useT } from '../../../../i18n'
import { useSheetPreviewStore } from '../../../../stores/filePreview'
import { Button } from '@/src/components/ui/button'
import {
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  SHEET_ZOOM_MAX,
  SHEET_ZOOM_MIN
} from './constants'
import type { SheetSnapshotResult } from './buildSnapshot'

/* ─────────────── Spreadsheet preview panel (right pane) ─────────────── */

/**
 * 右侧表格预览面板:用户点成果卡片里的 xlsx / xls / csv 文件时,在应用
 * 内直接铺开表格内容,替代跳出去开 Excel 的割裂体验(用户没装 Office
 * 时 shell.openPath 甚至直接失败)。生命周期最简:
 *
 *   点卡片 → useSheetPreviewStore.openPreview(path) → ThreadView 分栏、
 *   本面板按 path 走 SHEET_FILE_READ 拿原始字节 → buildSnapshot 解析 →
 *   UniverSheetView 渲染;✕ / 切会话 → closePreview。
 *
 * 2026-07-08 起渲染内核迁到 Univer(开源 preset):
 *   - 本壳层只管应用 UI 面(顶栏/sheet tab 条/截断与刷新提示/加载错误
 *     态),全部跟随应用主题;
 *   - 表格画布、选区、缩放、冻结窗格、条件格式、公式计算全在
 *     UniverSheetView(独立 chunk,React.lazy 拉起——Univer + 双库的
 *     解析链是 MB 级依赖,不进聊天首屏);
 *   - 文件解析(buildSnapshot)同样动态 import。壳层对重依赖只允许
 *     type-only import,常量走 ./constants(见该文件头注释)。
 *
 * 布局与 workflow 脚本面板完全同构:chat 列收窄成持久化的 chatColWidth
 * rail 在左,面板 flex-1 吃大头在右(表格要宽)。slides / proposal 分栏
 * 时让位(卡片点击自身降级回系统应用打开,见 useSplitWorkspaceBusy)。
 */

const UniverSheetView = lazy(() => import('./UniverSheetView'))

type ParseState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; result: SheetSnapshotResult }

export function SpreadsheetPreviewPanel(): React.JSX.Element | null {
  const t = useT()
  const path = useSheetPreviewStore((s) => s.path)
  const closePreview = useSheetPreviewStore((s) => s.closePreview)
  const [state, setState] = useState<ParseState>({ phase: 'loading' })
  const [activeSheet, setActiveSheet] = useState(0)
  const [zoom, setZoom] = useState(1)
  // 盘上文件变更检测:读文件时记 mtime/size 基准,打开期间轮询对比,
  // 变了浮「刷新」提示条;点刷新 bump reloadTick 重新解析(zoom/当前
  // sheet 保留,别把用户看到一半的状态抖掉)。
  const [stale, setStale] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const stampRef = useRef<{ m: number; s: number } | null>(null)
  /** 用户点 ✕ 忽略的那个版本——同版本不再弹,文件再变(新 mtime)照弹。 */
  const dismissedRef = useRef<{ m: number; s: number } | null>(null)

  // 换文件才回第一个 sheet;点「刷新」重载(reloadTick)保持当前 sheet。
  useEffect(() => {
    setActiveSheet(0)
  }, [path])

  useEffect(() => {
    if (path === null) return
    let cancelled = false
    setState({ phase: 'loading' })
    setStale(false)
    dismissedRef.current = null
    const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : ''
    ;(async () => {
      const res = await window.chatApi.readSheetFile({ absPath: path })
      if (cancelled) return
      if (!res.ok || !res.data) {
        setState({ phase: 'error', message: res.error ?? 'read failed' })
        return
      }
      stampRef.current =
        res.mtimeMs !== undefined ? { m: res.mtimeMs, s: res.size ?? 0 } : null
      // 解析链(xlsx/exceljs/OOXML 手解 → Univer snapshot)整体动态
      // import,聊天首屏 bundle 零负担。
      const { buildSheetSnapshot } = await import('./buildSnapshot')
      const fileName = path.split('/').pop() ?? path
      const result = await buildSheetSnapshot(res.data, ext, fileName)
      if (cancelled) return
      setState({ phase: 'ready', result })
    })().catch((err: unknown) => {
      if (!cancelled) {
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [path, reloadTick])

  // 盘上变更轮询:预览就绪期间每 3s stat 一次,mtime/size 偏离读取基准
  // 且不是已被忽略的版本 → 浮「刷新」提示条。
  useEffect(() => {
    if (path === null || state.phase !== 'ready') return
    const id = window.setInterval(() => {
      void window.chatApi.statSheetFile({ absPath: path }).then((r) => {
        if (!r.ok || r.mtimeMs === undefined) return
        const stamp = stampRef.current
        if (!stamp) return
        const changed = r.mtimeMs !== stamp.m || (r.size ?? 0) !== stamp.s
        if (!changed) return
        const dis = dismissedRef.current
        if (dis && dis.m === r.mtimeMs && dis.s === (r.size ?? 0)) return
        dismissedRef.current = null
        setStale(true)
      })
    }, 3000)
    return () => window.clearInterval(id)
  }, [path, state.phase])

  if (path === null) return null
  const fileName = path.split('/').pop() ?? path

  const sheets = state.phase === 'ready' ? state.result.sheets : []
  const active = sheets[Math.min(activeSheet, Math.max(0, sheets.length - 1))]

  const clampZoom = (z: number): number =>
    Math.min(SHEET_ZOOM_MAX, Math.max(SHEET_ZOOM_MIN, Math.round(z * 100) / 100))

  const refreshPreview = (): void => {
    setStale(false)
    setReloadTick((tick) => tick + 1)
  }
  const dismissStale = (): void => {
    setStale(false)
    // 记住被忽略的盘上版本:同版本不再弹,文件再变照弹。
    void window.chatApi.statSheetFile({ absPath: path }).then((r) => {
      if (r.ok && r.mtimeMs !== undefined) {
        dismissedRef.current = { m: r.mtimeMs, s: r.size ?? 0 }
      }
    })
  }

  const loadingBody = (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
      <span
        aria-hidden
        className="tc-breathe inline-block size-1.5 rounded-full bg-brand"
      />
      <span className="tool-loading-dots">{t('sheetPreviewLoading')}</span>
    </div>
  )

  return (
    <div className="workspace-split-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[4px] bg-card">
      {/* 盘上文件变更提示条:悬浮在顶栏下方,点击重新解析(保留 zoom/
          当前 sheet),✕ 忽略本次变更。 */}
      {stale && (
        <div className="pointer-events-none absolute inset-x-0 top-[54px] z-30 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-foreground py-1 pl-3 pr-1 text-background shadow-[0_8px_24px_-6px_rgba(0,0,0,0.4)]">
            <button
              type="button"
              onClick={refreshPreview}
              className="flex items-center gap-1.5 text-[12.5px] font-medium"
            >
              <RotateCw className="size-3.5" />
              {t('sheetPreviewStale')}
            </button>
            <button
              type="button"
              aria-label={t('sheetPreviewStaleDismiss')}
              onClick={dismissStale}
              className="grid size-6 place-items-center rounded-full transition-colors hover:bg-background/20"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}
      {/* 顶栏 —— 46px 与 ChatHeader 同高同 hairline(同 WorkflowScriptPanel
          的对齐纪律)。窗口拖拽由根 layout 的 .window-drag-strip 统一负责,
          本栏不声明 drag;所有按钮 no-drag 在 strip 上挖洞。 */}
      <div className="flex h-[46px] shrink-0 select-none items-center gap-2.5 border-b border-border/55 px-3.5">
        {/* 表格徽章:与 DeliverableCard 的 X 徽章同色系,小一号。 */}
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-[#217346] text-[10px] font-bold text-white"
        >
          X
        </span>
        <span
          title={path}
          className="min-w-0 truncate text-[13px] font-medium text-foreground"
        >
          {fileName}
        </span>
        {state.phase === 'ready' && active && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
            {t('sheetPreviewDims')
              .replaceAll('{rows}', String(active.totalRows))
              .replaceAll('{cols}', String(active.totalCols))}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          {/* 缩放控件:− 百分比 +,点百分比回 100%。⌘/Ctrl+滚轮在
              Univer 视图里同步(SheetZoomChanged 事件回报)。 */}
          {state.phase === 'ready' && (
            <span className="mr-1 flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('sheetPreviewZoomOut')}
                disabled={zoom <= SHEET_ZOOM_MIN}
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => setZoom((z) => clampZoom(z / 1.25))}
              >
                <Minus className="size-3.5" />
              </Button>
              <button
                type="button"
                title={t('sheetPreviewZoomReset')}
                onClick={() => setZoom(1)}
                className="min-w-11 rounded-md px-1 py-0.5 text-center text-[11.5px] tabular-nums text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('sheetPreviewZoomIn')}
                disabled={zoom >= SHEET_ZOOM_MAX}
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => setZoom((z) => clampZoom(z * 1.25))}
              >
                <Plus className="size-3.5" />
              </Button>
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              void window.chatApi.openPath({ absPath: path })
            }}
          >
            {t('sheetPreviewOpenExternal')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('sheetPreviewClose')}
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={closePreview}
          >
            <X className="size-4" />
          </Button>
        </span>
      </div>

      {/* Sheet tab 条 —— 多 sheet 才出现,横向滚动。切换经 prop 驱动
          Univer 的 setActiveSheet(Univer 自带 footer 已关)。 */}
      {sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/55 px-2.5 py-1.5">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={
                'shrink-0 rounded-md px-2.5 py-1 text-[12px] transition-colors ' +
                (i === activeSheet
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-hover/60 hover:text-foreground')
              }
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 截断提示条 —— 只在当前 sheet 真被截了才出现。 */}
      {active && (active.totalRows > SHEET_MAX_ROWS || active.totalCols > SHEET_MAX_COLS) && (
        <div className="shrink-0 border-b border-border/55 bg-muted/40 px-3.5 py-1.5 text-[11.5px] text-muted-foreground">
          {t('sheetPreviewTruncated')
            .replaceAll('{rows}', String(Math.min(active.totalRows, SHEET_MAX_ROWS)))
            .replaceAll('{total}', String(active.totalRows))}
        </div>
      )}

      {/* 内容区 */}
      {state.phase === 'loading' ? (
        loadingBody
      ) : state.phase === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-[13px] text-muted-foreground">
            {t('sheetPreviewError')}
          </p>
          <p className="max-w-full break-all text-[11.5px] text-muted-foreground/70">
            {state.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[12.5px]"
            onClick={() => {
              void window.chatApi.openPath({ absPath: path })
            }}
          >
            {t('sheetPreviewOpenExternal')}
          </Button>
        </div>
      ) : sheets.length > 0 ? (
        // key 绑定文件 + 刷新代:换文件/点刷新 → Univer 实例整体重建
        // (实例状态与 React 状态一起清零,见 UniverSheetView 头注释)。
        <Suspense fallback={loadingBody}>
          <UniverSheetView
            key={`${path}:${reloadTick}`}
            snapshot={state.result.snapshot}
            sheets={state.result.sheets}
            activeIndex={Math.min(activeSheet, sheets.length - 1)}
            path={path}
            zoom={zoom}
            onZoomChange={setZoom}
          />
        </Suspense>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
          {t('sheetPreviewEmpty')}
        </div>
      )}
    </div>
  )
}
