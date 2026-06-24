import { useEffect, useState } from 'react'
import { useProposalStore, useProposalForeground } from '../../stores/proposal'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'

export function ProposalDocPanel(): React.JSX.Element | null {
  // 与 App.tsx 隐藏右栏同一门控：只对【当前前台会话】是方案会话时显示，避免 tab
  // 内切到别的会话后还显示着旧会话的草稿（评审 #8）。
  const show = useProposalForeground()
  const doc = useProposalStore((s) => s.docMarkdown)
  const setDoc = useProposalStore((s) => s.setDoc)
  const products = useProposalStore((s) => s.products)
  const setProducts = useProposalStore((s) => s.setProducts)
  const [editing, setEditing] = useState(false)
  // 导出反馈：成功显路径 / 取消显「已取消」/ 失败显错误，4s 后自动消失。原来三种
  // 结果都只 console.error，用户无从区分成功、取消、失败（评审 #7）。
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{
    tone: 'ok' | 'err' | 'muted'
    text: string
  } | null>(null)
  useEffect(() => {
    if (!exportMsg) return
    const id = setTimeout(() => setExportMsg(null), 4000)
    return () => clearTimeout(id)
  }, [exportMsg])

  async function handleExport(): Promise<void> {
    if (exporting) return
    if (!doc.trim()) {
      setExportMsg({ tone: 'muted', text: '草稿为空，无内容可导出' })
      return
    }
    setExporting(true)
    try {
      const r = await window.chatApi.exportProposal({ markdown: doc, format: 'md' })
      setExportMsg(
        r.path
          ? { tone: 'ok', text: `已导出：${r.path}` }
          : { tone: 'muted', text: '已取消导出' }
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
    <div className="flex w-96 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between px-3 py-2 text-xs text-neutral-400">
        <span>方案草稿</span>
        <button className="rounded px-2 py-0.5 hover:bg-neutral-800"
          onClick={() => setEditing((v) => !v)}>{editing ? '预览' : '编辑'}</button>
        <button className="rounded px-2 py-0.5 hover:bg-neutral-800 disabled:opacity-50"
          disabled={exporting}
          onClick={() => { void handleExport() }}>{exporting ? '导出中…' : '导出'}</button>
      </div>
      {/* 导出结果反馈条：truncate + title 兜住长路径，避免撑破 w-96 面板。 */}
      {exportMsg && (
        <div
          className={
            'truncate border-b border-neutral-800 px-3 pb-1.5 text-[11px] ' +
            (exportMsg.tone === 'ok'
              ? 'text-emerald-400'
              : exportMsg.tone === 'err'
                ? 'text-rose-400'
                : 'text-neutral-500')
          }
          title={exportMsg.text}
        >
          {exportMsg.text}
        </div>
      )}
      {/* 识别到的产品 chip：方案首发时由 matchProducts 写入。可删——删除即从
          store 移除，后续 turn 不再把它列入可读目录（召回优先下用于纠误配）。
          空集时提示 AI 会自行在知识库定位（整库兜底）。 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 px-3 py-1.5">
        {products.length === 0 ? (
          <span className="text-[11px] text-neutral-500">未识别到产品，AI 将自行在知识库定位</span>
        ) : (
          products.map((p) => (
            <span
              key={`${p.productLine}\u0000${p.product}`}
              className="inline-flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-200"
            >
              {p.product}
              <button
                type="button"
                aria-label={`移除 ${p.product}`}
                className="text-neutral-500 hover:text-neutral-200"
                onClick={() =>
                  setProducts(
                    products.filter(
                      (x) => !(x.productLine === p.productLine && x.product === p.product)
                    )
                  )
                }
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>
      {/* 面板背景是硬编码深色(bg-neutral-950),但 AssistantMarkdown 各标签用的是
          主题语义色 text-foreground / text-muted-foreground——浅色主题下它们是深色文字，
          落在黑底上就看不见。这里在预览子树内局部把这两个 HSL 变量重定义为浅色：所有
          text-foreground 子元素自动变白、次要文字变浅灰，无需逐标签覆盖，也不波及聊天里
          复用的 AssistantMarkdown（变量只在本容器作用域内生效）。textarea 用的是
          text-neutral-200，不读这两个变量，编辑态不受影响。 */}
      <div className="flex-1 overflow-auto p-3 [--foreground:0_0%_100%] [--muted-foreground:0_0%_72%]">
        {editing
          ? <textarea className="h-full w-full resize-none bg-transparent text-[13px] text-neutral-200 outline-none"
              value={doc} onChange={(e) => setDoc(e.target.value)} />
          : <AssistantMarkdown text={doc || '_等待 AI 起草…_'} />}
      </div>
    </div>
  )
}
