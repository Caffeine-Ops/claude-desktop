import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildKbIndex } from './kbBuild/build'
import * as svc from './kbAdminService'
import type { KbIndex } from '../../shared/kbIndex'

/**
 * 覆盖「同步前预览 + 确认」这条防线（用户报的 bug：本地改名后同步把文件删了）。
 * previewSyncFromLocal 只算不写盘，syncFromLocal 与它同源算计划 → 「确认所见=实际所删」。
 */
async function setup(fileName: string): Promise<{
  dirs: { storeDir: string; outDir: string }; src: string; deps: svc.KbAdminDeps; scheduled: () => number
}> {
  const base = mkdtempSync(join(tmpdir(), 'kbsync-'))
  const dirs = { storeDir: join(base, 'store'), outDir: join(base, 'out') }
  const src = join(base, 'src')
  mkdirSync(join(src, '线', '品'), { recursive: true })
  writeFileSync(join(src, '线', '品', fileName), '正文', 'utf8')
  let n = 0
  const deps: svc.KbAdminDeps = {
    dirs,
    index: () => (existsSync(join(dirs.outDir, 'index.json'))
      ? (JSON.parse(readFileSync(join(dirs.outDir, 'index.json'), 'utf8')) as KbIndex) : null),
    schedule: () => { n++ }
  }
  svc.migrateFromFolder(deps, src)
  await buildKbIndex({ kbRoot: dirs.storeDir, outDir: dirs.outDir, now: 1000, vectors: false })
  return { dirs, src, deps, scheduled: () => n }
}

describe('syncFromLocal 预览 + 确认', () => {
  test('合法改名：preview 报 删1，apply 后库里是新名无旧名', async () => {
    const { dirs, src, deps } = await setup('方案.txt')
    renameSync(join(src, '线', '品', '方案.txt'), join(src, '线', '品', '方案V2.txt'))
    const p = await svc.previewSyncFromLocal(deps, src)
    expect(p.added).toBe(1)
    expect(p.deleted).toBe(1)
    expect(p.toDelete).toEqual([join('线', '品', '方案.txt')])
    // 预览未写盘：旧名还在、新名还没进库
    expect(existsSync(join(dirs.storeDir, '线', '品', '方案.txt'))).toBe(true)
    expect(existsSync(join(dirs.storeDir, '线', '品', '方案V2.txt'))).toBe(false)
    // apply
    const r = await svc.syncFromLocal(deps, src)
    expect(r).toEqual({ added: 1, updated: 0, deleted: 1 })
    expect(existsSync(join(dirs.storeDir, '线', '品', '方案.txt'))).toBe(false)
    expect(existsSync(join(dirs.storeDir, '线', '品', '方案V2.txt'))).toBe(true)
  })

  test('改成不受支持扩展名(.docx→.doc)：preview 报 删1增0 并列出旧名（用户可据此取消）', async () => {
    const { dirs, src, deps } = await setup('方案.docx')
    renameSync(join(src, '线', '品', '方案.docx'), join(src, '线', '品', '方案.doc'))
    const p = await svc.previewSyncFromLocal(deps, src)
    expect(p.added).toBe(0)
    expect(p.updated).toBe(0)
    expect(p.deleted).toBe(1)
    expect(p.toDelete).toEqual([join('线', '品', '方案.docx')])
    // 若用户看到后取消（不调 apply），库副本原封不动
    expect(existsSync(join(dirs.storeDir, '线', '品', '方案.docx'))).toBe(true)
  })

  test('无改动：preview 全 0、apply 不 schedule', async () => {
    const { src, deps, scheduled } = await setup('方案.txt')
    const p = await svc.previewSyncFromLocal(deps, src)
    expect(p).toEqual({ added: 0, updated: 0, deleted: 0, toDelete: [] })
    const before = scheduled()
    await svc.syncFromLocal(deps, src)
    expect(scheduled()).toBe(before) // 无增删改不触发构建
  })
})
