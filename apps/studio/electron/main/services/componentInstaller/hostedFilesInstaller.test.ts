import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { isComponentInstalled, readyCheckAbsPath, tarExtractArgs } from './hostedFilesInstaller'
import type { ComponentDescriptor, HostedArchiveInstall } from '../../../shared/componentDownload'

const filesDesc: ComponentDescriptor = {
  id: 'e', title: 'e', description: 'e', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: { kind: 'files', destSubdir: 'm', readyCheck: 'onnx/model.onnx',
    files: [{ relPath: 'config.json', urls: ['u'], sha256: 'h', size: 1 }] },
}
const filesNoReady: ComponentDescriptor = {
  id: 'e2', title: 'e2', description: 'e2', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: { kind: 'files', destSubdir: 'm',
    files: [
      { relPath: 'a.json', urls: ['u'], sha256: 'h', size: 1 },
      { relPath: 'b.json', urls: ['u'], sha256: 'h', size: 1 },
    ] },
}
const archiveDesc: ComponentDescriptor = {
  id: 'p', title: 'p', description: 'p', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: { kind: 'archive', destSubdir: 'py', format: 'tar.gz', stripComponents: 1,
    readyCheck: 'bin/python3', archive: { urls: ['u'], sha256: 'h', size: 1 } },
}

describe('readyCheckAbsPath', () => {
  test('files：root/destSubdir/readyCheck', () => {
    expect(readyCheckAbsPath(filesDesc, '/r')).toBe(join('/r', 'm', 'onnx/model.onnx'))
  })
  test('archive：root/destSubdir/readyCheck', () => {
    expect(readyCheckAbsPath(archiveDesc, '/r')).toBe(join('/r', 'py', 'bin/python3'))
  })
})

describe('isComponentInstalled', () => {
  test('有 readyCheck：判据文件存在即装好', () => {
    const exists = (p: string) => p === join('/r', 'm', 'onnx/model.onnx')
    expect(isComponentInstalled(filesDesc, '/r', exists)).toBe(true)
  })
  test('有 readyCheck：判据文件缺失即未装', () => {
    expect(isComponentInstalled(filesDesc, '/r', () => false)).toBe(false)
  })
  test('无 readyCheck 的 files：所有文件都在才算装好', () => {
    const onlyA = (p: string) => p === join('/r', 'm', 'a.json')
    expect(isComponentInstalled(filesNoReady, '/r', onlyA)).toBe(false)
    expect(isComponentInstalled(filesNoReady, '/r', () => true)).toBe(true)
  })
})

describe('tarExtractArgs', () => {
  test('含 strip-components 与目标目录', () => {
    const install = archiveDesc.install as HostedArchiveInstall
    expect(tarExtractArgs(install, '/tmp/p.part', '/r/py'))
      .toEqual(['-xzf', '/tmp/p.part', '--strip-components', '1', '-C', '/r/py'])
  })
})
