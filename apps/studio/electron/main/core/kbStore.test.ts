import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildKbIndex } from './kbBuild/build'
import {
  importDocs, deleteDoc, moveDoc, createCategory, renameCategory, deleteCategory, listStoreRelPaths,
  type KbStoreDirs
} from './kbStore'
import type { KbIndex } from '../../shared/kbIndex'

async function fixture(): Promise<{ dirs: KbStoreDirs; src: string }> {
  const base = mkdtempSync(join(tmpdir(), 'kbstore-'))
  const dirs = { storeDir: join(base, 'store'), outDir: join(base, 'out') }
  const src = join(base, 'inbox')
  mkdirSync(src, { recursive: true })
  mkdirSync(join(dirs.storeDir, '线A', '品1'), { recursive: true })
  writeFileSync(join(dirs.storeDir, '线A', '品1', '方案.txt'), '正文', 'utf8')
  await buildKbIndex({ kbRoot: dirs.storeDir, outDir: dirs.outDir, now: 1000, vectors: false })
  return { dirs, src }
}

const readIndex = (dirs: KbStoreDirs): KbIndex =>
  JSON.parse(readFileSync(join(dirs.outDir, 'index.json'), 'utf8')) as KbIndex

describe('kbStore 执行层', () => {
  test('importDocs：新文件拷入、冲突跳过、overwrite 覆盖并清旧条目', async () => {
    const { dirs, src } = await fixture()
    writeFileSync(join(src, '方案.txt'), '新版本', 'utf8')
    writeFileSync(join(src, '白皮书.txt'), '白皮书', 'utf8')
    const r1 = importDocs(dirs, [
      { srcPath: join(src, '方案.txt'), fileName: '方案.txt' },
      { srcPath: join(src, '白皮书.txt'), fileName: '白皮书.txt' }
    ], '线A', '品1', false)
    expect(r1.conflicted).toEqual([join('线A', '品1', '方案.txt')])
    expect(r1.imported).toEqual([join('线A', '品1', '白皮书.txt')])
    expect(readFileSync(join(dirs.storeDir, '线A', '品1', '方案.txt'), 'utf8')).toBe('正文') // 未覆盖

    const r2 = importDocs(dirs, [{ srcPath: join(src, '方案.txt'), fileName: '方案.txt' }], '线A', '品1', true)
    expect(r2.imported).toHaveLength(1)
    expect(readFileSync(join(dirs.storeDir, '线A', '品1', '方案.txt'), 'utf8')).toBe('新版本')
    // 覆盖导入 = 先删旧 index 条目：下一轮构建把它当新文件、importedAtMs 取新 now
    expect(readIndex(dirs).files).toHaveLength(0)
  })

  test('deleteDoc：原件+镜像+index 条目一起消失，且 bump builtAtMs 灭幽灵向量行', async () => {
    const { dirs } = await fixture()
    const rel = join('线A', '品1', '方案.txt')

    // 删不存在的文档 = 条目未变 → 不写盘：builtAtMs 与文件 mtime 都不动，
    // 避免无谓触发 embedWorker 的 index.json mtime 回收
    const indexPath = join(dirs.outDir, 'index.json')
    const mtimeBefore = statSync(indexPath).mtimeMs
    deleteDoc(dirs, join('线A', '品1', '不存在.txt'))
    expect(readIndex(dirs).builtAtMs).toBe(1000)
    expect(statSync(indexPath).mtimeMs).toBe(mtimeBefore)

    deleteDoc(dirs, rel)
    expect(existsSync(join(dirs.storeDir, rel))).toBe(false)
    expect(existsSync(`${join(dirs.outDir, rel)}.md`)).toBe(false)
    expect(readIndex(dirs).files).toHaveLength(0)
    // 命中条目的写操作必须 bump builtAtMs：vectors fingerprint 立即失配 → 语义检索
    // 降级 BM25，窗口期内不会命中已删文档的向量行
    expect(readIndex(dirs).builtAtMs).not.toBe(1000)
  })

  test('index.json 缺失时 deleteDoc/moveDoc 仍完成文件操作且不抛', async () => {
    const { dirs } = await fixture()
    rmSync(join(dirs.outDir, 'index.json'))
    const rel = join('线A', '品1', '方案.txt')
    const newRel = moveDoc(dirs, rel, '线B', '')
    expect(existsSync(join(dirs.storeDir, newRel))).toBe(true)
    expect(existsSync(`${join(dirs.outDir, newRel)}.md`)).toBe(true)
    deleteDoc(dirs, newRel)
    expect(existsSync(join(dirs.storeDir, newRel))).toBe(false)
    // updateIndex 对缺失索引是早退：不 resurrect 一个只有空表的 index.json
    expect(existsSync(join(dirs.outDir, 'index.json'))).toBe(false)
  })

  test('moveDoc：三处路径搬家 + index 条目改写，目标已存在则 throw', async () => {
    const { dirs } = await fixture()
    const rel = join('线A', '品1', '方案.txt')
    // 手工补一个 assets 子树（txt 转换不产 assets，但 docx/pptx 会）——覆盖 assetsDir 随迁分支
    const oldAssets = join(dirs.outDir, 'assets', rel)
    mkdirSync(oldAssets, { recursive: true })
    writeFileSync(join(oldAssets, 'img-1.png'), 'fake-png', 'utf8')

    const newRel = moveDoc(dirs, rel, '线B', '')
    expect(newRel).toBe(join('线B', '方案.txt'))
    expect(existsSync(join(dirs.storeDir, newRel))).toBe(true)
    expect(existsSync(`${join(dirs.outDir, newRel)}.md`)).toBe(true)
    expect(existsSync(join(dirs.outDir, 'assets', newRel, 'img-1.png'))).toBe(true) // assets 随迁
    expect(existsSync(oldAssets)).toBe(false)
    const f = readIndex(dirs).files[0]!
    expect(f.productLine).toBe('线B')
    expect(f.importedAtMs).toBe(1000) // 移动不是重新入库
    expect(() => moveDoc(dirs, newRel, '线B', '', '方案.txt')).toThrow() // 原地移动=目标已存在
  })

  test('分类：create/rename/delete 贯通且 index 跟随', async () => {
    const { dirs } = await fixture()
    createCategory(dirs, '线C', '品X')
    expect(existsSync(join(dirs.storeDir, '线C', '品X'))).toBe(true)
    // 不存在的 prefix 必须在动任何目录前被守卫拦下（带业务语义的错误，而不是 ENOENT）
    expect(() => renameCategory(dirs, '线不存在', '线乙')).toThrow('分类不存在')

    // 手工补 assets 子树，覆盖 rename/delete 的 assets 前缀搬/删分支
    const assetsUnderA = join(dirs.outDir, 'assets', '线A', '品1', '方案.txt')
    mkdirSync(assetsUnderA, { recursive: true })
    writeFileSync(join(assetsUnderA, 'img-1.png'), 'fake-png', 'utf8')

    const { moved } = renameCategory(dirs, '线A', '线甲')
    expect(moved).toBe(1)
    expect(readIndex(dirs).files[0]!.productLine).toBe('线甲')
    expect(listStoreRelPaths(dirs).has(join('线甲', '品1', '方案.txt'))).toBe(true)
    expect(existsSync(join(dirs.outDir, 'assets', '线甲', '品1', '方案.txt', 'img-1.png'))).toBe(true)

    const { deletedDocs } = deleteCategory(dirs, '线甲')
    expect(deletedDocs).toBe(1)
    expect(existsSync(join(dirs.storeDir, '线甲'))).toBe(false)
    expect(existsSync(join(dirs.outDir, 'assets', '线甲'))).toBe(false) // assets 子树一并删
    expect(readIndex(dirs).files).toHaveLength(0)
  })
})
