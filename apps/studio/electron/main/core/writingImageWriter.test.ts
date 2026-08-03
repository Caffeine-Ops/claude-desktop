import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { writingImagePathFor, writingImageRelPath } from './writingImageWriter'

describe('writingImagePathFor', () => {
  it('落在项目的 images/ 下，文件名带时间戳', () => {
    const p = writingImagePathFor('/Users/k/projects/稿子_20260803', 'png', 1754200000000)
    expect(p).toBe(join('/Users/k/projects/稿子_20260803', 'images', 'gen-1754200000000.png'))
  })

  it('扩展名跟着实际字节走，不写死 png', () => {
    const p = writingImagePathFor('/p', 'webp', 1)
    expect(p.endsWith('.webp')).toBe(true)
  })
})

describe('writingImageRelPath', () => {
  it('回 ../images/<文件名>——正文在 drafts/，与 images/ 是兄弟目录', () => {
    expect(writingImageRelPath('gen-1.png')).toBe('../images/gen-1.png')
  })
})
