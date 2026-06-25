import { useState } from 'react'
import { useProposalStore } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'

/**
 * 编辑态：一张连续的 A4 宽长纸，分节无缝拼接、向下滚动不分页。
 * 保留现有「哨兵→分节」数据模型，仅把卡片堆叠换皮成纸面：
 *  - 去卡片边框/底色，节正文用 AssistantMarkdown 渲染；白纸黑字靠 .proposal-paper
 *    作用域覆盖前景 token（见 index.css），无需逐元素 !important。
 *  - 悬停某节 → 右侧外边距浮出工具条（编辑/上移/下移/删除），不占正文宽度、不破坏纸面。
 *  - 单节编辑仍是 editingId 单选 + textarea，但 textarea 白底衬线、无框，就地改字。
 *
 * 工具条按钮用显式中性色（非主题 token）——因为 .proposal-paper 把 token 覆盖成纸墨色，
 * 若按钮也用 text-foreground 会变成白纸上的浅色控件、对比过低。
 */
export function ProposalPaper(): React.JSX.Element {
  const sections = useProposalStore((s) => s.sections)
  const { updateSection, removeSection, moveSection } = useProposalStore.getState()
  const proposalSid = useProposalStore((s) => s.sessionId)
  const generating = useChatStore((s) =>
    proposalSid ? (s.perSession[proposalSid]?.streaming ?? false) : false
  )
  const [editingId, setEditingId] = useState<string | null>(null)

  const toolBtn =
    'grid size-6 place-items-center rounded-md border border-neutral-300 bg-white text-[12px] text-neutral-600 hover:border-accent hover:text-accent disabled:opacity-30'

  return (
    <div className="flex-1 overflow-auto bg-black/10 py-7 dark:bg-black/25">
      <div className="proposal-paper mx-auto w-[min(794px,calc(100%-48px))] rounded-sm bg-white px-[clamp(28px,6%,76px)] py-16 text-[#1d1d1f] shadow-[0_1px_0_rgba(0,0,0,0.04),0_12px_34px_rgba(0,0,0,0.30)]">
        {sections.length === 0 ? (
          <div className="text-center text-[13px] text-neutral-400">
            {generating ? '方案正在生成，完成的部分会陆续出现在这里…' : '等待 AI 起草…'}
          </div>
        ) : (
          sections.map((sec, i) => (
            <section key={sec.id} className="group relative py-0.5">
              <div className="absolute -right-[58px] top-1.5 hidden flex-col gap-1 group-hover:flex">
                <button
                  className={toolBtn}
                  onClick={() => setEditingId(editingId === sec.id ? null : sec.id)}
                  aria-label={editingId === sec.id ? '完成' : '编辑'}
                >
                  {editingId === sec.id ? '✓' : '✎'}
                </button>
                <button
                  className={toolBtn}
                  disabled={i === 0}
                  onClick={() => moveSection(sec.id, 'up')}
                  aria-label="上移"
                >
                  ↑
                </button>
                <button
                  className={toolBtn}
                  disabled={i === sections.length - 1}
                  onClick={() => moveSection(sec.id, 'down')}
                  aria-label="下移"
                >
                  ↓
                </button>
                <button
                  className="grid size-6 place-items-center rounded-md border border-neutral-300 bg-white text-[12px] text-rose-500 hover:border-rose-400"
                  onClick={() => {
                    if (editingId === sec.id) setEditingId(null)
                    removeSection(sec.id)
                  }}
                  aria-label="删除"
                >
                  ×
                </button>
              </div>

              {sec.truncated && (
                <div className="mb-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600">
                  ⚠ 本段疑似截断（AI 未写结束标记），内容可能不完整，请复核或重新生成
                </div>
              )}

              {editingId === sec.id ? (
                <textarea
                  className="min-h-[120px] w-full resize-none rounded-sm bg-accent/5 font-serif text-[14.5px] leading-[1.95] text-[#1d1d1f] outline-none"
                  value={sec.markdown}
                  autoFocus
                  onChange={(e) => updateSection(sec.id, e.target.value)}
                />
              ) : (
                <AssistantMarkdown text={sec.markdown} />
              )}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
