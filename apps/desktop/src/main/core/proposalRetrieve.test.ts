import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { retrievePassages, renderRetrievedBlock } from './proposalRetrieve'
import type { ProposalProductScope } from './proposalPrompt'

let dir: string
let scopes: ProposalProductScope[]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'proposal-retrieve-'))
  // 关键场景：文件标题完全不含 query 关键词，但正文含——验证「凭内容召回」而非「凭标题」。
  const f1 = join(dir, 'a.txt')
  writeFileSync(
    f1,
    '总体方案设计概述。\n\n本平台的智能预问诊系统支持多轮对话与分诊建议，覆盖门诊全流程，显著缩短候诊时间。',
    'utf8'
  )
  const f2 = join(dir, 'b.txt')
  writeFileSync(f2, '售后服务条款与质保期说明。', 'utf8')
  scopes = [
    {
      dir,
      productLine: '线A',
      product: '品A',
      files: [
        { title: '建设背景与目标', mirrorPath: f1 }, // 标题无「预问诊」，正文有
        { title: '售后条款', mirrorPath: f2 },
        { title: '已删除的文件', mirrorPath: join(dir, 'missing.txt') } // 读失败应跳过
      ]
    }
  ]
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('retrievePassages', () => {
  it('标题不含关键词、正文含 → 凭内容召回到', () => {
    const out = retrievePassages('智能预问诊系统', scopes)
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].title).toBe('建设背景与目标')
    expect(out[0].text).toContain('智能预问诊系统')
  })

  it('读不到的文件被跳过、不抛', () => {
    // missing.txt 在 scopes 里但不存在；不应抛，且不出现在结果。
    const out = retrievePassages('预问诊', scopes)
    expect(out.every((p) => p.mirrorPath !== join(dir, 'missing.txt'))).toBe(true)
  })

  it('零命中 query → 空', () => {
    expect(retrievePassages('量子区块链元宇宙', scopes)).toEqual([])
  })

  it('空 scopes → 空', () => {
    expect(retrievePassages('预问诊', [])).toEqual([])
  })
})

describe('renderRetrievedBlock', () => {
  it('空 → 空串（不注入）', () => {
    expect(renderRetrievedBlock([])).toBe('')
  })

  it('非空 → 含召回标签与《title》来源', () => {
    const block = renderRetrievedBlock([
      { title: '建设背景与目标', mirrorPath: '/x', text: '正文片段', score: 1.2 }
    ])
    expect(block).toContain('知识库召回')
    expect(block).toContain('《建设背景与目标》')
    expect(block).toContain('正文片段')
  })

  it('巨表片段被截断注入（防撑爆提示词）', () => {
    const bigTable = Array.from({ length: 3000 }, (_, i) => `| 行${i} | 值 |`).join('\n')
    const block = renderRetrievedBlock([
      { title: '大表', mirrorPath: '/x', text: bigTable, score: 2 }
    ])
    expect(block).toContain('…（片段过长，余下已省略）')
    expect(block.length).toBeLessThan(bigTable.length) // 确实变短了
  })
})
