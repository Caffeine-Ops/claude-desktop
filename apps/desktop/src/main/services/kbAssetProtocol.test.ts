import { describe, it, expect } from 'bun:test'

import { isPathInsideKbRoot } from './kbAssetProtocol'

describe('isPathInsideKbRoot', () => {
  const root = '/Users/x/Library/Application Support/app/kb-index'

  it('root 内的文件路径 → true', () => {
    expect(isPathInsideKbRoot(`${root}/assets/线/品/img-1.png`, root)).toBe(true)
  })

  it('root 外的路径 → false', () => {
    expect(isPathInsideKbRoot('/etc/passwd', root)).toBe(false)
  })

  it('用 ../ 逃逸出 root → false', () => {
    expect(isPathInsideKbRoot(`${root}/assets/../../../etc/passwd`, root)).toBe(false)
  })

  it('前缀相近的兄弟目录（kb-index-evil）不算 root 内 → false', () => {
    expect(isPathInsideKbRoot(`${root}-evil/x.png`, root)).toBe(false)
  })

  it('空路径 → false', () => {
    expect(isPathInsideKbRoot('', root)).toBe(false)
  })
})
