import { describe, it, expect } from 'bun:test'

import { markTurnFailed, prepareRetry, type FailedTurnSlot } from './failedTurn'

const payload = { sessionId: 's1', text: 'hello' }
const userMsg = { id: 'usr_1', role: 'user', content: [{ type: 'text', text: 'hello' }] }
const badMsg = { id: 'a_1', role: 'assistant', content: [], status: { type: 'incomplete' } }

function slot(over: Partial<FailedTurnSlot> = {}): FailedTurnSlot {
  return { messages: [userMsg, badMsg], lastSentPayload: payload, failedTurn: null, ...over }
}

describe('markTurnFailed', () => {
  it('有已发送载荷时记下失败的消息 id 与错误文案', () => {
    const next = markTurnFailed(slot(), 'a_1', 'boom')
    expect(next.failedTurn).toEqual({ messageId: 'a_1', error: 'boom' })
  })

  it('没有可重发的载荷（比如没发过消息就收到错误）时不标记，返回原引用', () => {
    const s = slot({ lastSentPayload: null })
    expect(markTurnFailed(s, 'a_1', 'boom')).toBe(s)
  })

  it('同一条消息重复报错时原地覆盖，不产生新对象', () => {
    const s = slot({ failedTurn: { messageId: 'a_1', error: 'boom' } })
    expect(markTurnFailed(s, 'a_1', 'boom')).toBe(s)
    expect(markTurnFailed(s, 'a_1', 'other').failedTurn?.error).toBe('other')
  })
})

describe('prepareRetry', () => {
  it('删掉失败的 AI 气泡、保留用户气泡、清掉失败标记，并交出原始载荷', () => {
    const s = slot({ failedTurn: { messageId: 'a_1', error: 'boom' } })
    const r = prepareRetry(s)
    expect(r).not.toBeNull()
    expect(r!.payload).toBe(payload)
    expect(r!.slot.failedTurn).toBeNull()
    expect(r!.slot.messages.map((m) => m.id)).toEqual(['usr_1'])
  })

  it('失败气泡已不在（比如切换会话后重载历史）时照样能重发', () => {
    const s = slot({ messages: [userMsg], failedTurn: { messageId: 'a_1', error: 'boom' } })
    const r = prepareRetry(s)
    expect(r!.slot.messages).toBe(s.messages)
    expect(r!.payload).toBe(payload)
  })

  it('失败气泡里有已执行的工具调用时保留气泡（副作用已发生，不能藏起来）', () => {
    const toolMsg = {
      id: 'a_1',
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'Write' }]
    }
    const s = slot({ messages: [userMsg, toolMsg], failedTurn: { messageId: 'a_1', error: 'boom' } })
    const r = prepareRetry(s)
    expect(r!.slot.messages).toBe(s.messages)
    expect(r!.slot.failedTurn).toBeNull()
  })

  it('没有失败标记或没有载荷时返回 null', () => {
    expect(prepareRetry(slot())).toBeNull()
    expect(
      prepareRetry(slot({ lastSentPayload: null, failedTurn: { messageId: 'a_1', error: 'x' } }))
    ).toBeNull()
  })
})
