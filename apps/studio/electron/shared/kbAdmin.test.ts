import { describe, expect, test } from 'bun:test'
import { buildKbTree, type KbDocRaw, type KbFolderNode } from './kbAdmin'

/** 从 relPath 造 KbDocRaw；productLine/product 取头两段（与 scanKb 一致，仅供索引字段，不影响 n 级树）。 */
function raw(relPath: string, extra?: Partial<KbDocRaw>): KbDocRaw {
  const segs = relPath.split('/')
  const file = segs[segs.length - 1]!
  return {
    relPath, productLine: segs[0] ?? '', product: segs.length > 2 ? segs[1]! : '',
    title: file.replace(/\.[^.]+$/, ''), ext: '.' + (file.split('.').pop() ?? ''),
    sizeBytes: null, importedAtMs: null, ok: true, error: null, ...extra
  }
}
function find(roots: readonly KbFolderNode[], path: string): KbFolderNode | undefined {
  for (const r of roots) { if (r.path === path) return r; const f = find(r.folders, path); if (f) return f }
  return undefined
}

describe('buildKbTree n级', () => {
  test('空 → 空树', () => { expect(buildKbTree([])).toEqual({ roots: [] }) })

  test('三级嵌套：产品线/产品/第三级/文件', () => {
    const t = buildKbTree([raw('线A/品1/功能清单/a.docx')])
    expect(t.roots.map((r) => r.name)).toEqual(['线A'])
    const third = find(t.roots, '线A/品1/功能清单')
    expect(third).toBeDefined()
    expect(third!.docs.map((d) => d.title)).toEqual(['a'])
  })

  test('同名不同第三级都保留（根治拍平覆盖丢失）', () => {
    const t = buildKbTree([raw('线A/品1/简版/方案.docx'), raw('线A/品1/详版/方案.docx')])
    const p1 = find(t.roots, '线A/品1')!
    expect(p1.folders.map((f) => f.name)).toEqual(['简版', '详版'])
    expect(find(t.roots, '线A/品1/简版')!.docs.length).toBe(1)
    expect(find(t.roots, '线A/品1/详版')!.docs.length).toBe(1)
  })

  test('文件直接挂在产品线下（两段）', () => {
    const t = buildKbTree([raw('线A/loose.docx')])
    expect(find(t.roots, '线A')!.docs.map((d) => d.title)).toEqual(['loose'])
  })

  test('文件夹可同时有子文件夹和文件', () => {
    const t = buildKbTree([raw('线A/品1/x.docx'), raw('线A/品1/子/y.docx')])
    const p1 = find(t.roots, '线A/品1')!
    expect(p1.docs.map((d) => d.title)).toEqual(['x'])
    expect(p1.folders.map((f) => f.name)).toEqual(['子'])
  })

  test('排序：文件夹按名、文件按标题', () => {
    const t = buildKbTree([raw('B线/f.docx'), raw('A线/z.docx'), raw('A线/a.docx')])
    expect(t.roots.map((r) => r.name)).toEqual(['A线', 'B线'])
    expect(find(t.roots, 'A线')!.docs.map((d) => d.title)).toEqual(['a', 'z'])
  })

  test('反斜杠分隔（Windows relPath）也能切', () => {
    const t = buildKbTree([{ ...raw('x/y/z/a.docx'), relPath: '线A\\品1\\三\\a.docx' }])
    expect(find(t.roots, '线A/品1/三')).toBeDefined()
  })

  test('失败件 → status:failed + error + 元数据透传', () => {
    const t = buildKbTree([raw('线/坏.pptx', { ok: false, error: 'markitdown 失败', sizeBytes: 9, importedAtMs: 5 })])
    const d = find(t.roots, '线')!.docs[0]!
    expect(d.status).toBe('failed')
    expect(d.error).toBe('markitdown 失败')
    expect(d.sizeBytes).toBe(9)
    expect(d.importedAtMs).toBe(5)
  })
})
