import { describe, it, expect } from 'bun:test'

import {
  parseCitations,
  stripCitations,
  parseGaps,
  trigramOverlap,
  buildProposalMetric,
  parseImages,
  normalizeImageMarkdown,
  isEmbeddableImagePath,
  extractProposalDraftResult,
  sortSectionsByKind,
  gateDraftBlocksByPhase,
  isDraftBlockAheadOfPhase,
  detectContentSentinelAheadOfPhase,
  laterPhase,
  decideProposalStageConfirm,
  appendDraftBlocks,
  collapseSingletonSections,
  splitProposalDraftSegments,
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
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

describe('stripCitations（导出/预览剥除段末来源标注）', () => {
  it('单个来源组整段删掉', () => {
    expect(stripCitations('智能预问诊支持多轮对话。（据《产品白皮书》）')).toBe(
      '智能预问诊支持多轮对话。'
    )
  })

  it('连续多个来源组都删掉（用户实例）', () => {
    expect(
      stripCitations(
        '系统建设方案如下。（据《【福鑫数科-特别详细版】AI智能预问诊系统建设方案》）（据《【福鑫数科-特别详细版】AI智能预问诊系统建设方案》）'
      )
    ).toBe('系统建设方案如下。')
  })

  it('一组内多个《》一并删掉', () => {
    expect(stripCitations('正文。（据《A》《B》）')).toBe('正文。')
  })

  it('吃掉引用组前的 ASCII 空格', () => {
    expect(stripCitations('正文 （据《A》）')).toBe('正文')
  })

  it('保留正文其余内容、多段只删来源', () => {
    expect(stripCitations('第一段。（据《A》）\n\n第二段。（据《B》）')).toBe('第一段。\n\n第二段。')
  })

  it('无来源标注原样返回；空串安全', () => {
    expect(stripCitations('这是一段没有任何来源标注的正文。')).toBe('这是一段没有任何来源标注的正文。')
    expect(stripCitations('')).toBe('')
  })
})

describe('parseGaps', () => {
  it('无缺口 → 空数组', () => {
    expect(parseGaps('普通正文，没有缺口标记。（据《A》）')).toEqual([])
    expect(parseGaps('')).toEqual([])
  })

  it('标准格式 → 抽出冒号后的描述', () => {
    expect(parseGaps('正文。\n⚠️ 资料缺失：2024 年三甲医院部署数量\n继续。')).toEqual([
      '2024 年三甲医院部署数量'
    ])
  })

  it('容忍措辞抖动：无空格 / 半角冒号 / 无变体选择符', () => {
    expect(parseGaps('⚠️资料缺失:具体报价')).toEqual(['具体报价'])
    expect(parseGaps('⚠资料缺失：服务条款')).toEqual(['服务条款'])
  })

  it('容忍行首列表/引用符与前导空白', () => {
    expect(parseGaps('- ⚠️ 资料缺失：A\n  > ⚠️ 资料缺失：B')).toEqual(['A', 'B'])
  })

  it('一节多处缺口按出现顺序保留、不去重', () => {
    expect(parseGaps('⚠️ 资料缺失：同一项\n⚠️ 资料缺失：同一项')).toEqual(['同一项', '同一项'])
  })

  it('安全阀：不带 ⚠ 前缀的普通行不误判（如目录里「资料缺失分析」一章）', () => {
    expect(parseGaps('3. 资料缺失分析\n本章讨论资料缺失：问题。')).toEqual([])
  })

  it('冒号后为空 → 跳过该行', () => {
    expect(parseGaps('⚠️ 资料缺失：   ')).toEqual([])
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

  it('引用《用户补充资料》→ 计入 userSupplied，不混进 supported/unsupported/fileNotFound', () => {
    const secs: ProposalMetricSection[] = [
      {
        markdown: 'c',
        kind: 'content',
        verification: {
          verdicts: [
            { file: 'A', status: 'supported', overlap: 0.9 },
            { file: '用户补充资料', status: 'user-supplied' }
          ],
          citedFileCount: 2
        }
      }
    ]
    const r = buildProposalMetric(secs, META)
    expect(r.citation.totalCitations).toBe(2)
    expect(r.citation.supported).toBe(1)
    expect(r.citation.userSupplied).toBe(1)
    expect(r.citation.unsupported).toBe(0)
    expect(r.citation.fileNotFound).toBe(0)
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

  it('剥离 markdown title 语法，path 不夹带（防合法配图误判 ungrounded）', () => {
    expect(parseImages('![架构图](/kb/assets/a/img-1.png "系统架构")')).toEqual([
      { alt: '架构图', path: '/kb/assets/a/img-1.png' }
    ])
    expect(parseImages("![图](/kb/assets/a/img-2.png '说明文字')")).toEqual([
      { alt: '图', path: '/kb/assets/a/img-2.png' }
    ])
  })

  it('路径含空格但无 title → 不误剥（userData 路径可能含空格）', () => {
    expect(parseImages('![图](/Users/a b/kb-index/assets/img.png)')).toEqual([
      { alt: '图', path: '/Users/a b/kb-index/assets/img.png' }
    ])
  })

  it('目标被尖括号包裹（AI 或归一化写的 `<path>`）→ 剥掉 <>，接地比对拿到干净路径', () => {
    expect(parseImages('![图](</Users/a b/kb-index/assets/img.png>)')).toEqual([
      { alt: '图', path: '/Users/a b/kb-index/assets/img.png' }
    ])
    // <> 包裹 + 尾随 title 一并处理
    expect(parseImages('![图](</kb/assets/a/img-1.png> "架构")')).toEqual([
      { alt: '图', path: '/kb/assets/a/img-1.png' }
    ])
  })
})

describe('normalizeImageMarkdown（给含空格图片目标补 <>，保 CommonMark 可解析·预览=导出一致）', () => {
  it('目标含空格且未包裹 → 补 <>（userData 绝对路径含「Application Support」的核心场景）', () => {
    const md =
      '![语音输入交互界面](/Users/kika/Library/Application Support/@claude-desktop/kb-index/assets/x/img-4.png)'
    expect(normalizeImageMarkdown(md)).toBe(
      '![语音输入交互界面](</Users/kika/Library/Application Support/@claude-desktop/kb-index/assets/x/img-4.png>)'
    )
  })

  it('目标不含空格 → 原样不动（不动无辜图）', () => {
    const md = '![图](/kb/assets/a/img-1.png)'
    expect(normalizeImageMarkdown(md)).toBe(md)
  })

  it('已用 <> 包裹 → 幂等，不重复包裹', () => {
    const md = '![图](</Users/a b/kb-index/assets/img.png>)'
    expect(normalizeImageMarkdown(md)).toBe(md)
    // 二次归一化仍不变（幂等）
    expect(normalizeImageMarkdown(normalizeImageMarkdown(md))).toBe(md)
  })

  it('含空格路径 + 尾随 title → 只包 url、title 留在 <> 外', () => {
    const md = '![图](/Users/a b/assets/img.png "系统架构")'
    expect(normalizeImageMarkdown(md)).toBe('![图](</Users/a b/assets/img.png> "系统架构")')
  })

  it('普通链接 [text](url with space) 不受影响（无前置 `!`，非图片）', () => {
    const md = '[某链接](/a b/c)'
    expect(normalizeImageMarkdown(md)).toBe(md)
  })

  it('一段里多张图各自独立处理；空串安全', () => {
    const md = '![a](/x y/1.png)\n\n![b](/no-space/2.png)\n\n![c](/p q/3.png)'
    expect(normalizeImageMarkdown(md)).toBe(
      '![a](</x y/1.png>)\n\n![b](/no-space/2.png)\n\n![c](</p q/3.png>)'
    )
    expect(normalizeImageMarkdown('')).toBe('')
  })

  it('归一化后经 parseImages 仍取到干净路径（两个纯函数协同的闭环）', () => {
    const md = '![图](/Users/a b/kb-index/assets/img.png)'
    const normalized = normalizeImageMarkdown(md)
    expect(parseImages(normalized)).toEqual([
      { alt: '图', path: '/Users/a b/kb-index/assets/img.png' }
    ])
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

describe('extractProposalDraftResult·哨兵必须独占整行（防内联引用的幻影块）', () => {
  it('哨兵被反引号内联引用（如对话总结/压缩复述格式说明）→ 不抽出任何块', () => {
    // 真实 bug：上下文压缩生成的「对话总结」里把哨兵当文档引用：
    //   正文须包在哨兵 `===方案正文开始===`/`===方案正文结束===` 内
    // 旧 indexOf 扫描会从这对引用里抽出中间的 `/`（反引号+斜杠+反引号）当正文块，
    // 右侧草稿于是只剩一个「/」。哨兵只有独占整行才算真分隔符。
    const summary =
      '# 对话总结\n\n核心纪律：正文须包在哨兵 `===方案正文开始===`/`===方案正文结束===` 内，' +
      '封面用封面哨兵、目录用目录哨兵。每段正文末尾标注 `（据《文件名》）`。'
    const r = extractProposalDraftResult(summary)
    expect(r.blocks).toEqual([])
    expect(r.truncated).toBeNull()
  })

  it('同行内行文中夹哨兵（前后有可见字符）→ 不算分隔符', () => {
    const r = extractProposalDraftResult('提示你用 ===方案正文开始=== 包住正文 ===方案正文结束=== 即可')
    expect(r.blocks).toEqual([])
    expect(r.truncated).toBeNull()
  })

  it('真·独占整行的哨兵照常抽出（容忍前后空白与 \\r）', () => {
    const r = extractProposalDraftResult(
      '前言。\n\n===方案正文开始===\n# 正文内容\n这是一段。\n===方案正文结束===\n\n收尾。'
    )
    expect(r.blocks).toEqual([{ kind: 'content', markdown: '# 正文内容\n这是一段。' }])
    expect(r.truncated).toBeNull()
  })

  it('混合：先内联引用的幻影哨兵，后真·整行哨兵 → 只抽真块', () => {
    const r = extractProposalDraftResult(
      '说明：写法是 `===方案封面开始===`。下面是真封面：\n\n===方案封面开始===\n# 标题\n===方案封面结束==='
    )
    expect(r.blocks).toEqual([{ kind: 'cover', markdown: '# 标题' }])
  })

  it('真起始哨兵独占行但结束哨兵只内联引用 → 截断残文（不被内联引用误闭合）', () => {
    const r = extractProposalDraftResult(
      '===方案正文开始===\n# 正文\n（结束写法是 `===方案正文结束===`）'
    )
    expect(r.blocks).toEqual([])
    expect(r.truncated?.kind).toBe('content')
    expect(r.truncated?.markdown).toContain('# 正文')
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

describe('detectContentSentinelAheadOfPhase（流式硬门·趁 AI 跳过目录确认刚冒正文就掐断）', () => {
  const begin = PROPOSAL_DRAFT_BEGIN.content

  it('toc 阶段冒出独占整行的正文起始哨兵 → 命中（应 abort）', () => {
    const text = `===方案目录开始===\n1. 背景\n===方案目录结束===\n${begin}\n# 项目背景`
    expect(detectContentSentinelAheadOfPhase(text, 'toc')).toBe(true)
  })

  it('cover 阶段直接冒正文哨兵（连目录都跳了）→ 命中', () => {
    expect(detectContentSentinelAheadOfPhase(`${begin}\n# 正文`, 'cover')).toBe(true)
  })

  it('content 阶段（用户已确认目录）恒返回 false——正文哨兵是合法产出，绝不误伤', () => {
    expect(detectContentSentinelAheadOfPhase(`${begin}\n# 正文`, 'content')).toBe(false)
  })

  it('只生成目录、没有正文哨兵 → 不命中（正常目录回合不被打断）', () => {
    const text = '===方案目录开始===\n1. 背景\n2. 需求分析\n===方案目录结束==='
    expect(detectContentSentinelAheadOfPhase(text, 'toc')).toBe(false)
  })

  it('正文哨兵字样只是被内联引用/说明（非独占行）→ 不命中（复用独占行判定，防误掐）', () => {
    const text = `目录阶段提示：正文要用 \`${begin}\` 包裹，但现在先别写。`
    expect(detectContentSentinelAheadOfPhase(text, 'toc')).toBe(false)
  })

  it('空文本 → 不命中', () => {
    expect(detectContentSentinelAheadOfPhase('', 'toc')).toBe(false)
  })

  it('正文结束哨兵不触发（只认起始哨兵，避免把闭合误当起手）', () => {
    expect(detectContentSentinelAheadOfPhase(`${PROPOSAL_DRAFT_END.content}\n`, 'toc')).toBe(false)
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

describe('sortSectionsByKind（维持同 kind 连续不变量）', () => {
  const S = (kind: ProposalDraftBlock['kind'], id: string): { kind: ProposalDraftBlock['kind']; id: string } => ({ kind, id })

  it('非连续 kind（content 阶段回发封面块）归并回 cover 区段', () => {
    const out = sortSectionsByKind([S('cover', 'a'), S('toc', 'b'), S('content', 'c'), S('cover', 'd')])
    expect(out.map((s) => s.kind)).toEqual(['cover', 'cover', 'toc', 'content'])
    expect(out.map((s) => s.id)).toEqual(['a', 'd', 'b', 'c']) // 稳定：a 仍在 d 前
  })

  it('已连续 → 顺序不变', () => {
    const inp = [S('cover', 'a'), S('toc', 'b'), S('content', 'c'), S('content', 'd')]
    expect(sortSectionsByKind(inp).map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('稳定：同 kind 内既有顺序（含 moveSection 调整）保持', () => {
    const out = sortSectionsByKind([S('content', 'c2'), S('content', 'c1'), S('cover', 'a')])
    expect(out.map((s) => s.id)).toEqual(['a', 'c2', 'c1']) // cover 提前、content 内 c2/c1 保序
  })

  it('空数组 → 空数组；不修改入参（返回新数组）', () => {
    expect(sortSectionsByKind([])).toEqual([])
    const inp = [S('toc', 'b'), S('cover', 'a')]
    sortSectionsByKind(inp)
    expect(inp.map((s) => s.id)).toEqual(['b', 'a']) // 原数组未被原地改
  })
})

describe('collapseSingletonSections（重建/恢复路径折叠重复封面·目录）', () => {
  const S = (kind: ProposalDraftBlock['kind'], id: string): { kind: ProposalDraftBlock['kind']; id: string } => ({ kind, id })

  it('转录里两份封面（原版+修订版）→ 只保留最后一份（最新修订）', () => {
    const out = collapseSingletonSections([S('cover', 'v1'), S('cover', 'v2'), S('toc', 't')])
    expect(out.map((s) => [s.kind, s.id])).toEqual([['cover', 'v2'], ['toc', 't']])
  })

  it('封面、目录各保留最后一份；正文多节全保留；只过滤不排序（保留原序，排序交 sortSectionsByKind）', () => {
    const out = collapseSingletonSections([
      S('cover', 'c1'),
      S('toc', 't1'),
      S('content', 'a'),
      S('cover', 'c2'),
      S('toc', 't2'),
      S('content', 'b')
    ])
    expect(out.map((s) => s.id)).toEqual(['a', 'c2', 't2', 'b'])
  })

  it('各 kind 至多一份时原样返回；空数组 → 空数组；不原地改入参', () => {
    const inp = [S('cover', 'a'), S('toc', 'b'), S('content', 'c')]
    expect(collapseSingletonSections(inp).map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(collapseSingletonSections([])).toEqual([])
    collapseSingletonSections(inp)
    expect(inp.map((s) => s.id)).toEqual(['a', 'b', 'c']) // 入参未被原地改
  })
})

describe('decideProposalStageConfirm', () => {
  const tocInput = (firstLabel: string): unknown => ({
    questions: [
      {
        question: '目录确认？',
        header: PROPOSAL_TOC_CONFIRM_HEADER,
        options: [{ label: firstLabel }, { label: '我要调整目录' }]
      }
    ]
  })

  it('目录确认·选放行项（首选项）→ advance-content', () => {
    expect(
      decideProposalStageConfirm(tocInput('确认目录，开始撰写正文'), {
        '目录确认？': '确认目录，开始撰写正文'
      })
    ).toBe('advance-content')
  })

  it('目录确认·选修改项 → none（不推进）', () => {
    expect(
      decideProposalStageConfirm(tocInput('确认目录，开始撰写正文'), {
        '目录确认？': '我要调整目录'
      })
    ).toBe('none')
  })

  it('封面确认·选放行项 → clear-only', () => {
    const input = {
      questions: [
        {
          question: '封面确认？',
          header: PROPOSAL_COVER_CONFIRM_HEADER,
          options: [{ label: '确认封面，生成目录' }, { label: '我要调整封面' }]
        }
      ]
    }
    expect(decideProposalStageConfirm(input, { '封面确认？': '确认封面，生成目录' })).toBe(
      'clear-only'
    )
  })

  it('非方案确认 header → none', () => {
    const input = {
      questions: [{ question: '随便问？', header: '其它', options: [{ label: 'A' }] }]
    }
    expect(decideProposalStageConfirm(input, { '随便问？': 'A' })).toBe('none')
  })

  it('畸形输入 → none', () => {
    expect(decideProposalStageConfirm(null, {})).toBe('none')
    expect(decideProposalStageConfirm({}, {})).toBe('none')
    expect(decideProposalStageConfirm({ questions: 'x' }, {})).toBe('none')
  })
})

describe('appendDraftBlocks（轮内增量同步 + 轮末入库共用的纯 reducer）', () => {
  // 确定性 id 工厂（生产用 crypto.randomUUID，测试用计数器，便于断言）。
  type Sec = ProposalDraftBlock & { id: string; truncated?: boolean; baselineMarkdown?: string }
  let n = 0
  const mk = (b: ProposalDraftBlock, opts: { truncated?: boolean }): Sec => ({
    id: `id-${n++}`,
    markdown: b.markdown,
    kind: b.kind,
    baselineMarkdown: b.markdown,
    ...(opts.truncated ? { truncated: true } : {})
  })
  const empty = (): { sections: Sec[]; phase: 'cover'; stageSkip: null } => {
    n = 0
    return { sections: [], phase: 'cover', stageSkip: null }
  }
  const cover: ProposalDraftBlock = { kind: 'cover', markdown: '# 标题\n\n客户单位：XX' }
  const toc: ProposalDraftBlock = { kind: 'toc', markdown: '1. 背景\n2. 方案' }
  const content: ProposalDraftBlock = { kind: 'content', markdown: '## 一、背景\n正文（据《X》）' }

  it('把闭合块追加进草稿', () => {
    const out = appendDraftBlocks(empty(), [cover], null, mk)
    expect(out.sections.map((s) => s.kind)).toEqual(['cover'])
    expect(out.sections[0].baselineMarkdown).toBe(cover.markdown)
  })

  it('内容级去重：同 kind+markdown 重复同步不产生重复节（幂等）', () => {
    const s1 = appendDraftBlocks(empty(), [cover], null, mk)
    const s2 = appendDraftBlocks(s1, [cover], null, mk)
    expect(s2.sections.map((s) => s.kind)).toEqual(['cover'])
  })

  it('轮内同步封面 → 轮末再带封面+目录：封面被去重、目录新增，phase 推进到 toc', () => {
    const mid = appendDraftBlocks(empty(), [cover], null, mk) // 轮内：AskUserQuestion 暂停时
    const end = appendDraftBlocks(mid, [cover, toc], null, mk) // 轮末：同消息携全部块
    expect(end.sections.map((s) => s.kind)).toEqual(['cover', 'toc'])
    expect(end.phase).toBe('toc')
  })

  it('目录块到达时自动把 phase 由 cover 推进到 toc（cover→toc 非门）', () => {
    const out = appendDraftBlocks(empty(), [toc], null, mk)
    expect(out.phase).toBe('toc')
  })

  it('阶段门：cover 阶段收到 content 块被拦下（不入节、不推进），记 stageSkip', () => {
    const out = appendDraftBlocks(empty(), [content], null, mk)
    expect(out.sections.length).toBe(0)
    expect(out.phase).toBe('cover')
    expect(out.stageSkip).toEqual({ count: 1 })
  })

  it('截断残块：非越界时入节并标 truncated；越界（content 在 cover 阶段）则记 stageSkip', () => {
    const ok = appendDraftBlocks(empty(), [], { kind: 'cover', markdown: '半截封面' }, mk)
    expect(ok.sections.map((s) => [s.kind, s.truncated])).toEqual([['cover', true]])

    const blocked = appendDraftBlocks(empty(), [], { kind: 'content', markdown: '半截正文' }, mk)
    expect(blocked.sections.length).toBe(0)
    expect(blocked.stageSkip).toEqual({ count: 1 })
  })

  // 单例 kind（封面/目录）：全篇至多一节。用户在「确认/调整」对话里让 AI 重发修订版封面时，
  // 新块 markdown 与旧块不同、躲过逐字去重，旧逻辑会把它当新节追加 → 右侧出现两份封面
  // （用户报的「复制一整块、原处不变」bug）。修复后单例 kind 的新块【整节替换】同 kind 旧节。
  it('单例·封面修订：重发不同内容的封面 → 替换旧节而非追加（仍只 1 节、内容为新版）', () => {
    const v1 = appendDraftBlocks(empty(), [cover], null, mk)
    const adjusted: ProposalDraftBlock = { kind: 'cover', markdown: '# 标题\n\n客户单位：武汉协和医院' }
    const v2 = appendDraftBlocks(v1, [adjusted], null, mk)
    expect(v2.sections.map((s) => s.kind)).toEqual(['cover'])
    expect(v2.sections[0].markdown).toBe(adjusted.markdown)
    // baselineMarkdown 同步成新版：否则 M-0 埋点把「AI 重写封面」误算成用户编辑量。
    expect(v2.sections[0].baselineMarkdown).toBe(adjusted.markdown)
  })

  it('单例·目录修订：重发不同内容的目录 → 替换旧节而非追加（仍只 1 节、内容为新版）', () => {
    const v1 = appendDraftBlocks(empty(), [toc], null, mk)
    const adjusted: ProposalDraftBlock = { kind: 'toc', markdown: '1. 背景\n2. 方案\n3. 实施' }
    const v2 = appendDraftBlocks(v1, [adjusted], null, mk)
    expect(v2.sections.map((s) => s.kind)).toEqual(['toc'])
    expect(v2.sections[0].markdown).toBe(adjusted.markdown)
  })

  it('封面替换不波及正文：正文阶段重写封面只换封面，多节正文原样保留', () => {
    // 构造 [cover, content, content]（正文阶段）。
    let st = appendDraftBlocks(empty(), [cover], null, mk)
    st.phase = 'content'
    const c1: ProposalDraftBlock = { kind: 'content', markdown: '## 一、背景\n正文一（据《X》）' }
    const c2: ProposalDraftBlock = { kind: 'content', markdown: '## 二、目标\n正文二（据《Y》）' }
    st = appendDraftBlocks(st, [c1, c2], null, mk)
    expect(st.sections.map((s) => s.kind)).toEqual(['cover', 'content', 'content'])
    // 正文阶段重写封面（封面可反复改、不被阶段门拦）。
    const newCover: ProposalDraftBlock = { kind: 'cover', markdown: '# 新标题\n\n客户单位：ZZ' }
    const out = appendDraftBlocks(st, [newCover], null, mk)
    expect(out.sections.map((s) => s.kind)).toEqual(['cover', 'content', 'content'])
    expect(out.sections[0].markdown).toBe(newCover.markdown)
    expect(out.sections.filter((s) => s.kind === 'content').map((s) => s.markdown)).toEqual([
      c1.markdown,
      c2.markdown
    ])
  })

  it('单例·完全相同的封面重复同步仍幂等：不替换也不重复（沿用内容级去重）', () => {
    const v1 = appendDraftBlocks(empty(), [cover], null, mk)
    const id0 = v1.sections[0].id
    const v2 = appendDraftBlocks(v1, [cover], null, mk)
    expect(v2.sections.map((s) => s.kind)).toEqual(['cover'])
    // 完全相同 → 不重建节（id 不变），区别于「内容不同 → 替换（id 可变）」。
    expect(v2.sections[0].id).toBe(id0)
  })

  it('正文多节：仍是追加语义，不受单例替换影响', () => {
    let st = appendDraftBlocks(empty(), [], null, mk)
    st.phase = 'content'
    const c1: ProposalDraftBlock = { kind: 'content', markdown: '## 一\n正文一' }
    const c2: ProposalDraftBlock = { kind: 'content', markdown: '## 二\n正文二' }
    st = appendDraftBlocks(st, [c1], null, mk)
    st = appendDraftBlocks(st, [c2], null, mk)
    expect(st.sections.map((s) => s.markdown)).toEqual([c1.markdown, c2.markdown])
  })
})

// 聊天气泡里把哨兵块切成「普通文本 / 草稿卡片」段的展示层分块器。与入库抽取器
// extractProposalDraftResult 各司其职：这个宽松（哨兵不必独占整行，兼容截图里哨兵与
// 内容挤在同一行的情况）、只为渲染卡片；那个严格（独占整行）、决定落库内容。
describe('splitProposalDraftSegments', () => {
  const B = PROPOSAL_DRAFT_BEGIN
  const E = PROPOSAL_DRAFT_END

  it('空串 → 空数组', () => {
    expect(splitProposalDraftSegments('')).toEqual([])
  })

  it('无哨兵 → 单个原文文本段', () => {
    const out = splitProposalDraftSegments('这是一段普通对话，没有任何哨兵。')
    expect(out).toEqual([{ type: 'text', value: '这是一段普通对话，没有任何哨兵。' }])
  })

  it('完整正文哨兵块 → 一个 complete 草稿段（内容 trim）', () => {
    const out = splitProposalDraftSegments(`${B.content}\n客户单位：武汉协和医院\n${E.content}`)
    expect(out).toEqual([
      { type: 'draft', kind: 'content', content: '客户单位：武汉协和医院', complete: true }
    ])
  })

  it('哨兵与内容挤在同一行（截图场景）也识别成卡片', () => {
    const out = splitProposalDraftSegments(`${B.content} 客户单位：武汉协和医院 ${E.content}`)
    expect(out).toEqual([
      { type: 'draft', kind: 'content', content: '客户单位：武汉协和医院', complete: true }
    ])
  })

  it('哨兵前后的普通文本各自成段', () => {
    const out = splitProposalDraftSegments(`我来起草正文：\n${B.content}\n正文内容\n${E.content}\n以上，请过目。`)
    expect(out).toEqual([
      { type: 'text', value: '我来起草正文：\n' },
      { type: 'draft', kind: 'content', content: '正文内容', complete: true },
      { type: 'text', value: '\n以上，请过目。' }
    ])
  })

  it('只有起始哨兵、无结束（流式进行中）→ complete:false，其后全部当卡片内容', () => {
    const out = splitProposalDraftSegments(`${B.content}\n正在生成的半截正文`)
    expect(out).toEqual([
      { type: 'draft', kind: 'content', content: '正在生成的半截正文', complete: false }
    ])
  })

  it('三类 kind（封面/目录/正文）各自识别、按出现顺序', () => {
    const src = `${B.cover}\n封面\n${E.cover}\n${B.toc}\n目录\n${E.toc}\n${B.content}\n正文\n${E.content}`
    const out = splitProposalDraftSegments(src)
    expect(out.map((s) => (s.type === 'draft' ? s.kind : 'text'))).toEqual([
      'cover',
      'toc',
      'content'
    ])
    expect(out.every((s) => s.type === 'draft' && s.complete)).toBe(true)
  })

  it('纯空白的文本段被丢弃（不产出空 markdown 段）', () => {
    const out = splitProposalDraftSegments(`${B.content}\n正文\n${E.content}\n\n   \n`)
    expect(out).toEqual([
      { type: 'draft', kind: 'content', content: '正文', complete: true }
    ])
  })

  it('闭合但内容为空的块被跳过（不产出空卡片）', () => {
    expect(splitProposalDraftSegments(`${B.content}\n\n${E.content}`)).toEqual([])
  })
})
