import { describe, it, expect, beforeEach, mock } from 'bun:test'

// 把真正发消息的底层挡掉：只关心 drain 的"重定位/丢弃/前进/丢弃提示"逻辑，不真的发送。
mock.module('./sendProposalStageMessage', () => ({
  sendProposalStageMessage: async () => {}
}))

import { useProposalStore } from '../stores/proposal'
import { useChatStore } from '../stores/chat'
import { drainRevisionQueue } from './sendProposalSectionRevision'

const enqueue = (selectedText: string) =>
  useProposalStore.getState().enqueueRevision({
    sectionId: 'sec-1',
    selectedText,
    instruction: '精简',
    hintRange: { start: 0, end: 0 }
  })

describe('drainRevisionQueue', () => {
  beforeEach(() => {
    useProposalStore.getState().reset()
    // 真实 chat store 是模块单例、streaming 会跨用例残留（不像每例重建的 mock）：
    // 「streaming 为真」用例把 sess-1 置真后，若不清会漏进后面用同一 sess-1 的用例，
    // 令它们误命中 streaming 闸。reset 回到干净态，四个分支各测各的意图不受污染。
    useChatStore.getState().reset()
  })

  it('队列空：什么都不做', async () => {
    await drainRevisionQueue()
    expect(useProposalStore.getState().pendingRevision).toBeNull()
  })

  it('队头文字找不到：丢弃+置可见提示+继续到下一个', async () => {
    useProposalStore.setState({
      active: true,
      sessionId: 'sess-1',
      sections: [{ id: 'sec-1', markdown: '真实存在的一段。', kind: 'content' }]
    })
    enqueue('幽灵文字不存在')
    enqueue('真实存在的一段。')

    await drainRevisionQueue()

    expect(useProposalStore.getState().revisionQueue).toHaveLength(0)
    expect(useProposalStore.getState().pendingRevision?.sectionId).toBe('sec-1')
    // 护栏#2：被跳过的那项要有可见提示
    expect(useProposalStore.getState().revisionQueueNotice).toContain('跳过')
  })

  it('streaming 为真：不排空（护栏#1 并发闸的外层）', async () => {
    useProposalStore.setState({
      active: true,
      sessionId: 'sess-1',
      sections: [{ id: 'sec-1', markdown: '真实存在的一段。', kind: 'content' }]
    })
    useChatStore.setState((s) => ({
      perSession: { ...s.perSession, ['sess-1']: { ...(s.perSession['sess-1'] ?? {}), streaming: true } }
    }) as never)
    enqueue('真实存在的一段。')

    await drainRevisionQueue()
    expect(useProposalStore.getState().revisionQueue).toHaveLength(1)
  })

  it('并发闸：两次并发 drain 只发起一个（护栏#1）', async () => {
    useProposalStore.setState({
      active: true,
      sessionId: 'sess-1',
      sections: [{ id: 'sec-1', markdown: '真实存在的一段。', kind: 'content' }]
    })
    enqueue('真实存在的一段。')
    enqueue('真实存在的一段。')

    // 同一 tick 并发触发两次，模拟 end 双触发
    await Promise.all([drainRevisionQueue(), drainRevisionQueue()])

    // 只应消费一个（另一个被 draining 闸挡回），队列还剩 1
    expect(useProposalStore.getState().revisionQueue).toHaveLength(1)
  })
})
