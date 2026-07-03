import { describe, it, expect } from 'bun:test'

import {
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  PROPOSAL_GAP_PREFIX,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
} from '../../shared/proposal'
import { buildProposalAppend, loadAppendTemplate, renderPromptTemplate } from './proposalPrompt'

const PROTOCOL_STRINGS = [
  ...Object.values(PROPOSAL_DRAFT_BEGIN),
  ...Object.values(PROPOSAL_DRAFT_END),
  PROPOSAL_GAP_PREFIX,
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
  it('模板文件不含任何协议字样明文——事实源只在 shared/proposal.ts', () => {
    const tpl = loadAppendTemplate()
    for (const s of PROTOCOL_STRINGS) expect(tpl).not.toContain(s)
  })

  it('渲染结果含全部协议字样、且无 {{ 残留', () => {
    const out = buildProposalAppend('/mirror', [])
    for (const s of PROTOCOL_STRINGS) expect(out).toContain(s)
    expect(out).not.toContain('{{')
  })
})
