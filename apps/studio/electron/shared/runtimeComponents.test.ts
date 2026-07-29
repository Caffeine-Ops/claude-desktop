import { describe, expect, test } from 'bun:test'
import {
  artifactUrl,
  currentComponentPlatform,
  formatBytes,
  formatEta,
  parseComponentsManifest,
  pickArtifact,
  type ComponentEntry
} from './runtimeComponents'

const SHA = 'a'.repeat(64)
const SHA2 = 'b'.repeat(64)

function artifact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'v2.1.212',
    file: 'cli-v2.1.212-darwin-arm64.gz',
    sha256: SHA,
    size: 84_000_000,
    unpackedSize: 244_530_512,
    encoding: 'gzip',
    contentSha256: SHA2,
    source: 'official',
    binName: 'fusion-code-cli',
    readyProbe: 'fusion-code-cli',
    ...over
  }
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    publishedAt: 1753800000000,
    components: [
      {
        id: 'cli',
        kind: 'executable',
        required: true,
        artifacts: { 'darwin-arm64': artifact() }
      }
    ],
    ...over
  }
}

/** 造一个只改了 artifacts 的 cli entry，省去每个用例重复一堆字段。 */
function cliEntry(artifacts: Record<string, unknown>): Record<string, unknown> {
  return { id: 'cli', kind: 'executable', required: true, artifacts }
}

describe('parseComponentsManifest — 正常形状', () => {
  test('完整清单解析成功且字段保真', () => {
    const m = parseComponentsManifest(manifest())
    expect(m).not.toBeNull()
    expect(m!.components).toHaveLength(1)
    const e = m!.components[0]!
    expect(e.id).toBe('cli')
    expect(e.required).toBe(true)
    expect(e.artifacts['darwin-arm64']!.source).toBe('official')
    expect(e.artifacts['darwin-arm64']!.contentSha256).toBe(SHA2)
  })

  test('可选字段缺省时不出现在结果里（不是 undefined 值占位）', () => {
    const m = parseComponentsManifest(
      manifest({
        components: [
          {
            id: 'python-runtime',
            kind: 'tar.gz',
            required: false,
            stripComponents: 1,
            artifacts: {
              'darwin-arm64': artifact({
                encoding: 'none',
                contentSha256: undefined,
                source: undefined,
                binName: undefined,
                readyProbe: 'bin/python3'
              })
            }
          }
        ]
      })
    )
    expect(m).not.toBeNull()
    const a = m!.components[0]!.artifacts['darwin-arm64']!
    expect('contentSha256' in a).toBe(false)
    expect('source' in a).toBe(false)
    expect(m!.components[0]!.stripComponents).toBe(1)
  })

  test('publishedAt 缺失退化成 0，不判废整份清单', () => {
    const m = parseComponentsManifest(manifest({ publishedAt: undefined }))
    expect(m?.publishedAt).toBe(0)
  })
})

