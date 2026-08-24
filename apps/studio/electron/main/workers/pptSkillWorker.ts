import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import AdmZip from 'adm-zip'

import { backoffDelay, checkContentRange, planResume } from './downloadPlan'

/**
 * ppt-creator skill 的下载/校验/解压 worker（utilityProcess 子进程）。
 *
 * **为什么必须是子进程**：这个包压缩后 49MB、解压出 12167 个文件。sha256
 * 计算与解压都是 CPU 密集，12167 次写盘更是长时间占用事件循环——放 main
 * 里做会把所有 tab 的 engine 连同整个 UI 一起冻住（同 embedWorker/
 * kbBuildWorker 的既有教训：main 单线程，任何秒级同步工作都是全 app 卡顿）。
 * adm-zip 的 `extractAllToAsync` 名字里有 async，实现却是同步循环+回调，
 * 一样冻主线程，不能拿来当免死金牌。
 *
 * **为什么下载要落盘而不是攒在内存里**（2026-08 从 `chunks: Buffer[]` 改过来）：
 * 原实现把 49MB 攒进数组再 `Buffer.concat`，峰值近 100MB，且**没有任何超时**
 * ——连接卡在 0 B/s 会永远挂着、进度条冻死。而修它的前提是断点续传，续传的
 * 前提是落盘：
 *
 *   停滞看门狗单独存在是有害的。出口带宽 ~1.1MB/s 时一次合法下载本就要一两
 *   分钟，用总时长根本区分不了「慢」和「死」，所以判据只能是「多久没有新
 *   字节」；而这种判据必然有误判率。**正因为有断点续传，误判的代价才接近零**
 *   ——重连后从 .part 末尾接着走，白丢的最多是几秒。没有续传的看门狗只会把
 *   「卡住」变成「卡住 45 秒后前功尽弃」，弱网用户可能永远装不上。
 *   这两个特性互相成就，必须一起上。
 *
 * 整套策略与 `componentWorker.ts` 同源（那个是 80MB 的 CLI 二进制），差异只在
 * 产物形态：这里是 zip，那里是可执行文件/压缩包。
 *
 * argv[1] 是一整个 JSON job（字段到 7 个，位置参数已到极限）。
 * 消息协议见 WorkerMsg。
 */

interface PptSkillJob {
  url: string
  /** 插件安装根（~/.cowork/plugins），worker 往 <installRoot>/<skillId> 落。 */
  installRoot: string
  skillId: string
  /** zip 的 sha256（小写 hex）。 */
  sha256: string
  /** 清单声明的字节数；0 表示未知（那样就不做续传）。 */
  size: number
  /**
   * .part 与 staging 的家。**必须与 installRoot 同分区**——staging 最后要
   * `renameSync` 到安装目录，跨分区会直接 EXDEV 失败。（旧实现把 staging 开在
   * `os.tmpdir()` 下，macOS 上恰好同分区才没暴露，是个定时炸弹。）
   */
  cacheDir: string
  maxAttempts: number
}

type WorkerMsg =
  | {
      type: 'progress'
      phase: 'downloading' | 'extracting'
      done: number
      total: number
      /** 一句大白话，给 UI 的 detail 用（如「正在校验完整性…」）。 */
      detail?: string
    }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'done'; ok: true }
  | { type: 'done'; ok: false; error: string }

const send = (msg: WorkerMsg): void => {
  process.parentPort?.postMessage(msg)
}

/** 进度节流：49MB 下载会产生成千上万个 chunk，每个都发一条消息只会把 IPC
 *  打爆、反过来拖慢 main。100ms 一条足够画平滑进度条。 */
const PROGRESS_THROTTLE_MS = 100

/** 多久没有新字节就认定这条连接死了。判据是「无字节间隔」而不是总时长，理由见文件头。 */
const STALL_TIMEOUT_MS = 45_000

/** 非重试错误：再试多少次都是同样结果，立刻失败比让用户干等五轮退避强。 */
class FatalError extends Error {}

const IS_WIN = process.platform === 'win32'

const job: PptSkillJob = JSON.parse(process.argv[2] ?? '{}')

