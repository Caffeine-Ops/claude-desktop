import { describe, it, expect, beforeEach, mock } from 'bun:test'

// mock 的 sendProposalStageMessage 用开关模拟两种结局：
//  - simulateInFlight=true：模拟「真起飞」——把 sess 的 streaming 置真，drain 发起后据此判「在飞」而返回等 end；
//  - simulateInFlight=false：模拟「发了但没起飞」（send 被吞/切走会话）——streaming 保持假，drain 判「没起飞」继续下一项。
// 这正是复审 H3 的判定分岔点：不靠 catch（不会 reject），靠发起后 streaming 是否为真。
let simulateInFlight = true
mock.module('./sendProposalStageMessage', () => ({
  sendProposalStageMessage: async () => {
    if (!simulateInFlight) return
    const sid = useProposalStore.getState().sessionId
    if (!sid) return
    useChatStore.setState((s) => ({
      perSession: { ...s.perSession, [sid]: { ...(s.perSession[sid] ?? {}), streaming: true } }
    }) as never)
  }
}))

import { useProposalStore } from '../stores/proposal'
import { useChatStore } from '../stores/chat'
import { drainRevisionQueue } from './sendProposalSectionRevision'

const seed = (markdown = '真实存在的一段。'): void =>
  useProposalStore.setState({
    active: true,
    sessionId: 'sess-1',
    sections: [{ id: 'sec-1', markdown, kind: 'content' }]
  })

const enqueue = (selectedText: string): void => {
  useProposalStore.getState().enqueueRevision({
    sectionId: 'sec-1',
    selectedText,
    instruction: '精简',
    hintRange: { start: 0, end: 0 }
  })
}

describe('drainRevisionQueue', () => {
  beforeEach(() => {
    simulateInFlight = true
    useProposalStore.getState().reset()
    // 真实 chat store 是模块单例、streaming 会跨用例残留，reset 回干净态防污染。
    useChatStore.getState().reset()
  })

  it('队列空：什么都不做', async () => {
    await drainRevisionQueue()
    expect(useProposalStore.getState().pendingRevision).toBeNull()
  })

  it('队头文字找不到：跳过+置可见提示，继续发起下一个（起飞后返回）', async () => {
    seed()
    enqueue('幽灵文字不存在')
    enqueue('真实存在的一段。')

    await drainRevisionQueue()

    // 幽灵项被跳过；真实项起飞（streaming 置真）→ drain 返回，真实项已出队
    expect(useProposalStore.getState().revisionQueue).toHaveLength(0)
    expect(useProposalStore.getState().pendingRevision?.sectionId).toBe('sec-1')
    // 复审 M5：被跳过的项要有可见提示（且不会被清空）
    expect(useProposalStore.getState().revisionQueueNotice).toContain('跳过')
  })

  it('streaming 为真：不排空（忙时按兵不动）', async () => {
    seed()
    useChatStore.setState((s) => ({
      perSession: { ...s.perSession, ['sess-1']: { ...(s.perSession['sess-1'] ?? {}), streaming: true } }
    }) as never)
    enqueue('真实存在的一段。')

    await drainRevisionQueue()
    expect(useProposalStore.getState().revisionQueue).toHaveLength(1)
  })

  it('并发闸：两次并发 drain 只发起一个（护栏#1）', async () => {
    seed()
    enqueue('真实存在的一段。')
    enqueue('真实存在的一段。')

    // 同一 tick 并发触发两次，模拟 end 双触发
    await Promise.all([drainRevisionQueue(), drainRevisionQueue()])

    // 第一个 drain 发起一项即因 streaming 转真而返回；第二个被 draining 闸挡回。队列还剩 1。
    expect(useProposalStore.getState().revisionQueue).toHaveLength(1)
  })

  it('发起没起飞（send 被吞/切走会话）：不空等 end，跳过并排空整条队列（复审 H3·防永久停摆）', async () => {
    simulateInFlight = false // 模拟「发了但没起飞」——streaming 始终为假
    seed()
    enqueue('真实存在的一段。')
    enqueue('真实存在的一段。')

    await drainRevisionQueue()

    // 两项都被消费、队列排空（不会卡在第一项空等一个永不到来的 end）
    expect(useProposalStore.getState().revisionQueue).toHaveLength(0)
    // 都没起飞 → 计入跳过、有可见提示
    expect(useProposalStore.getState().revisionQueueNotice).toContain('跳过')
  })
})
