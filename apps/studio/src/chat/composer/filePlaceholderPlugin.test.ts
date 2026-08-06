import { describe, it, expect } from 'bun:test'

import { acceptForPlaceholder } from './filePlaceholderPlugin'

describe('acceptForPlaceholder · 文稿组合映射（设计 §5.2）', () => {
  const DOC_FORMATS = '.txt,.md,.markdown,.docx,.pdf'

  it('文稿 / 作品 / 稿件 都映射到全部文稿格式', () => {
    expect(acceptForPlaceholder('文稿文件')).toBe(DOC_FORMATS)
    expect(acceptForPlaceholder('作品文件')).toBe(DOC_FORMATS)
    expect(acceptForPlaceholder('稿件文件')).toBe(DOC_FORMATS)
  })

  it('文稿组合不含独立的旧版 .doc（picker 自动置灰，不是选完再报错）', () => {
    // .docx 里的 .doc 前缀不算——按逗号切成 token 后不应出现独立 '.doc'
    expect(acceptForPlaceholder('文稿文件')!.split(',')).not.toContain('.doc')
  })

  it('既有单格式映射不回归', () => {
    expect(acceptForPlaceholder('PPT 文件')).toBe('.ppt,.pptx')
    expect(acceptForPlaceholder('Excel 文件')).toBe('.xls,.xlsx,.csv')
    expect(acceptForPlaceholder('Word 文档')).toBe('.doc,.docx')
    expect(acceptForPlaceholder('PDF 文件')).toBe('.pdf')
    expect(acceptForPlaceholder('图片文件')).toBe('image/*')
  })

  it('未命中任何关键词仍返回 undefined（不限制，只做引导）', () => {
    expect(acceptForPlaceholder('资料文件')).toBeUndefined()
  })
})

describe('acceptForPlaceholder · 招标文件（审标技能）', () => {
  const TENDER_FORMATS = '.pdf,.doc,.docx'

  it('招标 / 标书 / 投标 都映射到 pdf + word', () => {
    expect(acceptForPlaceholder('招标文件')).toBe(TENDER_FORMATS)
    expect(acceptForPlaceholder('标书文件')).toBe(TENDER_FORMATS)
    expect(acceptForPlaceholder('投标文件')).toBe(TENDER_FORMATS)
  })

  it('必须含 .pdf——招标文件绝大多数是 PDF，这条专属引导规则漏了 pdf 用户就还是选不到自己的标书', () => {
    expect(acceptForPlaceholder('招标文件')!.split(',')).toContain('.pdf')
  })

  it('不含 .txt/.md——招标文件不会是纯文本，混进来只是噪音', () => {
    const tokens = acceptForPlaceholder('招标文件')!.split(',')
    expect(tokens).not.toContain('.txt')
    expect(tokens).not.toContain('.md')
  })
})
