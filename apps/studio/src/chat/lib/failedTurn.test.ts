import { describe, it, expect, test } from 'bun:test'

import { dismissFailedTurn, markTurnFailed, prepareRetry, type FailedTurnSlot } from './failedTurn'

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

describe('dismissFailedTurn', () => {
  test('关掉重试条要连载荷一起清：之后再来的 error 不能把已放弃的那次重新弹回来', () => {
    // 场景：用户 ✕ 掉重试条 → 下一次发送前，后台任务的合成回合报错（engine 只发
    // 一条 error，没有新载荷）→ 若 lastSentPayload 还在，markTurnFailed 会把
    // 重试条绑回已放弃的那条消息，「重试」就会重发用户已经放弃的话。
    const slot = {
      messages: [{ id: 'a1' }],
      lastSentPayload: { text: 'hi' } as never,
      failedTurn: { messageId: 'a1', error: 'boom' }
    }
    const dismissed = dismissFailedTurn(slot)
    expect(dismissed.failedTurn).toBeNull()
    expect(dismissed.lastSentPayload).toBeNull()
    expect(markTurnFailed(dismissed, 'synthetic-1', 'later')).toBe(dismissed)
  })

  test('没有待重试的失败时是空操作，不换引用', () => {
    const slot = { messages: [], lastSentPayload: { text: 'hi' } as never, failedTurn: null }
    expect(dismissFailedTurn(slot)).toBe(slot)
  })
})
