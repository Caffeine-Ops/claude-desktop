import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanWritingDoc, readWritingSections, writeWritingSection } from './writingProject'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'writing-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeProject(opts: { specLock?: string; designSpec?: string; drafts?: Record<string, string> }): string {
  const dir = join(root, 'proj_2026-07-29')
  mkdirSync(join(dir, 'drafts'), { recursive: true })
  if (opts.specLock !== undefined) writeFileSync(join(dir, 'spec_lock.md'), opts.specLock)
  if (opts.designSpec !== undefined) writeFileSync(join(dir, 'design_spec.md'), opts.designSpec)
  for (const [name, body] of Object.entries(opts.drafts ?? {})) {
    writeFileSync(join(dir, 'drafts', name), body)
  }
  return dir
}

describe('scanWritingDoc · project 模式', () => {
  it('回体裁、大纲总数与节文件元信息（按自然序）', () => {
    const dir = makeProject({
      specLock: '## 体裁\n- genre: short-story\n',
      designSpec: '## 大纲\n\n### 第1节 开场\n\n### 第2节 收束\n',
      drafts: { '10-j.md': 'j', '2-b.md': 'b', '1-a.md': 'a' }
    })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.genre).toBe('short-story')
    expect(r.outlineTotal).toBe(2)
    expect(r.files.map((f) => f.name)).toEqual(['1-a.md', '2-b.md', '10-j.md'])
    expect(r.files[0].size).toBeGreaterThan(0)
  })

  it('没有 spec_lock 时退回 workplace 默认档', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.genre).toBe('workplace')
  })

  it('drafts 目录还没建（AI 刚 init 完）时回空列表，不是错误', () => {
    const dir = join(root, 'empty_proj')
    mkdirSync(dir)
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.files).toEqual([])
  })

  it('只认 .md，忽略其他文件（编辑器临时文件不该进正文）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a', '.DS_Store': 'x', 'notes.txt': 'y' } })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.files.map((f) => f.name)).toEqual(['1-a.md'])
  })

  it('项目目录不存在时回 dirMissing，供 UI 退回空态', () => {
    const r = scanWritingDoc({ kind: 'project', projectDir: join(root, 'nope') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.dirMissing).toBe(true)
  })

  it('相对路径一律拒绝（IPC 边界的路径守卫）', () => {
    const r = scanWritingDoc({ kind: 'project', projectDir: 'relative/path' })
    expect(r.ok).toBe(false)
  })
})

describe('scanWritingDoc · single 模式', () => {
  it('单文件当作只有一节的文档，体裁恒为默认档', () => {
    const f = join(root, '周报.md')
    writeFileSync(f, '# 本周周报\n\n做了三件事')
    const r = scanWritingDoc({ kind: 'single', filePath: f })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.genre).toBe('workplace')
    expect(r.outlineTotal).toBeNull()
    expect(r.files.map((f2) => f2.name)).toEqual(['周报.md'])
  })

  it('文件不存在时回 dirMissing', () => {
    const r = scanWritingDoc({ kind: 'single', filePath: join(root, 'nope.md') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.dirMissing).toBe(true)
  })
})

describe('readWritingSections', () => {
  it('按给定名字读正文，返回顺序与 names 无关、恒为自然序', () => {
    const dir = makeProject({ drafts: { '1-a.md': '正文一', '2-b.md': '正文二' } })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, ['2-b.md', '1-a.md'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sections.map((s) => s.name)).toEqual(['1-a.md', '2-b.md'])
    expect(r.sections[0].markdown).toBe('正文一')
    expect(r.sections[0].mtimeMs).toBeGreaterThan(0)
  })

  it('names 为空数组 = 读全部', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a', '2-b.md': 'b' } })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, [])
    expect(r.ok && r.sections.length).toBe(2)
  })

  it('跳过读不到的文件而不是整批失败（AI 可能正好在改名）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, ['1-a.md', '9-gone.md'])
    expect(r.ok && r.sections.map((s) => s.name)).toEqual(['1-a.md'])
  })

  it('拒绝带路径分隔符的名字（防目录穿越）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, ['../../etc/passwd'])
    expect(r.ok && r.sections).toEqual([])
  })
})

describe('writeWritingSection · 乐观锁', () => {
  it('mtime 相符时写入成功并回新 mtime', () => {
    const dir = makeProject({ drafts: { '1-a.md': '旧正文' } })
    const before = statSync(join(dir, 'drafts', '1-a.md')).mtimeMs
    const r = writeWritingSection({ kind: 'project', projectDir: dir }, '1-a.md', '新正文', before)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mtimeMs).toBeGreaterThanOrEqual(before)
  })

  it('mtime 不符时拒写，回冲突与盘上最新内容', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'AI 刚改过的内容' } })
    const r = writeWritingSection({ kind: 'project', projectDir: dir }, '1-a.md', '我的改动', 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflict).toBe(true)
    expect(r.current?.markdown).toBe('AI 刚改过的内容')
  })

  it('冲突时磁盘内容原封不动', () => {
    const dir = makeProject({ drafts: { '1-a.md': '原内容' } })
    writeWritingSection({ kind: 'project', projectDir: dir }, '1-a.md', '我的改动', 1)
    const r = readWritingSections({ kind: 'project', projectDir: dir }, ['1-a.md'])
    expect(r.ok && r.sections[0].markdown).toBe('原内容')
  })

  it('拒绝带路径分隔符的名字（防目录穿越）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = writeWritingSection({ kind: 'project', projectDir: dir }, '../evil.md', 'x', 0)
    expect(r.ok).toBe(false)
  })
})
