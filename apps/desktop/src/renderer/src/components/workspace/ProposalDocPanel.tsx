import { useState } from 'react'
import { useProposalStore } from '../../stores/proposal'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'

export function ProposalDocPanel(): React.JSX.Element | null {
  const active = useProposalStore((s) => s.active)
  const doc = useProposalStore((s) => s.docMarkdown)
  const setDoc = useProposalStore((s) => s.setDoc)
  const [editing, setEditing] = useState(false)
  if (!active) return null
  return (
    <div className="flex w-96 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between px-3 py-2 text-xs text-neutral-400">
        <span>方案草稿</span>
        <button className="rounded px-2 py-0.5 hover:bg-neutral-800"
          onClick={() => setEditing((v) => !v)}>{editing ? '预览' : '编辑'}</button>
        <button className="rounded px-2 py-0.5 hover:bg-neutral-800"
          onClick={() => { void window.chatApi.exportProposal({ markdown: doc, format: 'md' }).catch((err) => console.error('[export]', err)) }}>导出</button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {editing
          ? <textarea className="h-full w-full resize-none bg-transparent text-[13px] text-neutral-200 outline-none"
              value={doc} onChange={(e) => setDoc(e.target.value)} />
          : <AssistantMarkdown text={doc || '_等待 AI 起草…_'} />}
      </div>
    </div>
  )
}
