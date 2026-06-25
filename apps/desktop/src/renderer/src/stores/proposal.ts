import { create } from 'zustand'

import type { ProposalDraftBlock, ProposalKind } from '@shared/proposal'
import { useChatStore } from './chat'

export interface ProposalProduct {
  productLine: string
  product: string
}

export interface ProposalSection {
  // 稳定 id：React key + 增删/重排定位。renderer 浏览器环境可用 crypto.randomUUID()。
  id: string
  markdown: string
  // 该节由「截断恢复」产生：AI 写了起始哨兵但流被截断、无结束哨兵，内容可能不完整。
  // 面板对其打「疑似截断」徽标提示用户复核。正常闭合块不带此标志（undefined）。
  truncated?: boolean
  // 该节属于哪个阶段（封面/目录/正文）。由 appendSections 取自【哨兵块自带的 kind】
  // （AI 用封面/目录/正文哨兵声明），不再依赖 store.phase——这样聊天驱动阶段（phase
  // 未推进）时目录也归到目录区，不会错塞进封面区（重复目录的根因修复）。决定草稿分区
  // 渲染（ProposalPaper）与导出分页（buildProposalMarkdown）。
  kind: ProposalKind
}

interface ProposalState {
  active: boolean
  // 方案绑定的会话 ID——只有该 session 的 send 才带 proposalMode=true，
  // 只有该 session 的 end 事件输出才被累积进 sections。
  // null 表示当前没有活跃方案会话。
  sessionId: string | null
  // 本次方案识别到的产品集（可空）。发送时由 matchProducts 写入，chip 删除时更新。
  // 收窄检索范围用：空 = 退回整个镜像根目录由 AI 自行 Grep 定位。
  products: ProposalProduct[]
  // 是否已对「首发用户文本」做过产品匹配播种。一旦为真，后续 turn 一律复用 products
  // （即便为空），不再重复 readKbIndex/matchProducts、也不会在会话中途忽然命中而
  // 骤然收窄检索范围。零命中也算已播种——这正是修复点：原来用 products.length===0 当
  // 「未播种」，零命中时会每个 turn 反复重匹配并可能突变。chip 删除走 setProducts，
  // 不触碰本标志（用户清空 chip 后仍维持已播种、不重新匹配）。
  seeded: boolean
  // 已累积进 sections 的 assistant 消息 id 集合。end 事件可能对同一 messageId
  // 二次触发（异常路径重发等）；按 id 去重，避免同一段正文被重复 append 进节。
  consumedDraftIds: Set<string>
  // 分节草稿：每个 AI 哨兵块一节（旧的 docMarkdown/setDoc 单串路径已移除）。
  sections: ProposalSection[]
  // 当前生成阶段，封面→目录→正文有序推进，是给哨兵块打 kind 与驱动阶段条 UI 的
  // 单一真相源。start() 起为 'cover'。仅由 advancePhase 推进（草稿面板按钮调用，
  // 按钮先推进 phase 再给 AI 发推进消息，保证该轮哨兵输出落到对应区）。
  phase: ProposalKind
  // 方案工作台是否接管布局（撤对话历史栏 + 可折叠对话列 + 宽纸张区）。
  // 与 active 分离：「返回」只关工作台、不销毁草稿，可再入。start() 时置 true。
  workspaceOpen: boolean
  // 文档面板「编辑｜预览」视图。提到 store 而非 ProposalDocPanel 本地 state：面板在
  // 前台会话切走时会整体卸载（!show → return null），本地 state 会被重置回 edit，
  // 用户切回会被悄悄拽回编辑态。放 store 里跨卸载存活（评审 #3）。
  viewMode: 'edit' | 'preview'
  start: (sessionId: string) => void
  setProducts: (products: ProposalProduct[]) => void
  // 首发播种：写入产品集并置 seeded=true（与 setProducts 区分——后者是 chip 编辑）。
  seedProducts: (products: ProposalProduct[]) => void
  markDraftConsumed: (messageId: string) => void
  // 哨兵块 → 节：messageId 去重后，每块成一节追加到尾部，kind 取自块自带标签。truncated
  // 为截断恢复的残块（非空时）额外追加一节并标记 truncated:true，避免半截正文被静默丢弃（B2）。
  appendSections: (
    messageId: string,
    blocks: ProposalDraftBlock[],
    truncated?: ProposalDraftBlock | null
  ) => void
  // 推进到目标阶段（cover→toc→content）。只改 phase，不动 sections——已生成的封面/
  // 目录节保持原 kind。按钮在调用本方法后另发推进消息给 AI。
  advancePhase: (to: ProposalKind) => void
  updateSection: (id: string, markdown: string) => void
  removeSection: (id: string) => void
  moveSection: (id: string, dir: 'up' | 'down') => void
  setWorkspaceOpen: (open: boolean) => void
  setViewMode: (mode: 'edit' | 'preview') => void
  reset: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  active: false,
  sessionId: null,
  products: [],
  seeded: false,
  consumedDraftIds: new Set(),
  sections: [],
  phase: 'cover',
  workspaceOpen: false,
  viewMode: 'edit',
  start: (sessionId) =>
    set({
      active: true,
      sessionId,
      products: [],
      seeded: false,
      consumedDraftIds: new Set(),
      sections: [],
      phase: 'cover',
      workspaceOpen: true,
      viewMode: 'edit'
    }),
  setProducts: (products) => set({ products }),
  seedProducts: (products) => set({ products, seeded: true }),
  markDraftConsumed: (messageId) =>
    set((s) => {
      const next = new Set(s.consumedDraftIds)
      next.add(messageId)
      return { consumedDraftIds: next }
    }),
  appendSections: (messageId, blocks, truncated) =>
    set((s) => {
      // 消息级去重：end 对同一 messageId 二次触发时不重复入节（沿用原 consumedDraftIds 语义）。
      if (s.consumedDraftIds.has(messageId)) return s
      const consumed = new Set(s.consumedDraftIds)
      consumed.add(messageId)
      // kind 取自每个哨兵块自带的标签（AI 在哨兵里声明封面/目录/正文），不再取自全局 phase。
      // 这样无论用户走右侧按钮还是直接在聊天里驱动阶段，草稿都按内容真实归档。
      const added: ProposalSection[] = blocks.map((b) => ({
        id: crypto.randomUUID(),
        markdown: b.markdown,
        kind: b.kind
      }))
      if (truncated) {
        added.push({
          id: crypto.randomUUID(),
          markdown: truncated.markdown,
          kind: truncated.kind,
          truncated: true
        })
      }
      // 阶段条同步真实进度：把 phase 推进到本轮新块里最靠后的 kind（cover<toc<content，
      // 绝不回退）。聊天驱动阶段时 phase 不再卡在 cover，阶段条与推进按钮随之反映实际
      // 进展；按钮流里 phase 已被提前推进，此处取 max 不会回退、无冲突。
      const order: Record<ProposalKind, number> = { cover: 0, toc: 1, content: 2 }
      let phase = s.phase
      for (const sec of added) {
        if (order[sec.kind] > order[phase]) phase = sec.kind
      }
      return { sections: [...s.sections, ...added], consumedDraftIds: consumed, phase }
    }),
  advancePhase: (to) => set({ phase: to }),
  updateSection: (id, markdown) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.id === id ? { ...sec, markdown } : sec))
    })),
  removeSection: (id) =>
    set((s) => ({ sections: s.sections.filter((sec) => sec.id !== id) })),
  moveSection: (id, dir) =>
    set((s) => {
      const i = s.sections.findIndex((sec) => sec.id === id)
      if (i < 0) return s
      const j = dir === 'up' ? i - 1 : i + 1
      if (j < 0 || j >= s.sections.length) return s // 越界 no-op
      // 仅允许同 kind 组内移动：sections 天然按 kind 连续（appendSections 按阶段顺序
      // 追加，phase 只前进），跨 kind 交换会打破「同 kind 连续」不变量，进而让
      // buildProposalMarkdown 在错误边界插分页、ProposalPaper 出现两个不相邻的同 kind
      // 分区标题（评审发现 1）。封面/目录/正文是有序阶段，跨区移动一节本就无意义，
      // 故邻居 kind 不同时 no-op；同 kind 内交换则保持连续性。
      if (s.sections[i].kind !== s.sections[j].kind) return s
      const next = s.sections.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return { sections: next }
    }),
  setWorkspaceOpen: (open) => set({ workspaceOpen: open }),
  setViewMode: (mode) => set({ viewMode: mode }),
  reset: () =>
    set({
      active: false,
      sessionId: null,
      products: [],
      seeded: false,
      consumedDraftIds: new Set(),
      sections: [],
      phase: 'cover',
      workspaceOpen: false,
      viewMode: 'edit'
    })
}))

