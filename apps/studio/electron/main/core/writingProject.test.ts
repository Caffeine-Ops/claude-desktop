import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync, readFileSync } from 'node:fs'
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

  it('顺路读出 spec_lock「## 配图」段的 image_style，供出图触发器拼提示词', () => {
    const dir = makeProject({
      specLock: '## 配图\n- image_plan: inline\n- image_style: 极简线条插画，低饱和暖色\n',
      drafts: { '1-a.md': 'a' }
    })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.imageStyle).toBe('极简线条插画，低饱和暖色')
  })

  it('没有 spec_lock 时 imageStyle 也回 null（不只 genre 一个默认档）', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.imageStyle).toBeNull()
  })

  it('image_plan: none 时配图段其余字段留空，imageStyle 回 null——不是错误', () => {
    const dir = makeProject({
      specLock: '## 配图\n- image_plan: none\n',
      drafts: { '1-a.md': 'a' }
    })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.imageStyle).toBeNull()
  })

  it('顺路读出 spec_lock「## 配图」段的 image_count 张数上限（契约的第一道花钱闸）', () => {
    const dir = makeProject({
      specLock: '## 配图\n- image_plan: inline\n- image_count: 3\n- image_style: 水墨风\n',
      drafts: { '1-a.md': 'a' }
    })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.imageCount).toBe(3)
  })

  it('没有 spec_lock / 字段缺失时 imageCount 回 null，由桌面端退回默认上限', () => {
    const dir = makeProject({ drafts: { '1-a.md': 'a' } })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.imageCount).toBeNull()
  })

  it('m-1：image_plan: none 时 imageCount 顺路回 0（契约"这篇不配图"要能闸住自动出图）', () => {
    const dir = makeProject({
      specLock: '## 配图\n- image_plan: none\n',
      drafts: { '1-a.md': 'a' }
    })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok && r.imageCount).toBe(0)
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

  it('序号节旁边混进的合并全文不算节，名字回进 excluded 供 UI 提示', () => {
    // 真实事故复现：质检脚本只吃单个正文文件，写手把四节 cat 成 drafts/full.md 留在原地，
    // 于是它被当成第 5 节拼进正文，预览与导出（同一份 joinWritingSections 结果）各重播一遍全文。
    const dir = makeProject({
      drafts: { '01-立靶.md': '一', '02-破.md': '二', 'full.md': '一\n\n二' }
    })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files.map((f) => f.name)).toEqual(['01-立靶.md', '02-破.md'])
    expect(r.excluded).toEqual(['full.md'])
  })

  it('读全部时同样排除合并全文（预览与导出的正文源就是这一条）', () => {
    const dir = makeProject({
      drafts: { '01-a.md': '一', '02-b.md': '二', '全文.md': '一\n\n二' }
    })
    const r = readWritingSections({ kind: 'project', projectDir: dir }, [])
    expect(r.ok && r.sections.map((s) => s.name)).toEqual(['01-a.md', '02-b.md'])
  })

  it('一个序号节都没有时全收（单文件形态：rewrite.md / 正文.md）', () => {
    const dir = makeProject({ drafts: { '正文.md': '全篇' } })
    const r = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files.map((f) => f.name)).toEqual(['正文.md'])
    expect(r.excluded).toEqual([])
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
    // 单文件模式没有 spec_lock 可读，也没有 images/ 落点——恒 null。
    expect(r.imageStyle).toBeNull()
    expect(r.imageCount).toBeNull()
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

describe('writeWritingSection · 原子写入', () => {
  it('写入后目录里不残留临时文件', () => {
    const dir = makeProject({ drafts: { '1-a.md': '旧' } })
    const before = statSync(join(dir, 'drafts', '1-a.md')).mtimeMs
    writeWritingSection({ kind: 'project', projectDir: dir }, '1-a.md', '新', before)
    const left = readdirSync(join(dir, 'drafts'))
    expect(left).toEqual(['1-a.md'])
  })

  it('冲突拒写时也不残留临时文件', () => {
    const dir = makeProject({ drafts: { '1-a.md': '旧' } })
    writeWritingSection({ kind: 'project', projectDir: dir }, '1-a.md', '新', 1)
    expect(readdirSync(join(dir, 'drafts'))).toEqual(['1-a.md'])
  })
})

describe('scanWritingDoc · contentHash（轮询签名专用，Windows 上取代了 mtimeNs）', () => {
  // 【为什么原先这里测的是 mtimeNs】旧实现拿 statSync(..., { bigint: true }).mtimeNs 当轮询
  // 签名要素，论断是「纳秒精度下『等长改写 + 同一纳秒写入』不可能同时成立」。CI 的 Windows
  // 腿上这条论断被真实写入证伪：两次连续写入拿到完全相同的 mtimeNs（Windows 的文件时间源
  // 粒度远粗于纳秒）。签名改用内容哈希（sha1，见 WritingFileMeta.contentHash 顶注）后，
  // 「变没变」这件事不再依赖任何时间戳的分辨率，下面这条测试要能在 Windows 上一样通过。

  it('project 模式每个文件都带非空的 contentHash，且同内容两次扫描结果一致', () => {
    const dir = makeProject({ drafts: { '1-a.md': '正文内容' } })
    const r1 = scanWritingDoc({ kind: 'project', projectDir: dir })
    const r2 = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r1.files[0].contentHash.length).toBeGreaterThan(0)
    // 内容没变，哈希必须稳定——不是每次读都重新算出不一样的东西（比如混进了随机数/时间戳）。
    expect(r1.files[0].contentHash).toBe(r2.files[0].contentHash)
  })

  it('single 模式的文件同样带 contentHash', () => {
    const f = join(root, '周报.md')
    writeFileSync(f, '正文')
    const r = scanWritingDoc({ kind: 'single', filePath: f })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files[0].contentHash.length).toBeGreaterThan(0)
  })

  it('真正该保证的契约：等长改写后签名必须变化，不依赖任何时间戳精度', () => {
    // 这条测试取代了原先那条测 mtimeNs 的用例——它测的是错误的东西（纳秒分辨率，一个
    // 平台细节），真正该保证的是「等长改写 → 轮询签名（scan 结果拼出来的那三元组）一定变」。
    // 新正文与旧正文字节长度相同（各自 3 个汉字），专门复现「等长改写」这个此前在 Windows
    // 上漏刷的场景；断言只比较 contentHash 本身，不牵涉 mtime，所以这条测试在时间戳分辨率
    // 粗糙的文件系统上同样成立。
    const dir = makeProject({ drafts: { '1-a.md': '旧旧旧' } })
    const before = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    writeFileSync(join(dir, 'drafts', '1-a.md'), '新新新')
    const after = scanWritingDoc({ kind: 'project', projectDir: dir })
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.files[0].size).toBe(before.files[0].size) // 佐证这确实是「等长」改写
    expect(after.files[0].contentHash).not.toBe(before.files[0].contentHash)
  })

  it('single 模式等长改写后 contentHash 同样变化', () => {
    const f = join(root, '周报.md')
    writeFileSync(f, '旧内容')
    const before = scanWritingDoc({ kind: 'single', filePath: f })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    writeFileSync(f, '新内容')
    const after = scanWritingDoc({ kind: 'single', filePath: f })
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.files[0].size).toBe(before.files[0].size)
    expect(after.files[0].contentHash).not.toBe(before.files[0].contentHash)
  })
})

