import { describe, expect, it } from 'bun:test'
import { sanitizeBaseName } from './writingExportPure'

describe('sanitizeBaseName', () => {
  it('原样保留正常标题', () => {
    expect(sanitizeBaseName('周报 0729')).toBe('周报 0729')
  })

  it('去掉首尾空白', () => {
    expect(sanitizeBaseName('  标题  ')).toBe('标题')
  })

  it('替换路径分隔符（正斜杠）', () => {
    expect(sanitizeBaseName('2026/07 周报')).toBe('2026_07 周报')
  })

  it('替换路径分隔符（反斜杠）', () => {
    expect(sanitizeBaseName('C:\\临时\\标题')).toBe('C:_临时_标题')
  })

  it('空串回退「文稿」', () => {
    expect(sanitizeBaseName('')).toBe('文稿')
  })

  it('纯空白回退「文稿」', () => {
    expect(sanitizeBaseName('   ')).toBe('文稿')
  })

  it('null/undefined 视同空串，回退「文稿」', () => {
    expect(sanitizeBaseName(null as unknown as string)).toBe('文稿')
    expect(sanitizeBaseName(undefined as unknown as string)).toBe('文稿')
  })
})
