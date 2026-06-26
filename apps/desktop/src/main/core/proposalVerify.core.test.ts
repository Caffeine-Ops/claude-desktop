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

  it('表格段落与原文同款表格 → supported', () => {
    const tableMd =
      '| 模块 | 说明 |\n| --- | --- |\n| 分诊 | 智能分诊建议 |\n| 预问诊 | 多轮对话采集 |\n（据《白皮书》）'
    const mirror =
      '产品参数表：\n| 模块 | 说明 |\n| --- | --- |\n| 分诊 | 智能分诊建议 |\n| 预问诊 | 多轮对话采集 |\n以上为核心模块。'
    const r = verifyCitationsCore(tableMd, (f) => (f === '白皮书' ? mirror : null))
    expect(r.citedFileCount).toBe(1)
    expect(r.verdicts[0].status).toBe('supported')
  })
})

describe('verifyCitationsCore 图片接地', () => {
  it('图属本节所引文件的 assets → grounded', () => {
    const md = '本系统架构如下。（据《白皮书》）\n\n![架构图](/kb/a/img-1.png)'
    const r = verifyCitationsCore(
      md,
      (f) => (f === '白皮书' ? '架构如下，包含分诊与预问诊。' : null),
      (f) => (f === '白皮书' ? ['/kb/a/img-1.png', '/kb/a/img-2.png'] : [])
    )
    expect(r.imageVerdicts).toEqual([{ path: '/kb/a/img-1.png', status: 'grounded' }])
  })

  it('图不属任何本节所引文件的 assets → ungrounded', () => {
    const md = '本系统架构如下。（据《白皮书》）\n\n![盗图](/kb/other/img-9.png)'
    const r = verifyCitationsCore(
      md,
      (f) => (f === '白皮书' ? '架构如下。' : null),
      (f) => (f === '白皮书' ? ['/kb/a/img-1.png'] : [])
    )
    expect(r.imageVerdicts).toEqual([{ path: '/kb/other/img-9.png', status: 'ungrounded' }])
  })

  it('无图 → 不带 imageVerdicts（向后兼容）', () => {
    const r = verifyCitationsCore('纯文字。（据《白皮书》）', () => '纯文字。', () => ['/x.png'])
    expect(r.imageVerdicts).toBeUndefined()
  })

  it('不传 resolveAssets 时仍可用（旧签名，有图则全 ungrounded）', () => {
    const r = verifyCitationsCore('文。（据《白皮书》）\n\n![图](/kb/a/img-1.png)', () => '文。')
    expect(r.imageVerdicts).toEqual([{ path: '/kb/a/img-1.png', status: 'ungrounded' }])
  })
})
