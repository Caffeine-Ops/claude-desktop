import { describe, it, expect } from 'bun:test'

import { buildProposalAppend } from './proposalPrompt'

describe('buildProposalAppend 表格纪律', () => {
  it('输出包含「结构化数据用表格」纪律与接地约束', () => {
    const out = buildProposalAppend('/mirror', [])
    expect(out).toContain('结构化数据')
    expect(out).toContain('GFM markdown 表格')
    // 接地：表里只填查到的真值、空缺写「—」、绝不为凑表编造
    expect(out).toContain('绝不为凑满表格而编造数据')
  })

  it('保留既有「全程中文」收尾纪律（无回归）', () => {
    expect(buildProposalAppend('/mirror', [])).toContain('全程中文')
  })
})

describe('buildProposalAppend 图片暴露与规则', () => {
  const scope = {
    dir: '/kb/线/品',
    productLine: '线',
    product: '品',
    files: [{ title: '白皮书', mirrorPath: '/kb/线/品/wp.txt', assets: ['/kb/线/品/assets/img-1.png'] }]
  }

  it('文件清单下列出其可用图路径', () => {
    const out = buildProposalAppend('/kb', [scope])
    expect(out).toContain('/kb/线/品/assets/img-1.png')
  })

  it('含「只用本段所引文件的图」嵌图规则', () => {
    const out = buildProposalAppend('/kb', [scope])
    expect(out).toContain('![图说]')
    expect(out).toContain('绝不挪用别处的图')
  })
})

describe('buildProposalAppend 阶段确认走 AskUserQuestion', () => {
  const out = buildProposalAppend('/mirror', [])

  it('每阶段完成后用 AskUserQuestion 确认才推进', () => {
    expect(out).toContain('每完成一个阶段')
    expect(out).toContain('AskUserQuestion')
  })

  it('封面/目录确认问题用固定 header 与放行项首选项文案', () => {
    expect(out).toContain('封面确认')
    expect(out).toContain('确认封面，生成目录')
    expect(out).toContain('目录确认')
    expect(out).toContain('确认目录，开始撰写正文')
  })

  it('不再宣称界面按钮推进（无回归）', () => {
    expect(out).not.toContain('界面按钮发来')
  })
})

describe('buildProposalAppend 配图密度增强', () => {
  const out = buildProposalAppend('/mirror', [])

  it('库图纪律为积极式：有对应图就应当插入、一节一图', () => {
    expect(out).toContain('就应当插入')
    expect(out).toContain('一节一图')
  })

  it('同一张图全文只插一次', () => {
    expect(out).toContain('只插一次')
  })

  it('mermaid 升级为密度要求：每个一级章应至少配一张结构图', () => {
    expect(out).toContain('应至少配一张')
  })

  it('genimage 指令块纪律：存在、限 3 个、接地', () => {
    expect(out).toContain('genimage')
    expect(out).toContain('图说:')
    expect(out).toContain('最多 3 个')
    expect(out).toContain('绝不为画面丰满编造')
  })

  it('既有库图硬约束不回归：同源约束与尖括号包裹仍在', () => {
    expect(out).toContain('![图说]')
    expect(out).toContain('绝不挪用别处的图')
    expect(out).toContain('尖括号')
  })
})
