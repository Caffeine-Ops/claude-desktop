import { describe, it, expect } from 'bun:test'

import { chatLangForLocale } from './chatLangForLocale'

describe('chatLangForLocale', () => {
  it('两种中文都映射到 zh', () => {
    expect(chatLangForLocale('zh-CN')).toBe('zh')
    expect(chatLangForLocale('zh-TW')).toBe('zh')
  })

  it('其余 17 种语言都落到 en——chat 面只有 zh/en 两本字典，别的语言没有可用译文', () => {
    for (const l of ['en', 'ja', 'ko', 'de', 'fr', 'ru', 'ar', 'th', 'it']) {
      expect(chatLangForLocale(l)).toBe('en')
    }
  })

  it('未知/空值兜底到 en，与 canvas t() 的 en 兜底链同向', () => {
    expect(chatLangForLocale('')).toBe('en')
    expect(chatLangForLocale('xx-YY')).toBe('en')
  })
})
