import { create } from 'zustand'

export interface ProposalProduct {
  productLine: string
  product: string
}

interface ProposalState {
  active: boolean
  // 方案绑定的会话 ID——只有该 session 的 send 才带 proposalMode=true，
  // 只有该 session 的 end 事件输出才被累积进 docMarkdown。
  // null 表示当前没有活跃方案会话。
  sessionId: string | null
  // 本次方案识别到的产品集（可空）。发送时由 matchProducts 写入，chip 删除时更新。
  // 收窄检索范围用：空 = 退回整个镜像根目录由 AI 自行 Grep 定位。
  products: ProposalProduct[]
  docMarkdown: string
  start: (sessionId: string) => void
  setProducts: (products: ProposalProduct[]) => void
  setDoc: (md: string) => void
  reset: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  active: false,
  sessionId: null,
  products: [],
  docMarkdown: '',
  start: (sessionId) => set({ active: true, sessionId, products: [], docMarkdown: '' }),
  setProducts: (products) => set({ products }),
  setDoc: (md) => set({ docMarkdown: md }),
  reset: () => set({ active: false, sessionId: null, products: [], docMarkdown: '' })
}))