describe('parseComponentsManifest — 必须判废的输入', () => {
  /**
   * 这一组是本模块存在的主要理由：自建源同域挂着 sub2api 网关，**漏配路径不会
   * 404，会被它的 SPA 兜底吃成 200 + text/html**（已实测）。若不严校验，客户端会
   * 把一个网页当清单解析，然后以千奇百怪的方式失败在下游。
   */
  test('SPA 兜底回来的 HTML 字符串 → null', () => {
    expect(parseComponentsManifest('<!doctype html><html><body>…</body></html>')).toBeNull()
  })

  test('null / 数组 / 数字 → null', () => {
    expect(parseComponentsManifest(null)).toBeNull()
    expect(parseComponentsManifest([])).toBeNull()
    expect(parseComponentsManifest(42)).toBeNull()
  })

  test('未来的 schemaVersion → null（让调用方走离线降级，而不是焊死用户）', () => {
    expect(parseComponentsManifest(manifest({ schemaVersion: 2 }))).toBeNull()
  })

  test('components 为空数组 → null', () => {
    expect(parseComponentsManifest(manifest({ components: [] }))).toBeNull()
  })

  test('未知的 component id → null', () => {
    expect(
      parseComponentsManifest(
        manifest({ components: [{ ...cliEntry({ 'darwin-arm64': artifact() }), id: 'something-else' }] })
      )
    ).toBeNull()
  })

  test('executable 却没给 binName → null', () => {
    expect(
      parseComponentsManifest(
        manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ binName: undefined }) })] })
      )
    ).toBeNull()
  })

  test('未知平台 key → null', () => {
    expect(parseComponentsManifest(manifest({ components: [cliEntry({ 'linux-x64': artifact() })] }))).toBeNull()
  })

  test('artifacts 一个平台都没有 → null', () => {
    expect(parseComponentsManifest(manifest({ components: [cliEntry({})] }))).toBeNull()
  })

  test('sha256 不是 64 位小写 hex → null', () => {
    for (const bad of ['', 'xyz', SHA.toUpperCase(), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ sha256: bad }) })] }))).toBeNull()
    }
  })

  /** file 会被拼进 URL 和本地路径——放行 `/` 或 `..` 等于把远端清单变成任意写盘原语。 */
  test('file 名含路径分隔或 .. → null', () => {
    for (const bad of ['../../etc/passwd', 'a/b.gz', '/abs.gz', 'x\\y.gz']) {
      expect(parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ file: bad }) })] }))).toBeNull()
    }
  })

  test('size / unpackedSize 非正数或非有限 → null', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      expect(parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ size: bad }) })] }))).toBeNull()
    }
  })

  test('encoding 不在联合内 → null', () => {
    expect(parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ encoding: 'br' }) })] }))).toBeNull()
  })

  test('url 非 https → null（不接受明文 http 下发可执行文件）', () => {
    expect(parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ url: 'http://evil/x.gz' }) })] }))).toBeNull()
  })

  test('required 不是 boolean → null', () => {
    expect(parseComponentsManifest(manifest({ components: [{ ...cliEntry({ 'darwin-arm64': artifact() }), required: 'yes' }] }))).toBeNull()
  })

  test('readyProbe 缺失 → null', () => {
    expect(
      parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ readyProbe: undefined }) })] }))
    ).toBeNull()
  })

  /** readyProbe / binName 都会被拼进本地路径，不能含跳出安装目录的成分。 */
  test('readyProbe 含 .. 或绝对路径 → null', () => {
    for (const bad of ['../../../etc/passwd', '/etc/passwd', 'a/../../b']) {
      expect(
        parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ readyProbe: bad }) })] }))
      ).toBeNull()
    }
  })

  test('binName 含路径分隔 → null', () => {
    for (const bad of ['../evil', 'a/b', '/abs']) {
      expect(
        parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ binName: bad }) })] }))
      ).toBeNull()
    }
  })
})

/**
 * 平台相关字段必须**逐平台独立保真**。
 *
 * 这组是踩过坑之后补的回归：binName / readyProbe 最初放在 entry 层，合并三平台
 * 分片时后一个平台的值被前一个覆盖，产出的清单里 Windows 用着 mac 的文件名——
 * 装完落盘没有 .exe（cliDetect 找不到），python 判据永远不满足（每次启动重下一遍）。
 * 两个症状都离真因极远，而且只在 Windows 上出现，mac 上开发永远测不到。
 */
