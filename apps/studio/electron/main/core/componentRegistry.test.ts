// apps/studio/electron/main/core/componentRegistry.test.ts
import { describe, expect, test } from 'bun:test'
import { COMPONENT_REGISTRY, EMBED_COMPONENT_ID, MARKITDOWN_COMPONENT_ID, SOFFICE_COMPONENT_ID, getComponentDescriptor } from './componentRegistry'
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

describe('markitdown / soffice 档案卡', () => {
  test('markitdown 是 pipx 策略', () => {
    const d = getComponentDescriptor(MARKITDOWN_COMPONENT_ID)!
    expect(d.strategy).toBe('pipx')
    if (d.install.kind !== 'pipx') throw new Error('应为 pipx')
    expect(d.install.pkg).toBe('markitdown')
    expect(d.install.probeCmd).toBe('markitdown')
  })
  test('soffice 是 detect-only 策略', () => {
    const d = getComponentDescriptor(SOFFICE_COMPONENT_ID)!
    expect(d.strategy).toBe('detect-only')
    if (d.install.kind !== 'detect-only') throw new Error('应为 detect-only')
    expect(d.install.probeCmd).toBe('soffice')
  })
})

import { PYTHON_COMPONENT_ID, pickPythonDist } from './componentRegistry'

describe('python-runtime 档案卡(P1c)', () => {
  test('三个已支持平台各返回一份完整 dist,未知平台返回 undefined', () => {
    const mac = pickPythonDist('darwin', 'arm64')!
    const macX64 = pickPythonDist('darwin', 'x64')!
    const win = pickPythonDist('win32', 'x64')!
    expect(mac.url).toContain('aarch64-apple-darwin-install_only.tar.gz')
    expect(macX64.url).toContain('x86_64-apple-darwin-install_only.tar.gz')
    expect(win.url).toContain('x86_64-pc-windows-msvc-install_only.tar.gz')
    // 版本钉出现在 url 里(名册是唯一事实源,CI 的 env 钉在 Task 8 退役)
    for (const d of [mac, macX64, win]) {
      expect(d.url).toContain('20260510')
      expect(d.url).toContain('3.12.13')
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(d.size).toBeGreaterThan(10_000_000)
    }
    // 就绪判据/chmod 按平台分岔:mac 解释器在 bin/python3(需补 +x),win 在根下 python.exe
    expect(mac.readyCheck).toBe('bin/python3')
    expect(mac.chmodExec).toEqual(['bin/python3'])
    expect(win.readyCheck).toBe('python.exe')
    expect(win.chmodExec).toEqual([])
    expect(pickPythonDist('linux', 'x64')).toBeUndefined()
    expect(pickPythonDist('win32', 'arm64')).toBeUndefined()
  })

  test('本机平台(darwin-arm64 CI/dev 机)注册了 python 卡且忠实于 pickPythonDist', () => {
    // 本仓 dev/CI 都是 mac;若将来在别的平台跑测试,这条按平台自适应即可
    const dist = pickPythonDist(process.platform, process.arch)
    const d = getComponentDescriptor(PYTHON_COMPONENT_ID)
    if (!dist) { expect(d).toBeUndefined(); return }
    expect(d).toBeDefined()
    expect(d!.strategy).toBe('hosted-files')
    if (d!.install.kind !== 'archive') throw new Error('python 应为 archive 形态')
    expect(d!.install.destSubdir).toBe('python-runtime')
    expect(d!.install.format).toBe('tar.gz')
    expect(d!.install.stripComponents).toBe(1)
    expect(d!.install.readyCheck).toBe(dist.readyCheck)
    expect(d!.install.archive.urls).toEqual([dist.url])
    expect(d!.install.archive.sha256).toBe(dist.sha256)
    expect(d!.install.archive.size).toBe(dist.size)
    expect(d!.sizeEstimateBytes).toBe(dist.size)
  })
})