describe('single 模式的 name 约束', () => {
  it('读：只允许读这份文档自己，同目录别的 md 一律拒绝', () => {
    const mine = join(root, '周报.md')
    const other = join(root, '别人的.md')
    writeFileSync(mine, '我的周报')
    writeFileSync(other, '不该被读到')
    const r = readWritingSections({ kind: 'single', filePath: mine }, ['别人的.md'])
    expect(r.ok && r.sections).toEqual([])
  })

  it('写：同目录别的 md 一律拒绝，且那个文件内容不变', () => {
    const mine = join(root, '周报.md')
    const other = join(root, '别人的.md')
    writeFileSync(mine, '我的周报')
    writeFileSync(other, '原样')
    const st = statSync(other).mtimeMs
    const r = writeWritingSection({ kind: 'single', filePath: mine }, '别人的.md', '被篡改', st)
    expect(r.ok).toBe(false)
    expect(readFileSync(other, 'utf-8')).toBe('原样')
  })

  it('读写自己这份文档正常放行', () => {
    const mine = join(root, '周报.md')
    writeFileSync(mine, '我的周报')
    const r = readWritingSections({ kind: 'single', filePath: mine }, ['周报.md'])
    expect(r.ok && r.sections[0].markdown).toBe('我的周报')
  })
})
