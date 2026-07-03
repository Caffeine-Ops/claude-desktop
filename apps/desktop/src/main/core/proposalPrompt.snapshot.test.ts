import { describe, it, expect } from 'bun:test'

import { buildProposalAppend, type ProposalProductScope } from './proposalPrompt'

// skill 化改造（2026-07-03 设计）的逐字节回归基线：三种输入形态覆盖 scope 块与
// renderProductBlock 的全部分支——空清单回退、常规清单（含图/空 assets/空文件产品）、
// 文件数与图数双溢出截断。改造后（模板渲染）输出必须与这里固化的快照逐字节相等；
// 只有【有意】修改方法论文案时才允许 `bun test --update-snapshots` 刷新基线。
const EMPTY: ProposalProductScope[] = []

const NORMAL: ProposalProductScope[] = [
  {
    dir: '/kb/医疗线/预问诊',
    productLine: '医疗线',
    product: '预问诊',
    files: [
      {
        title: '产品白皮书',
        mirrorPath: '/kb/医疗线/预问诊/白皮书.md',
        // 路径故意带空格：验证清单渲染不动原始路径（尖括号包裹是 AI 侧纪律）
        assets: ['/kb/医疗线/预问诊/assets/首页 界面.png']
      },
      { title: '技术方案', mirrorPath: '/kb/医疗线/预问诊/技术方案.md', assets: [] }
    ]
  },
  { dir: '/kb/医疗线/空品', productLine: '医疗线', product: '空品', files: [] }
]

const OVERFLOW: ProposalProductScope[] = [
  {
    dir: '/kb/线/品',
    productLine: '线',
    product: '品',
    files: Array.from({ length: 55 }, (_, i) => ({
      title: `文件${i}`,
      mirrorPath: `/kb/线/品/f${i}.md`,
      assets: i === 0 ? Array.from({ length: 15 }, (_, j) => `/kb/线/品/assets/img-${j}.png`) : []
    }))
  }
]

describe('buildProposalAppend 输出快照（skill 化改造的逐字节回归基线）', () => {
  it('空产品清单（scope 回退到 Grep/Glob 自查文案）', () => {
    expect(buildProposalAppend('/mirror/kb-index', EMPTY)).toMatchSnapshot()
  })

  it('常规产品清单（含图 / 空 assets / 空文件产品三种文件形态）', () => {
    expect(buildProposalAppend('/mirror/kb-index', NORMAL)).toMatchSnapshot()
  })

  it('文件数超 50 且首文件图数超 12 的双溢出截断', () => {
    expect(buildProposalAppend('/mirror/kb-index', OVERFLOW)).toMatchSnapshot()
  })
})
