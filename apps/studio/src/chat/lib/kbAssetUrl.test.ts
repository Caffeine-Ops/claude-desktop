import { describe, it, expect } from 'bun:test'

import { toKbAssetUrl } from './kbAssetUrl'

describe('toKbAssetUrl', () => {
  it('KB assets 绝对路径 → kbasset:// 编码 URL', () => {
    const p = '/Users/x/Library/Application Support/app/kb-index/assets/线/品/img-1.png'
    expect(toKbAssetUrl(p)).toBe(`kbasset://kb/${encodeURIComponent(p)}`)
  })

  it('普通 http(s) 图原样返回', () => {
    expect(toKbAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })

  it('非 KB 的本地路径原样返回（不含 /kb-index/assets/ 特征）', () => {
    expect(toKbAssetUrl('/Users/x/Desktop/random.png')).toBe('/Users/x/Desktop/random.png')
  })

  it('空串原样返回', () => {
    expect(toKbAssetUrl('')).toBe('')
  })
})
