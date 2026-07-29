import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import {
  parseOutlineTotal,
  parseWritingGenre,
  sortSectionNames,
  type WritingDocSource,
  type WritingFileMeta,
  type WritingGenre,
  type WritingSection
} from '../../shared/writing'

/**
 * 写作文档的磁盘访问层。三个动作：扫（轮询用，只回元信息）、读（拉正文）、
 * 写（带乐观锁）。**同步 fs 是刻意的**：三个操作都在几个小文件上，异步化换来的
 * 并发收益抵不过让 handler 变成 async 之后的错误路径复杂度（proposalDraftStore
 * 同理）。
 */

export type WritingScanResult =
  | { ok: true; genre: WritingGenre; outlineTotal: number | null; files: WritingFileMeta[] }
  | { ok: false; dirMissing?: true; error: string }

export type WritingReadResult =
  | { ok: true; sections: WritingSection[] }
  | { ok: false; error: string }

export type WritingWriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; conflict: true; current: { markdown: string; mtimeMs: number } | null }
  | { ok: false; conflict?: false; error: string }

/** 读文本，任何失败（不存在/不是文件/无权限）一律回 null——调用方据此走默认分支。 */
function readTextOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 节文件所在目录。project 模式是 <projectDir>/drafts，single 模式是那个文件的父目录。
 * 统一到一个函数，下游三个动作就不用各自分叉。
 */
function sectionDir(source: WritingDocSource): string {
  return source.kind === 'project' ? join(source.projectDir, 'drafts') : dirname(source.filePath)
}

/**
 * 名字白名单：必须是纯文件名的 .md。**拒绝任何带路径分隔符的名字**——name 来自 IPC，
 * 直接 join 会被 `../../` 穿越出项目目录写到任意位置。
 */
function isSafeSectionName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name === basename(name) &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name.toLowerCase().endsWith('.md')
  )
}

/** IPC 入口的路径守卫：只收绝对路径（相对路径的基准目录在 main 侧毫无意义）。 */
function sourceAbsPath(source: WritingDocSource): string | null {
  const p = source.kind === 'project' ? source.projectDir : source.filePath
  return typeof p === 'string' && p.length > 0 && isAbsolute(p) ? p : null
}

export function scanWritingDoc(source: WritingDocSource): WritingScanResult {
  const abs = sourceAbsPath(source)
  if (!abs) return { ok: false, error: 'Invalid path (expected absolute).' }

  if (source.kind === 'single') {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      return { ok: false, dirMissing: true, error: 'Document not found.' }
    }
    if (!st.isFile()) return { ok: false, dirMissing: true, error: 'Not a file.' }
    return {
      ok: true,
      // 单文件模式没有契约可读，恒走默认档——职场快道 / 去AI化本来就不建 spec_lock。
      genre: 'workplace',
      outlineTotal: null,
      files: [{ name: basename(abs), mtimeMs: st.mtimeMs, size: st.size }]
    }
  }

  try {
    if (!statSync(abs).isDirectory()) {
      return { ok: false, dirMissing: true, error: 'Not a directory.' }
    }
  } catch {
    return { ok: false, dirMissing: true, error: 'Project directory not found.' }
  }

  const genre = parseWritingGenre(readTextOrNull(join(abs, 'spec_lock.md')))
  const outlineTotal = parseOutlineTotal(readTextOrNull(join(abs, 'design_spec.md')))

  // drafts/ 还没建（AI 刚 init 完、还没开写）不是错误，回空列表让 UI 显示「等待 AI 开写」。
  let names: string[]
  try {
    names = readdirSync(sectionDir(source))
  } catch {
    return { ok: true, genre, outlineTotal, files: [] }
  }

  const files: WritingFileMeta[] = []
  for (const name of sortSectionNames(names.filter(isSafeSectionName))) {
    try {
      const st = statSync(join(sectionDir(source), name))
      if (st.isFile()) files.push({ name, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // 扫描与 stat 之间文件消失（AI 正在改名）——跳过，下一轮轮询自会补上。
    }
  }
  return { ok: true, genre, outlineTotal, files }
}

export function readWritingSections(
  source: WritingDocSource,
  names: string[]
): WritingReadResult {
  const abs = sourceAbsPath(source)
  if (!abs) return { ok: false, error: 'Invalid path (expected absolute).' }

  // names 为空 = 读全部。先扫一次拿到当前文件清单，避免调用方还得先 scan 再 read。
  let wanted = names.filter(isSafeSectionName)
  if (names.length === 0) {
    const scan = scanWritingDoc(source)
    if (!scan.ok) return { ok: false, error: scan.error }
    wanted = scan.files.map((f) => f.name)
  }

  const dir = sectionDir(source)
  const sections: WritingSection[] = []
  for (const name of sortSectionNames(wanted)) {
    try {
      const p = join(dir, name)
      const st = statSync(p)
      if (!st.isFile()) continue
      sections.push({ name, markdown: readFileSync(p, 'utf-8'), mtimeMs: st.mtimeMs })
    } catch {
      // 单个文件读不到就跳过，不让整批失败——AI 可能正好在改名或删重建。
    }
  }
  return { ok: true, sections }
}

export function writeWritingSection(
  source: WritingDocSource,
  name: string,
  markdown: string,
  expectedMtimeMs: number
): WritingWriteResult {
  const abs = sourceAbsPath(source)
  if (!abs) return { ok: false, error: 'Invalid path (expected absolute).' }
  if (!isSafeSectionName(name)) return { ok: false, error: 'Invalid section name.' }
  if (typeof markdown !== 'string') return { ok: false, error: 'Invalid markdown.' }

  const p = join(sectionDir(source), name)
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(p)
  } catch {
    return { ok: false, conflict: true, current: null }
  }

  // 乐观锁：读这一节时记下的 mtime 与盘上不符 = 期间被 AI 改过。拒写并回传最新内容，
  // 由 UI 提示用户重来。宁可让用户重做一次，也不静默覆盖 AI 的产出（反之亦然）。
  // 用不等号而非「大于」：文件被删后重建，mtime 理论上可能变小。
  if (st.mtimeMs !== expectedMtimeMs) {
    let current: { markdown: string; mtimeMs: number } | null = null
    try {
      current = { markdown: readFileSync(p, 'utf-8'), mtimeMs: st.mtimeMs }
    } catch {
      current = null
    }
    return { ok: false, conflict: true, current }
  }

  try {
    writeFileSync(p, markdown, 'utf-8')
    return { ok: true, mtimeMs: statSync(p).mtimeMs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
