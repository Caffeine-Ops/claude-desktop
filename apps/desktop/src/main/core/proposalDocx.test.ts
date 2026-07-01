import { describe, it, expect } from 'bun:test'
import { HeadingLevel } from 'docx'
import { headingLevelForDepth } from './proposalDocx'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RootContent } from 'mdast'

import {
  markdownToDocxBuffer,
  stripLeadingTocHeading,
  splitCoverNodes,
  hierarchicalLevelText,
  stripManualHeadingNumber,
  chapterPageBreakIndices
} from './proposalDocx'

// 层级编号占位串：每级引用全部祖先计数器，配 DECIMAL 即 1 / 1.1 / 1.1.1（目录与正文标题共用）。
describe('headingLevelForDepth（字号档位与编号同源 depth-2，防塌陷回归）', () => {
  it('## 章(depth2) → HEADING_1（复用此前闲置的 h1 档 = 最大标题字号）', () => {
    expect(headingLevelForDepth(2)).toBe(HeadingLevel.HEADING_1)
  })
  it('### 节(depth3) → HEADING_2', () => {
    expect(headingLevelForDepth(3)).toBe(HeadingLevel.HEADING_2)
  })
  it('#### 小节(depth4) → HEADING_3', () => {
    expect(headingLevelForDepth(4)).toBe(HeadingLevel.HEADING_3)
  })
  it('##### 要点(depth5) → HEADING_4（回退 h3 字号，靠加粗与正文区分）', () => {
    expect(headingLevelForDepth(5)).toBe(HeadingLevel.HEADING_4)
  })
  it('depth1（正文罕见的裸 #）下界 clamp → HEADING_1，绝不越界出 undefined', () => {
    expect(headingLevelForDepth(1)).toBe(HeadingLevel.HEADING_1)
  })
  it('过深 depth9 上界 clamp → HEADING_6，绝不越界', () => {
    expect(headingLevelForDepth(9)).toBe(HeadingLevel.HEADING_6)
  })
  it('回归锚点：档位索引 = depth-2 = 编号 numLevel，别再改回 depth-1', () => {
    // ## → 索引0(H1)=numLevel0(编号 1)、### → 索引1(H2)=numLevel1(编号 1.1)，两套映射同基准。
    expect(headingLevelForDepth(2)).toBe(HeadingLevel.HEADING_1)
    expect(headingLevelForDepth(3)).toBe(HeadingLevel.HEADING_2)
  })
})

describe('hierarchicalLevelText', () => {
  it('level 0 → %1（一级章，单计数器）', () => {
    expect(hierarchicalLevelText(0)).toBe('%1')
  })
  it('level 1 → %1.%2（二级节，串祖先）', () => {
    expect(hierarchicalLevelText(1)).toBe('%1.%2')
  })
  it('level 2 → %1.%2.%3（三级子节）', () => {
    expect(hierarchicalLevelText(2)).toBe('%1.%2.%3')
  })
})

// 防御性剥除 AI 手打的章节序号——只剥「小章节号」，放过数字开头的真标题。
describe('stripManualHeadingNumber', () => {
  it('剥单层「1 」', () => {
    expect(stripManualHeadingNumber('1 系统功能概述')).toBe('系统功能概述')
  })
  it('剥点分两级「1.1 」', () => {
    expect(stripManualHeadingNumber('1.1 建设背景')).toBe('建设背景')
  })
  it('剥点分三级「1.4.1 」', () => {
    expect(stripManualHeadingNumber('1.4.1 面向患者')).toBe('面向患者')
  })
  it('剥顿号分隔「1、」', () => {
    expect(stripManualHeadingNumber('1、建设背景')).toBe('建设背景')
  })
  it('剥句点分隔「1. 」', () => {
    expect(stripManualHeadingNumber('1. 系统定位')).toBe('系统定位')
  })
  it('放过数字后非分隔符的真标题「5G 网络方案」', () => {
    expect(stripManualHeadingNumber('5G 网络方案')).toBe('5G 网络方案')
  })
  it('放过 4 位数年份开头「2024 年规划」（非章节号）', () => {
    expect(stripManualHeadingNumber('2024 年规划')).toBe('2024 年规划')
  })
  it('放过无序号的纯标题', () => {
    expect(stripManualHeadingNumber('系统定位')).toBe('系统定位')
  })
})

