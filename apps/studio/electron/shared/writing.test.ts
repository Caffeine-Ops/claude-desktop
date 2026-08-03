import { describe, expect, it } from 'bun:test'
import {
  parseWritingGenre,
  parseOutlineTotal,
  parseImageStyle,
  parseImageCount,
  sortSectionNames,
  joinWritingSections,
  shouldPageBreak,
  extractRevisionResult,
  WRITING_REVISION_BEGIN,
  WRITING_REVISION_END,
  type WritingSection
} from './writing'
import { PROPOSAL_PAGEBREAK } from './proposal'

describe('parseWritingGenre', () => {
  it('读出 spec_lock 的 genre', () => {
    const text = '# 写作契约\n\n## 体裁\n- genre: short-story\n- sub: 悬疑推理\n'
    expect(parseWritingGenre(text)).toBe('short-story')
  })

  it('文件不存在（null）退回 workplace 默认档', () => {
    expect(parseWritingGenre(null)).toBe('workplace')
  })

  it('有文件但没有 genre 字段，退回 workplace', () => {
    expect(parseWritingGenre('# 写作契约\n\n## 目标\n- audience: 通勤读者\n')).toBe('workplace')
  })

  it('genre 值不在白名单内，退回 workplace（不信任任意字符串）', () => {
    expect(parseWritingGenre('- genre: 随便写的\n')).toBe('workplace')
  })

  it('容忍全角冒号与多余空白', () => {
    expect(parseWritingGenre('-  genre ：  wechat  \n')).toBe('wechat')
  })
})

describe('parseOutlineTotal', () => {
  it('数出大纲里的节数', () => {
    const text = '# 写作方案\n\n## 大纲\n\n### 第1节 开场\n铺垫\n\n### 第2节 转折\n推进\n\n### 第3节 收束\n落点\n'
    expect(parseOutlineTotal(text)).toBe(3)
  })

  it('没有大纲段落时返回 null——不猜数字', () => {
    expect(parseOutlineTotal('# 写作方案\n\n## 目标\n写清楚\n')).toBeNull()
  })

  it('入参为 null 时返回 null', () => {
    expect(parseOutlineTotal(null)).toBeNull()
  })

  it('认真实模板的表格式大纲（标题带罗马数字编号、节次在表格行里）', () => {
    const text = [
      '## V. 内容大纲（分节表）',
      '',
      '写手逐节施工的图纸。**每节 800-1200 字**。',
      '',
      '| 节次 | 字数 | 本节任务 | 结束时读者感受 |',
      '|---|---|---|---|',
      '| 第1节 | 600 | 抛谜面 | 好奇被吊起 |',
      '| 第2节 | 1000 | 回溯 | 隐约不安 |',
      '| 第3节 | 700 | 升级 | 情绪被顶起 |',
      '',
      '## VI. 人物设定（小说填）',
      '',
      '| 人物 | Want | Need |',
      '|---|---|---|',
      '| 张明 | 找妹妹 | 原谅自己 |'
    ].join('\n')
    expect(parseOutlineTotal(text)).toBe(3)
  })

  it('表头行与分隔行不算进节数', () => {
    const text = '## 大纲\n\n| 节次 | 字数 |\n|---|---|\n| 第1节 | 600 |\n'
    expect(parseOutlineTotal(text)).toBe(1)
  })

  it('下一个二级标题之后的表格不算进来（人物表不是大纲）', () => {
    const text = [
      '## V. 内容大纲',
      '| 第1节 | 600 |',
      '## VI. 人物设定',
      '| 第2节 | 假的 |'
    ].join('\n')
    expect(parseOutlineTotal(text)).toBe(1)
  })

  it('表格式与三级标题式并存时取较大的一个，不相加', () => {
    const text = '## 大纲\n\n### 第1节 开场\n### 第2节 收束\n\n| 第1节 | 600 |\n'
    expect(parseOutlineTotal(text)).toBe(2)
  })

  it('容忍「第 1 节」中间带空格', () => {
    expect(parseOutlineTotal('## 大纲\n\n| 第 1 节 | 600 |\n| 第 2 节 | 800 |\n')).toBe(2)
  })
})

