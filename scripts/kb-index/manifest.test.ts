import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { buildKbManifestFiles } from './manifest.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-manifest-'))
  mkdirSync(join(dir, '01产品线/1_产品/assets'), { recursive: true })
  writeFileSync(join(dir, 'index.json'), '{"v":1}')
  writeFileSync(join(dir, '01产品线/1_产品/方案.docx.md'), '正文')
  writeFileSync(join(dir, '01产品线/1_产品/assets/img-1.png'), Buffer.from([1, 2, 3]))
  // 应被跳过的四类
  writeFileSync(join(dir, 'manifest.json'), '{}')
  writeFileSync(join(dir, '.DS_Store'), '')
  writeFileSync(join(dir, '半截下载.md.part'), '')
  mkdirSync(join(dir, '.tmp'))
  writeFileSync(join(dir, '.tmp/soffice-中转.txt'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildKbManifestFiles', () => {
  it('收录普通文件、路径为 POSIX、sha1/size 正确、按 path 排序', () => {
    const files = buildKbManifestFiles(dir)
    expect(files.map((f) => f.path)).toEqual([
      '01产品线/1_产品/assets/img-1.png',
      '01产品线/1_产品/方案.docx.md',
      'index.json'
    ])
    const img = files[0]!
    expect(img.size).toBe(3)
    expect(img.sha1).toBe(createHash('sha1').update(Buffer.from([1, 2, 3])).digest('hex'))
  })
  it('跳过 manifest.json / 点开头文件与目录 / *.part', () => {
    const paths = buildKbManifestFiles(dir).map((f) => f.path)
    expect(paths.some((p) => p.includes('manifest.json'))).toBe(false)
    expect(paths.some((p) => p.includes('.DS_Store'))).toBe(false)
    expect(paths.some((p) => p.endsWith('.part'))).toBe(false)
    expect(paths.some((p) => p.includes('.tmp'))).toBe(false)
  })
})
