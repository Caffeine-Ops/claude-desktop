import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { buildKbTree, type KbDocRaw } from './kbAdmin'

function raw(p: { productLine: string; product: string; title: string; ext: string; sizeBytes?: number|null; importedAtMs?: number|null; ok?: boolean; error?: string|null }): KbDocRaw {
  const rel = p.product ? join(p.productLine, p.product, `${p.title}${p.ext}`) : join(p.productLine, `${p.title}${p.ext}`)
  return { relPath: rel, productLine: p.productLine, product: p.product, title: p.title, ext: p.ext,
    sizeBytes: p.sizeBytes ?? null, importedAtMs: p.importedAtMs ?? null, ok: p.ok ?? true, error: p.error ?? null }
}

describe('buildKbTree', () => {
  test('空 → 空树', () => { expect(buildKbTree([])).toEqual({ lines: [] }) })

  test('两级分组 + 产品线根文档 + 排序', () => {
    const tree = buildKbTree([
      raw({ productLine: '智慧水务', product: '平台A', title: '方案', ext: '.docx', sizeBytes: 9, importedAtMs: 5 }),
      raw({ productLine: '智慧水务', product: '平台A', title: '白皮书', ext: '.pdf' }),
      raw({ productLine: '智慧水务', product: '', title: '总纲', ext: '.txt' }),
      raw({ productLine: '智慧交通', product: '信号机', title: '规格', ext: '.docx' })
    ])
    expect(tree.lines.map((l) => l.name)).toEqual(['智慧交通', '智慧水务'])
    const water = tree.lines.find((l) => l.name === '智慧水务')!
    expect(water.rootDocs.map((d) => d.title)).toEqual(['总纲'])
    expect(water.products[0]!.docs.map((d) => d.title)).toEqual(['方案', '白皮书'])
    expect(water.products[0]!.docs.find((d) => d.title === '方案')).toEqual({
      relPath: join('智慧水务', '平台A', '方案.docx'), title: '方案', ext: '.docx',
      sizeBytes: 9, importedAtMs: 5, status: 'indexed', error: null
    })
  })

  test('失败 → status:failed + error', () => {
    const tree = buildKbTree([raw({ productLine: '线', product: '', title: '坏', ext: '.pptx', ok: false, error: 'markitdown 失败' })])
    const d = tree.lines[0]!.rootDocs[0]!
    expect(d.status).toBe('failed'); expect(d.error).toBe('markitdown 失败')
    expect(d.sizeBytes).toBeNull(); expect(d.importedAtMs).toBeNull()
  })
})
