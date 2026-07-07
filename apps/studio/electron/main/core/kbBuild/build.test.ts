import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildKbIndex } from './build'
import type { KbIndex } from '../../../shared/kbIndex'

function fixture(): { root: string; out: string } {
  const base = mkdtempSync(join(tmpdir(), 'kbbuild-'))
  const root = join(base, 'store')
  mkdirSync(join(root, '智慧水务', '平台A'), { recursive: true })
  writeFileSync(join(root, '智慧水务', '平台A', '方案.txt'), '这是方案正文', 'utf8')
  return { root, out: join(base, 'out') }
}

describe('buildKbIndex', () => {
  test('全量构建：v3 索引 + 镜像 + importedAtMs/sizeBytes', async () => {
    const { root, out } = fixture()
    const idx = await buildKbIndex({ kbRoot: root, outDir: out, now: 1000, vectors: false })
    expect(idx.version).toBe(3)
    expect(idx.files).toHaveLength(1)
    const f = idx.files[0]!
    expect(f.ok).toBe(true)
    expect(f.importedAtMs).toBe(1000)
    expect(f.sizeBytes).toBeGreaterThan(0)
    expect(f.productLine).toBe('智慧水务')
    expect(f.product).toBe('平台A')
    expect(existsSync(f.mirrorPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')) as KbIndex
    expect(onDisk.files).toHaveLength(1)
  })

  test('增量：未变文件跳过且 importedAtMs 保留；删除的文件从索引消失', async () => {
    const { root, out } = fixture()
    await buildKbIndex({ kbRoot: root, outDir: out, now: 1000, vectors: false })
    writeFileSync(join(root, '智慧水务', '平台A', '新增.txt'), '第二篇', 'utf8')
    const idx2 = await buildKbIndex({ kbRoot: root, outDir: out, now: 2000, vectors: false })
    const old = idx2.files.find((f) => f.title === '方案')!
    expect(old.importedAtMs).toBe(1000) // 未变文件保留首次入库时间
    expect(idx2.files.find((f) => f.title === '新增')!.importedAtMs).toBe(2000)
    rmSync(join(root, '智慧水务', '平台A', '新增.txt'))
    const idx3 = await buildKbIndex({ kbRoot: root, outDir: out, now: 3000, vectors: false })
    expect(idx3.files.map((f) => f.title)).toEqual(['方案'])
  })

  test('同路径内容变更（sha1 变）重转：importedAtMs 保留旧值、镜像已更新', async () => {
    const { root, out } = fixture()
    const p = join(root, '智慧水务', '平台A', '方案.txt')
    const idx1 = await buildKbIndex({ kbRoot: root, outDir: out, now: 1000, vectors: false })
    writeFileSync(p, '这是修改后的方案正文', 'utf8')
    const idx2 = await buildKbIndex({ kbRoot: root, outDir: out, now: 2000, vectors: false })
    const f = idx2.files[0]!
    expect(f.importedAtMs).toBe(1000) // 重转不刷新「首次入库时间」（v3 语义）
    expect(f.sha1).not.toBe(idx1.files[0]!.sha1) // 内容变了 → sha1 必须变、走重转而非快路径
    expect(readFileSync(f.mirrorPath, 'utf8')).toContain('这是修改后的方案正文')
  })

  test('内容不变仅 touch：走 sha1 快路径仍跳过', async () => {
    const { root, out } = fixture()
    const p = join(root, '智慧水务', '平台A', '方案.txt')
    const idx1 = await buildKbIndex({ kbRoot: root, outDir: out, now: 1000, vectors: false })
    utimesSync(p, new Date(9999999), new Date(9999999))
    const idx2 = await buildKbIndex({ kbRoot: root, outDir: out, now: 2000, vectors: false })
    expect(idx2.files[0]!.importedAtMs).toBe(1000)
    expect(idx2.files[0]!.sha1).toBe(idx1.files[0]!.sha1)
  })
})
