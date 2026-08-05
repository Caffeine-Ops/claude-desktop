import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isWritingAssetPath } from '../services/writingAssetProtocol'
import { writeWritingImage, writingImagePathFor, writingImageRelPath } from './writingImageWriter'

describe('writingImagePathFor', () => {
  it('落在项目的 images/ 下，文件名带时间戳', () => {
    const p = writingImagePathFor('/Users/k/projects/稿子_20260803', 'png', 1754200000000)
    // 文件名现在是 `gen-<ts>-<随机 hex>.<ext>`（同毫秒并发防覆盖，见模块头注释），
    // 不再是纯时间戳的确定性字符串，所以断言目录 + 前缀 + 后缀，不断言整串相等。
    expect(dirname(p)).toBe(join('/Users/k/projects/稿子_20260803', 'images'))
    expect(basename(p)).toMatch(/^gen-1754200000000-[0-9a-f]{12}\.png$/)
  })

  it('扩展名跟着实际字节走，不写死 png', () => {
    // 用 jpg 而不是 webp：生产唯一调用方 embeddableExtFor 对 webp 直接抛
    // 「无法嵌入 Word」，ext === 'webp' 永远传不进 writingImagePathFor，webp 用例
    // 断言的是生产不可达的行为。jpg 才是 embeddableExtFor 实际会产出的非 png 分支。
    const p = writingImagePathFor('/p', 'jpg', 1)
    expect(p.endsWith('.jpg')).toBe(true)
  })

  it('产出路径必须命中 isWritingAssetPath——这是本模块对 writingasset:// 协议的唯一契约', () => {
    // Task 1 的 writingasset:// 协议靠 isWritingAssetPath 白名单决定是否放行加载。
    // 这条断言钉住跨模块契约：日后若把落点从 images/ 改成别的目录名，这里会先炸，
    // 而不是等到真机上「图落盘了但右栏空白」才发现（协议侧没有任何日志/报错）。
    expect(isWritingAssetPath(writingImagePathFor('/Users/k/稿子', 'png', 1))).toBe(true)
  })
})

describe('writingImageRelPath', () => {
  it('回 ../images/<文件名>——正文在 drafts/，与 images/ 是兄弟目录', () => {
    expect(writingImageRelPath('gen-1.png')).toBe('../images/gen-1.png')
  })
})

describe('writeWritingImage', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  it('mkdir -p images/ 后落盘，返回的 path/relPath 自洽，内容与传入字节一致', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'writing-image-writer-test-'))
    tmpDirs.push(projectDir)

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // 假 PNG 头，字节内容不重要，只验证透传
    const result = await writeWritingImage(projectDir, bytes, 'png', 1754200000000)

    // path 是绝对路径，落在 <projectDir>/images/ 下
    expect(dirname(result.path)).toBe(join(projectDir, 'images'))

    // relPath 的文件名必须与 path 的 basename 一致——这是 writeWritingImage 内部
    // 「只算一次文件名」这条修复的行为契约（此前分别拼两次会算出两个不同随机后缀）。
    expect(basename(result.path)).toBe(basename(result.relPath))
    expect(result.relPath).toBe(`../images/${basename(result.path)}`)

    // 文件真的落盘了，内容与传入的 bytes 完全一致（没有被截断/转码）。
    const written = await readFile(result.path)
    expect(written.equals(bytes)).toBe(true)
  })
})
