import { create } from 'zustand'

interface ProposalState {
  active: boolean
  // 方案绑定的会话 ID——只有该 session 的 send 才带 proposalMode=true，
  // 只有该 session 的 end 事件输出才被累积进 docMarkdown。
  // null 表示当前没有活跃方案会话。
  sessionId: string | null
  productLine: string | null
  product: string | null
  docMarkdown: string
  start: (productLine: string, product: string, sessionId: string) => void
  setDoc: (md: string) => void
  reset: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  active: false,
  sessionId: null,
  productLine: null,
  product: null,
  docMarkdown: '',
  start: (productLine, product, sessionId) =>
    set({ active: true, productLine, product, sessionId, docMarkdown: '' }),
  setDoc: (md) => set({ docMarkdown: md }),
  reset: () => set({ active: false, sessionId: null, productLine: null, product: null, docMarkdown: '' })
}))
