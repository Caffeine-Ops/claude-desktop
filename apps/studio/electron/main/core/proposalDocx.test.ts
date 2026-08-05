import { describe, it, expect } from 'bun:test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
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

// 回归守卫：产出图（AI 生成/用户上传，存 <userData>/proposal-drafts/<sessionId>/assets/ 下的绝对
// 路径）走的是同一条 imageParagraphs 读图路径，架构上零改动——但没有测试锁住的话，未来任何人在
// exporter 里加「只信 KB 目录」的校验都会悄悄ломать产出图导出。用真实目录形状（proposal-drafts/
// <sessionId>/assets/xxx.png）复现，而不是随手扔在 tmp 根下，让意图看得见。
describe('markdownToDocxBuffer 嵌图（产出图 proposal-drafts 路径，防未来加白名单校验回归）', () => {
  it('产出图（proposal-drafts 绝对路径）真嵌入 docx，且未被 grounding 豁免逻辑误剔', async () => {
    const PNG_100 =
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAH0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg=='
    const assetsDir = join(tmpdir(), 'proposal-drafts', 'sess-test-12', 'assets')
    mkdirSync(assetsDir, { recursive: true })
    const png = join(assetsDir, 'gen-123.png')
    writeFileSync(png, Buffer.from(PNG_100, 'base64'))

    const withImg = await markdownToDocxBuffer(
      `<!--proposal-section:content-->\n\n## 架构\n\n![架构图](${png})\n\n（据《白皮书》）`
    )
    const without = await markdownToDocxBuffer(
      `<!--proposal-section:content-->\n\n## 架构\n\n架构图说明文字。\n\n（据《白皮书》）`
    )
    // 体积差 > 200 字节 = zip 里真多了 media 部件（proven 判据，见文件头 KB 嵌图用例）；
    // 顺带证明「图片是产出图（非 KB 资产）」这一事实没有触发 grounding 豁免逻辑把它从导出剔除——
    // 若被误剔，withImg 会退化成与 without 几乎等长的纯文字段落，差值远小于 200。
    expect(withImg.byteLength - without.byteLength).toBeGreaterThan(200)
  })
})

