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

/** 只认绝对路径：main 侧的路径守卫会拒相对路径，这里先挡住省一次无谓 IPC。 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

/** 路径是否落在「写作」目录下且是 .md。用分隔符包夹匹配，防止 `我的写作笔记/` 这类误命中。 */
function isSingleDocPath(p: string): boolean {
  if (!p.toLowerCase().endsWith('.md')) return false
  const norm = p.replace(/\\/g, '/')
  return norm.includes(`/${WRITING_SINGLE_DIR}/`)
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
      // 标记可能出现在命令输出里（正常路径），也可能在命令文本里（用户手敲 echo 调试）。
      // 两处都扫，取最后一次命中。
      for (const hay of [p.commandText, p.resultText]) {
        if (!hay) continue
        PROJECT_LINE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = PROJECT_LINE.exec(hay)) !== null) {
          const dir = m[1].trim()
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
