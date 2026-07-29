import { describe, expect, it } from 'bun:test'
import { writingStyleFor, paperSkinClass } from './writingGenreStyle'

describe('writingStyleFor', () => {
  it('一律关掉品牌横幅——写作交付的是用户自己的稿子，不该印 Fusion Ai logo', () => {
    for (const g of ['wechat', 'short-story', 'article', 'workplace'] as const) {
      expect(writingStyleFor(g).brand).toBe(false)
    }
  })

  it('小说正文首行缩进两字符、段后不留白（靠缩进分段）', () => {
    const s = writingStyleFor('short-story')
    expect(s.body.indentChars).toBe(2)
    expect(s.spaceAfterPt).toBe(0)
  })

  it('文章不缩进、段后留白', () => {
    const s = writingStyleFor('article')
    expect(s.body.indentChars).toBe(0)
    expect(s.spaceAfterPt).toBeGreaterThan(0)
  })

  it('职场文档标题用黑体、正文仿宋（公文观感）', () => {
    const s = writingStyleFor('workplace')
    expect(s.h1.font).toBe('黑体')
    expect(s.body.font).toBe('仿宋')
    expect(s.body.indentChars).toBe(0)
  })

  it('每次调用返回独立对象，改一个不影响另一个', () => {
    const a = writingStyleFor('article')
    const b = writingStyleFor('article')
    a.body.indentChars = 9
    expect(b.body.indentChars).toBe(0)
  })
})

describe('paperSkinClass', () => {
  it('四种体裁给出各不相同的皮肤类名', () => {
    const classes = (['wechat', 'short-story', 'article', 'workplace'] as const).map(paperSkinClass)
    expect(new Set(classes).size).toBe(4)
  })
})
