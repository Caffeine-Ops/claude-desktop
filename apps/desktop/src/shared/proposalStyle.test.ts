import { describe, it, expect } from 'bun:test'

import {
  coerceProposalStyle,
  defaultProposalStyle,
  PROPOSAL_TEMPLATES
} from './proposalStyle'

describe('coerceProposalStyle（持久化样式·字段级补全，防半残配置喂进 docx）', () => {
  it('完整合法配置 → 等价返回', () => {
    expect(coerceProposalStyle(PROPOSAL_TEMPLATES.business)).toEqual(PROPOSAL_TEMPLATES.business)
    expect(coerceProposalStyle(PROPOSAL_TEMPLATES.classic)).toEqual(PROPOSAL_TEMPLATES.classic)
  })

  it('null / 非对象 → 整份默认', () => {
    const d = defaultProposalStyle()
    expect(coerceProposalStyle(null)).toEqual(d)
    expect(coerceProposalStyle(undefined)).toEqual(d)
    expect(coerceProposalStyle('x')).toEqual(d)
    expect(coerceProposalStyle(42)).toEqual(d)
  })

  it('缺顶层分级字段（h1）→ 补默认 h1（这正是评审里导出崩溃的根因）', () => {
    const d = defaultProposalStyle()
    const { h1: _omit, ...noH1 } = d
    expect(coerceProposalStyle(noH1).h1).toEqual(d.h1)
  })

  it('缺标量字段（margin/ol/ul）→ 补默认', () => {
    const d = defaultProposalStyle()
    const { margin: _m, ol: _o, ul: _u, ...partial } = d
    const out = coerceProposalStyle(partial)
    expect(out.margin).toBe(d.margin)
    expect(out.ol).toBe(d.ol)
    expect(out.ul).toBe(d.ul)
  })

  it('层级缺子字段（h1 缺 size）→ 补默认 size，保留已有子字段', () => {
    const d = defaultProposalStyle()
    const raw = {
      ...d,
      h1: { font: d.h1.font, bold: d.h1.bold, align: d.h1.align, indentChars: d.h1.indentChars }
    }
    const out = coerceProposalStyle(raw)
    expect(out.h1.size).toBe(d.h1.size) // 补回
    expect(out.h1.font).toBe(d.h1.font) // 保留
  })

  it('枚举值非法（废弃字号名 / margin 拼错）→ 回退默认', () => {
    const d = defaultProposalStyle()
    const raw = { ...d, margin: 'huge', body: { ...d.body, size: '特大号' } }
    const out = coerceProposalStyle(raw)
    expect(out.margin).toBe(d.margin)
    expect(out.body.size).toBe(d.body.size)
  })

  it('保留用户的合法改动（body.size 改成合法字号）', () => {
    const d = defaultProposalStyle()
    const raw = { ...d, body: { ...d.body, size: '三号' } }
    expect(coerceProposalStyle(raw).body.size).toBe('三号')
  })
})
