import { describe, expect, it } from 'bun:test'
import { deriveWritingExportBaseName } from './writingExportInput'

describe('deriveWritingExportBaseName', () => {
  it('取第一个一级标题', () => {
    expect(deriveWritingExportBaseName('# 我的周报\n\n正文')).toBe('我的周报')
  })

  it('多节拼合后仍只取全篇第一个一级标题', () => {
    const md = '# 第一章\n\n正文一\n\n<!--proposal-pagebreak-->\n\n# 第二章\n\n正文二'
    expect(deriveWritingExportBaseName(md)).toBe('第一章')
  })

  it('标题前后空白被裁剪', () => {
    expect(deriveWritingExportBaseName('#   带空格的标题   \n\n正文')).toBe('带空格的标题')
  })

  it('二级标题不算数，只认一级', () => {
    expect(deriveWritingExportBaseName('## 不是一级标题\n\n正文')).toBe('文稿')
  })

  it('没有标题回退「文稿」', () => {
    expect(deriveWritingExportBaseName('只有正文，没有标题')).toBe('文稿')
  })

  it('空串回退「文稿」', () => {
    expect(deriveWritingExportBaseName('')).toBe('文稿')
  })

  it('一级标题内容为空白也回退「文稿」', () => {
    expect(deriveWritingExportBaseName('#    \n\n正文')).toBe('文稿')
  })
})
