import { describe, expect, test } from 'bun:test'

import { isEditableImageExt } from './imageKinds'

describe('isEditableImageExt', () => {
  test('静态位图四种进标记改图编辑器', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      expect(isEditableImageExt(ext)).toBe(true)
    }
  })

  test('大小写不敏感（Windows 常见 .PNG）', () => {
    expect(isEditableImageExt('PNG')).toBe(true)
  })

  test('gif / svg / 非图片一律不进编辑器', () => {
    for (const ext of ['gif', 'svg', 'bmp', 'pdf', '']) {
      expect(isEditableImageExt(ext)).toBe(false)
    }
  })
})