// 章节分页（需求：每个 ## 章节大标题另起一页）：决定「正文节里哪些顶层节点前应插分页符」的
// 纯函数。规则——只认 ## 章节（depth 2，即编号 1/2/3 的层级），且【第一章除外】（它已在本节首页
// 顶部，再插会多出空白页）；###/#### 子标题不触发。
describe('chapterPageBreakIndices', () => {
  const h = (depth: number): RootContent =>
    ({ type: 'heading', depth, children: [{ type: 'text', value: 'x' }] }) as unknown as RootContent
  const p = (): RootContent =>
    ({ type: 'paragraph', children: [{ type: 'text', value: '正文' }] }) as unknown as RootContent

  it('多章：第一章不分页，其后每章前分页', () => {
    // [##, p, ##, p, ##] → 第二、三个 ## 前分页（索引 2、4），第一个（索引 0）不分页。
    const nodes = [h(2), p(), h(2), p(), h(2)]
    expect([...chapterPageBreakIndices(nodes)].sort((a, b) => a - b)).toEqual([2, 4])
  })
  it('单章：不产生任何分页', () => {
    expect(chapterPageBreakIndices([h(2), p(), p()]).size).toBe(0)
  })
  it('子标题 ### / #### 不触发分页', () => {
    // 一个 ## 章下挂 ###、####：只有 ## 算章节，子标题不分页 → 空集（首个 ## 也不分页）。
    const nodes = [h(2), h(3), p(), h(4), p()]
    expect(chapterPageBreakIndices(nodes).size).toBe(0)
  })
  it('章前有游离段落：仍只在第二个 ## 起分页', () => {
    const nodes = [p(), h(2), p(), h(2)]
    expect([...chapterPageBreakIndices(nodes)]).toEqual([3])
  })
})

// 多章正文过真实导出器不抛错、产出非空 docx（章节分页插的 PageBreak 段落不破坏合法性）。
describe('markdownToDocxBuffer 章节分页', () => {
  it('多章正文导出不抛错', async () => {
    const md = [
      '<!--proposal-section:content-->',
      '',
      '## 第一章',
      '',
      '正文一。（据《白皮书》）',
      '',
      '## 第二章',
      '',
      '正文二。（据《白皮书》）',
      '',
      '## 第三章',
      '',
      '正文三。（据《白皮书》）'
    ].join('\n')
    const buf = await markdownToDocxBuffer(md)
    expect(buf.length).toBeGreaterThan(1000)
  })
})

// 新增的目录/正文层级编号路径冒烟：含嵌套有序目录 + 多级正文标题的 markdown 过真实导出器
// 不抛错、产出合法 docx。仓库无 zip 库，无法断言 numbering.xml 的层级文本（与表格冒烟同限制），
// 故这里只守 no-throw + 非空；编号是否真为 1/1.1/1.1.1 由 GUI 走查确认。
describe('markdownToDocxBuffer 层级编号路径', () => {
  it('嵌套有序目录 + 多级正文标题导出不抛错', async () => {
    const md = [
      '<!--proposal-section:toc-->',
      '',
      '1. 系统功能概述',
      '   1. 建设背景',
      '   2. 系统定位',
      '2. 总体方案设计',
      '',
      '<!--proposal-section:content-->',
      '',
      '## 系统功能概述',
      '',
      '### 建设背景',
      '',
      '#### 面向患者',
      '',
      '正文一段。（据《白皮书》）'
    ].join('\n')
    const buf = await markdownToDocxBuffer(md)
    expect(buf.length).toBeGreaterThan(1000)
  })
})

