import { describe, it, expect, beforeEach } from 'bun:test'
import { useProposalStore } from './proposal'

const item = (selectedText: string, instruction = '润色') => ({
  sectionId: 's1',
  selectedText,
  instruction,
  hintRange: { start: 0, end: 0 }
})

describe('proposal revisionQueue', () => {
  beforeEach(() => {
    useProposalStore.getState().reset()
  })

  it('enqueue 追加并返回稳定 id，FIFO 顺序', () => {
    const a = useProposalStore.getState().enqueueRevision(item('甲'))
    const b = useProposalStore.getState().enqueueRevision(item('乙', '精简'))
    const q = useProposalStore.getState().revisionQueue
    expect(q.map((x) => x.id)).toEqual([a, b])
    expect(q[0].selectedText).toBe('甲')
    expect(a).not.toBe(b)
  })

  it('dequeue 弹出队头、缩短队列；空时返回 null', () => {
    useProposalStore.getState().enqueueRevision(item('甲'))
    const head = useProposalStore.getState().dequeueRevision()
    expect(head?.selectedText).toBe('甲')
    expect(useProposalStore.getState().revisionQueue).toHaveLength(0)
    expect(useProposalStore.getState().dequeueRevision()).toBeNull()
  })

  it('removeRevision 按 id 删除（取消某项）', () => {
    const a = useProposalStore.getState().enqueueRevision(item('甲'))
    const b = useProposalStore.getState().enqueueRevision(item('乙'))
    useProposalStore.getState().removeRevision(a)
    expect(useProposalStore.getState().revisionQueue.map((x) => x.id)).toEqual([b])
  })

  it('setRevisionQueueNotice 置/清丢弃提示', () => {
    useProposalStore.getState().setRevisionQueueNotice('1 个排队改写被跳过')
    expect(useProposalStore.getState().revisionQueueNotice).toBe('1 个排队改写被跳过')
    useProposalStore.getState().setRevisionQueueNotice(null)
    expect(useProposalStore.getState().revisionQueueNotice).toBeNull()
  })

  it('reset / start 清空队列与提示', () => {
    useProposalStore.getState().enqueueRevision(item('甲'))
    useProposalStore.getState().setRevisionQueueNotice('x')
    useProposalStore.getState().start('sess-1')
    expect(useProposalStore.getState().revisionQueue).toHaveLength(0)
    expect(useProposalStore.getState().revisionQueueNotice).toBeNull()
  })
})
