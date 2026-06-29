import { describe, it, expect } from 'bun:test'

import {
  parseCitations,
  trigramOverlap,
  buildProposalMetric,
  parseImages,
  isEmbeddableImagePath,
  extractProposalDraftResult,
  gateDraftBlocksByPhase,
  isDraftBlockAheadOfPhase,
  laterPhase
} from './proposal'
import type { ProposalMetricSection, ProposalDraftBlock } from './proposal'

describe('parseCitations', () => {
  it('无引用 → 空数组', () => {
    expect(parseCitations('这是一段没有任何来源标注的正文。')).toEqual([])
    expect(parseCitations('')).toEqual([])
  })

  it('单条引用 → 一段正文 + 单文件', () => {
    const out = parseCitations('智能预问诊系统支持多轮对话。（据《产品白皮书》）')
    expect(out).toHaveLength(1)
    expect(out[0].files).toEqual(['产品白皮书'])
    expect(out[0].paragraph).toBe('智能预问诊系统支持多轮对话。')
  })

  it('一组多文件（空格 / 顿号分隔都识别）', () => {
    expect(parseCitations('正文。（据《A》《B》）')[0].files).toEqual(['A', 'B'])
    expect(parseCitations('正文。（据《A》、《B》）')[0].files).toEqual(['A', 'B'])
  })

  it('组内同名文件去重', () => {
    expect(parseCitations('正文。（据《A》《A》）')[0].files).toEqual(['A'])
  })

  it('相邻两段：各自正文归属到各自引用之前', () => {
    const out = parseCitations('第一段内容。（据《A》）\n\n第二段内容。（据《B》《C》）')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ paragraph: '第一段内容。', files: ['A'] })
    expect(out[1]).toEqual({ paragraph: '第二段内容。', files: ['B', 'C'] })
  })

  it('空引用组（无《》）跳过', () => {
    expect(parseCitations('正文。（据无名）')).toEqual([])
  })
})

describe('trigramOverlap', () => {
  it('全等 → 1', () => {
    expect(trigramOverlap('智能预问诊系统', '智能预问诊系统')).toBe(1)
  })

  it('完全无重叠 → 0', () => {
    expect(trigramOverlap('aaaa', 'bbbb')).toBe(0)
  })

  it('部分重叠 → 介于 0 和 1（且高于阈值）', () => {
    const o = trigramOverlap(
      '智能预问诊系统支持多轮对话',
      '本平台的智能预问诊系统支持多轮对话与分诊建议，覆盖门诊全流程'
    )
    expect(o).toBeGreaterThan(0.5)
    expect(o).toBeLessThanOrEqual(1)
  })

  it('短串（<3字）退化为子串判定', () => {
    expect(trigramOverlap('预诊', '智能预诊流程')).toBe(1)
    expect(trigramOverlap('问诊', '智能预诊流程')).toBe(0)
  })

  it('空串 → 0', () => {
    expect(trigramOverlap('', 'abc')).toBe(0)
    expect(trigramOverlap('abc', '')).toBe(0)
  })

  it('忽略空白后比较', () => {
    expect(trigramOverlap('智 能 预 问 诊', '智能预问诊')).toBe(1)
  })
})

