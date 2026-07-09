import { describe, it, expect } from 'bun:test'
import { parseKbConfig } from './kbConfig'

// localDocsExtraDirs / localDocsDisabledPresets 是「全部文件」扫描加的新字段，
// parseKbConfig 恒返回（默认空数组），所有期望值都要带上。
const noLocalDocs = { localDocsExtraDirs: [] as string[], localDocsDisabledPresets: [] as string[] }

describe('parseKbConfig', () => {
  it('老格式 {kbRoot} 向后兼容，remote 为 null', () => {
    expect(parseKbConfig('{"kbRoot":"/a/b"}')).toEqual({ kbRoot: '/a/b', remote: null, ...noLocalDocs })
  })
  it('新格式带 remote', () => {
    expect(parseKbConfig('{"kbRoot":"/a","remote":{"baseUrl":"http://h:8080","kbId":"default"}}')).toEqual({
      kbRoot: '/a',
      remote: { baseUrl: 'http://h:8080', kbId: 'default' },
      ...noLocalDocs
    })
  })
  it('null / 损坏 JSON / 非对象 → 全空配置', () => {
    const empty = { kbRoot: null, remote: null, ...noLocalDocs }
    expect(parseKbConfig(null)).toEqual(empty)
    expect(parseKbConfig('{oops')).toEqual(empty)
    expect(parseKbConfig('"str"')).toEqual(empty)
  })
  it('remote 字段残缺（缺 kbId / baseUrl 非串）→ remote 当 null，不连坐 kbRoot', () => {
    expect(parseKbConfig('{"kbRoot":"/a","remote":{"baseUrl":"http://h"}}')).toEqual({
      kbRoot: '/a',
      remote: null,
      ...noLocalDocs
    })
    expect(parseKbConfig('{"remote":{"baseUrl":1,"kbId":"d"}}')).toEqual({
      kbRoot: null,
      remote: null,
      ...noLocalDocs
    })
  })
})