describe('parseImageStyle', () => {
  it('读出「## 配图」段的 image_style，即便同段前面有带尾注释的 image_plan/image_count 行', () => {
    const text =
      '# 写作契约\n\n## 配图\n- image_plan: inline          # none | cover-only | inline\n' +
      '- image_count: 3\n- image_style: 极简线条插画，低饱和暖色\n'
    expect(parseImageStyle(text)).toBe('极简线条插画，低饱和暖色')
  })

  it('M-1 回归：不剥 image_style 行本身的内容——画风里的配色 hex 码不会被当成注释砍掉', () => {
    // 真实模板里只有 image_plan / image_count 带尾注释，image_style 从不带；
    // 若像修复前那样用「空白+#」当注释分隔符，这里会被腰斩成「低饱和暖色，主色」。
    const text = '## 配图\n- image_style: 低饱和暖色，主色 #E8A33D 点缀\n'
    expect(parseImageStyle(text)).toBe('低饱和暖色，主色 #E8A33D 点缀')
  })

  it('文件不存在（null）回 null', () => {
    expect(parseImageStyle(null)).toBeNull()
  })

  it('没有「## 配图」段回 null（职场快道刻意不建 spec_lock 也是这个结果）', () => {
    expect(parseImageStyle('# 写作契约\n\n## 体裁\n- genre: workplace\n')).toBeNull()
  })

  it('有「## 配图」段但 image_plan: none 时字段留空，回 null', () => {
    expect(parseImageStyle('## 配图\n- image_plan: none\n')).toBeNull()
  })

  it('容忍全角冒号与多余空白', () => {
    expect(parseImageStyle('## 配图\n-  image_style ：  水墨风  \n')).toBe('水墨风')
  })

  it('不会越界读到下一个二级标题段落里的字段', () => {
    const text = '## 配图\n- image_plan: inline\n\n## 附录\n- image_style: 这是别的段落，不该被读到\n'
    expect(parseImageStyle(text)).toBeNull()
  })
})

describe('parseImageCount', () => {
  it('读出「## 配图」段的 image_count 张数上限', () => {
    const text = '## 配图\n- image_plan: inline\n- image_count: 3\n- image_style: 水墨风\n'
    expect(parseImageCount(text)).toBe(3)
  })

  it('文件不存在（null）回 null', () => {
    expect(parseImageCount(null)).toBeNull()
  })

  it('没有「## 配图」段回 null', () => {
    expect(parseImageCount('## 体裁\n- genre: workplace\n')).toBeNull()
  })

  it('字段缺失回 null（不猜数字）', () => {
    expect(parseImageCount('## 配图\n- image_plan: inline\n- image_style: 水墨风\n')).toBeNull()
  })

  it('m-1：image_count: 0 是合法值（"一张都不要"），不再回退成默认上限', () => {
    expect(parseImageCount('## 配图\n- image_plan: inline\n- image_count: 0\n')).toBe(0)
  })

  it('负数不是合法上限，回 null', () => {
    expect(parseImageCount('## 配图\n- image_count: -1\n')).toBeNull()
  })

  it('m-1：image_plan: none 无条件把上限压成 0，即便 image_count 残留了陈旧数值', () => {
    // 按模板约定 none 时这两行本就该留空，但写手可能中途改主意却忘记删——不能把
    // 残留的旧数字当真，否则"这篇根本不配图"这个最该被闸住的场景反而不受契约约束。
    expect(parseImageCount('## 配图\n- image_plan: none\n- image_count: 5\n')).toBe(0)
    expect(parseImageCount('## 配图\n- image_plan: none\n')).toBe(0)
  })

  it('不会越界读到下一个二级标题段落里的字段', () => {
    const text = '## 配图\n- image_plan: inline\n\n## 附录\n- image_count: 99\n'
    expect(parseImageCount(text)).toBeNull()
  })
})

