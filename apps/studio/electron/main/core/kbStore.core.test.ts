import { describe, expect, test } from 'bun:test'
import { join, sep } from 'node:path'
import {
  validateSegmentName, docRelPath, planImport, moveRelPath, docPaths, rewriteMovedIndexFile,
  isSafeRelPath
} from './kbStore.core'
import type { KbIndexFile } from '../../shared/kbIndex'

describe('validateSegmentName', () => {
  test('合法名通过', () => {
    expect(validateSegmentName('智慧水务')).toBeNull()
    expect(validateSegmentName('平台 A-2.0')).toBeNull()
  })
  test('非法名给中文错误', () => {
    expect(validateSegmentName('')).toContain('不能为空')
    expect(validateSegmentName('  ')).toContain('不能为空')
    expect(validateSegmentName('a/b')).toContain('分隔符')
    expect(validateSegmentName('a\\b')).toContain('分隔符')
    expect(validateSegmentName('.隐藏')).toContain('点')      // dotfile 会被 scan/manifest 静默跳过
    expect(validateSegmentName('..')).toContain('点')          // 路径穿越
    expect(validateSegmentName('~$草稿')).toContain('~$')      // scan 跳过 Office 锁文件前缀
    expect(validateSegmentName('a:b')).toContain('Windows 保留字符') // NTFS 上建不出这种文件
    expect(validateSegmentName(' 前导空白')).toContain('空白')  // 首尾空白在 Windows 上是坑
    expect(validateSegmentName('尾随空白 ')).toContain('空白')
  })
})

describe('isSafeRelPath', () => {
  test('正常相对路径放行', () => {
    expect(isSafeRelPath(join('线', '品', '方案.docx'))).toBe(true)
  })
  test('拒空/绝对/.. 穿越（正反斜杠都挡）', () => {
    expect(isSafeRelPath('')).toBe(false)
    expect(isSafeRelPath('/etc/passwd')).toBe(false)
    expect(isSafeRelPath('../../../etc/passwd')).toBe(false)
    expect(isSafeRelPath('线/../../../x')).toBe(false)
    expect(isSafeRelPath('线\\..\\..\\x')).toBe(false)
  })
})

describe('docRelPath / planImport', () => {
  test('两级与一级归属', () => {
    expect(docRelPath('线', '品', 'a.docx')).toBe(join('线', '品', 'a.docx'))
    expect(docRelPath('线', '', 'a.docx')).toBe(join('线', 'a.docx'))
  })
  test('冲突按 existing 集合标记', () => {
    const existing = new Set([join('线', '品', '旧.docx')])
    const plan = planImport(['旧.docx', '新.docx'], '线', '品', existing)
    expect(plan).toEqual([
      { fileName: '旧.docx', relPath: join('线', '品', '旧.docx'), conflict: true },
      { fileName: '新.docx', relPath: join('线', '品', '新.docx'), conflict: false }
    ])
  })
})

describe('moveRelPath / docPaths / rewriteMovedIndexFile', () => {
  test('移动改分类保留文件名，可改名', () => {
    const from = join('线A', '品1', '方案.docx')
    expect(moveRelPath(from, '线B', '')).toBe(join('线B', '方案.docx'))
    expect(moveRelPath(from, '线B', '品2', '新名.docx')).toBe(join('线B', '品2', '新名.docx'))
  })
  test('docPaths 与构建管线的路径派生完全同源', () => {
    const p = docPaths(join('线', '品', '方案.docx'), '/store', '/out')
    expect(p.sourcePath).toBe(join('/store', '线', '品', '方案.docx'))
    expect(p.mirrorPath).toBe(`${join('/out', '线', '品', '方案.docx')}.md`)
    expect(p.assetsDir).toBe(join('/out', 'assets', '线', '品', '方案.docx'))
    expect(p.productLine).toBe('线')
    expect(p.product).toBe('品')
    expect(p.title).toBe('方案')
  })
  test('title 复刻 scan.ts 的大小写怪癖：大写扩展名不剥离', () => {
    // scan.ts 是 ext=extname().toLowerCase() 再 basename(_, ext)：大写扩展名
    // 因不匹配而保留在 title 里。docPaths 必须同源，否则移动后 title 无声漂移。
    expect(docPaths(join('线', 'MyDoc.DOCX'), '/s', '/o').title).toBe('MyDoc.DOCX')
  })
  test('rewriteMovedIndexFile 全字段改写且 assets 前缀替换', () => {
    const oldRel = join('线A', '方案.docx')
    const newRel = join('线B', '品', '方案.docx')
    const f: KbIndexFile = {
      sourcePath: join('/s', oldRel), mirrorPath: `${join('/o', oldRel)}.md`,
      productLine: '线A', product: '', title: '方案', mtimeMs: 1, sha1: 'x',
      assets: [join('/o', 'assets', oldRel, 'img-1.png')], ok: true,
      importedAtMs: 5, sizeBytes: 9
    }
    const r = rewriteMovedIndexFile(f, oldRel, newRel, '/s', '/o')
    expect(r.sourcePath).toBe(join('/s', newRel))
    expect(r.mirrorPath).toBe(`${join('/o', newRel)}.md`)
    expect(r.productLine).toBe('线B')
    expect(r.product).toBe('品')
    expect(r.assets).toEqual([join('/o', 'assets', newRel, 'img-1.png')])
    expect(r.sha1).toBe('x')          // 内容没变
    expect(r.importedAtMs).toBe(5)    // 移动不是重新入库
  })
})
