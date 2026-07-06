import { describe, it, expect } from 'bun:test'

import {
  verifyCitationsCore,
  splitMarkdownBySections,
  collectUngroundedImagePathsCore
} from './proposalVerify.core'

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

  it('引用《用户补充资料》→ user-supplied，不查原文、不算缺文件，仍计入覆盖度', () => {
    // resolveContent 返回 null（保留名本就不在 KB）；但 user-supplied 分支应在查询前命中，
    // 故不落 file-not-found，且 citedFileCount 计 1（避免误报「本段未标注来源」）。
    const r = verifyCitationsCore('据用户提供的部署数据撰写。（据《用户补充资料》）', () => null)
    expect(r.citedFileCount).toBe(1)
    expect(r.verdicts).toHaveLength(1)
    expect(r.verdicts[0].status).toBe('user-supplied')
    expect(r.verdicts[0].overlap).toBeUndefined()
  })

  it('同段混引 KB 文件与《用户补充资料》→ 各得其判', () => {
    const r = verifyCitationsCore(
      '智能预问诊系统支持多轮对话。（据《白皮书》《用户补充资料》）',
      (f) => (f === '白皮书' ? '智能预问诊系统支持多轮对话，覆盖门诊全流程。' : null)
    )
    expect(r.citedFileCount).toBe(2)
    expect(r.verdicts.find((v) => v.file === '白皮书')?.status).toBe('supported')
    expect(r.verdicts.find((v) => v.file === '用户补充资料')?.status).toBe('user-supplied')
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

  it('极短正文段（去空白 <3 字）即便子串命中也不判 supported（防绕过编造核对）', () => {
    // 「概述」2 字：trigramOverlap 退化为子串判定、命中返 1，旧逻辑会判 supported 绿灯。
    const r = verifyCitationsCore('概述（据《白皮书》）', (f) =>
      f === '白皮书' ? '本白皮书概述了系统能力与流程。' : null
    )
    expect(r.verdicts).toHaveLength(1)
    expect(r.verdicts[0].status).toBe('unsupported')
  })

  it('恰好 3 字的正文段仍走正常 trigram 核对（边界）', () => {
    // 「预问诊」3 字：有 trigram，忠实出自原文 → 仍判 supported，不被短段规则误伤。
    const r = verifyCitationsCore('预问诊（据《白皮书》）', (f) =>
      f === '白皮书' ? '系统提供预问诊与分诊建议。' : null
    )
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

  it('proposal-drafts 下的产出图豁免接地——不产生 ungrounded verdict', () => {
    const md =
      '正文（据《报告A》）\n\n![示意](/U/x/app/proposal-drafts/s1/assets/gen-1.png)'
    const r = verifyCitationsCore(
      md,
      (f) => (f === '报告A' ? '正文' : null),
      // 所引文件的 assets 不含该产出图——若不豁免，按旧逻辑会判 ungrounded
      (f) => (f === '报告A' ? ['/kb/a/img-1.png'] : [])
    )
    const bad = (r.imageVerdicts ?? []).filter((v) => v.status === 'ungrounded')
    expect(bad.find((v) => v.path.includes('/proposal-drafts/'))).toBeUndefined()
  })

  it('注入 isDraftAsset 后：形状命中但谓词不过（幻造/不存在的产出图路径）→ 掉回接地判定标红', () => {
    const md = '正文（据《报告A》）\n\n![幻造](/any/dir/proposal-drafts/x/assets/diagram.png)'
    const r = verifyCitationsCore(
      md,
      (f) => (f === '报告A' ? '正文' : null),
      (f) => (f === '报告A' ? ['/kb/a/img-1.png'] : []),
      () => false // 强校验：不在真实草稿根/不存在
    )
    expect(r.imageVerdicts).toEqual([
      { path: '/any/dir/proposal-drafts/x/assets/diagram.png', status: 'ungrounded' }
    ])
  })

  it('注入 isDraftAsset 后：谓词通过的真产出图仍豁免', () => {
    const md = '正文（据《报告A》）\n\n![真图](/U/x/app/proposal-drafts/s1/assets/gen-1.png)'
    const r = verifyCitationsCore(
      md,
      (f) => (f === '报告A' ? '正文' : null),
      (f) => (f === '报告A' ? ['/kb/a/img-1.png'] : []),
      () => true
    )
    expect(r.imageVerdicts).toBeUndefined()
  })

  it('一节的图全部被豁免 → imageVerdicts 字段缺省而非空数组（字段有无契约）', () => {
    const md = '正文（据《报告A》）\n\n![上传图](/U/x/app/proposal-drafts/s1/assets/upload-1.png)'
    const r = verifyCitationsCore(md, (f) => (f === '报告A' ? '正文' : null), () => [])
    expect(r.imageVerdicts).toBeUndefined()
    expect('imageVerdicts' in r).toBe(false)
  })
})

describe('splitMarkdownBySections', () => {
  it('按 section 标记切节，标记行本身剔除', () => {
    const md = '<!--proposal-section:cover-->\n封面\n\n<!--proposal-section:content-->\n正文'
    const parts = splitMarkdownBySections(md)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toContain('封面')
    expect(parts[0]).not.toContain('proposal-section')
    expect(parts[1]).toContain('正文')
  })
  it('无标记 → 整篇当一节', () => {
    expect(splitMarkdownBySections('裸 markdown')).toEqual(['裸 markdown'])
  })
  it('空串 → 空数组', () => {
    expect(splitMarkdownBySections('')).toEqual([])
  })
})

describe('collectUngroundedImagePathsCore（导出闸门·按节汇总未接地图）', () => {
  const resolveAssets = (f: string): string[] =>
    f === 'A' ? ['/kb/a/img-1.png'] : f === 'B' ? ['/kb/b/img-2.png'] : []

  it('每节按本节引用判接地，汇总所有 ungrounded 图路径', () => {
    const md = [
      '<!--proposal-section:content-->',
      '甲章内容。（据《A》）',
      '![图1](/kb/a/img-1.png)', // 本节引 A、img-1 属 A → grounded
      '![盗图](/kb/x/img-9.png)', // 不属 A → ungrounded
      '<!--proposal-section:content-->',
      '乙章内容。（据《B》）',
      '![图2](/kb/b/img-2.png)' // 本节引 B、img-2 属 B → grounded
    ].join('\n')
    const out = collectUngroundedImagePathsCore(md, () => null, resolveAssets)
    expect([...out]).toEqual(['/kb/x/img-9.png'])
  })

  it('per-section 隔离：图属 A 但出现在只引 B 的节 → ungrounded', () => {
    const md = [
      '<!--proposal-section:content-->',
      '乙章内容。（据《B》）',
      '![借A的图](/kb/a/img-1.png)' // 本节只引 B，img-1 属 A 不属 B → ungrounded
    ].join('\n')
    const out = collectUngroundedImagePathsCore(md, () => null, resolveAssets)
    expect([...out]).toEqual(['/kb/a/img-1.png'])
  })

  it('全部接地 → 空集', () => {
    const md = '<!--proposal-section:content-->\n甲。（据《A》）\n![图](/kb/a/img-1.png)'
    const out = collectUngroundedImagePathsCore(md, () => null, resolveAssets)
    expect(out.size).toBe(0)
  })
})
