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

  // Bug 1：数值字段越界——脏持久化（负值/0/NaN/Infinity/巨值）此前原样穿过，进 docx 抛
  // 「Must be a positive integer」整篇导出/预览失败。coerce 现在范围校验、越界回退默认。
  describe('数值字段越界回退（防 docx「Must be a positive integer」崩溃）', () => {
    const d = defaultProposalStyle()
    it('lineMultiple 负数 / 0 / NaN / Infinity / 巨值 → 回退默认', () => {
      for (const bad of [-3, 0, NaN, Infinity, -Infinity, 1e9, '1.5']) {
        expect(coerceProposalStyle({ ...d, lineMultiple: bad }).lineMultiple).toBe(d.lineMultiple)
      }
    })
    it('lineMultiple 合法范围内（含 UI 滑块边界 1.2/2.4）→ 保留', () => {
      for (const ok of [1.0, 1.2, 1.65, 2.4, 3.0]) {
        expect(coerceProposalStyle({ ...d, lineMultiple: ok }).lineMultiple).toBe(ok)
      }
    })
    it('spaceAfterPt 负数 / 巨值 → 回退默认；0~100 内保留', () => {
      expect(coerceProposalStyle({ ...d, spaceAfterPt: -100 }).spaceAfterPt).toBe(d.spaceAfterPt)
      expect(coerceProposalStyle({ ...d, spaceAfterPt: 1e9 }).spaceAfterPt).toBe(d.spaceAfterPt)
      expect(coerceProposalStyle({ ...d, spaceAfterPt: 0 }).spaceAfterPt).toBe(0)
      expect(coerceProposalStyle({ ...d, spaceAfterPt: 12 }).spaceAfterPt).toBe(12)
    })
    it('indentChars 负数 → 回退默认；0/1/2 保留', () => {
      expect(coerceProposalStyle({ ...d, body: { ...d.body, indentChars: -5 } }).body.indentChars).toBe(d.body.indentChars)
      for (const ok of [0, 1, 2]) {
        expect(coerceProposalStyle({ ...d, body: { ...d.body, indentChars: ok } }).body.indentChars).toBe(ok)
      }
    })
  })

  it('color 非 6 位 hex（注入串 / 短码 / 带#）→ 丢弃（回退默认模板的 base.color）；合法 hex 保留', () => {
    const d = defaultProposalStyle()
    // 注入串绝不能原样活下来。注：coerce 的 base 恒为默认模板(classic)对应层级，classic.h1 无 color，
    // 故脏 color 回退为 undefined（不是 business 的 ACCENT）——安全降级，关键是注入串没进 docx。
    const evil = coerceProposalStyle({
      ...PROPOSAL_TEMPLATES.business,
      h1: { ...PROPOSAL_TEMPLATES.business.h1, color: 'ff0000"/><inject' }
    })
    expect(evil.h1.color).not.toBe('ff0000"/><inject')
    expect(evil.h1.color).toBeUndefined()
    // 短码 / 带 # 同样非法 → 丢弃
    expect(coerceProposalStyle({ ...d, body: { ...d.body, color: '#abc' } }).body.color).toBeUndefined()
    expect(coerceProposalStyle({ ...d, body: { ...d.body, color: 'abc' } }).body.color).toBeUndefined()
    // 合法 6 位 hex 保留
    expect(coerceProposalStyle({ ...d, h1: { ...d.h1, color: '2b46b8' } }).h1.color).toBe('2b46b8')
    // 全合法的 business 配置仍完整 round-trip（ACCENT 是合法 hex，不受影响）
    expect(coerceProposalStyle(PROPOSAL_TEMPLATES.business)).toEqual(PROPOSAL_TEMPLATES.business)
  })
})