describe('平台相关字段逐平台独立', () => {
  test('三平台各自的 binName / readyProbe 互不覆盖', () => {
    const m = parseComponentsManifest(
      manifest({
        components: [
          cliEntry({
            'darwin-arm64': artifact({ file: 'cli-mac-arm.gz', binName: 'fusion-code-cli', readyProbe: 'fusion-code-cli' }),
            'darwin-x64': artifact({ file: 'cli-mac-x64.gz', binName: 'fusion-code-cli', readyProbe: 'fusion-code-cli' }),
            'win32-x64': artifact({ file: 'cli-win.gz', binName: 'fusion-code-cli.exe', readyProbe: 'fusion-code-cli.exe' })
          })
        ]
      })
    )
    expect(m).not.toBeNull()
    const a = m!.components[0]!.artifacts
    expect(a['darwin-arm64']!.binName).toBe('fusion-code-cli')
    expect(a['win32-x64']!.binName).toBe('fusion-code-cli.exe')
    expect(a['win32-x64']!.readyProbe).toBe('fusion-code-cli.exe')
  })

  test('python 的解释器路径按平台不同，各自保真', () => {
    const m = parseComponentsManifest(
      manifest({
        components: [
          {
            id: 'python-runtime',
            kind: 'tar.gz',
            required: false,
            stripComponents: 1,
            artifacts: {
              'darwin-arm64': artifact({ file: 'py-mac.tar.gz', encoding: 'none', binName: undefined, readyProbe: 'bin/python3' }),
              'win32-x64': artifact({ file: 'py-win.tar.gz', encoding: 'none', binName: undefined, readyProbe: 'python.exe' })
            }
          }
        ]
      })
    )
    expect(m).not.toBeNull()
    const a = m!.components[0]!.artifacts
    expect(a['darwin-arm64']!.readyProbe).toBe('bin/python3')
    expect(a['win32-x64']!.readyProbe).toBe('python.exe')
  })
})

describe('currentComponentPlatform', () => {
  test('三个受支持平台', () => {
    expect(currentComponentPlatform('darwin', 'arm64')).toBe('darwin-arm64')
    expect(currentComponentPlatform('darwin', 'x64')).toBe('darwin-x64')
    expect(currentComponentPlatform('win32', 'x64')).toBe('win32-x64')
  })

  test('CI 不打的平台返回 null（调用方据此不注册组件，而不是注册一张坏卡）', () => {
    expect(currentComponentPlatform('linux', 'x64')).toBeNull()
    expect(currentComponentPlatform('win32', 'arm64')).toBeNull()
    expect(currentComponentPlatform('darwin', 'ia32')).toBeNull()
  })
})

describe('pickArtifact / artifactUrl', () => {
  const entry = parseComponentsManifest(manifest())!.components[0] as ComponentEntry

  test('取到本平台产物；其他平台为 undefined', () => {
    expect(pickArtifact(entry, 'darwin-arm64')).toBeDefined()
    expect(pickArtifact(entry, 'win32-x64')).toBeUndefined()
    expect(pickArtifact(entry, null)).toBeUndefined()
  })

  test('无 url 时同目录拼接，并吃掉 base 末尾多余的斜杠', () => {
    const a = pickArtifact(entry, 'darwin-arm64')!
    expect(artifactUrl('https://x.test/downloads/components', a)).toBe('https://x.test/downloads/components/cli-v2.1.212-darwin-arm64.gz')
    expect(artifactUrl('https://x.test/downloads/components///', a)).toBe('https://x.test/downloads/components/cli-v2.1.212-darwin-arm64.gz')
  })

  test('清单写死绝对 url 时优先用它（异地托管场景）', () => {
    const m = parseComponentsManifest(manifest({ components: [cliEntry({ 'darwin-arm64': artifact({ url: 'https://cdn.test/a.gz' }) })] }))!
    expect(artifactUrl('https://x.test/base', m.components[0]!.artifacts['darwin-arm64']!)).toBe('https://cdn.test/a.gz')
  })
})

describe('formatEta / formatBytes', () => {
  test('速率未知或已下完 → 空串（宁可不显示，也不显示跳动的假数字）', () => {
    expect(formatEta(1000, 0)).toBe('')
    expect(formatEta(0, 1000)).toBe('')
    expect(formatEta(-5, 1000)).toBe('')
  })

  test('不足一分钟按秒，超过按分钟，都向上取整', () => {
    expect(formatEta(1_100_000, 1_100_000)).toBe('约 1 秒')
    expect(formatEta(52_800_000, 1_100_000)).toBe('约 48 秒')
    expect(formatEta(80_000_000, 1_100_000)).toBe('约 2 分钟')
  })

  test('字节格式化', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(84_000_000)).toBe('80.1 MB')
  })
})
