import { describe, it, expect } from 'bun:test'
import { diffManifests } from './kbSyncDiff'
import type { KbManifest } from '../../shared/kbManifest'

const mk = (files: { path: string; sha1: string }[]): KbManifest => ({
  schemaVersion: 1,
  kbId: 'default',
  name: 'kb',
  builtAtMs: 1,
  files: files.map((f) => ({ ...f, size: 1 }))
})

describe('diffManifests', () => {
  it('base null → 全量下载、零删除', () => {
    const remote = mk([{ path: 'a.md', sha1: 'x' }, { path: 'index.json', sha1: 'y' }])
    const plan = diffManifests(null, remote)
    expect(plan.toDownload.map((f) => f.path)).toEqual(['a.md', 'index.json'])
    expect(plan.toDelete).toEqual([])
  })
  it('sha1 相同跳过、不同重下、新增下载、缺失删除', () => {
    const base = mk([
      { path: '不变.md', sha1: 'same' },
      { path: '变了.md', sha1: 'old' },
      { path: '删了.md', sha1: 'gone' }
    ])
    const remote = mk([
      { path: '不变.md', sha1: 'same' },
      { path: '变了.md', sha1: 'new' },
      { path: '新增.md', sha1: 'add' }
    ])
    const plan = diffManifests(base, remote)
    expect(plan.toDownload.map((f) => f.path).sort()).toEqual(['变了.md', '新增.md'])
    expect(plan.toDelete).toEqual(['删了.md'])
  })
  it('index.json 恒排在 toDownload 末位（哪怕字典序在前）', () => {
    const remote = mk([{ path: 'index.json', sha1: 'a' }, { path: 'z_最后.md', sha1: 'b' }])
    const plan = diffManifests(null, remote)
    expect(plan.toDownload.at(-1)!.path).toBe('index.json')
  })
})
