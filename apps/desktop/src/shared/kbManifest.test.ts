import { describe, it, expect } from 'bun:test'
import {
  parseKbManifest,
  manifestPathToPlatform,
  kbManifestUrl,
  kbFileUrl
} from './kbManifest'

const good = {
  schemaVersion: 1,
  kbId: 'default',
  name: '福鑫数科产品线资料库',
  builtAtMs: 1751500000000,
  files: [
    { path: 'index.json', sha1: 'a'.repeat(40), size: 10 },
    { path: '01AI患者服务/1_智能导诊系统/方案.docx.md', sha1: 'b'.repeat(40), size: 20 },
    { path: 'assets/01AI患者服务/1_智能导诊系统/方案.docx/img-1.png', sha1: 'c'.repeat(40), size: 30 }
  ]
}

describe('parseKbManifest', () => {
  it('良构 manifest → 原样返回', () => {
    expect(parseKbManifest(good)).toEqual(good)
  })
  it('null / 非对象 / 缺字段 → null', () => {
    expect(parseKbManifest(null)).toBeNull()
    expect(parseKbManifest('{}')).toBeNull()
    expect(parseKbManifest({ ...good, files: undefined })).toBeNull()
  })
  it('schemaVersion 不是 1 → null（未来版本不认识就拒收）', () => {
    expect(parseKbManifest({ ...good, schemaVersion: 2 })).toBeNull()
  })
  it('files 里混入坏条目（缺 sha1 / size 非数）→ null', () => {
    expect(parseKbManifest({ ...good, files: [{ path: 'x.md', size: 1 }] })).toBeNull()
    expect(parseKbManifest({ ...good, files: [{ path: 'x.md', sha1: 'a', size: '1' }] })).toBeNull()
  })
  it('路径逃逸（.. 段 / 绝对路径 / 反斜杠 / 空段）→ null，整份拒收', () => {
    for (const path of ['../etc/passwd', 'a/../../b.md', '/etc/passwd', 'a\\b.md', 'a//b.md', '']) {
      expect(parseKbManifest({ ...good, files: [{ path, sha1: 'a'.repeat(40), size: 1 }] })).toBeNull()
    }
  })
})

describe('路径与 URL 纯函数', () => {
  it('manifestPathToPlatform 按注入 sep 转换', () => {
    expect(manifestPathToPlatform('a/b/c.md', '\\')).toBe('a\\b\\c.md')
    expect(manifestPathToPlatform('a/b/c.md')).toBe('a/b/c.md')
  })
  it('kbManifestUrl 拼接并容忍 baseUrl 尾斜杠', () => {
    expect(kbManifestUrl('http://10.0.0.5:8080', 'default')).toBe('http://10.0.0.5:8080/kb/default/manifest.json')
    expect(kbManifestUrl('http://10.0.0.5:8080/', 'default')).toBe('http://10.0.0.5:8080/kb/default/manifest.json')
  })
  it('kbFileUrl 逐段 encodeURIComponent（中文/空格），保留段间 /', () => {
    expect(kbFileUrl('http://h', 'default', '01AI患者服务/a b/方案.docx.md')).toBe(
      `http://h/kb/default/${encodeURIComponent('01AI患者服务')}/${encodeURIComponent('a b')}/${encodeURIComponent('方案.docx.md')}`
    )
  })
})
