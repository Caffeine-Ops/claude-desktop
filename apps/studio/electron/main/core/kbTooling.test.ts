import { describe, expect, test } from 'bun:test'
import { detectTooling, probeTooling } from './kbTooling'

describe('probeTooling', () => {
  test('两个都在', () => {
    const s = probeTooling({ run: () => ({ ok: true }) })
    expect(s).toEqual({ markitdown: true, soffice: true })
  })
  test('markitdown 缺失、soffice 在', () => {
    const s = probeTooling({ run: (cmd) => ({ ok: cmd === 'soffice' }) })
    expect(s).toEqual({ markitdown: false, soffice: true })
  })
  test('全缺（探针抛→run 返回 ok:false 的约定由包装保证）', () => {
    const s = probeTooling({ run: () => ({ ok: false }) })
    expect(s).toEqual({ markitdown: false, soffice: false })
  })
})

describe('detectTooling', () => {
  test('绝不抛——无论工具是否安装都返回布尔结构', () => {
    let s!: ReturnType<typeof detectTooling>
    expect(() => { s = detectTooling() }).not.toThrow()
    expect(typeof s.markitdown).toBe('boolean')
    expect(typeof s.soffice).toBe('boolean')
  })
})
