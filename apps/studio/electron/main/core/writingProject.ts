import {
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

import {
  parseImageCount,
  parseImageStyle,
  parseOutlineTotal,
  parseWritingGenre,
  selectSectionNames,
  sortSectionNames,
  type WritingDocSource,
  type WritingFileMeta,
  type WritingGenre,
  type WritingSection
} from '../../shared/writing'

/**
 * 写作文档的磁盘访问层。三个动作：扫（轮询用）、读（拉正文）、写（带乐观锁）。
 * **同步 fs 是刻意的**：三个操作都在几个小文件上，异步化换来的并发收益抵不过让
 * handler 变成 async 之后的错误路径复杂度（proposalDraftStore 同理）。
 *
 * 【scan 不再是"只回元信息"】这条描述在内容哈希改动（见 WritingFileMeta.contentHash
 * 顶注）之前成立——scanWritingDoc 曾经只 statSync，正文交给 readWritingSections 按需拉。
 * 现在 scanWritingDoc 为了算轮询签名要素，每节都要 readFileSync 整份内容去过 sha1，
 * "元信息 vs 正文分离"这条设计边界已经不纯粹了：scan 仍然不回传 markdown 给调用方
 * （UI 拿不到正文，仍要走 readWritingSections），但它内部确实读了全部文件的字节。
 * 之所以还留着"扫描"这个名字和 IPC 边界，是因为对调用方（轮询 effect）而言接口语义
 * 没变——只是内部实现代价从"只 stat"变成了"stat + 读 + 哈希"，量级仍然很小（见
 * contentHash 字段顶注的实测数字与已知限制）。这条注释此前没有跟着代码改动同步更新，
 * 一度写着与实现不符的描述——教训是"只回元信息"这类断言一旦承载了某个具体实现细节，
 * 改实现时必须回来检查它是否还成立。
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
      /** 契约锁定的配图张数上限（spec_lock.md「## 配图」段的 image_count 字段）——
       *  spec_lock_reference.md 原话「生图是要花钱的，这是第一道闸（第二道在桌面端的
       *  自动触发上限）」。null（无 spec_lock / 无该段 / 字段缺失或非法）时由调用方退回
       *  桌面端自己的默认上限，不是"不限量"。 */
      imageCount: number | null
      files: WritingFileMeta[]
      /** `drafts/` 里判为「不是节」而没计入正文的 .md 文件名（判据见 selectSectionNames 顶注）。
       *  **不是错误信号**，是给 UI 明示用的：命名判据必然有误伤面，静默吞掉一节正文比重播
       *  一节更难排查，所以宁可在纸面上摆一行「这些文件没算进正文」。single 模式恒为空数组。 */
      excluded: string[]
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
 * 内容的 sha1 十六进制摘要，供轮询签名比对用（见 WritingFileMeta.contentHash 顶注：
 * 换掉了原先「纳秒精度 mtime 足够堵死等长改写撞车」的论断，那条论断在 Windows 上不成立）。
 * **用 `node:crypto`，不是 `Bun.hash`**：这段代码跑在 Electron 打包的 main 进程里，是
 * Electron 自带的 Node 运行时在执行，不是 bun——`Bun.hash` 在这里根本不存在。sha1 不是
 * 安全用途（不防碰撞攻击），只是「内容变没变」的判据，选它只因为 node:crypto 自带、
 * 不必新增依赖。
 *
 * **不吞异常**：读不到文件本就该让调用方按它们各自既有的降级路径处理——project 模式的
 * 逐节循环整体包在一个 try/catch 里（见调用点），文件在 scan 途中消失（AI 正在改名/删除）
 * 时整节跳过、下一轮轮询自会补上；single 模式读不到就是文档本身不可用，回 dirMissing。
 * 两条路径的降级行为在这次改动前就已经是这样（针对 statSync 失败），现在只是把
 * readFileSync 也纳入同一个 try 块，没有新引入行为分支。
 */
function contentHashOf(p: string): string {
  return createHash('sha1').update(readFileSync(p)).digest('hex')
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
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      return { ok: false, dirMissing: true, error: 'Document not found.' }
    }
    if (!st.isFile()) return { ok: false, dirMissing: true, error: 'Not a file.' }
    // 读内容算哈希单独一个 try、不并进上面的 stat：这一步失败（文件存在、但被杀软/其他
    // 进程短暂锁住、或权限被中途收回）跟"文件本就不存在"是两种不同的失败，不该共用同一个
    // dirMissing:true——UI 用 dirMissing 挑 'missing' 空态还是 'error' 提示（见
    // useWritingPoll），'missing' 意味着"这份文档没了，别再等它"，而这里恰恰相反：文档
    // 还在，只是这一轮碰巧读不到，多半 2 秒后自愈。回 'missing' 会让用户以为文档丢了，
    // 比一条不那么起眼的 error 提示更容易引起不必要的恐慌/误操作（比如去手动新建同名文件）。
    let hash: string
    try {
      hash = contentHashOf(abs)
    } catch (err) {
      return {
        ok: false,
        error: `Failed to read document content: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    return {
      ok: true,
      // 单文件模式没有契约可读，恒走默认档——职场快道 / 去AI化本来就不建 spec_lock。
      genre: 'workplace',
      outlineTotal: null,
      // 同理没有 spec_lock 可读，画风与张数上限恒为 null（单文件模式也没有 images/
      // 落点，writingImageGenerate 只支持 project 模式，见 autoFireWritingGenImages 守卫①）。
      imageStyle: null,
      imageCount: null,
      files: [
        {
          name: basename(abs),
          mtimeMs: st.mtimeMs,
          size: st.size,
          contentHash: hash
        }
      ],
      // single 模式只认文档自己那一个文件（isAllowedSectionName 已把同目录其他 .md 挡在外面），
      // 谈不上「谁被排除」——恒空数组，不是 undefined，省得下游到处判空。
      excluded: []
    }
  }

  try {
    if (!statSync(abs).isDirectory()) {
      return { ok: false, dirMissing: true, error: 'Not a directory.' }
    }
  } catch {
    return { ok: false, dirMissing: true, error: 'Project directory not found.' }
  }

  // 只读一次 spec_lock.md，genre / imageStyle / imageCount 共用同一份文本——避免多次同步 IO。
  const specLockText = readTextOrNull(join(abs, 'spec_lock.md'))
  const genre = parseWritingGenre(specLockText)
  const imageStyle = parseImageStyle(specLockText)
  const imageCount = parseImageCount(specLockText)
  const outlineTotal = parseOutlineTotal(readTextOrNull(join(abs, 'design_spec.md')))

  // drafts/ 还没建（AI 刚 init 完、还没开写）不是错误，回空列表让 UI 显示「等待 AI 开写」。
  let names: string[]
  try {
    names = readdirSync(sectionDir(source))
  } catch {
    return { ok: true, genre, outlineTotal, imageStyle, imageCount, files: [], excluded: [] }
  }

  // 先过格式白名单（挡掉 .DS_Store / notes.txt 这类根本不是 .md 的），再过「是不是这条主线上的
  // 节」——两道闸分开：前者是安全/格式问题（不该出现在 excluded 里让用户困惑），后者是语义取舍，
  // 只有后者要回给 UI 明示。判据与事故背景见 selectSectionNames 顶注。
  const { sections: sectionNames, excluded } = selectSectionNames(names.filter(isSafeSectionName))

  const files: WritingFileMeta[] = []
  for (const name of sectionNames) {
    try {
      const p = join(sectionDir(source), name)
      const st = statSync(p)
      if (st.isFile()) {
        // stat 与读内容算哈希包在同一个 try 里：读不到（AI 正好在这一刻改名/重写这个文件）
        // 与 stat 失败同等对待——跳过这一节，下一轮轮询（2s 后）自会补上，不让它拖垮整批。
        files.push({
          name,
          mtimeMs: st.mtimeMs,
          size: st.size,
          contentHash: contentHashOf(p)
        })
      }
    } catch {
      // 扫描与 stat/读内容之间文件消失或变更（AI 正在改名/重写）——跳过，下一轮轮询自会补上。
    }
  }
  return { ok: true, genre, outlineTotal, imageStyle, imageCount, files, excluded }
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
