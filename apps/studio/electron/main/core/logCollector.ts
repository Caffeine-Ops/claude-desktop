/**
 * logCollector
 * ------------
 * 一个进程级的运行时日志汇聚点，给「设置 → 日志分析」面板供数。它把三类
 * 来源的输出收进同一个环形缓冲，并：
 *   1. 仍然原样写回 stdout/stderr（终端 / `bun run dev` 体验不变）；
 *   2. 追加落盘到 `<userData>/logs/runtime-YYYY-MM-DD.log`，供重启后回看；
 *   3. 实时推送给已注册的 settings overlay webContents（流式刷进面板）。
 *
 * 三类来源（`LogSource`）：
 *   - `main`     —— 本进程的 console.*（patchConsole 接管）。
 *   - `daemon`   —— spawn 出来的 daemon 子进程 stdout/stderr（openDesignServices 接管）。
 *   - `renderer` —— 各 tab/overlay 渲染进程的 console-message（tabRegistry 转发）。
 *
 * 为什么是单例模块而不是类：日志源散落在 main、services、tabRegistry 三处，
 * 它们都只想「往一个地方丢一行」，用模块级单例最省心，也契合本仓库其它
 * 全局状态（appSettings 等）的写法。注意 collector 自身**绝不能** console.*，
 * 否则会和 patchConsole 形成回环——内部只用原始 stdout 写错误。
 */

import { app, type WebContents } from 'electron'
import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

import { IPC_CHANNELS, type RuntimeLogEntry, type LogSource } from '../../shared/ipc-channels'

/** 环形缓冲容量。够覆盖一次冷启动 + 一阵子操作，又不至于吃内存。 */
const RING_CAPACITY = 2000

/** 单条日志最大字符数——超长（比如一坨 JSON dump）截断，避免面板卡死。 */
const MAX_LINE_LEN = 8000

const ring: RuntimeLogEntry[] = []
let seq = 0

/**
 * 已订阅实时推送的 webContents 集合。settings overlay 打开时注册、关闭时注销。
 * 用 Set 是因为允许将来多个面板同时看（虽然当前只有一个 overlay）。
 */
const subscribers = new Set<WebContents>()

/** 落盘流。首次 push 时惰性打开（那时 app 已 ready，userData 可用）。 */
let fileStream: WriteStream | null = null
let fileStreamFailed = false
/** 当前落盘文件的绝对路径（fileStream 打开后有效），给「查看日志文件」用。 */
let currentLogPath: string | null = null

/**
 * 原始 console 方法引用。patchConsole 把它们存下来，patch 后的实现既调原始
 * （保证终端照常输出），又把内容喂进 collector。保存在模块级，patchConsole
 * 幂等（重复调用不会二次包裹）。
 */
let originalConsole: {
  log: typeof console.log
  info: typeof console.info
  warn: typeof console.warn
  error: typeof console.error
  debug: typeof console.debug
} | null = null

/** 日志文件目录：`<userData>/logs`。openFileStream 与 clearLogs 共用。 */
function logsDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function openFileStream(): void {
  if (fileStream || fileStreamFailed) return
  try {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const path = join(dir, `runtime-${day}.log`)
    fileStream = createWriteStream(path, { flags: 'a' })
    currentLogPath = path
    fileStream.on('error', () => {
      // 落盘失败不能影响日志面板；标记放弃文件，继续走内存 + 推送。
      fileStreamFailed = true
      fileStream = null
      currentLogPath = null
    })
    // 标记一次会话边界，回看时能区分不同启动。
    fileStream.write(`\n===== session start ${new Date().toISOString()} =====\n`)
  } catch {
    fileStreamFailed = true
  }
}

/**
 * 「查看日志文件」的目标：当前正在写的文件（若已打开）+ 日志目录。文件可能
 * 尚未打开（本次启动还没有一条日志落盘，几乎不可能）或刚被 clearLogs 删掉
 * ——调用方（LOGS_REVEAL handler）自行 existsSync 后决定 reveal 文件还是
 * 退回打开目录。
 */
export function getLogFileTarget(): { file: string | null; dir: string } {
  return { file: currentLogPath, dir: logsDir() }
}

/** 把已知 ANSI 颜色码剥掉——daemon / vite 的彩色输出在面板里是噪音。 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '')
}

/**
 * 汇入一条日志。所有来源最终都走这里。`text` 可能含换行——按行拆开，每行一条，
 * 这样 daemon 的多行 stdout 在面板里也是规整的逐行列表。空行忽略。
 */
export function pushLog(source: LogSource, level: RuntimeLogEntry['level'], text: string): void {
  const cleaned = stripAnsi(text)
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '') continue
    const entry: RuntimeLogEntry = {
      seq: seq++,
      ts: Date.now(),
      source,
      level,
      text: line.length > MAX_LINE_LEN ? `${line.slice(0, MAX_LINE_LEN)} …[truncated]` : line,
    }

    ring.push(entry)
    if (ring.length > RING_CAPACITY) ring.shift()

    openFileStream()
    if (fileStream) {
      const tag = source.padEnd(8)
      fileStream.write(`${new Date(entry.ts).toISOString()} [${tag}] ${entry.text}\n`)
    }

    for (const wc of subscribers) {
      if (wc.isDestroyed()) {
        subscribers.delete(wc)
        continue
      }
      try {
        wc.send(IPC_CHANNELS.LOGS_STREAM, entry)
      } catch {
        // webContents 可能正在销毁的竞态——忽略，下次 push 时会清理。
      }
    }
  }
}

/** 返回当前环形缓冲的快照（面板首次打开时一次性拉取）。 */
export function getLogs(): RuntimeLogEntry[] {
  return ring.slice()
}