describe('buildProposalMetric', () => {
  const META = { ts: 1000, sessionId: 's1', format: 'docx' as const }

  it('空草稿 → 全 0', () => {
    const r = buildProposalMetric([], META)
    expect(r.sectionCount).toBe(0)
    expect(r.kindCounts).toEqual({ cover: 0, toc: 0, content: 0 })
    expect(r.deliverability).toEqual({ generatedChars: 0, finalChars: 0, netEditedChars: 0 })
    expect(r.citation.totalCitations).toBe(0)
    expect(r.ts).toBe(1000)
    expect(r.format).toBe('docx')
  })

  it('各 kind 段落数按 kind 计', () => {
    const secs: ProposalMetricSection[] = [
      { markdown: 'a', kind: 'cover' },
      { markdown: 'b', kind: 'toc' },
      { markdown: 'c', kind: 'content' },
      { markdown: 'd', kind: 'content' }
    ]
    expect(buildProposalMetric(secs, META).kindCounts).toEqual({ cover: 1, toc: 1, content: 2 })
  })

  it('净编辑字数=Σ|len(当前)−len(生成原文)|，无 baseline 记 0', () => {
    const secs: ProposalMetricSection[] = [
      { markdown: '1234567890', baselineMarkdown: '12345' }, // 生成5字→改成10字，净+5
      { markdown: '12', baselineMarkdown: '12345' }, // 生成5字→删成2字，净3
      { markdown: 'xyz' } // 无 baseline → 净 0
    ].map((s) => ({ ...s, kind: 'content' as const }))
    const r = buildProposalMetric(secs, META)
    expect(r.deliverability.generatedChars).toBe(5 + 5 + 3) // 无 baseline 退化为当前长
    expect(r.deliverability.finalChars).toBe(10 + 2 + 3)
    expect(r.deliverability.netEditedChars).toBe(5 + 3 + 0)
  })

  it('引用三态聚合，仅统计 content、按 verdict 累加', () => {
    const secs: ProposalMetricSection[] = [
      // 封面有 verification 也不计入引用统计
      {
        markdown: 'cover',
        kind: 'cover',
        verification: { verdicts: [{ file: 'X', status: 'supported', overlap: 0.9 }], citedFileCount: 1 }
      },
      {
        markdown: 'c1',
        kind: 'content',
        verification: {
          verdicts: [
            { file: 'A', status: 'supported', overlap: 0.8 },
            { file: 'B', status: 'unsupported', overlap: 0.1 }
          ],
          citedFileCount: 2
        }
      },
      {
        markdown: 'c2',
        kind: 'content',
        verification: { verdicts: [{ file: 'C', status: 'file-not-found' }], citedFileCount: 1 }
      }
    ]
    const r = buildProposalMetric(secs, META)
    expect(r.citation.verifiedSections).toBe(2)
    expect(r.citation.totalCitations).toBe(3)
    expect(r.citation.supported).toBe(1)
    expect(r.citation.unsupported).toBe(1)
    expect(r.citation.fileNotFound).toBe(1)
  })

  it('degraded / 未校验的 content 节排除出分母', () => {
    const secs: ProposalMetricSection[] = [
      { markdown: 'a', kind: 'content', verification: { verdicts: [], citedFileCount: 0, degraded: true } },
      { markdown: 'b', kind: 'content' }, // 未校验
      {
        markdown: 'c',
        kind: 'content',
        verification: { verdicts: [{ file: 'A', status: 'supported', overlap: 0.9 }], citedFileCount: 1 }
      }
    ]
    const r = buildProposalMetric(secs, META)
    expect(r.citation.degradedSections).toBe(1)
    expect(r.citation.unverifiedSections).toBe(1)
    expect(r.citation.verifiedSections).toBe(1)
    expect(r.citation.totalCitations).toBe(1)
  })

  it('已校验但 0 引用 → 覆盖度红灯计数', () => {
    const secs: ProposalMetricSection[] = [
      { markdown: 'a', kind: 'content', verification: { verdicts: [], citedFileCount: 0 } }
    ]
    const r = buildProposalMetric(secs, META)
    expect(r.citation.verifiedSections).toBe(1)
    expect(r.citation.zeroCitationSections).toBe(1)
    expect(r.citation.totalCitations).toBe(0)
  })
})

describe('parseImages', () => {
  it('抽取多张图的 alt 与 path', () => {
    const md = '正文一。\n\n![架构图](/kb/assets/a/img-1.png)\n\n更多。\n\n![流程](/kb/assets/a/img-2.jpg)'
    expect(parseImages(md)).toEqual([
      { alt: '架构图', path: '/kb/assets/a/img-1.png' },
      { alt: '流程', path: '/kb/assets/a/img-2.jpg' }
    ])
  })

  it('与引用标注（据《X》）共存、互不干扰；普通链接不算图', () => {
    const md = '某段（据《白皮书》）\n\n![图](/kb/assets/a/img-1.png)\n\n[纯链接](/not-an-image)'
    expect(parseImages(md)).toEqual([{ alt: '图', path: '/kb/assets/a/img-1.png' }])
  })

  it('无图 → 空数组', () => {
    expect(parseImages('纯文字，无图。')).toEqual([])
    expect(parseImages('')).toEqual([])
  })
})

describe('isEmbeddableImagePath（可嵌 docx 的位图格式·预览=导出同源谓词）', () => {
  it('docx ImageRun 支持的位图 → true（不分大小写）', () => {
    expect(isEmbeddableImagePath('/kb/assets/a/img-1.png')).toBe(true)
    expect(isEmbeddableImagePath('/kb/assets/a/img-1.jpg')).toBe(true)
    expect(isEmbeddableImagePath('/kb/assets/a/img-1.jpeg')).toBe(true)
    expect(isEmbeddableImagePath('/kb/assets/a/img-1.gif')).toBe(true)
    expect(isEmbeddableImagePath('/kb/assets/a/IMG.PNG')).toBe(true)
  })
  it('docx 无法原生嵌入的格式（webp/svg/bmp）→ false（预览与导出都降级文字）', () => {
    expect(isEmbeddableImagePath('/kb/assets/a/img-1.webp')).toBe(false)
    expect(isEmbeddableImagePath('/kb/assets/a/diagram.svg')).toBe(false)
    expect(isEmbeddableImagePath('/kb/assets/a/scan.bmp')).toBe(false)
  })
  it('无扩展名 / 空串 → false（顺带堵无后缀名边界）', () => {
    expect(isEmbeddableImagePath('/kb/assets/a/noext')).toBe(false)
    expect(isEmbeddableImagePath('')).toBe(false)
  })
})