/**
 * 方案 UI 是否应对【当前前台会话】显示。
 *
 * `active` 只说明「存在一个方案会话」，但一个 tab 内可切换前台会话——若只看
 * `active`，切到别的（普通）会话后右栏 Todos/工作区仍被隐藏、草稿面板还显示着
 * 旧会话的内容（评审 #8）。所以必须再校验方案绑定的 sessionId 与 chat store 的
 * 前台 sessionId 一致。null（尚无会话）一律为 false。
 *
 * 跨 store 派生：chat.ts 不 import 本文件，单向依赖无环。布局（App.tsx 隐藏右栏）
 * 与面板（ProposalDocPanel 是否渲染）都用它，保证两者同进同出、不会一个显一个藏。
 */
export function useProposalForeground(): boolean {
  const active = useProposalStore((s) => s.active)
  const proposalSid = useProposalStore((s) => s.sessionId)
  const foregroundSid = useChatStore((s) => s.sessionId)
  return active && proposalSid !== null && proposalSid === foregroundSid
}

/**
 * 方案工作台是否应接管布局。在「前台是方案会话」(useProposalForeground) 之上再叠加
 * workspaceOpen——「返回」把 workspaceOpen 置 false 即退出接管、回到正常三栏，但
 * sections/products 仍在，可由再入按钮重新打开。与 useProposalForeground 分离，确保
 * 「返回」不等于销毁草稿。
 */
export function useProposalWorkspace(): boolean {
  const foreground = useProposalForeground()
  const open = useProposalStore((s) => s.workspaceOpen)
  return foreground && open
}
