// apps/studio/electron/main/core/componentRegistry.test.ts
import { describe, expect, test } from 'bun:test'
import { COMPONENT_REGISTRY, EMBED_COMPONENT_ID, getComponentDescriptor } from './componentRegistry'
import { KB_DOWNLOADABLE_MODELS } from './kbModelManifest'

describe('componentRegistry', () => {
  test('能按 id 取到 embed 档案卡', () => {
    const d = getComponentDescriptor(EMBED_COMPONENT_ID)
    expect(d).toBeDefined()
    expect(d!.strategy).toBe('hosted-files')
    expect(d!.install.kind).toBe('files')
  })
  test('未知 id 返回 undefined', () => {
    expect(getComponentDescriptor('nope')).toBeUndefined()
  })
  test('embed 档案卡的文件 sha256/size 逐条忠实于 KB_DOWNLOADABLE_MODELS（防漂移）', () => {
    const d = getComponentDescriptor(EMBED_COMPONENT_ID)!
    const model = KB_DOWNLOADABLE_MODELS[0]
    if (d.install.kind !== 'files') throw new Error('embed 应为 files 形态')
    expect(d.install.files.length).toBe(model.files.length)
    for (const f of model.files) {
      const got = d.install.files.find((x) => x.relPath === f.relPath)
      expect(got).toBeDefined()
      expect(got!.sha256).toBe(f.sha256)
      expect(got!.size).toBe(f.size)
    }
  })
})
