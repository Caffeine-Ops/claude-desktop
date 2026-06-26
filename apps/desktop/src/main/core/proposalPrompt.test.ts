import { describe, it, expect } from 'bun:test'

import { buildProposalAppend } from './proposalPrompt'

describe('buildProposalAppend 表格纪律', () => {
  it('输出包含「结构化数据用表格」纪律与接地约束', () => {
    const out = buildProposalAppend('/mirror', [])
    expect(out).toContain('结构化数据')
    expect(out).toContain('GFM markdown 表格')
    // 接地：表里只填查到的真值、空缺写「—」、绝不为凑表编造
    expect(out).toContain('绝不为凑满表格而编造数据')
  })

  it('保留既有「全程中文」收尾纪律（无回归）', () => {
    expect(buildProposalAppend('/mirror', [])).toContain('全程中文')
  })
})
