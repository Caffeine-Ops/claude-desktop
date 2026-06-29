import { describe, it, expect } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RootContent } from 'mdast'

import { markdownToDocxBuffer, stripLeadingTocHeading, splitCoverNodes } from './proposalDocx'

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