/**
 * .part 的文件名带 sha 前缀：远端换了产物后，老版本留下的半截包永远不会被
 * 拿去对新产物做 Range 拼接（那会拼出一个只有 sha256 才能发现的坏文件）。
 */
function partPath(): string {
  return join(job.cacheDir, `${job.skillId}-${job.sha256.slice(0, 12)}.part`)
}

/** 清掉本 skill 其它 .part（换版本后的残留）。照 componentWorker 的 sweepStaleParts。 */
function sweepStaleParts(): void {
  const keep = `${job.skillId}-${job.sha256.slice(0, 12)}.part`
  let entries: string[]
  try {
    entries = readdirSync(job.cacheDir)
  } catch {
    return // 目录还不存在，无可清扫
  }
  for (const name of entries) {
    if (name === keep) continue
    if (!name.startsWith(`${job.skillId}-`) || !name.endsWith('.part')) continue
    rmSync(join(job.cacheDir, name), { force: true })
  }
}

// ── ① 下载（流式落盘，支持 Range 续传）─────────────────────────────────

async function downloadOnce(): Promise<void> {
  const part = partPath()
  let existing = 0
  try {
    existing = statSync(part).size
  } catch {
    existing = 0
  }

  const plan = planResume(existing, job.size)
  if (plan.action === 'complete') return // 字节已齐，上次多半挂在校验/解压
  let writeOffset = 0
  if (plan.action === 'restart') {
    rmSync(part, { force: true })
  } else {
    writeOffset = plan.offset
    truncateSync(part, writeOffset)
  }

  const controller = new AbortController()
  const headers: Record<string, string> = {}
  if (writeOffset > 0) headers.Range = `bytes=${writeOffset}-`

  /**
   * 看门狗必须在 `fetch` **之前**就 armed，不能等 fetch 返回后再启动。
   *
   * 实测（2026-08，Node 24 + undici）：服务器只发响应头就装死时 `await fetch()`
   * 本身会永久挂起——而 fetch 之后才 setInterval 的话，那行 setInterval 永远
   * 执行不到，看门狗形同虚设。把它提前，abort 就同时覆盖「等响应头」和「读
   * body」两个阶段（两阶段各自实测能在 abort 后 ~5ms 内抛错）。
   *
   * 45 秒对「等响应头」偏宽松，但语义统一成「45 秒毫无进展就判死」比拆成两个
   * 阈值更好理解，也更难写错——而且有断点续传兜底，误判的代价只是几秒。
   */
  let lastBytesAt = Date.now()
  const stall = setInterval(() => {
    if (Date.now() - lastBytesAt > STALL_TIMEOUT_MS) controller.abort()
  }, 5_000)

  try {
    await downloadBody(controller, headers, writeOffset, part, () => {
      lastBytesAt = Date.now()
    })
  } catch (err) {
    // **不能依赖 abort(reason) 把 reason 带出来**：实测经 `Readable.fromWeb`
    // 包装的 body 流被 abort 时，pipeline 抛的是固定的 "This operation was
    // aborted"，塞进 abort() 的 Error 被丢掉了。所以在这里按「是谁掐的」反查
    // ——signal.aborted 只可能是看门狗（本函数不接受外部 signal），可以放心
    // 翻译成人话。不这么做的话，用户在界面上看到的就是那句英文。
    if (controller.signal.aborted) {
      throw new Error(
        `连接停滞超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒没有新数据——已判定为断线`
      )
    }
    throw err
  } finally {
    clearInterval(stall)
  }
}

/**
 * 真正跑请求与落盘的那一段。抽出来只是为了让上面的看门狗 try/finally 保持扁平
 * ——它必须包住 fetch 与 pipeline 两者，嵌在一个函数里比手写两层 try 好读。
 *
 * @param onBytes 收到新字节时回调，用来喂看门狗的「上次有进展」时间戳。
 */
