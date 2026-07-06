import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { assetPathFor } from './proposalImageWriter'

// assetPathFor 内部用 node:path 的 join 拼接，Windows 上产出反斜杠分隔符——
// 断言期望值同样过 join()，跟随平台分隔符，而不是硬编码 Unix 风格字面量
// （硬编码字面量在 Windows CI 上必然因分隔符不一致而失败）。
describe('assetPathFor', () => {
  it('拼出 <root>/<sessionId>/assets/<gen|edit|upload>-<ts>.<ext>', () => {
    const p = assetPathFor('/root', 'sess-1', 'generated', 'png', 123)
    expect(p).toBe(join('/root', 'sess-1', 'assets', 'gen-123.png'))
  })
  it('edited → edit- 前缀', () => {
    expect(assetPathFor('/root', 's', 'edited', 'png', 9)).toBe(
      join('/root', 's', 'assets', 'edit-9.png')
    )
  })
  it('uploaded → upload- 前缀', () => {
    expect(assetPathFor('/root', 's', 'uploaded', 'jpg', 7)).toBe(
      join('/root', 's', 'assets', 'upload-7.jpg')
    )
  })
})
