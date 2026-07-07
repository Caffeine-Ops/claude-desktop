import { describe, expect, test } from 'bun:test'
import { planLocalSync, type LocalSyncSourceFile } from './kbLocalSync.core'

/** 造一个源文件项（relPath 即 productLine/product/file 拼出，测试里手写）。 */
function src(relPath: string, sha1: string): LocalSyncSourceFile {
  const parts = relPath.split('/')
  return { relPath, sha1, productLine: parts[0] ?? '', product: parts.length > 2 ? parts[1]! : '', sourcePath: '/src/' + relPath }
}

describe('planLocalSync', () => {
  test('空库 → 源全部 toCopy、无删除', () => {
    const source = [src('线A/品1/a.pdf', 'h1'), src('线A/品1/b.pdf', 'h2')]
    const plan = planLocalSync(source, new Set(), new Map())
    expect(plan.toCopy.map((c) => c.relPath)).toEqual(['线A/品1/a.pdf', '线A/品1/b.pdf'])
    expect(plan.toDelete).toEqual([])
  })

  test('全部未变（sha1 一致）→ 空计划', () => {
    const source = [src('线A/品1/a.pdf', 'h1'), src('线A/品1/b.pdf', 'h2')]
    const store = new Set(['线A/品1/a.pdf', '线A/品1/b.pdf'])
    const idx = new Map([['线A/品1/a.pdf', 'h1'], ['线A/品1/b.pdf', 'h2']])
    const plan = planLocalSync(source, store, idx)
    expect(plan.toCopy).toEqual([])
    expect(plan.toDelete).toEqual([])
  })

  test('新增文件 → 只 toCopy 新的', () => {
    const source = [src('线A/品1/a.pdf', 'h1'), src('线A/品1/c.pdf', 'h3')]
    const store = new Set(['线A/品1/a.pdf'])
    const idx = new Map([['线A/品1/a.pdf', 'h1']])
    const plan = planLocalSync(source, store, idx)
    expect(plan.toCopy.map((c) => c.relPath)).toEqual(['线A/品1/c.pdf'])
    expect(plan.toDelete).toEqual([])
  })

  test('本地删了文件 → toDelete 库里多出的', () => {
    const source = [src('线A/品1/a.pdf', 'h1')]
    const store = new Set(['线A/品1/a.pdf', '线A/品1/b.pdf'])
    const idx = new Map([['线A/品1/a.pdf', 'h1'], ['线A/品1/b.pdf', 'h2']])
    const plan = planLocalSync(source, store, idx)
    expect(plan.toCopy).toEqual([])
    expect(plan.toDelete).toEqual(['线A/品1/b.pdf'])
  })

  test('内容改了（sha1 变）→ 该文件进 toCopy', () => {
    const source = [src('线A/品1/a.pdf', 'NEW')]
    const store = new Set(['线A/品1/a.pdf'])
    const idx = new Map([['线A/品1/a.pdf', 'OLD']])
    const plan = planLocalSync(source, store, idx)
    expect(plan.toCopy.map((c) => c.relPath)).toEqual(['线A/品1/a.pdf'])
    expect(plan.toDelete).toEqual([])
  })

  test('改名 = 删旧 relPath + 拷新 relPath', () => {
    // 本地把 a.pdf 改名成 a2.pdf（内容不变）
    const source = [src('线A/品1/a2.pdf', 'h1')]
    const store = new Set(['线A/品1/a.pdf'])
    const idx = new Map([['线A/品1/a.pdf', 'h1']])
    const plan = planLocalSync(source, store, idx)
    expect(plan.toCopy.map((c) => c.relPath)).toEqual(['线A/品1/a2.pdf'])
    expect(plan.toDelete).toEqual(['线A/品1/a.pdf'])
  })

  test('库有文件但索引查不到 sha1 → 归 toCopy（安全侧，不漏更新）', () => {
    const source = [src('线A/品1/a.pdf', 'h1')]
    const store = new Set(['线A/品1/a.pdf'])
    const idx = new Map<string, string>() // 索引缺失
    const plan = planLocalSync(source, store, idx)
    expect(plan.toCopy.map((c) => c.relPath)).toEqual(['线A/品1/a.pdf'])
    expect(plan.toDelete).toEqual([])
  })
})
