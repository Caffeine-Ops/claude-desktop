import { describe, it, expect, beforeEach } from 'bun:test'

import { useProposalStore } from '../stores/proposal'
import { startOrReopenProposal } from './startOrReopenProposal'

// zustand vanilla store 在 bun 下可直接驱动；每例前 reset 回初始态，互不串扰。
beforeEach(() => {
  useProposalStore.getState().reset()
})

describe('startOrReopenProposal（场景卡与斜杠入口共用的再入语义）', () => {
  it('无草稿 → started：激活并绑定会话', () => {
    expect(startOrReopenProposal('s1')).toBe('started')
    const ps = useProposalStore.getState()
    expect(ps.active).toBe(true)
    expect(ps.sessionId).toBe('s1')
  })

  it('active 中再入 → reopened：重绑到新前台会话、不清草稿状态', () => {
    useProposalStore.getState().start('s1')
    expect(startOrReopenProposal('s2')).toBe('reopened')
    const ps = useProposalStore.getState()
    expect(ps.active).toBe(true)
    expect(ps.sessionId).toBe('s2')
  })

  it('leaveMode 收起但 sections 非空 → reopened：草稿在就绝不 start 清空', () => {
    const st = useProposalStore.getState()
    st.start('s1')
    useProposalStore.setState({
      sections: [{ id: 'x', markdown: '# 封面', kind: 'cover' }]
    })
    useProposalStore.getState().leaveMode()
    expect(startOrReopenProposal('s2')).toBe('reopened')
    const ps = useProposalStore.getState()
    expect(ps.sections.length).toBe(1)
    expect(ps.sessionId).toBe('s2')
  })

  it('leaveMode 收起且无草稿 → started（与场景卡语义一致）', () => {
    useProposalStore.getState().start('s1')
    useProposalStore.getState().leaveMode()
    expect(startOrReopenProposal('s2')).toBe('started')
  })
})