async function downloadBody(
  controller: AbortController,
  headers: Record<string, string>,
  offset: number,
  part: string,
  onBytes: () => void
): Promise<void> {
  let writeOffset = offset
  const res = await fetch(job.url, { headers, signal: controller.signal })

  // 自建源同域挂着网关：**漏配路径不会 404，会被 SPA 兜底吃成 200 + text/html**
  // （componentWorker 那边已实测）。没有这条断言，我们会兴高采烈地下载一个网页，
  // 然后得到一个和真因毫无关系的「zip 格式错误」。
  const ctype = res.headers.get('content-type') ?? ''
  if (ctype.includes('text/html')) {
    throw new FatalError('远端返回的是网页而不是文件——下载地址配置有误（检查服务器路径）')
  }
  if (res.status === 404 || res.status === 403) {
    throw new FatalError(`远端没有这个文件（HTTP ${res.status}）——清单与服务器不一致`)
  }
  if (!res.ok || !res.body) {
    throw new Error(`下载失败：HTTP ${res.status}`)
  }
  // undici 会**自动解压** Content-Encoding: gzip。哪天有人给这个路径开了 nginx
  // gzip，我们拿到的就是已解压的字节，Range 偏移不再对应文件字节——续传会拼出
  // 一个 sha256 死活对不上的文件。显式拒绝，让问题暴露在这里而不是校验那步。
  if (res.headers.get('content-encoding')) {
    throw new FatalError('远端启用了传输层压缩，会破坏断点续传——请关闭该路径的 gzip')
  }

  if (res.status === 206) {
    const check = checkContentRange(res.headers.get('content-range'), writeOffset, job.size)
    if (!check.ok) {
      rmSync(part, { force: true }) // 拼不得，下一轮干净重下
      throw new Error(check.reason ?? '服务器返回了不匹配的分片')
    }
  } else {
    // 200 = 服务器忽略了 Range（或我们本来就没发）。从头写。
    writeOffset = 0
    const len = Number(res.headers.get('content-length'))
    if (job.size > 0 && Number.isFinite(len) && len > 0 && len !== job.size) {
      throw new FatalError(`远端文件大小与清单不符（清单 ${job.size}，实际 ${len}）——清单已过期`)
    }
  }

  mkdirSync(job.cacheDir, { recursive: true })
  // Content-Length 可能缺失（分块传输）——那时用清单里的 size 当分母，
  // 两者都没有则发 total:0，UI 退化成不确定进度条而不是显示 NaN%。
  const total = job.size || Number(res.headers.get('content-length')) || 0
  let received = writeOffset
  let lastTick = 0

  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      onBytes()
      const now = Date.now()
      if (now - lastTick >= PROGRESS_THROTTLE_MS) {
        lastTick = now
        send({ type: 'progress', phase: 'downloading', done: received, total })
      }
      // 服务器给的比清单长 = 清单与产物漂移，继续下去只会填满磁盘。
      if (job.size > 0 && received > job.size) {
        cb(new FatalError(`远端文件比清单声明的长（清单 ${job.size}）——清单已过期`))
        return
      }
      cb(null, chunk)
    }
  })

  // 用 pipeline 管背压：只是「写盘了」不够，没有背压一样会把整包堆在内存里。
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    createWriteStream(part, writeOffset > 0 ? { flags: 'a' } : { flags: 'w' })
  )
  send({ type: 'progress', phase: 'downloading', done: received, total: total || received })
}

// ── ② 校验（重读 .part）───────────────────────────────────────────────

/**
 * 为什么下载期不再边下边算 sha256、改成事后重读一遍：
 *
 * 断点续传要求能对着已有的 .part 接着推进 hash，而 Node 的 `crypto.Hash` 只有
 * **进程内**的 `.copy()`，没有任何序列化 API——中间态跨不了进程，续传一次就得
 * 从头重算。重读的成本在真实瓶颈面前是噪声：瓶颈是 ~1.1MB/s 的网络（49MB 要
 * 四五十秒），重读 49MB 在 SSD 上是 0.1~0.3 秒。
 *
 * 而且重读**严格更正确**：它校验的是「此刻磁盘上真正是什么」，能抓到撕裂写、
 * 未刷盘的页缓存、被别的进程动过的 .part；内存里带过来的 hash 只能证明
 * 「我们以为自己写了什么」。
 */
