import { describe, it, expect } from 'bun:test'

import { verifyCitationsCore } from './proposalVerify.core'

describe('verifyCitationsCore', () => {
  it('无引用 → 空 verdicts、覆盖度 0', () => {
    expect(verifyCitationsCore('一段没有来源的正文。', () => null)).toEqual({
      verdicts: [],
      citedFileCount: 0
    })
    expect(verifyCitationsCore('', () => 'x')).toEqual({ verdicts: [], citedFileCount: 0 })
  })

  it('原文支持该段 → supported', () => {
    const r = verifyCitationsCore('智能预问诊系统支持多轮对话。（据《白皮书》）', (f) =>
      f === '白皮书' ? '产品介绍：智能预问诊系统支持多轮对话，覆盖门诊全流程。' : null
    )
    expect(r.citedFileCount).toBe(1)
    expect(r.verdicts).toHaveLength(1)
    expect(r.verdicts[0].status).toBe('supported')
    expect(r.verdicts[0].overlap).toBeGreaterThan(0.5)
  })

  it('原文不支持该段（疑似编造）→ unsupported', () => {
    const r = verifyCitationsCore('本系统采用量子区块链元宇宙架构。（据《白皮书》）', (f) =>
      f === '白皮书' ? '智能预问诊系统介绍文档，包含问诊流程与分诊建议。' : null
    )
    expect(r.verdicts[0].status).toBe('unsupported')
    expect(r.verdicts[0].overlap).toBeLessThan(0.5)
  })

  it('文件解析不到（索引无/读失败）→ file-not-found', () => {
    const r = verifyCitationsCore('某段正文。（据《不存在的文件》）', () => null)
    expect(r.verdicts[0].status).toBe('file-not-found')
    expect(r.verdicts[0].overlap).toBeUndefined()
  })

  it('跨段引同一文件 → 覆盖度按文件去重', () => {
    const r = verifyCitationsCore(
      '第一段。（据《A》）\n\n第二段。（据《A》《B》）',
      (f) => (f === 'A' || f === 'B' ? '第一段。第二段。' : null)
    )
    expect(r.citedFileCount).toBe(2) // A、B 去重后 2 个文件
    expect(r.verdicts).toHaveLength(3) // 引用条数：A、A、B
  })
})
