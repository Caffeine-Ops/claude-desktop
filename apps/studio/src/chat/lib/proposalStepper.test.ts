import { describe, it, expect } from 'bun:test'
import { proposalStepperNodeState } from './proposalStepper'

// 节点下标：0=封面 1=目录 2=正文
describe('proposalStepperNodeState', () => {
  it('封面阶段生成中：封面=current，目录/正文=future', () => {
    expect(proposalStepperNodeState('cover', true, 0)).toBe('current')
    expect(proposalStepperNodeState('cover', true, 1)).toBe('future')
    expect(proposalStepperNodeState('cover', true, 2)).toBe('future')
  })

  it('目录阶段：封面=done（已越过），目录=current，正文=future', () => {
    expect(proposalStepperNodeState('toc', true, 0)).toBe('done')
    expect(proposalStepperNodeState('toc', true, 1)).toBe('current')
    expect(proposalStepperNodeState('toc', true, 2)).toBe('future')
  })

  it('正文生成中：封面/目录=done，正文=current（仍在写）', () => {
    expect(proposalStepperNodeState('content', true, 0)).toBe('done')
    expect(proposalStepperNodeState('content', true, 1)).toBe('done')
    expect(proposalStepperNodeState('content', true, 2)).toBe('current')
  })

  // 这条是本次 bug 的回归点：正文生成结束（generating=false）后，正文节点必须显示「完成」而非「进行中」。
  it('正文生成结束：正文=done（修复前会卡在 current）', () => {
    expect(proposalStepperNodeState('content', false, 2)).toBe('done')
    expect(proposalStepperNodeState('content', false, 0)).toBe('done')
    expect(proposalStepperNodeState('content', false, 1)).toBe('done')
  })

  // 非终态阶段的 idle 不算完成：cover/toc 阶段即便暂时没在生成，当前节点仍是 current（等确认/等下一步）。
  it('封面阶段闲置（未生成）：封面仍是 current，不误判完成', () => {
    expect(proposalStepperNodeState('cover', false, 0)).toBe('current')
  })
  it('目录阶段闲置（等用户确认）：目录仍是 current', () => {
    expect(proposalStepperNodeState('toc', false, 1)).toBe('current')
  })
})
