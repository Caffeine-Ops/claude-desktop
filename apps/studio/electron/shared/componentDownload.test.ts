// apps/studio/electron/shared/componentDownload.test.ts
import { describe, expect, test } from 'bun:test'
import { descriptorTotalBytes, type ComponentDescriptor } from './componentDownload'

const filesDesc: ComponentDescriptor = {
  id: 'x', title: 'X', description: 'x', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: {
    kind: 'files', destSubdir: 'x',
    files: [
      { relPath: 'a', urls: ['u1'], sha256: 'h1', size: 10 },
      { relPath: 'b', urls: ['u2'], sha256: 'h2', size: 32 },
    ],
  },
}
const archiveDesc: ComponentDescriptor = {
  id: 'y', title: 'Y', description: 'y', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: { kind: 'archive', destSubdir: 'y', format: 'tar.gz', readyCheck: 'bin/x',
    archive: { urls: ['u'], sha256: 'h', size: 100 } },
}

describe('descriptorTotalBytes', () => {
  test('files 形态 = 各文件 size 之和', () => {
    expect(descriptorTotalBytes(filesDesc)).toBe(42)
  })
  test('archive 形态 = 整包 size', () => {
    expect(descriptorTotalBytes(archiveDesc)).toBe(100)
  })
})

import { initialComponentState } from './componentDownload'

describe('initialComponentState', () => {
  test('新组件初态 = idle、无进度、无错误', () => {
    expect(initialComponentState('foo')).toEqual({
      id: 'foo', status: 'idle', percent: null, currentFile: null, errorMessage: null, origin: null,
    })
  })
  test('initialComponentState 含 origin: null(P1c 随包来源注记的缺省值)', () => {
    expect(initialComponentState('x').origin).toBeNull()
  })
})
