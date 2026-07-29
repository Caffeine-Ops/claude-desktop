import type { WritingDocSource } from '@desktop-shared/writing'

/**
 * 「当前会话是不是在写作、正文在哪」的判定。**纯函数**：入参是从消息里摘出来的工具调用
 * 摘要，不碰 store、不碰 window——放在 src/chat/lib/ 才进得了 bun test 的覆盖范围
 * （package.json 的 test 脚本只跑 electron/、src/chat/lib、src/chat/composer）。
 *
 * 判定思路照搬 chat.ts 的 usePreviewServer：遍历消息里的 tool-call，从命令文本 / 命令输出 /
 * 工具参数里找路径。**不猜路径**——项目目录名是 <slug>_<日期>，slug 规则在 Python 里
 * （中文保留、其余压下划线），前端复刻一份必然漂移，所以让脚本自己报数。
 */

/** `project_manager.py init` 在 stdout 末行打印的标记。同款手法见 bin/ensure-python.cmd 的 `WRITING_PY=`。 */
export const WRITING_PROJECT_MARKER = 'WRITING_PROJECT='

/** 单文件模式的约定落点目录名（职场快道 / 去AI化的成稿写进 <cwd>/写作/）。 */
export const WRITING_SINGLE_DIR = '写作'

/** 从一条 tool-call 里摘出的判定素材。由调用方（store）从消息树上取，本模块不关心怎么取。 */
export interface WritingToolPart {
  toolName: string
  /** Bash 的命令文本；非 Bash 为空串。 */
  commandText: string
  /** Bash 的命令输出；没有结果时为空串。 */
  resultText: string
  /** Write/Edit 的目标绝对路径；非文件工具为 null。 */
  filePath: string | null
}

// 标记行：取到行尾，两侧 trim。用 [^\r\n]+ 而非 \S+ 是因为路径可能含空格。
const PROJECT_LINE = new RegExp(`${WRITING_PROJECT_MARKER}([^\\r\\n]+)`, 'g')

// 用户手敲 echo 调试时常见形态：`echo "WRITING_PROJECT=/a/proj"`——marker 落在引号内，
// 贪婪匹配到行尾会把收尾的引号也吞进捕获组。真实路径不会以引号结尾，脱一层尾随的单/双
// 引号是安全的；不去脱首尾配对（只脱尾）是因为开引号在 marker 之前，不在捕获范围内。
const TRAILING_QUOTE = /["']$/

/**
 * 只认绝对路径：main 侧的路径守卫会拒相对路径，这里先挡住省一次无谓 IPC。
 * 三种绝对路径形态都要认：POSIX（`/...`）、Windows 盘符（`C:\...`），以及
 * **UNC 网络共享路径**（`\\server\share\...`）——UNC 在 Windows 上同样是合法的绝对路径，
 * 漏判它不会报错，只会让共享盘上的写作目录悄悄判成"不是写作"，会话保持单栏、
 * 功能表现为"偶尔不生效"，这类静默失败最难排查（CI 矩阵含 windows-latest，
 * 是真实构建目标，不是假设性场景）。
 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p)
}

/** 路径是否落在「写作」目录下且是 .md。用分隔符包夹匹配，防止 `我的写作笔记/` 这类误命中。 */
function isSingleDocPath(p: string): boolean {
  if (!p.toLowerCase().endsWith('.md')) return false
  const norm = p.replace(/\\/g, '/')
  return norm.includes(`/${WRITING_SINGLE_DIR}/`)
}

/**
 * 从工具调用参数里摘取文件路径。兼容三种字段名（`file_path`/`filePath`/`path`），
 * 按此优先级逐个尝试，**每个字段独立判断「是不是非空字符串」，不是就换下一个**——
 * 与 `ToolCallCard.tsx` 里模块私有的同名函数同源，但那份用 `??` 链
 * （`obj.file_path ?? obj.filePath ?? obj.path`）：`??` 只在值为 `null`/`undefined`
 * 时才往下退，若 `file_path` 存在但类型不对（比如误传成数字），`??` 会直接拿到这个
 * 错值、并不会继续尝试 `filePath`。这份为了同时兜住「字段缺失」与「字段类型错」两种
 * 脏数据，改成逐字段类型检查——是两份拷贝之间唯一的行为分歧点，其余（三字段优先级、
 * 空串视为无效、非对象入参返回空值）完全一致。改一处要同步另一处，见 `ToolCallCard.tsx`
 * 对应函数上的反向注释（该函数未导出、不进 bun test 覆盖范围，无法在这里被直接复用）。
 *
 * 返回 `string | null`（`ToolCallCard` 那份返回 `string | undefined`）——只是跟
 * `WritingToolPart.filePath: string | null` 的类型对齐，不需要调用方再做一次 `?? null`。
 */
export function pickFilePath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  for (const key of ['file_path', 'filePath', 'path'] as const) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/**
 * 遍历工具调用，判定文档源。**项目模式优先于单文件模式**：主管线会先 init 项目再写文件，
 * 若按出现顺序取最后一个，写第一节时就会被 Write 的路径判定顶掉。两种模式各自取「最后一次」
 * （用户可能在同一会话里开第二个项目 / 写第二篇周报）。都没有则返回 null，会话保持单栏。
 */
export function detectWritingSource(parts: WritingToolPart[]): WritingDocSource | null {
  let projectDir: string | null = null
  let singleFile: string | null = null

  for (const p of parts) {
    if (p.toolName === 'Bash') {
      // 标记可能出现在命令输出里（正常路径：脚本 stdout 真实报数），也可能在命令文本里
      // （用户手敲 echo 调试，字面量不可信）。两处都扫，取最后一次命中；**顺序故意是
      // [commandText, resultText]**——同一个 part 里若两处都命中，后扫的 resultText
      // 覆盖先扫的 commandText，让"脚本报数"赢过"用户手敲"，不是任意选的顺序。
      for (const hay of [p.commandText, p.resultText]) {
        if (!hay) continue
        PROJECT_LINE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = PROJECT_LINE.exec(hay)) !== null) {
          const dir = m[1].trim().replace(TRAILING_QUOTE, '')
          if (dir && isAbsolutePath(dir)) projectDir = dir
        }
      }
      continue
    }
    if (p.filePath && isAbsolutePath(p.filePath) && isSingleDocPath(p.filePath)) {
      singleFile = p.filePath
    }
  }

  if (projectDir) return { kind: 'project', projectDir }
  if (singleFile) return { kind: 'single', filePath: singleFile }
  return null
}