/**
 * 清空所有日志：内存环形缓冲 + 磁盘上 `<userData>/logs/` 下的全部
 * `runtime-*.log` 文件。先关掉当前写流再删文件，否则被删的 inode 仍被
 * 句柄占着、后续 write 会写进一个已 unlink 的文件（磁盘看不到却仍占空间）。
 * 删完把 fileStream 置空，下一条日志触发 openFileStream 重建当天文件。
 */
export function clearLogs(): void {
  ring.length = 0

  if (fileStream) {
    try {
      fileStream.end()
    } catch {
      /* ignore */
    }
    fileStream = null
  }
  currentLogPath = null
  // 之前若曾标记落盘失败，清空是一次重置机会——允许重建。
  fileStreamFailed = false

  try {
    const dir = logsDir()
    for (const name of readdirSync(dir)) {
      if (name.startsWith('runtime-') && name.endsWith('.log')) {
        try {
          rmSync(join(dir, name), { force: true })
        } catch {
          /* 单个文件删不掉（占用/权限）就跳过，不阻断其余 */
        }
      }
    }
  } catch {
    // 目录不存在（从没落过盘）等情况——无所谓，内存已清空。
  }
}

/** 注册一个实时推送目标（settings overlay 打开时调用）。 */
export function addLogSubscriber(wc: WebContents): void {
  subscribers.add(wc)
  wc.once('destroyed', () => subscribers.delete(wc))
}

/** 注销推送目标（overlay 关闭时调用）。 */
export function removeLogSubscriber(wc: WebContents): void {
  subscribers.delete(wc)
}

/**
 * Forward a renderer webContents' console output into the collector.
 * Wire it from `app.on('web-contents-created')` so every tab / shell /
 * overlay renderer is covered without touching each creation site.
 *
 * Electron 43 fires `console-message` with a single details object
 * (`Event<WebContentsConsoleMessageEventParams>`) whose `level` is a **string**
 * enum: `'debug' | 'info' | 'warning' | 'error'`. The old positional args
 * `(event, level:number, message, line, sourceId)` still arrive after `details`
 * but are all `@deprecated` — reading them is exactly what triggers Electron's
 * runtime deprecation warning, so we read `details.level` / `details.message`
 * instead. (Pre-35 used the numeric positional signature; the migration to the
 * details object happened over 35→43.)
 *
 * The `message` is the already-formatted console string, so no util.format
 * here. We skip the settings overlay's own renderer: it's the panel that
 * *displays* logs, so echoing its render-time console back into the stream is
 * pure noise. Rather than detect the overlay by URL at creation time (racy —
 * the view hasn't navigated yet), we check membership in `subscribers` at
 * emit time: the overlay registers itself as a push target on open, which is
 * exactly the set we want to exclude as a source.
 */
export function attachRendererCapture(wc: WebContents): void {
  wc.on('console-message', (details) => {
    if (subscribers.has(wc)) return
    // electron 的 'warning' 映射到内部的 'warn'；其余（info/error/debug）同名直传。
    const lvl: RuntimeLogEntry['level'] =
      details.level === 'warning' ? 'warn' : details.level
    pushLog('renderer', lvl, details.message)
  })
}

/**
 * 接管本进程的 console.*，让每次调用既照常打到终端，又汇入 collector。
 * 幂等：已 patch 则直接返回。应在 main 入口尽早调用（loadEnv 之后即可）。
 *
 * 实现上保留原始引用并在 patched 版本里转调，所以原有 stdout 行为零变化；
 * format 用 node 的 util.format 复刻 console 的占位符 / 多参数拼接语义。
 */
export function patchConsole(): void {
  if (originalConsole) return
  // 动态 require util，避免顶部 import 干扰 tree-shaking 语义；只在 patch 时取一次。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { format } = require('node:util') as typeof import('node:util')

  originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }

  const wrap =
    (level: RuntimeLogEntry['level'], original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      original(...args)
      try {
        pushLog('main', level, format(...args))
      } catch {
        // collector 出问题绝不能拖垮调用方的 console；静默吞掉。
      }
    }

  console.log = wrap('info', originalConsole.log)
  console.info = wrap('info', originalConsole.info)
  console.warn = wrap('warn', originalConsole.warn)
  console.error = wrap('error', originalConsole.error)
  console.debug = wrap('debug', originalConsole.debug)
}

let processEventsPatched = false

/**
 * 补上 patchConsole 抓不到的 process 级信号——它们直接写 stderr、不经过
 * console.*，恰恰是排障最要紧的一类（engine 的 `cli exited before first
 * init` 就是以 UnhandledPromiseRejectionWarning 的形态只在终端一闪而过，
 * 日志文件里没有）：
 *   - unhandledRejection      —— async 函数忘了 catch 的 reject。只记录，
 *     不改变 node 的默认 warning 行为（不调 process.exit 也不吞）。
 *   - uncaughtExceptionMonitor —— 只监听不接管：普通的 `uncaughtException`
 *     监听器会阻止 Electron 默认的崩溃/弹窗行为，monitor 变体专为
 *     「旁路记录」设计。
 *   - warning                 —— DeprecationWarning / MaxListeners 等。
 * 幂等；在 patchConsole 旁调用一次。
 */
export function patchProcessEvents(): void {
  if (processEventsPatched) return
  processEventsPatched = true

  process.on('unhandledRejection', (reason) => {
    const detail =
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    pushLog('main', 'error', `[unhandledRejection] ${detail}`)
  })

  process.on('uncaughtExceptionMonitor', (err) => {
    pushLog('main', 'error', `[uncaughtException] ${err.stack ?? err.message}`)
  })

  process.on('warning', (warning) => {
    pushLog('main', 'warn', `[process warning] ${warning.stack ?? `${warning.name}: ${warning.message}`}`)
  })
}
