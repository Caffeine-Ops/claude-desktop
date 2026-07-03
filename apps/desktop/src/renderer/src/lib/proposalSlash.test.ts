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

  // 终审 finding #4：中文输入习惯里命令后常不打空格，切词法会静默不命中、整串
  // 当普通消息直发 CLI（方案硬门纪律没激活）。前缀+边界匹配后这些形态必须命中。
  it('命令名后直接接中文（无空格）也命中，中文进 rest', () => {
    expect(matchProposalSlash('/proposal-writer给XX医院写预问诊方案')).toEqual({
      rest: '给XX医院写预问诊方案'
    })
    expect(matchProposalSlash('/claude-desktop:proposal-writer给YY客户写方案')).toEqual({
      rest: '给YY客户写方案'
    })
  })

  it('Tab / 全角空格等空白分隔同样命中', () => {
    expect(matchProposalSlash('/proposal-writer\t写个方案')).toEqual({ rest: '写个方案' })
    expect(matchProposalSlash('/proposal-writer　写个方案')).toEqual({ rest: '写个方案' })
  })

  it('命名空间形态优先于裸名：不会被短名截断吞掉命名空间', () => {
    // 若裸名先匹配，'claude-desktop:proposal-writer' 里的 'proposal-writer' 不在
    // 串首、startsWith 不会命中裸名——此用例锁住「长名在前」的顺序不变量。
    expect(matchProposalSlash('/claude-desktop:proposal-writer 文字')).toEqual({ rest: '文字' })
  })
})
