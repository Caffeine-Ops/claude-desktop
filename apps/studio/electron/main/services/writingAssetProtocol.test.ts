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

  // validate 模式下 localAssetProtocol 不做根包含检查（见文件头注释 2026-08-03 code
  // review 更正的那段）：借 `..` 逃出 images/ 之外的路径必须由这条判定自己拦，不能指望
  // 下游 normalize 兜底。
  it('拦掉借 .. 逃出 images/ 之外的路径——validate 模式没有根检查兜底，必须自己拦', () => {
    expect(
      isWritingAssetPath('/Users/k/projects/稿子/images/../../../../Users/k/Private/x.png')
    ).toBe(false)
  })

  it('win32 反斜杠路径同样能命中 images/ 段', () => {
    expect(isWritingAssetPath('C:\\Users\\k\\稿子\\images\\gen-1.png')).toBe(true)
  })
})
