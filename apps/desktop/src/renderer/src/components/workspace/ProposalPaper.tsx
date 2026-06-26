import { useState } from 'react'
import { useProposalStore, type ProposalSection } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import type { ProposalKind } from '@shared/proposal'

/**
 * 引用落地校验（#1）的节级提示条。仅对正文节（content）渲染：
 *  - verification 尚未回填（undefined）→ 不渲染（校验中，避免闪烁）。
 *  - degraded → 灰「未校验」（索引缺失/异常，≠「无编造」，绝不报绿）。
 *  - 有 file-not-found / unsupported → 红，逐文件列出，提示人工核对。
 *  - citedFileCount===0 → 红「本段未引用任何来源」。
 *  - 全 supported 且有引用 → 淡绿「N 处来源已核对」，给正向反馈。
 * 封面/目录节不标来源（提示词规则 3），一律不渲染。
 */
function renderVerification(sec: ProposalSection): React.JSX.Element | null {
  if (sec.kind !== 'content') return null
  const v = sec.verification
  if (!v) return null
  if (v.degraded) {
    return (
      <div className="mb-1 rounded bg-neutral-500/10 px-1.5 py-0.5 text-[11px] text-neutral-500">
        来源未校验（知识库索引不可用）
      </div>
    )
  }
  if (v.citedFileCount === 0) {
    return (
      <div className="mb-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
        ⚠ 本段未引用任何来源，无法溯源，请核对是否凭空生成
      </div>
    )
  }
  const notFound = [...new Set(v.verdicts.filter((d) => d.status === 'file-not-found').map((d) => d.file))]
  const unsupported = [...new Set(v.verdicts.filter((d) => d.status === 'unsupported').map((d) => d.file))]
  if (notFound.length === 0 && unsupported.length === 0) {
    return (
      <div className="mb-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600">
        ✓ {v.citedFileCount} 处来源已核对
      </div>
    )
  }
  return (
    <div className="mb-1 space-y-0.5">
      {unsupported.length > 0 && (
        <div className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
          ⚠ 这段在{unsupported.map((f) => `《${f}》`).join('、')}里没找到（重叠率低），疑似编造，请核对
        </div>
      )}
      {notFound.length > 0 && (
        <div className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
          ⚠ {notFound.map((f) => `《${f}》`).join('、')}不在知识库索引里，无法核对来源
        </div>
      )}
    </div>
  )
}

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
  // 这三个 action 是 zustand 稳定引用、永不变——从 getState() 一次性取出、不订阅，
  // 避免每次 store 更新（如流式 append 新节）都白跑一遍 selector。
  const { updateSection, removeSection, moveSection } = useProposalStore.getState()
  const proposalSid = useProposalStore((s) => s.sessionId)
  const generating = useChatStore((s) =>
    proposalSid ? (s.perSession[proposalSid]?.streaming ?? false) : false
  )
  const [editingId, setEditingId] = useState<string | null>(null)

  const toolBtn =
    'grid size-6 place-items-center rounded-md border border-neutral-300 bg-white text-[12px] text-neutral-600 hover:border-accent hover:text-accent disabled:opacity-30'

  // 中文区名：每个 kind 对应面板里显示的分区标题。
  const KIND_LABEL: Record<ProposalKind, string> = {
    cover: '封面',
    toc: '目录',
    content: '正文'
  }
  // 保持 sections 原有顺序的前提下按 kind 切组（同 kind 连续，故顺序天然分块）。
  const groups: Array<{ kind: ProposalKind; items: typeof sections }> = []
  for (const sec of sections) {
    const last = groups[groups.length - 1]
    if (last && last.kind === sec.kind) last.items.push(sec)
    else groups.push({ kind: sec.kind, items: [sec] })
  }

  // 单节渲染辅助：参数用「全局下标」以保留上移/下移的边界判断（首尾禁用依赖 sections
  // 全局长度，不能用组内下标——跨组时组内下标会从 0 重置、错误地允许跨组第一节上移）。
  const renderSection = (sec: (typeof sections)[number], globalIndex: number): React.JSX.Element => (
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
          disabled={globalIndex === 0}
          onClick={() => moveSection(sec.id, 'up')}
          aria-label="上移"
        >
          ↑
        </button>
        <button
          className={toolBtn}
          disabled={globalIndex === sections.length - 1}
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

      {renderVerification(sec)}

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
  )

  return (
    <div className="flex-1 overflow-auto bg-black/10 py-7 dark:bg-black/25">
      <div className="proposal-paper mx-auto w-[min(794px,calc(100%-48px))] rounded-sm bg-white px-[clamp(28px,6%,76px)] py-16 text-[#1d1d1f] shadow-[0_1px_0_rgba(0,0,0,0.04),0_12px_34px_rgba(0,0,0,0.30)]">
        {sections.length === 0 ? (
          <div className="text-center text-[13px] text-neutral-400">
            {generating ? '方案正在生成，完成的部分会陆续出现在这里…' : '等待 AI 起草…'}
          </div>
        ) : (
          (() => {
            let running = -1 // 跨组累计全局下标，喂给 renderSection 做首尾禁用判断
            return groups.map((g, gi) => (
              // key 用组下标而非 g.kind：组下标在本次渲染中永远唯一且与 sections 顺序一致。
              // （moveSection 现已限制为同 kind 组内交换，sections 始终按 kind 连续、每 kind
              //  至多一组，故 g.kind 理论上也唯一；仍用组下标作 key，对未来放宽移动规则更稳健。）
              <div key={gi} className="mb-2">
                <div className="mb-1 border-b border-neutral-200 pb-0.5 text-[11px] font-medium tracking-wide text-neutral-400">
                  {KIND_LABEL[g.kind]}
                </div>
                {g.items.map((sec) => {
                  running += 1
                  return renderSection(sec, running)
                })}
              </div>
            ))
          })()
        )}
      </div>
    </div>
  )
}
