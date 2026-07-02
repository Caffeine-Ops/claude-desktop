import { describe, it, expect } from 'bun:test'
import { assetPathFor } from './proposalImageWriter'

describe('assetPathFor', () => {
  it('拼出 <root>/<sessionId>/assets/<gen|edit|upload>-<ts>.<ext>', () => {
    const p = assetPathFor('/root', 'sess-1', 'generated', 'png', 123)
    expect(p).toBe('/root/sess-1/assets/gen-123.png')
  })
  it('edited → edit- 前缀', () => {
    expect(assetPathFor('/root', 's', 'edited', 'png', 9)).toBe('/root/s/assets/edit-9.png')
  })
  it('uploaded → upload- 前缀', () => {
    expect(assetPathFor('/root', 's', 'uploaded', 'jpg', 7)).toBe('/root/s/assets/upload-7.jpg')
  })
})
