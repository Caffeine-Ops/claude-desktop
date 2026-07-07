import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildKbIndex } from './kbBuild/build'
import * as svc from './kbAdminService'
import type { KbIndex } from '../../shared/kbIndex'

async function fixture(): Promise<{ deps: svc.KbAdminDeps; scheduled: () => number; inbox: string }> {
  const base = mkdtempSync(join(tmpdir(), 'kbadmin-'))
  const dirs = { storeDir: join(base, 'store'), outDir: join(base, 'out') }
  const inbox = join(base, 'inbox'); mkdirSync(inbox, { recursive: true })
  mkdirSync(join(dirs.storeDir, '智慧水务', '平台A'), { recursive: true })
  writeFileSync(join(dirs.storeDir, '智慧水务', '平台A', '方案.txt'), '正文', 'utf8')
  await buildKbIndex({ kbRoot: dirs.storeDir, outDir: dirs.outDir, now: 1000, vectors: false })
  let n = 0
  const deps: svc.KbAdminDeps = {
    dirs,
    index: () => JSON.parse(readFileSync(join(dirs.outDir, 'index.json'), 'utf8')) as KbIndex,
    schedule: () => { n++ }
  }
  return { deps, scheduled: () => n, inbox }
}

describe('kbAdminService', () => {
  test('listDocs 折树 + readOnly 透传', async () => {
    const { deps } = await fixture()
    const r = svc.listDocs(deps, false)
    expect(r.readOnly).toBe(false)
    expect(r.total).toBe(1)
    expect(r.tree.lines[0]!.name).toBe('智慧水务')
    expect(r.tree.lines[0]!.products[0]!.docs[0]!.ext).toBe('.txt') // ext 从 sourcePath 补出
  })

  test('importDocs 非法产品线名先抛，一个文件都不拷', async () => {
    const { deps, scheduled, inbox } = await fixture()
    writeFileSync(join(inbox, 'a.txt'), 'x', 'utf8')
    expect(() => svc.importDocs(deps, { paths: [join(inbox, 'a.txt')], productLine: 'a/b', product: '', overwrite: false }))
      .toThrow() // validateSegmentName 挡分隔符
    expect(existsSync(join(deps.dirs.storeDir, 'a'))).toBe(false)
    expect(scheduled()).toBe(0)
  })

  test('importDocs 空产品线被拒，不拷文件', async () => {
    const { deps, scheduled, inbox } = await fixture()
    writeFileSync(join(inbox, 'a.txt'), 'x', 'utf8')
    expect(() => svc.importDocs(deps, { paths: [join(inbox, 'a.txt')], productLine: '', product: 'B', overwrite: false })).toThrow()
    expect(existsSync(join(deps.dirs.storeDir, 'B'))).toBe(false)
    expect(scheduled()).toBe(0)
  })

  test('moveDoc 空目标产品线被拒', async () => {
    const { deps } = await fixture()
    expect(() => svc.moveDoc(deps, { relPath: join('智慧水务', '平台A', '方案.txt'), toProductLine: '', toProduct: 'x' })).toThrow()
  })

  test('importDocs 合法 → 拷入 + schedule 一次；全冲突跳过不 schedule', async () => {
    const { deps, scheduled, inbox } = await fixture()
    writeFileSync(join(inbox, '新.txt'), 'x', 'utf8')
    const r1 = svc.importDocs(deps, { paths: [join(inbox, '新.txt')], productLine: '智慧水务', product: '平台A', overwrite: false })
    expect(r1.imported).toHaveLength(1)
    expect(scheduled()).toBe(1)
    // 再导一次同名、不覆盖 → 全冲突 → 不 schedule
    const r2 = svc.importDocs(deps, { paths: [join(inbox, '新.txt')], productLine: '智慧水务', product: '平台A', overwrite: false })
    expect(r2.conflicted).toHaveLength(1); expect(r2.imported).toHaveLength(0)
    expect(scheduled()).toBe(1) // 未增
  })

  test('moveDoc 非法目标名先抛', async () => {
    const { deps } = await fixture()
    expect(() => svc.moveDoc(deps, { relPath: join('智慧水务', '平台A', '方案.txt'), toProductLine: 'x', toProduct: 'a\\b' }))
      .toThrow()
  })

  test('createCategory 校验但不 schedule；renameCategory 校验+schedule', async () => {
    const { deps, scheduled } = await fixture()
    svc.createCategory(deps, { productLine: '新线', product: '新品' })
    expect(existsSync(join(deps.dirs.storeDir, '新线', '新品'))).toBe(true)
    expect(scheduled()).toBe(0)
    expect(() => svc.renameCategory(deps, { prefix: '智慧水务', newName: '.隐藏' })).toThrow() // dot 前缀非法
    svc.renameCategory(deps, { prefix: '智慧水务', newName: '智慧供水' })
    expect(scheduled()).toBe(1)
  })

  test('renameCategory/deleteCategory 拒穿越 prefix', async () => {
    const { deps } = await fixture()
    expect(() => svc.renameCategory(deps, { prefix: '../../../etc', newName: '线X' })).toThrow()
    expect(() => svc.deleteCategory(deps, '../../../etc')).toThrow()
  })

  test('retryDoc 只 schedule 不改文件', async () => {
    const { deps, scheduled } = await fixture()
    svc.retryDoc(deps, join('智慧水务', '平台A', '方案.txt'))
    expect(scheduled()).toBe(1)
  })

  test('migrateFromFolder 保结构导入 + schedule', async () => {
    const { deps, scheduled } = await fixture()
    const legacy = join(mkdtempSync(join(tmpdir(), 'legacy-')), 'root')
    mkdirSync(join(legacy, '智慧交通', '信号机'), { recursive: true })
    writeFileSync(join(legacy, '智慧交通', '信号机', '规格.txt'), 'spec', 'utf8')
    const r = svc.migrateFromFolder(deps, legacy)
    expect(r.imported).toBe(1)
    expect(existsSync(join(deps.dirs.storeDir, '智慧交通', '信号机', '规格.txt'))).toBe(true)
    expect(scheduled()).toBe(1)
  })
})
