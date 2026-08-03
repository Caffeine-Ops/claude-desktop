import { describe, expect, it } from 'bun:test'
import { isWritingAssetPath } from './writingAssetProtocol'

describe('isWritingAssetPath', () => {
  it('放行写作项目 images/ 下的图片', () => {
    expect(isWritingAssetPath('/Users/k/projects/稿子_20260803/images/gen-1.png')).toBe(true)
  })

  it('拦掉非图片扩展名——协议只该服务图片，别变成任意读盘通道', () => {
    expect(isWritingAssetPath('/Users/k/projects/稿子_20260803/images/secrets.env')).toBe(false)
  })

  it('拦掉不在 images/ 下的路径', () => {
    expect(isWritingAssetPath('/Users/k/projects/稿子_20260803/drafts/01.png')).toBe(false)
  })

  it('空串不放行', () => {
    expect(isWritingAssetPath('')).toBe(false)
  })
})
