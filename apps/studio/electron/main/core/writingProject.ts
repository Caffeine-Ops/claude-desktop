import {
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  parseImageStyle,
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
  | {
      ok: true
      genre: WritingGenre
      outlineTotal: number | null
      /** 契约锁定的配图画风（spec_lock.md「## 配图」段的 image_style 字段），见
       *  parseImageStyle 顶注——三种正常态（无 spec_lock / 无该段 / 该字段留空）都回 null。
       *  顺路跟 genre/outlineTotal 一起算出来，不为它新开一条 IPC 往返（见 WRITING_SCAN
       *  通道注释）。 */
      imageStyle: string | null
      files: WritingFileMeta[]
    }
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

/**
 * name 是否允许被读/写。格式白名单（isSafeSectionName）之外，**single 模式还多一条约束：
 * name 必须等于文档自身的文件名**。single 模式的语义是「这一个文件就是全部」，但
 * sectionDir() 对 single 返回的是整个父目录——光靠格式白名单挡不住调用方传同目录下
 * 另一个 .md 的文件名（哪怕只是笔误），那样就能读/写到这份文档范围之外的文件。
 * project 模式没有这层限制：drafts/ 目录下任何合法命名的 .md 都是这份文档自己的节。
 */
function isAllowedSectionName(source: WritingDocSource, abs: string, name: string): boolean {
  if (!isSafeSectionName(name)) return false
  return source.kind === 'single' ? name === basename(abs) : true
}

/**
 * 原子写入：先在同目录写临时文件，成功后 rename 到目标路径。**为什么不能直接
 * writeFileSync(target, data)**——它默认 flag 是 `'w'`，即先截断目标文件再写内容；
 * 写到一半若失败（磁盘满/权限被中途收回/进程被杀），目标文件已经被截断但新内容
 * 没写完，原内容和新内容一起丢失，磁盘上留下一份损坏的正文。这条写路径承载的是
 * 用户和 AI 创作的核心正文，截断即不可逆数据丢失，不能承受。
 *
 * 同目录内的 rename 在 POSIX 上是原子操作（不存在「文件已存在但内容是一半」的
 * 中间态）——**临时文件必须落在与目标同一目录**，落到系统 tmp 目录会因跨设备/
 * 跨文件系统导致 rename 退化成「拷贝+删除」，原子性随之丢失。临时文件名带
 * pid + 随机串，避免同一进程内并发写同名节时互相踩踏；写入或 rename 失败时
 * 尽力清理掉临时文件，不在 drafts/ 目录留下垃圾。
 */
function writeFileAtomic(targetPath: string, data: string): void {
  const tmpPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  )
  try {
    writeFileSync(tmpPath, data, 'utf-8')
    renameSync(tmpPath, targetPath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 临时文件本就没建成，或 rename 失败前就已消失——两种情况都无需再清理。
    }
    throw err
  }
}

export function scanWritingDoc(source: WritingDocSource): WritingScanResult {
  const abs = sourceAbsPath(source)
  if (!abs) return { ok: false, error: 'Invalid path (expected absolute).' }

  if (source.kind === 'single') {
    // { bigint: true } 把 Stats 上所有数值字段（含 mtimeMs/size）都变成 BigInt——
    // 一次 stat 调用同时拿到毫秒精度（转回 number，兼容既有消费者）和纳秒精度
    // （mtimeNs 转 string，供轮询签名比对用，见 WritingFileMeta.mtimeNs 顶注）。
    let st: BigIntStats
    try {
      st = statSync(abs, { bigint: true })
    } catch {
      return { ok: false, dirMissing: true, error: 'Document not found.' }
    }
    if (!st.isFile()) return { ok: false, dirMissing: true, error: 'Not a file.' }
    return {
      ok: true,
      // 单文件模式没有契约可读，恒走默认档——职场快道 / 去AI化本来就不建 spec_lock。
      genre: 'workplace',
      outlineTotal: null,
      // 同理没有 spec_lock 可读，画风恒为 null（单文件模式也没有 images/ 落点，
      // writingImageGenerate 只支持 project 模式，见 autoFireWritingGenImages 守卫①）。
      imageStyle: null,
      files: [
        {
          name: basename(abs),
          mtimeMs: Number(st.mtimeMs),
          size: Number(st.size),
          mtimeNs: st.mtimeNs.toString()
        }
      ]
    }
  }

  try {
    if (!statSync(abs).isDirectory()) {
      return { ok: false, dirMissing: true, error: 'Not a directory.' }
    }
  } catch {
    return { ok: false, dirMissing: true, error: 'Project directory not found.' }
  }

  // 只读一次 spec_lock.md，genre 与 imageStyle 共用同一份文本——避免两次同步 IO。
  const specLockText = readTextOrNull(join(abs, 'spec_lock.md'))
  const genre = parseWritingGenre(specLockText)
  const imageStyle = parseImageStyle(specLockText)
  const outlineTotal = parseOutlineTotal(readTextOrNull(join(abs, 'design_spec.md')))

  // drafts/ 还没建（AI 刚 init 完、还没开写）不是错误，回空列表让 UI 显示「等待 AI 开写」。
  let names: string[]
  try {
    names = readdirSync(sectionDir(source))
  } catch {
    return { ok: true, genre, outlineTotal, imageStyle, files: [] }
  }

  const files: WritingFileMeta[] = []
  for (const name of sortSectionNames(names.filter(isSafeSectionName))) {
    try {
      // 同上：{ bigint: true } 一次拿到毫秒 + 纳秒两种精度，见 single 模式分支的注释。
      const st = statSync(join(sectionDir(source), name), { bigint: true })
      if (st.isFile()) {
        files.push({
          name,
          mtimeMs: Number(st.mtimeMs),
          size: Number(st.size),
          mtimeNs: st.mtimeNs.toString()
        })
      }
    } catch {
      // 扫描与 stat 之间文件消失（AI 正在改名）——跳过，下一轮轮询自会补上。
    }
  }
  return { ok: true, genre, outlineTotal, imageStyle, files }
}

export function readWritingSections(
  source: WritingDocSource,
  names: string[]
): WritingReadResult {
  const abs = sourceAbsPath(source)
  if (!abs) return { ok: false, error: 'Invalid path (expected absolute).' }

  // names 为空 = 读全部。先扫一次拿到当前文件清单，避免调用方还得先 scan 再 read
  // ——scanWritingDoc 本身已经只回这份文档范围内的文件，不需要再过一遍 isAllowedSectionName。
  let wanted: string[]
  if (names.length === 0) {
    const scan = scanWritingDoc(source)
    if (!scan.ok) return { ok: false, error: scan.error }
    wanted = scan.files.map((f) => f.name)
  } else {
    wanted = names.filter((name) => isAllowedSectionName(source, abs, name))
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
  if (!isAllowedSectionName(source, abs, name)) return { ok: false, error: 'Invalid section name.' }
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
    writeFileAtomic(p, markdown)
    return { ok: true, mtimeMs: statSync(p).mtimeMs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
