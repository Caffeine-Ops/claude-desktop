import { create } from 'zustand'

interface ProposalState {
  active: boolean
  productLine: string | null
  product: string | null
  docMarkdown: string
  start: (productLine: string, product: string) => void
  setDoc: (md: string) => void
  appendSection: (heading: string, body: string) => void
  reset: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  active: false,
  productLine: null,
  product: null,
  docMarkdown: '',
  start: (productLine, product) =>
    set({ active: true, productLine, product, docMarkdown: '' }),
  setDoc: (md) => set({ docMarkdown: md }),
  appendSection: (heading, body) =>
    set((s) => ({ docMarkdown: `${s.docMarkdown}\n\n## ${heading}\n\n${body}`.trimStart() })),
  reset: () => set({ active: false, productLine: null, product: null, docMarkdown: '' })
}))
