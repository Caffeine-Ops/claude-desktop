import { describe, it, expect } from 'bun:test'

import {
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  PROPOSAL_GAP_PREFIX,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
} from '../../shared/proposal'
import {
  assertWellFormedPlaceholders,
  buildProposalAppend,
  loadAppendTemplate,
  renderPromptTemplate
} from './proposalPrompt'

// 硬协议字样：解析器逐字节匹配的标记（哨兵、缺失前缀），模板里【绝不允许】出现
// 明文——只能是占位符，否则改常量必与模板漂移。
const HARD_PROTOCOL_STRINGS = [
  ...Object.values(PROPOSAL_DRAFT_BEGIN),
  ...Object.values(PROPOSAL_DRAFT_END),
  PROPOSAL_GAP_PREFIX
]

// 确认 header 是「值必须逐字一致」的协议量，但它同时也是普通中文名词——模板的
// 【散文位】（如「发起封面确认」）允许写明文（改常量后散文照样通顺），只有
// 【协议位】（header 固定填「…」）必须走占位符跟随常量（终审 finding #9：此前
// 散文位也占位符化，改常量会把散文渲染成语病，两层测试都拦不住）。
const ALL_PROTOCOL_STRINGS = [
  ...HARD_PROTOCOL_STRINGS,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
]

describe('renderPromptTemplate', () => {
  it('替换全部出现（含同名重复占位符）', () => {
    expect(renderPromptTemplate('a{{X}}b{{X}}c{{Y}}', { X: '1', Y: '2' })).toBe('a1b1c2')
  })

  it('未知占位符抛错——fail fast，防模板拼错字静默漏进 prompt', () => {
    expect(() => renderPromptTemplate('{{NOPE}}', {})).toThrow('NOPE')
  })

  it('替换值含 $& 等 replace 特殊序列时原样落地（函数替换器语义）', () => {
    expect(renderPromptTemplate('{{X}}', { X: 'a$&b' })).toBe('a$&b')
  })
})

describe('append 模板契约', () => {
  it('模板文件不含硬协议字样明文（哨兵/缺失前缀）——事实源只在 shared/proposal.ts', () => {
    const tpl = loadAppendTemplate()
    for (const s of HARD_PROTOCOL_STRINGS) expect(tpl).not.toContain(s)
  })

  it('确认 header 的【协议位】走占位符跟随常量（散文位允许明文）', () => {
    const tpl = loadAppendTemplate()
    expect(tpl).toContain('header 固定填「{{COVER_CONFIRM_HEADER}}」')
    expect(tpl).toContain('header 固定填「{{TOC_CONFIRM_HEADER}}」')
  })

  it('渲染结果含全部协议字样、且无 {{ 残留', () => {
    const out = buildProposalAppend('/mirror', [])
    for (const s of ALL_PROTOCOL_STRINGS) expect(out).toContain(s)
    expect(out).not.toContain('{{')
  })
})

describe('assertWellFormedPlaceholders（运行期改坏模板的 fail-fast）', () => {
  it('良构模板通过（含多个合法占位符）', () => {
    expect(() => assertWellFormedPlaceholders('a{{KB_SCOPE}}b{{COVER_BEGIN}}')).not.toThrow()
  })

  it('小写占位符抛错', () => {
    expect(() => assertWellFormedPlaceholders('a{{kb_scope}}b')).toThrow('残缺占位符')
  })

  it('残缺右括号抛错', () => {
    expect(() => assertWellFormedPlaceholders('a{{X}b')).toThrow('残缺占位符')
  })

  it('当前提交的真实模板通过（loadAppendTemplate 全链路）', () => {
    expect(() => loadAppendTemplate()).not.toThrow()
  })
})