describe('stripDraftHtml（经 extractProposalDraftResult 间接验证）', () => {
  const wrap = (body: string): string => `===方案正文开始===\n${body}\n===方案正文结束===`
  const draftOf = (body: string): string =>
    extractProposalDraftResult(wrap(body)).blocks[0]?.markdown ?? ''

  it('删除 AI 自作主张的排版 HTML 标签，保留可见文本', () => {
    expect(draftOf('<div align="center">方案标题</div>')).toBe('方案标题')
    expect(draftOf('左<span style="color:red">红</span>右')).toBe('左红右')
  })
  it('<br> 各形态 → 换行', () => {
    expect(draftOf('上<br>下')).toBe('上\n下')
    expect(draftOf('上<br/>下')).toBe('上\n下')
    expect(draftOf('上<br />下')).toBe('上\n下')
  })
  it('不吞正文里的泛型 / 比较表达式（非 HTML 标签名）', () => {
    expect(draftOf('用 List<String> 承载结果')).toBe('用 List<String> 承载结果')
    expect(draftOf('当 A<B 且 C>D 时触发')).toBe('当 A<B 且 C>D 时触发')
    expect(draftOf('泛型 Map<K,V> 缓存')).toBe('泛型 Map<K,V> 缓存')
  })
  it('保留 markdown 自动链接（< 后紧跟协议/邮箱，非标签）', () => {
    expect(draftOf('见 <https://example.com> 链接')).toBe('见 <https://example.com> 链接')
  })
})

describe('isDraftBlockAheadOfPhase（阶段门谓词）', () => {
  it('content 块在 cover/toc 阶段都判为「越过目录门」', () => {
    expect(isDraftBlockAheadOfPhase('cover', 'content')).toBe(true)
    expect(isDraftBlockAheadOfPhase('toc', 'content')).toBe(true)
  })
  it('content 块在 content 阶段合法（用户已确认目录）', () => {
    expect(isDraftBlockAheadOfPhase('content', 'content')).toBe(false)
  })
  it('cover/toc 块任何阶段都不算越界（封面可反复改、cover→toc 允许聊天驱动）', () => {
    for (const phase of ['cover', 'toc', 'content'] as const) {
      expect(isDraftBlockAheadOfPhase(phase, 'cover')).toBe(false)
      expect(isDraftBlockAheadOfPhase(phase, 'toc')).toBe(false)
    }
  })
})

describe('gateDraftBlocksByPhase（阶段门护栏）', () => {
  const block = (kind: ProposalDraftBlock['kind'], markdown = 'x'): ProposalDraftBlock => ({
    kind,
    markdown
  })

  it('核心 bug：toc 阶段 AI 直接吐 content → 拦下，phase 不被顶过目录门', () => {
    const r = gateDraftBlocksByPhase('toc', [block('content', '## 第一章 …')])
    expect(r.accepted).toEqual([])
    expect(r.skippedAhead).toEqual([block('content', '## 第一章 …')])
    expect(r.nextPhase).toBe('toc') // 绝不自动跨 toc→content
  })

  it('toc 阶段正常出目录 → 接受，phase 留 toc', () => {
    const r = gateDraftBlocksByPhase('toc', [block('toc', '1. 背景\n2. 方案')])
    expect(r.accepted).toHaveLength(1)
    expect(r.skippedAhead).toEqual([])
    expect(r.nextPhase).toBe('toc')
  })

  it('cover 阶段聊天驱动出目录 → 接受并自动推进到 toc', () => {
    const r = gateDraftBlocksByPhase('cover', [block('toc')])
    expect(r.accepted).toHaveLength(1)
    expect(r.nextPhase).toBe('toc')
  })

  it('cover 阶段 AI 越级吐正文 → 拦下，phase 留 cover', () => {
    const r = gateDraftBlocksByPhase('cover', [block('content')])
    expect(r.accepted).toEqual([])
    expect(r.skippedAhead).toHaveLength(1)
    expect(r.nextPhase).toBe('cover')
  })

  it('content 阶段逐章写正文 → 接受（用户已确认目录）', () => {
    const r = gateDraftBlocksByPhase('content', [block('content')])
    expect(r.accepted).toHaveLength(1)
    expect(r.skippedAhead).toEqual([])
    expect(r.nextPhase).toBe('content')
  })

  it('同消息混排 toc+content（toc 阶段）→ 收目录、拦正文，phase 留 toc', () => {
    const r = gateDraftBlocksByPhase('toc', [block('toc', '目录'), block('content', '正文')])
    expect(r.accepted).toEqual([block('toc', '目录')])
    expect(r.skippedAhead).toEqual([block('content', '正文')])
    expect(r.nextPhase).toBe('toc')
  })

  it('content 阶段回头改目录 → 接受 toc 块但 phase 不回退', () => {
    const r = gateDraftBlocksByPhase('content', [block('toc', '改后的目录')])
    expect(r.accepted).toHaveLength(1)
    expect(r.nextPhase).toBe('content')
  })
})

describe('laterPhase（阶段绝不回退）', () => {
  it('取更靠后的阶段', () => {
    expect(laterPhase('cover', 'toc')).toBe('toc')
    expect(laterPhase('toc', 'cover')).toBe('toc') // 不回退
    expect(laterPhase('content', 'toc')).toBe('content')
    expect(laterPhase('cover', 'cover')).toBe('cover')
  })
})
