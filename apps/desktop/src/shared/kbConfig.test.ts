import { describe, it, expect } from 'bun:test'
import { parseKbConfig } from './kbConfig'

describe('parseKbConfig', () => {
  it('老格式 {kbRoot} 向后兼容，remote 为 null', () => {
    expect(parseKbConfig('{"kbRoot":"/a/b"}')).toEqual({ kbRoot: '/a/b', remote: null })
  })
  it('新格式带 remote', () => {
    expect(parseKbConfig('{"kbRoot":"/a","remote":{"baseUrl":"http://h:8080","kbId":"default"}}')).toEqual({
      kbRoot: '/a',
      remote: { baseUrl: 'http://h:8080', kbId: 'default' }
    })
  })
  it('null / 损坏 JSON / 非对象 → 全空配置', () => {
    const empty = { kbRoot: null, remote: null }
    expect(parseKbConfig(null)).toEqual(empty)
    expect(parseKbConfig('{oops')).toEqual(empty)
    expect(parseKbConfig('"str"')).toEqual(empty)
  })
  it('remote 字段残缺（缺 kbId / baseUrl 非串）→ remote 当 null，不连坐 kbRoot', () => {
    expect(parseKbConfig('{"kbRoot":"/a","remote":{"baseUrl":"http://h"}}')).toEqual({ kbRoot: '/a', remote: null })
    expect(parseKbConfig('{"remote":{"baseUrl":1,"kbId":"d"}}')).toEqual({ kbRoot: null, remote: null })
  })
})
