import { describe, it, expect } from 'bun:test'

import { matchProposalSlash } from './proposalSlash'

describe('matchProposalSlash', () => {
  it('裸名命中，无尾随文字时 rest 为空串', () => {
    expect(matchProposalSlash('/proposal-writer')).toEqual({ rest: '' })
  })

  it('plugin 命名空间形态命中（chip 序列化的实际值）', () => {
    expect(matchProposalSlash('/claude-desktop:proposal-writer')).toEqual({ rest: '' })
  })

  it('尾随文字进 rest（含多行），首尾空白剥掉', () => {
    expect(matchProposalSlash('/proposal-writer 给XX医院写预问诊方案\n分三部分')).toEqual({
      rest: '给XX医院写预问诊方案\n分三部分'
    })
    expect(matchProposalSlash('  /claude-desktop:proposal-writer   写个方案  ')).toEqual({
      rest: '写个方案'
    })
  })

  it('大小写不敏感（与 matchSlashCommand 的 head 处理一致）', () => {
    expect(matchProposalSlash('/Proposal-Writer')).toEqual({ rest: '' })
  })

  it('不命中：其它命令 / 前缀相似 / 非斜杠开头 / 空串', () => {
    expect(matchProposalSlash('/skill')).toBeNull()
    expect(matchProposalSlash('/proposal-writerx')).toBeNull()
    expect(matchProposalSlash('proposal-writer')).toBeNull()
    expect(matchProposalSlash('')).toBeNull()
  })
})
