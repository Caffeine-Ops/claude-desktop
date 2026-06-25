import { useEffect, useState } from 'react'
import { useProposalStore, useProposalForeground, useProposalWorkspace } from '../../stores/proposal'
import type { ProposalExportFormat } from '@shared/ipc-channels'
import { ProposalPaper } from './ProposalPaper'
import { ProposalPreview } from './ProposalPreview'

export function ProposalDocPanel(): React.JSX.Element | null {
  // 与 App.tsx 隐藏右栏同一门控：只对【当前前台会话】是方案会话时显示（评审 #8）。
  const show = useProposalForeground()
  const isWorkspace = useProposalWorkspace()
  const setWorkspaceOpen = useProposalStore((s) => s.setWorkspaceOpen)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  // 只订阅会变的状态切片（sections / products）。下面 4 个 action 是 zustand 稳定引用、
  // 永不变，单独 selector 订阅纯属空跑（store 每次更新都白跑一遍）——改从 getState()
  // 一次性取出、不订阅（C5）。
  const sections = useProposalStore((s) => s.sections)
  const products = useProposalStore((s) => s.products)
  const { setProducts } = useProposalStore.getState()
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null)

  useEffect(() => {
    if (!exportMsg) return
    const id = setTimeout(() => setExportMsg(null), 4000)
    return () => clearTimeout(id)
  }, [exportMsg])

  async function handleExport(format: ProposalExportFormat): Promise<void> {
    if (exporting) return
    // 各节现算成单串 markdown 再交给主进程（IPC payload 形状不变）。
    const markdown = sections.map((s) => s.markdown).join('\n\n').trim()
    if (!markdown) {
      setExportMsg({ tone: 'muted', text: '草稿为空，无内容可导出' })
      return
    }
    setExporting(true)
    try {
      const r = await window.chatApi.exportProposal({ markdown, format })
      setExportMsg(
        r.path ? { tone: 'ok', text: `已导出：${r.path}` } : { tone: 'muted', text: '已取消导出' }
      )
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error('[export]', err)
      setExportMsg({ tone: 'err', text: `导出失败：${m}` })
    } finally {
      setExporting(false)
    }
  }

  if (!show) return null
  return (
    <div
      className={
        'flex flex-col border-l border-border bg-background text-foreground ' +
        (isWorkspace ? 'flex-1 min-w-0' : 'w-96')
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">方案草稿</span>

        {/* 编辑 ｜ 预览 segmented */}
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          <button
            className={
              'rounded-md px-3 py-1 ' +
              (mode === 'edit' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')
            }
            onClick={() => setMode('edit')}
          >
            ✎ 编辑
          </button>
          <button
            className={
              'rounded-md px-3 py-1 ' +
              (mode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')
            }
            onClick={() => setMode('preview')}
          >
            ▤ 预览
          </button>
        </div>

        <div className="flex items-center gap-1">
          {/* 返回态（非工作台）显示再入按钮：把工作台重新打开，不丢草稿 */}
          {!isWorkspace && (
            <button
              className="rounded px-2 py-0.5 hover:bg-muted"
              onClick={() => setWorkspaceOpen(true)}
              title="展开为方案工作台"
            >
              ⤢ 工作台
            </button>
          )}
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => {
              void handleExport('docx')
            }}
          >
            {exporting ? '导出中…' : '导出 Word'}
          </button>
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => {
              void handleExport('md')
            }}
          >
            .md
          </button>
        </div>
      </div>

      {exportMsg && (
        <div
          className={
            'truncate border-b border-border px-3 pb-1.5 pt-1 text-[11px] ' +
            (exportMsg.tone === 'ok'
              ? 'text-emerald-500'
              : exportMsg.tone === 'err'
                ? 'text-rose-500'
                : 'text-muted-foreground')
          }
          title={exportMsg.text}
        >
          {exportMsg.text}
        </div>
      )}

      {/* 识别到的产品 chip：方案首发时由 matchProducts 写入，可删纠错。空集 → 提示整库兜底。 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
        {products.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">未识别到产品，AI 将自行在知识库定位</span>
        ) : (
          products.map((p) => (
            <span
              key={`${p.productLine} ${p.product}`}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
            >
              {p.product}
              <button
                type="button"
                aria-label={`移除 ${p.product}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setProducts(
                    products.filter((x) => !(x.productLine === p.productLine && x.product === p.product))
                  )
                }
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>

      {/* 分节文档区：edit 模式渲染 ProposalPaper（连续长纸 + 悬停工具条 + 就地编辑），
          preview 模式渲染 ProposalPreview（A4 分页预览，与导出 Word 同源）。 */}
      {mode === 'edit' ? <ProposalPaper /> : <ProposalPreview />}
    </div>
  )
}