// 仓库无 zip 库、表格导出代码（case 'table'）本就存在未改，故这里只做冒烟：含 GFM 表格的
// 正文 markdown 过真实导出器不抛错、产出合法 docx（zip）。
// 注意 buf.length > 1000 只是【no-throw + 非空】守卫，对「表格是否真进了 <w:tbl>」零信号
// （纯文字正文导出也远超 1000 字节）。要真正校验表格被渲染进 docx XML 需引 zip 库解包，
// 已划到范围外（见 spec「不在本 spec」）；待子项目 B 引入 docx 解包能力后再升级为行列断言。
describe('markdownToDocxBuffer 表格', () => {
  it('含 GFM 表格的正文不抛错、产出非空 docx', async () => {
    const md =
      '<!--proposal-section:content-->\n\n## 核心参数\n\n| 模块 | 说明 |\n| --- | --- |\n| 分诊 | 智能分诊建议 |\n\n（据《白皮书》）'
    const buf = await markdownToDocxBuffer(md)
    expect(buf.length).toBeGreaterThan(1000)
  })
})

describe('markdownToDocxBuffer 嵌图', () => {
  it('真位图被嵌入 docx（体积显著大于同文去图，证明非静默降级）', async () => {
    // 100x100 PNG（比 1x1 大，嵌入后体积差才明显）。
    const PNG_100 =
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAH0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg=='
    const png = join(tmpdir(), 'proposal-test-img-100.png')
    writeFileSync(png, Buffer.from(PNG_100, 'base64'))
    const withImg = await markdownToDocxBuffer(
      `<!--proposal-section:content-->\n\n## 架构\n\n![架构图](${png})\n\n（据《白皮书》）`
    )
    const noImg = await markdownToDocxBuffer(
      `<!--proposal-section:content-->\n\n## 架构\n\n架构图说明文字。\n\n（据《白皮书》）`
    )
    // 图真嵌入 → docx（zip）里多出 media 部件，体积显著更大；静默降级则两者几乎相等。
    expect(withImg.length).toBeGreaterThan(noImg.length + 200)
  })

  it('SVG / 读不到的图降级为文字、不抛错', async () => {
    const md =
      '<!--proposal-section:content-->\n\n![矢量图](/nope/x.svg)\n\n![缺图](/nope/missing.png)'
    const buf = await markdownToDocxBuffer(md)
    expect(buf.length).toBeGreaterThan(500)
  })
})

// mdast 节点构造小工具：测试 stripLeadingTocHeading / splitCoverNodes 对【粗体包裹】文本的
// 递归提取（评审发现：旧内联实现只读直接子节点的 value，strong/emphasis 包裹的文字读成空串）。
const text = (v: string): RootContent =>
  ({ type: 'paragraph', children: [{ type: 'text', value: v }] }) as unknown as RootContent
const heading = (v: string): RootContent =>
  ({ type: 'heading', depth: 1, children: [{ type: 'text', value: v }] }) as unknown as RootContent
const boldHeading = (v: string): RootContent =>
  ({
    type: 'heading',
    depth: 1,
    children: [{ type: 'strong', children: [{ type: 'text', value: v }] }]
  }) as unknown as RootContent
const boldPara = (v: string): RootContent =>
  ({
    type: 'paragraph',
    children: [{ type: 'strong', children: [{ type: 'text', value: v }] }]
  }) as unknown as RootContent

describe('stripLeadingTocHeading', () => {
  it('剥掉粗体包裹的「目录」标题（# **目录**）', () => {
    const rest = text('1. 第一章')
    expect(stripLeadingTocHeading([boldHeading('目录'), rest])).toEqual([rest])
  })
  it('纯文本「目录」标题仍剥（回归）', () => {
    const rest = text('1. 第一章')
    expect(stripLeadingTocHeading([heading('目录'), rest])).toEqual([rest])
  })
  it('非「目录」标题不剥', () => {
    expect(stripLeadingTocHeading([boldHeading('第一章 概述')])).toHaveLength(1)
  })
})

describe('splitCoverNodes', () => {
  it('粗体落款（**编制单位：X**）归为封面下块', () => {
    const title = text('某某系统建设方案')
    const footer = boldPara('编制单位：某某公司')
    const { top, bottom } = splitCoverNodes([title, footer])
    expect(top).toEqual([title])
    expect(bottom).toEqual([footer])
  })
  it('纯文本落款仍识别（回归）', () => {
    const title = text('某某系统建设方案')
    const footer = text('编制单位：某某公司')
    const { bottom } = splitCoverNodes([title, footer])
    expect(bottom).toEqual([footer])
  })
})
