import { describe, it, expect } from 'bun:test'

import { safeDecodeUri, isLocalAssetPath } from './localAssetPath'
import { isKbAssetPath } from './kbAssetUrl'

// 回归锚点：react-markdown 会把 img src 百分号编码（macOS userData 恒含空格 →
// Application%20Support），不解码则点图链三处全断（403 / 手术 no-op / 改图 ENOENT）。
describe('safeDecodeUri', () => {
  it('还原 %20 空格（macOS Application Support 场景）', () => {
    expect(safeDecodeUri('/Users/k/Library/Application%20Support/app/proposal-drafts/s1/assets/gen-1.png')).toBe(
      '/Users/k/Library/Application Support/app/proposal-drafts/s1/assets/gen-1.png'
    )
  })
  it('还原 CJK 百分号编码', () => {
    expect(safeDecodeUri('/U/%E7%9F%A5%E8%AF%86%E5%BA%93/kb-index/assets/%E5%9B%BE-1.png')).toBe(
      '/U/知识库/kb-index/assets/图-1.png'
    )
  })
  it('非法转义序列不抛、原样返回（文件名含字面量 %）', () => {
    expect(safeDecodeUri('/a/100%.png')).toBe('/a/100%.png')
  })
  it('未编码路径原样返回', () => {
    expect(safeDecodeUri('/a/b c.png')).toBe('/a/b c.png')
  })
})

describe('isLocalAssetPath', () => {
  it('KB 图（含反斜杠变体）', () => {
    expect(isLocalAssetPath('/U/x/app/kb-index/assets/img.png')).toBe(true)
    expect(isLocalAssetPath('C:\\U\\x\\app\\kb-index\\assets\\img.png')).toBe(true)
  })
  it('草稿产出图（含 win32 盘符路径——defaultUrlTransform 会清空它，必须被本谓词接住）', () => {
    expect(isLocalAssetPath('/U/x/app/proposal-drafts/s1/assets/gen-1.png')).toBe(true)
    expect(isLocalAssetPath('C:\\Users\\k\\AppData\\Roaming\\app\\proposal-drafts\\s1\\assets\\gen-1.png')).toBe(true)
    expect(isLocalAssetPath('C:/Users/k/AppData/Roaming/app/proposal-drafts/s1/assets/gen-1.png')).toBe(true)
  })
  it('外链与普通本地路径不放行', () => {
    expect(isLocalAssetPath('https://e.com/a.png')).toBe(false)
    expect(isLocalAssetPath('javascript:alert(1)')).toBe(false)
    expect(isLocalAssetPath('/etc/passwd')).toBe(false)
  })
})

describe('isKbAssetPath', () => {
  it('win32 反斜杠 KB 路径识别（与 proposalAsset 的 toPosix 同款归一）', () => {
    expect(isKbAssetPath('C:\\U\\app\\kb-index\\assets\\a.png')).toBe(true)
    expect(isKbAssetPath('/U/app/kb-index/assets/a.png')).toBe(true)
    expect(isKbAssetPath('/U/app/other/a.png')).toBe(false)
    expect(isKbAssetPath('')).toBe(false)
  })
})
