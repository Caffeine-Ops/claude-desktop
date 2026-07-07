import { describe, it, expect } from 'bun:test'
import { parseKbConfig } from './kbConfig'

describe('parseKbConfig', () => {
  it('老格式 {kbRoot} 向后兼容，remote 为 null', () => {
    expect(parseKbConfig('{"kbRoot":"/a/b"}')).toEqual({ mode: null, kbRoot: '/a/b', remote: null })
  })
  it('新格式带 remote', () => {
    expect(parseKbConfig('{"kbRoot":"/a","remote":{"baseUrl":"http://h:8080","kbId":"default"}}')).toEqual({
      mode: null,
      kbRoot: '/a',
      remote: { baseUrl: 'http://h:8080', kbId: 'default' }
    })
  })
  it('null / 损坏 JSON / 非对象 → 全空配置', () => {
    const empty = { mode: null, kbRoot: null, remote: null }
    expect(parseKbConfig(null)).toEqual(empty)
    expect(parseKbConfig('{oops')).toEqual(empty)
    expect(parseKbConfig('"str"')).toEqual(empty)
  })
  it('remote 字段残缺（缺 kbId / baseUrl 非串）→ remote 当 null，不连坐 kbRoot', () => {
    expect(parseKbConfig('{"kbRoot":"/a","remote":{"baseUrl":"http://h"}}')).toEqual({ mode: null, kbRoot: '/a', remote: null })
    expect(parseKbConfig('{"remote":{"baseUrl":1,"kbId":"d"}}')).toEqual({ mode: null, kbRoot: null, remote: null })
  })
})

describe('parseKbConfig mode 字段', () => {
  it('合法 mode 透传', () => {
    expect(parseKbConfig('{"mode":"managed"}').mode).toBe('managed')
    expect(parseKbConfig('{"mode":"remote"}').mode).toBe('remote')
  })
  it('非法/缺失 mode 退 null，不连坐其他字段', () => {
    expect(parseKbConfig('{"mode":"banana","kbRoot":"/a"}')).toEqual({
      mode: null, kbRoot: '/a', remote: null
    })
    expect(parseKbConfig('{"kbRoot":"/a"}').mode).toBeNull()
    expect(parseKbConfig(null).mode).toBeNull()
    expect(parseKbConfig('not json').mode).toBeNull()
  })
})