// task-7：写作导出复用同一条 imageParagraphs 读图路径，但写作正文里的图恒为相对路径
// （`../images/x.png`，正文节文件在 <项目>/drafts/、图在 <项目>/images/，兄弟目录）——
// 第 5 个参数 assetBaseDir 就是喂给这条路径的「节文件所在目录」，见 WalkEnv.assetBaseDir
// 与 resolveWritingAssetPath（writingExportPure.ts）头注释。
describe('markdownToDocxBuffer 嵌图（写作相对路径，assetBaseDir）', () => {
  // 2026-08-04 code review M-2：此前这条只断言 `buf.length > 500`，而一份完全空的 markdown
  // 生成的 docx 就有 20411 字节——这条断言的实际含义只有「函数没抛异常」，对「是否真的降级」
  // 零覆盖。改成与「传了 assetBaseDir、图真嵌入」的版本比体积：降级态应显著更小（没有 media
  // 部件），且应与「压根没提到图」的纯文字基线同一量级（< 200 字节差，同下面 webp 用例的判据）。
  it('assetBaseDir 缺省时，相对路径图找不到文件、降级为文字占位（不抛错，且真的没嵌入）', async () => {
    const md = '<!--proposal-section:content-->\n\n![配图](../images/gen-1.png)'
    const withoutAssetBaseDir = await markdownToDocxBuffer(md)
    const noImageAtAll = await markdownToDocxBuffer(
      '<!--proposal-section:content-->\n\n占位文字，没有图。'
    )
    // 降级态与「压根没提到图」的纯文字基线体积接近（同为一段文字段落），证明没有 media 部件
    // 被嵌入——而不只是「没抛异常」。
    expect(
      Math.abs(withoutAssetBaseDir.byteLength - noImageAtAll.byteLength)
    ).toBeLessThan(200)
  })

  it('图片文件不存在（用户手删 images/ 里的图）：readFileSync 失败，降级为文字占位、不抛错', async () => {
    const projectDir = join(tmpdir(), 'writing-test-proj-missing-' + Date.now())
    const draftsDir = join(projectDir, 'drafts')
    const imagesDir = join(projectDir, 'images')
    mkdirSync(draftsDir, { recursive: true })
    mkdirSync(imagesDir, { recursive: true }) // images/ 目录本身存在，但目标文件不存在
    const md = '<!--proposal-section:content-->\n\n![配图](../images/deleted.png)'
    const withMissingFile = await markdownToDocxBuffer(md, undefined, undefined, undefined, draftsDir)
    const noImageAtAll = await markdownToDocxBuffer(
      '<!--proposal-section:content-->\n\n占位文字，没有图。'
    )
    // 路径本身能正确解析成绝对路径（assetBaseDir 有效、images/ 目录也存在），但文件缺失——
    // 走 imageParagraphs 的 `readFileSync` try/catch 分支降级，与「压根没提到图」同一量级，
    // 不抛错、不中断导出。
    expect(Math.abs(withMissingFile.byteLength - noImageAtAll.byteLength)).toBeLessThan(200)
  })

  it('传入 assetBaseDir 后，相对路径图解析成绝对路径并真嵌入 docx', async () => {
    const PNG_100 =
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAH0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg=='
    const projectDir = join(tmpdir(), 'writing-test-proj-' + Date.now())
    const draftsDir = join(projectDir, 'drafts')
    const imagesDir = join(projectDir, 'images')
    mkdirSync(draftsDir, { recursive: true })
    mkdirSync(imagesDir, { recursive: true })
    writeFileSync(join(imagesDir, 'gen-1.png'), Buffer.from(PNG_100, 'base64'))

    const md = '<!--proposal-section:content-->\n\n![配图](../images/gen-1.png)'
    const withBase = await markdownToDocxBuffer(md, undefined, undefined, undefined, draftsDir)
    const withoutBase = await markdownToDocxBuffer(md)
    // 有 assetBaseDir 时相对路径被解析、真图嵌入（体积显著更大）；没有时降级为
    // 「[图：gen-1.png]」文字段落，两者体积差 > 200 字节的 media 部件判据同上。
    expect(withBase.byteLength - withoutBase.byteLength).toBeGreaterThan(200)
  })

  it('同一张图被引用两次，两处都真嵌入（各自独立解析，互不影响）', async () => {
    const PNG_100 =
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAH0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg=='
    const projectDir = join(tmpdir(), 'writing-test-proj-dup-' + Date.now())
    const draftsDir = join(projectDir, 'drafts')
    const imagesDir = join(projectDir, 'images')
    mkdirSync(draftsDir, { recursive: true })
    mkdirSync(imagesDir, { recursive: true })
    writeFileSync(join(imagesDir, 'gen-1.png'), Buffer.from(PNG_100, 'base64'))

    const mdOnce = '<!--proposal-section:content-->\n\n![配图](../images/gen-1.png)'
    const mdTwice =
      '<!--proposal-section:content-->\n\n![配图](../images/gen-1.png)\n\n正文分隔段。\n\n![配图2](../images/gen-1.png)'
    const noImage = '<!--proposal-section:content-->\n\n正文分隔段。'
    const once = await markdownToDocxBuffer(mdOnce, undefined, undefined, undefined, draftsDir)
    const twice = await markdownToDocxBuffer(mdTwice, undefined, undefined, undefined, draftsDir)
    const withoutAnyImage = await markdownToDocxBuffer(noImage)
    // `docx` 库按内容对 media 部件去重（同一张图两次引用只落一份二进制、两个引用关系），
    // 故 twice 不会是 once 的整整两倍——但两次引用都必须真解析出同一个 resolvedUrl、
    // 都不降级：twice 比"完全没有图、只多一段正文"的基线大得多（每个引用各自新增一段
    // ImageRun 段 + 一条 relationship，即便共享同一份 media 二进制）。
    expect(twice.byteLength).toBeGreaterThan(withoutAnyImage.byteLength + 200)
    expect(once.byteLength).toBeGreaterThan(withoutAnyImage.byteLength + 200)
  })

  it('.webp 相对路径图降级为文字占位，与预览侧同一谓词（isEmbeddableImagePath）', async () => {
    const projectDir = join(tmpdir(), 'writing-test-proj-webp-' + Date.now())
    const draftsDir = join(projectDir, 'drafts')
    const imagesDir = join(projectDir, 'images')
    mkdirSync(draftsDir, { recursive: true })
    mkdirSync(imagesDir, { recursive: true })
    // 内容是否为真 webp 不重要——isEmbeddableImagePath 只按扩展名判定，走到扩展名分支
    // 就应直接降级，不会尝试读盘/解码。
    writeFileSync(join(imagesDir, 'gen-1.webp'), Buffer.from('not-a-real-webp'))

    const md = '<!--proposal-section:content-->\n\n![配图](../images/gen-1.webp)'
    const withBase = await markdownToDocxBuffer(md, undefined, undefined, undefined, draftsDir)
    const withoutImage = await markdownToDocxBuffer(
      '<!--proposal-section:content-->\n\n占位文字，没有图。'
    )
    // 两者都是纯文字段落量级（降级占位 vs 无图正文），不应出现真嵌图那种 > 200 字节的跳变。
    expect(withBase.byteLength - withoutImage.byteLength).toBeLessThan(200)
  })

  // 越界安全阀落到真实导出链路的冒烟。2026-08-04 code review M-2：此前用 `/etc/passwd` 当靶子
  // 是重言式——它没有扩展名，isEmbeddableImagePath 本来就会拒绝，就算把越界安全阀整个删掉
  // 这条测试也照样绿，测的其实是「无扩展名图片会降级」而不是「越界会被拦」。换成一个真实存在、
  // 扩展名合法、只是【在越界路径上】的 png：如果安全阀失效，这张图会被真嵌入（体积跳变）；
  // 安全阀生效则与「压根没提到图」的基线同一量级。
  it('相对路径越界（跳出 base 父目录之外）不解析，降级为文字占位（真实存在的图也不例外）', async () => {
    const PNG_100 =
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAH0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg=='
    // 目录结构：<root>/a/b/drafts（assetBaseDir）与 <root>/a/images（越界两层才能到达，
    // 超出「只放一层」的安全阀），后者放一张真实存在的 png——如果安全阀被绕过，这张图会被
    // 真嵌入；安全阀生效的话，two-levels-up 的相对路径压根不会被解析，还是原样的相对串，
    // readFileSync 找不到文件，降级为文字占位。
    const root = join(tmpdir(), 'writing-test-escape-' + Date.now())
    const draftsDir = join(root, 'a', 'b', 'drafts')
    const escapedImagesDir = join(root, 'a', 'images') // 只跳一层本该落在这里，但越界请求跳了两层
    mkdirSync(draftsDir, { recursive: true })
    mkdirSync(escapedImagesDir, { recursive: true })
    writeFileSync(join(escapedImagesDir, 'x.png'), Buffer.from(PNG_100, 'base64'))

    const md = '<!--proposal-section:content-->\n\n![越界](../../images/x.png)'
    const withEscape = await markdownToDocxBuffer(md, undefined, undefined, undefined, draftsDir)
    const noImageAtAll = await markdownToDocxBuffer(
      '<!--proposal-section:content-->\n\n占位文字，没有图。'
    )
    expect(Math.abs(withEscape.byteLength - noImageAtAll.byteLength)).toBeLessThan(200)
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

// 从 docx（zip）buffer 里解出 word/document.xml 文本：尾部找 EOCD → 中央目录拿偏移与压缩尺寸
// → inflateRawSync。仅测试用，不求通用健壮。
function readDocxDocumentXml(buf: Buffer): string {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('EOCD not found')
  let off = buf.readUInt32LE(eocd + 16)
  const count = buf.readUInt16LE(eocd + 10)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory header')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    if (name === 'word/document.xml') {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const data = buf.subarray(dataStart, dataStart + compSize)
      return method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8')
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('document.xml not found in docx')
}

describe('markdownToDocxBuffer 剥除 genimage 指令块', () => {
  it('未处理的指令块绝不进交付 Word（document.xml 无残留）', async () => {
    const md = [
      '<!--proposal-section:content-->',
      '',
      '## 总体架构',
      '',
      '正文。（据《白皮书》）',
      '',
      '```genimage',
      '图说: 系统总体架构图',
      '分层构图描述。',
      '```',
      '',
      '尾段。（据《白皮书》）'
    ].join('\n')
    const buf = await markdownToDocxBuffer(md)
    const xml = readDocxDocumentXml(Buffer.from(buf))
    expect(xml).not.toContain('genimage')
    expect(xml).not.toContain('图说')
    expect(xml).not.toContain('分层构图描述')
    expect(xml).toContain('尾段') // 剥除不误伤相邻正文
  })
  it('未闭合的 genimage 围栏绝不吞掉后续正文（评审 #1 回归：code 兜底不再 return []）', async () => {
    // 流式截断现场：未闭合围栏 + 后续真实章节 + mermaid 块。strip 对畸形块安全失败原样保留，
    // remark 会把它解析成一路吞到 mermaid 收尾 ``` 的 genimage code 节点——旧的 return [] 兜底
    // 会让「重要章节」和 mermaid 一起从交付 Word 里无声消失。
    const md = [
      '<!--proposal-section:content-->',
      '',
      '## 总体架构',
      '',
      '```genimage',
      '图说: 被截断的指令',
      '描述写到一半',
      '',
      '## 重要章节',
      '',
      '这段正文绝不能丢。（据《白皮书》）',
      '',
      '```mermaid',
      'flowchart LR',
      'A-->B',
      '```',
      '',
      '尾段。（据《白皮书》）'
    ].join('\n')
    const buf = await markdownToDocxBuffer(md)
    const xml = readDocxDocumentXml(Buffer.from(buf))
    expect(xml).toContain('这段正文绝不能丢')
    expect(xml).toContain('尾段')
  })
})

// ── 章节装饰（自动编号 + 分章分页）的体裁开关 ────────────────────────────
//
// 2026-08-05 真机走查抓到的缺陷：写作的 Word/PDF 导出复用本模块，连带继承了方案文档专属的
// 两个「章节装饰」——① `##` 标题自动挂层级编号（与方案目录对齐用），② 每个 `##` 另起一页。
// 对方案是对的，对一篇公众号文案是错的：标题被编号会与正文自带的「一、二、三」撞成双重编号，
// 每节分页会把 600 字的文案排成 3 页（大半空白）。
//
// 故加一个 `chapterChrome` 开关，**缺省 true = 方案行为逐字不变**（这是本仓的红线），写作侧传 false。
// 两条用例是一对：一条钉住方案不许被改坏，一条钉住写作确实关掉了。
describe('markdownToDocxBuffer 章节装饰开关（chapterChrome）', () => {
  const md = [
    '# 每天写日报，怎么越写越累',
    '',
    '## 一、活干完了，你还得再干一遍',
    '',
    '正文一。',
    '',
    '## 二、日报的单位是一天',
    '',
    '正文二。'
  ].join('\n')

  it('缺省（方案）：章节标题带自动编号，且各章另起一页', async () => {
    const buf = await markdownToDocxBuffer(md)
    const xml = readDocxDocumentXml(Buffer.from(buf))
    expect(xml).toContain('<w:numPr>') // 标题挂了编号实例
    expect(xml).toContain('w:type="page"') // 章节间插了分页符
  })

  it('chapterChrome=false（写作）：标题不编号，也不插分页符', async () => {
    const buf = await markdownToDocxBuffer(md, undefined, undefined, undefined, undefined, false)
    const xml = readDocxDocumentXml(Buffer.from(buf))
    expect(xml).not.toContain('<w:numPr>')
    expect(xml).not.toContain('w:type="page"')
    expect(xml).toContain('活干完了') // 关掉装饰不影响正文本身
  })
})