describe('sortSectionNames', () => {
  it('数字前缀按自然序，不是字典序（10 排在 2 之后）', () => {
    const input = ['10-收束.md', '2-转折.md', '1-开场.md']
    expect(sortSectionNames(input)).toEqual(['1-开场.md', '2-转折.md', '10-收束.md'])
  })

  it('零填充前缀同样按数值排', () => {
    expect(sortSectionNames(['03-c.md', '01-a.md', '02-b.md'])).toEqual([
      '01-a.md',
      '02-b.md',
      '03-c.md'
    ])
  })

  it('无数字前缀的退回字典序', () => {
    expect(sortSectionNames(['b.md', 'a.md', 'c.md'])).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('混合时数字前缀的整体排在无前缀的前面（保证正文顺序稳定）', () => {
    expect(sortSectionNames(['附录.md', '2-b.md', '1-a.md'])).toEqual([
      '1-a.md',
      '2-b.md',
      '附录.md'
    ])
  })
})

describe('joinWritingSections', () => {
  const secs: WritingSection[] = [
    { name: '1-a.md', markdown: '# 第一章\n\n正文一', mtimeMs: 1 },
    { name: '2-b.md', markdown: '# 第二章\n\n正文二', mtimeMs: 2 }
  ]

  it('不分页时用空行连接', () => {
    expect(joinWritingSections(secs, { pageBreaks: false })).toBe(
      '# 第一章\n\n正文一\n\n# 第二章\n\n正文二'
    )
  })

  it('分页时在节之间插入分页标记，首节前不插', () => {
    const out = joinWritingSections(secs, { pageBreaks: true })
    expect(out.startsWith('# 第一章')).toBe(true)
    // 分页标记必须与 markdownToDocxBuffer（proposalDocx.ts）识别的 PROPOSAL_PAGEBREAK
    // 逐字节一致，否则小说体裁的分页导出会静默失效（曾经的真实 bug，见上方常量注释）。
    expect(out).toContain(`\n\n${PROPOSAL_PAGEBREAK}\n\n# 第二章`)
  })

  it('空数组返回空串', () => {
    expect(joinWritingSections([], { pageBreaks: true })).toBe('')
  })
})

describe('shouldPageBreak', () => {
  it('小说每节起新页（节=章节）', () => {
    expect(shouldPageBreak('short-story')).toBe(true)
  })

  it('文章与职场文档连续排版（节只是小标题段落）', () => {
    expect(shouldPageBreak('article')).toBe(false)
    expect(shouldPageBreak('workplace')).toBe(false)
  })

  it('微信不涉及分页', () => {
    expect(shouldPageBreak('wechat')).toBe(false)
  })
})

describe('extractRevisionResult', () => {
  it('抽出哨兵之间的正文并去掉首尾空白', () => {
    const text = `好的，我改了：\n${WRITING_REVISION_BEGIN}\n改后的段落。\n${WRITING_REVISION_END}\n还有什么要调整的吗？`
    expect(extractRevisionResult(text)).toBe('改后的段落。')
  })

  it('没有哨兵时返回 null——不把整段回复当成正文写进文件', () => {
    expect(extractRevisionResult('我觉得这段挺好的，需要我改哪里？')).toBeNull()
  })

  it('只有开始哨兵（被截断）时返回 null', () => {
    expect(extractRevisionResult(`${WRITING_REVISION_BEGIN}\n写到一半`)).toBeNull()
  })

  it('哨兵之间为空时返回 null——不拿空内容覆盖原文', () => {
    expect(extractRevisionResult(`${WRITING_REVISION_BEGIN}\n\n${WRITING_REVISION_END}`)).toBeNull()
  })

  it('取第一对哨兵（AI 多写了一对时不拼接）', () => {
    const text = `${WRITING_REVISION_BEGIN}\nA\n${WRITING_REVISION_END}\n${WRITING_REVISION_BEGIN}\nB\n${WRITING_REVISION_END}`
    expect(extractRevisionResult(text)).toBe('A')
  })
})
