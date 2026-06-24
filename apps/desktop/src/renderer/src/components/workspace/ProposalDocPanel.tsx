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