async function verifyPart(): Promise<string> {
  const part = partPath()
  const total = statSync(part).size
  const hash = createHash('sha256')
  let done = 0
  let lastTick = 0
  await pipeline(
    createReadStream(part),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk)
        done += chunk.length
        const now = Date.now()
        if (now - lastTick >= PROGRESS_THROTTLE_MS) {
          lastTick = now
          // 复用 downloading 阶段：重读不到半秒，为它新增一个用户几乎看不见的
          // UI 阶段（要动 PptSkillPhase 契约）不划算，用 detail 说清就够。
          send({ type: 'progress', phase: 'downloading', done, total, detail: '正在校验完整性…' })
        }
        cb(null, chunk)
      }
    }),
    // pipeline 需要一个终点；这里只关心副作用（hash），数据丢弃即可。
    new Transform({ transform: (_c, _e, cb) => cb() })
  )
  return hash.digest('hex')
}

// ── ③ 解压 + 原子换名 ─────────────────────────────────────────────────

function extractAndInstall(): void {
  const targetDir = join(job.installRoot, job.skillId)
  mkdirSync(job.installRoot, { recursive: true })
  mkdirSync(job.cacheDir, { recursive: true })
  // staging 开在 cacheDir 而不是 os.tmpdir()：与 installRoot 同分区，rename 永不 EXDEV。
  let staging: string | null = mkdtempSync(join(job.cacheDir, `${job.skillId}-stage-`))
  try {
    // 从磁盘读而不是 Buffer.concat：49MB 不再进内存。
    const zip = new AdmZip(partPath())
    const entries = zip.getEntries()
    let extracted = 0
    let lastTick = 0
    // 权限位对账，见循环后的断言。
    let execDeclared = 0
    let execApplied = 0
    for (const entry of entries) {
      if (entry.isDirectory) continue
      // 路径穿越防御：zip 里的 entryName 是外部数据，`../` 能写到安装根之外。
      const dest = join(staging, entry.entryName)
      if (!dest.startsWith(staging + '/') && !dest.startsWith(staging + '\\')) {
        throw new Error(`zip 内路径越界：${entry.entryName}`)
      }
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, entry.getData())

      /**
       * 把 zip 里的权限位写回磁盘。
       *
       * **writeFileSync 不会带上 mode**，于是包里 755 的脚本解出来是 644。这个
       * bug 一直潜伏着：skill 的 `bin/ensure-python.sh` 正是靠被 `source` 调用
       * （而不是直接执行）才侥幸没炸——真去 exec 它就是 EACCES。
       *
       * 三道守卫，每道都有必要：
       *   · 非 Windows —— 那边没有 unix 权限位概念，chmodSync 只能改只读位。
       *   · zip 声明来自 unix（made 高字节 = 3）—— 只有那样 external attributes
       *     的高 16 位才真的是 unix mode；Windows 工具打的包那里是 MS-DOS 属性
       *     位，照搬会 chmod 出垃圾权限。
       *   · mode 落在 (0, 0o777] —— 兜底。**chmod(0) 会让文件谁都读不了**，那比
       *     丢执行位严重得多；宁可不改，也不能改坏。
       */
      const mode = entry.header.fileAttr
      const unixZip = entry.header.made >> 8 === 3
      const declaresExec = unixZip && (mode & 0o111) !== 0
      if (declaresExec) execDeclared += 1
      if (!IS_WIN && unixZip && mode > 0 && mode <= 0o777) {
        chmodSync(dest, mode)
        // 只对声明了可执行的少数文件回读校验——12167 个文件全 stat 一遍不值得。
        if (declaresExec && (statSync(dest).mode & 0o111) !== 0) execApplied += 1
      }
      extracted += 1
      const now = Date.now()
      if (now - lastTick >= PROGRESS_THROTTLE_MS) {
        lastTick = now
        send({ type: 'progress', phase: 'extracting', done: extracted, total: entries.length })
      }
    }
    send({ type: 'progress', phase: 'extracting', done: extracted, total: entries.length })

    /**
     * 权限位对账。
     *
     * 丢执行位属于「不报错、只是以后某处莫名 EACCES」那类退化——症状离病因很远，
     * 排查成本极高（这次就是靠读另一个文件的注释才发现的）。所以在这里当场对账：
     * zip 里声明了几个可执行文件，落盘后就该有几个。数不上就是 chmod 环节失效，
     * 安装期硬失败，而不是留给用户某天在 CLI 里撞见。
     *
     * 同 afterPack 的 assertLocalesSurvived：静默的退化必须用断言逼成显式失败。
     * Windows 上不对账 —— 那边 chmod 本就不生效，execApplied 恒为 0。
     */
    if (!IS_WIN && execDeclared > 0 && execApplied !== execDeclared) {
      throw new Error(
        `可执行权限设置失败：zip 声明 ${execDeclared} 个可执行文件，实际只有 ${execApplied} 个生效`
      )
    }

    // fusion-code 认的插件清单——由安装器写而不是打进 zip：它是安装形态的
    // 一部分，不是 skill 内容（与 daemon 市场安装器的 pluginManifestContent
    // 保持逐字一致，两处产出必须同形，否则同一个包经两条路装出来行为不同）。
    const manifestDir = join(staging, '.claude-plugin')
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(
      join(manifestDir, 'plugin.json'),
      `${JSON.stringify(
        {
          name: 'cowork',
          version: '0.0.1',
          description:
            'Cowork skills market install root, exposed to the fusion-code agent as plugin skills (namespaced cowork:<skill>).',
          skills: './skills/'
        },
        null,
        2
      )}\n`
    )

    // 旧版本先挪走再换名，失败可回滚；成功后才删——避免「删了旧的、新的没上位」
    const trash = `${targetDir}.old-${process.pid}`
    const hadOld = existsSync(targetDir)
    if (hadOld) renameSync(targetDir, trash)
    try {
      renameSync(staging, targetDir)
    } catch (err) {
      if (hadOld) {
        try {
          renameSync(trash, targetDir)
        } catch {
          /* 回滚也失败——原样把首个错误抛出去，别用回滚错误盖掉真因 */
        }
      }
      throw err
    }
    staging = null
    if (hadOld) rmSync(trash, { recursive: true, force: true })
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function attemptOnce(): Promise<void> {
  await downloadOnce()

  const actual = await verifyPart()
  if (actual !== job.sha256) {
    // 校验不过绝不落盘：宁可没装，也不能把一个被篡改/截断的包解到用户机器上
    // 再交给 CLI 执行（这个包里全是会被跑起来的 Python 脚本）。
    // 最可能的原因是上一次会话留下的坏 .part——删掉让下一轮干净重下。
    rmSync(partPath(), { force: true })
    throw new Error(
      `校验失败：sha256 不匹配（期望 ${job.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`
    )
  }

  extractAndInstall()
  // 装好了才删 .part（中间任何一步失败，下次还能靠它续传/免下）。
  rmSync(partPath(), { force: true })
}

async function run(): Promise<void> {
  if (!job.url || !job.installRoot || !job.skillId || !job.sha256 || !job.cacheDir) {
    send({ type: 'done', ok: false, error: 'pptSkillWorker 参数不完整' })
    return
  }

  try {
    mkdirSync(job.cacheDir, { recursive: true })
    sweepStaleParts()
  } catch (err) {
    send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
    return
  }

  const maxAttempts = Math.max(1, job.maxAttempts || 1)
  let lastErr = 'unknown'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await attemptOnce()
      send({ type: 'done', ok: true })
      return
    } catch (err) {
      if (err instanceof FatalError) {
        send({ type: 'done', ok: false, error: err.message })
        return
      }
      lastErr = err instanceof Error ? err.message : String(err)
      if (attempt >= maxAttempts) break
      const delayMs = backoffDelay(attempt)
      // 静默重试会被用户当成卡死，必须让 UI 说出来。
      send({ type: 'retry', attempt: attempt + 1, delayMs, reason: lastErr })
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  send({ type: 'done', ok: false, error: lastErr })
}

void run().catch((err: unknown) => {
  send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
})

// 防御：worker 里未捕获的异常也要收敛成 done，否则 main 侧只能靠 exit 兜底，
// 用户看到的是「安装进程异常退出」而不是真正的原因。
process.on('uncaughtException', (err) => {
  send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
})
