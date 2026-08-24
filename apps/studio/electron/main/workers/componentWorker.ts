import { execFileSync } from 'node:child_process'
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
  statfsSync,
  truncateSync
} from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { inspectExecutable, type ExpectArch } from '../../shared/binaryIntegrity'
import type { ComponentEncoding, ComponentKind } from '../../shared/runtimeComponents'

/**
 * 运行时组件的下载 / 校验 / 安装 worker（utilityProcess 子进程）。
 *
 * **为什么必须是子进程**：CLI 二进制压缩后 ~80MB、解压后 233MB。sha256 与
 * gunzip 都是 CPU 密集，放 main 里会把所有 tab 的 engine 连同整个 UI 一起冻住
 * （同 embedWorker / kbBuildWorker / pptSkillWorker 的既有教训）。
 *
 * **与 pptSkillWorker 的关键差异**（那个是 49MB zip，这套是 233MB 可执行文件）：
 *   ① 不用 `Buffer.concat` 把整包读进内存 —— 那在这个尺度上峰值近 500MB。
 *      全程流式，靠 `pipeline` 管背压（只是「写盘了」不够，没有背压一样堆内存）。
 *   ② 有 HTTP Range 断点续传 —— 自建源出口只有 ~1.1MB/s，一次下载一两分钟，
 *      中断即从头来是不可接受的。
 *   ③ 有停滞看门狗与退避重试。
 *   ④ 保留 mode 位（pptSkillWorker 的 adm-zip 会把 +x 丢掉，实证：它解出来的
 *      ensure-python.sh 是 644，靠 `source` 调用才侥幸没炸；Mach-O 644 = EACCES）。
 *
 * argv[1] 是一整个 JSON job（字段太多，位置参数已到极限）。
 * 消息协议见 WorkerMsg。
 */

interface ComponentJob {
  id: string
  kind: ComponentKind
  encoding: ComponentEncoding
  url: string
  /** 传输层字节（即 url 指向的那个文件）的 sha256。 */
  sha256: string
  /** 解压后可执行文件的 sha256（仅 kind='executable'）。 */
  contentSha256?: string
  size: number
  unpackedSize: number
  binName?: string
  stripComponents?: number
  readyProbe: string
  version: string
  /** 组件安装根（<userData>/components），worker 会往 <installRoot>/<id> 落。 */
  installRoot: string
  /** .part 与 staging 的家，必须与 installRoot 同分区。 */
  cacheDir: string
  maxAttempts: number
  expectArch?: ExpectArch
}

type WorkerMsg =
  | { type: 'progress'; phase: 'downloading' | 'verifying' | 'installing'; done: number; total: number; bytesPerSecond: number; attempt: number }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'done'; ok: true; version: string; contentSha256?: string }
  | { type: 'done'; ok: false; error: string; retryable: boolean }

const send = (msg: WorkerMsg): void => {
  process.parentPort?.postMessage(msg)
}

/** 进度节流：80MB 会产生上万个 chunk，每个都发一条消息只会把 IPC 打爆。 */
const PROGRESS_THROTTLE_MS = 100

/**
 * 多久没有新字节就认定这条连接死了。
 *
 * 为什么需要它、以及为什么是「无字节间隔」而不是总超时：出口带宽 ~1.1MB/s 时，
 * 一次合法下载本来就要一两分钟（坏线路上更久），用总时长根本区分不了「慢」和
 * 「死」。而 pptSkillWorker 那边 `await fetch(url)` 完全没有超时，连接卡在
 * 0 B/s 会永远挂着、进度条冻死。
 *
 * 关键是：**正因为有断点续传，误判的代价接近零** —— 重连后从 .part 末尾接着走，
 * 白丢的最多是几秒。这两个特性互相成就。
 */
const STALL_TIMEOUT_MS = 45_000

/** 退避阶梯。required 组件用满，可选组件只用前几档（由 maxAttempts 控制）。 */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

/** 非重试错误：再试多少次都是同样的结果，立刻失败比让用户干等五轮退避强。 */
class FatalError extends Error {}

const job: ComponentJob = JSON.parse(process.argv[2] ?? '{}')

function partPath(): string {
  // **文件名带版本**：老版本留下的半截包永远不会被拿去对新产物做 Range 拼接。
  return join(job.cacheDir, `${job.id}-${job.version}.part`)
}

/** 清掉同组件的其它 .part（换版本后的残留）。照搬 kbSync 的 sweepPartFiles 思路。 */
function sweepStaleParts(): void {
  const keep = `${job.id}-${job.version}.part`
  let entries: string[]
  try {
    entries = readdirSync(job.cacheDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith(`${job.id}-`) && name.endsWith('.part') && name !== keep) {
      rmSync(join(job.cacheDir, name), { force: true })
    }
  }
}

/**
 * 磁盘预检。别让用户等 80 秒再 ENOSPC。
 *
 * 两条守卫照抄 kbSync.ts 的血泪注释：
 *   - 必须守 `bsize > 0`：Bun x64 的 statfsSync 结构体错位，bsize 会读成 0，
 *     把任何下载都误判成磁盘不足（曾让 Intel mac CI 集体挂）。
 *   - **不要**守 `bavail === 0`：那是「磁盘真满」的合法信号，不是读数异常。
 */
function checkDiskSpace(): void {
  // 压缩态与解压态在 gunzip 期间同时在盘上，两份都要算，再留一点余量。
  const need = job.size + job.unpackedSize + 200 * 1024 * 1024
  try {
    const fs = statfsSync(job.cacheDir)
    if (!fs.bsize || fs.bsize <= 0) return // 读数不可信，跳过预检而不是误判
    const free = fs.bavail * fs.bsize
    if (free < need) {
      throw new FatalError(
        `磁盘空间不足：需要约 ${Math.ceil(need / 1048576)} MB，当前可用 ${Math.floor(free / 1048576)} MB`
      )
    }
  } catch (err) {
    if (err instanceof FatalError) throw err
    // statfs 本身失败（平台不支持等）：跳过预检，别因为一个锦上添花的检查挡住安装。
  }
}

// ── ① 下载（可续传）──────────────────────────────────────────────────

/**
 * 一轮下载。本层只负责**架好停滞看门狗**，实际的请求与落盘在 downloadBody。
 *
 * 看门狗必须在 `fetch` **之前**就 armed。这里原本把 setInterval 写在 fetch
 * 之后——实测（2026-08，Node 24 + undici）服务器只发响应头就装死时
 * `await fetch()` 本身会永久挂起，那行 setInterval 永远执行不到，看门狗形同
 * 虚设：首启门会无限转圈，正是它本该防住的场景。提前 arm 之后，「等响应头」
 * 与「读 body」两个阶段都能在 abort 后 ~5ms 内抛错（已用最小复现确认）。
 * 同 pptSkillWorker，两处保持同形。
 */
async function downloadOnce(attempt: number): Promise<void> {
  const controller = new AbortController()
  let lastBytesAt = Date.now()
  const stall = setInterval(() => {
    if (Date.now() - lastBytesAt > STALL_TIMEOUT_MS) controller.abort()
  }, 5_000)

  try {
    await downloadBody(attempt, controller, () => {
      lastBytesAt = Date.now()
    })
  } catch (err) {
    // **不能依赖 abort(reason) 把 reason 带出来**：经 `Readable.fromWeb` 包装的
    // body 流被 abort 时，pipeline 抛的是固定的 "This operation was aborted"。
    // 所以按「是谁掐的」反查——signal.aborted 只可能是看门狗（本层不接受外部
    // signal），可以放心翻译成人话；否则用户在界面上看到的就是那句英文。
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
 * 真正跑请求与落盘的那一段。
 * @param onBytes 收到新字节时回调，喂上层看门狗的「上次有进展」时间戳。
 */
async function downloadBody(
  attempt: number,
  controller: AbortController,
  onBytes: () => void
): Promise<void> {
  const part = partPath()
  let existing = 0
  try {
    existing = statSync(part).size
  } catch {
    existing = 0
  }

  if (existing > job.size) {
    // 比目标还长，只可能是异常（换了产物 / 写坏了）——从 0 重来。
    rmSync(part, { force: true })
    existing = 0
  } else if (existing === job.size) {
    return // 上次是在校验/安装阶段挂的，字节已齐，直接进下一段
  } else if (existing > 0) {
    // 被杀掉的 createWriteStream 可能留下半个 chunk。直接从 statSync 的长度接着
    // 请求会悄悄产出一个损坏文件（而且只有 sha256 能发现，代价是整包白下一遍）。
    // 便宜的保险：回退 1MB 重下那一段，覆盖掉可能的撕裂尾巴。
    const rewind = Math.min(existing, 1024 * 1024)
    existing -= rewind
    truncateSync(part, existing)
  }

  const headers: Record<string, string> = {}
  if (existing > 0) headers.Range = `bytes=${existing}-`

  const res = await fetch(job.url, { headers, signal: controller.signal })

  // 自建源同域挂着 sub2api 网关：**漏配路径不会 404，会被它的 SPA 兜底吃成
  // 200 + text/html**（已实测）。没有这条断言，我们会兴高采烈地下载一个网页、
  // chmod +x 它，然后得到一个和真因毫无关系的 `spawn Exec format error`。
  const ctype = res.headers.get('content-type') ?? ''
  if (ctype.includes('text/html')) {
    throw new FatalError('远端返回的是网页而不是文件——下载地址配置有误（检查服务器路径）')
  }
  if (res.status === 404 || res.status === 403) {
    throw new FatalError(`远端没有这个文件（HTTP ${res.status}）——清单与服务器不一致`)
  }
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`)
  }

  // undici 会**自动解压** Content-Encoding: gzip。哪天有人给 octet-stream 开了
  // nginx gzip，我们拿到的就是已解压的字节，而 Range 偏移也不再对应文件字节——
  // 续传会拼出一个 sha256 死活对不上的文件。显式拒绝，让问题暴露在这里。
  if (res.headers.get('content-encoding')) {
    throw new FatalError('远端启用了传输层压缩，会破坏断点续传——请关闭该路径的 gzip')
  }

  let writeOffset = existing
  if (res.status === 206) {
    // 核对服务器给的确实是我们要的那一段。有些中间层会返回 206 却给了另一段。
    const cr = res.headers.get('content-range') ?? ''
    const m = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(cr)
    if (!m || Number(m[1]) !== existing || Number(m[3]) !== job.size) {
      rmSync(part, { force: true })
      throw new Error(`服务器返回了不匹配的分片（Content-Range: ${cr || '缺失'}）`)
    }
  } else {
    // 200 = 服务器忽略了 Range（或我们本来就没发）。从头写。
    writeOffset = 0
    const len = Number(res.headers.get('content-length'))
    if (Number.isFinite(len) && len > 0 && len !== job.size) {
      throw new FatalError(`远端文件大小与清单不符（清单 ${job.size}，实际 ${len}）——清单已过期`)
    }
  }

  mkdirSync(job.cacheDir, { recursive: true })
  let received = writeOffset
  let lastTick = 0
  let lastSampleAt = Date.now()
  let lastSampleBytes = received
  let bps = 0

  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      onBytes()
      const now = Date.now()
      if (now - lastTick >= PROGRESS_THROTTLE_MS) {
        // 速率用 EMA 平滑，否则 1.1MB/s 的抖动会让 ETA 疯狂跳。
        const dt = (now - lastSampleAt) / 1000
        if (dt >= 0.5) {
          const inst = (received - lastSampleBytes) / dt
          bps = bps === 0 ? inst : bps * 0.7 + inst * 0.3
          lastSampleAt = now
          lastSampleBytes = received
        }
        lastTick = now
        send({ type: 'progress', phase: 'downloading', done: received, total: job.size, bytesPerSecond: Math.round(bps), attempt })
      }
      // 服务器给的比清单长 = 清单与产物漂移，继续下去只会填满磁盘。
      if (received > job.size) {
        cb(new FatalError(`远端文件比清单声明的长（清单 ${job.size}）——清单已过期`))
        return
      }
      cb(null, chunk)
    }
  })

  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    createWriteStream(part, writeOffset > 0 ? { flags: 'a' } : { flags: 'w' })
  )

  send({ type: 'progress', phase: 'downloading', done: received, total: job.size, bytesPerSecond: Math.round(bps), attempt })
}

// ── ② 校验（重读 .part）──────────────────────────────────────────────

/**
 * 为什么下载期完全不算 sha256、而是事后重读一遍：
 *
 * 断点续传要求能对着已有的 .part 接着推进 hash，而 Node 的 `crypto.Hash` 只有
 * **进程内**的 `.copy()`，没有任何序列化 / 反序列化 API（OpenSSL 的 SHA256_CTX
 * 也不通过 Node 暴露）。要持久化中间态就得在 JS 里手写一遍 SHA-256 并自己管
 * h0..h7 与残余块——慢一个数量级，还凭空造出一整个新的正确性面。
 *
 * 而重读的成本在真实瓶颈面前是噪声：瓶颈是 1.1MB/s 的网络（80MB 要 ~80 秒），
 * 重读 80MB 在 SSD 上是 0.1~0.3 秒，占比不到 0.5%。
 *
 * 而且重读**严格更正确**：它校验的是「此刻磁盘上真正是什么」，能抓到撕裂写、
 * 未刷盘的页缓存、被别的进程动过的 .part；带过来的内存 hash 只能证明
 * 「我们以为自己写了什么」。
 *
 * 副作用还是个好事：verifying 成了用户可见的独立阶段，进度条继续走，而不是在
 * 100% 处静默僵住几百毫秒——在一个动辄等几分钟的界面里，这很重要。
 */
async function verifyPart(attempt: number): Promise<string> {
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
          send({ type: 'progress', phase: 'verifying', done, total, bytesPerSecond: 0, attempt })
        }
        cb(null, chunk)
      }
    }),
    // 只为消费流，不落盘。
    new Transform({ transform: (_c, _e, cb) => cb() })
  )
  return hash.digest('hex')
}

// ── ③ 安装（解压 + 落位）────────────────────────────────────────────

function tarBinary(): string {
  // **绝对路径**：GUI 启动的 Electron 拿到的是精简 PATH，靠 PATH 找 tar 是本仓库
  // 反复踩过的坑（见 cliDetect 的 resolveJsRuntimeBin 注释）。
  if (process.platform === 'win32') {
    return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  }
  return '/usr/bin/tar'
}

async function installExecutable(staging: string, attempt: number): Promise<string> {
  const part = partPath()
  const target = join(staging, job.binName!)
  const hash = createHash('sha256')
  let done = 0
  let lastTick = 0

  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      done += chunk.length
      const now = Date.now()
      if (now - lastTick >= PROGRESS_THROTTLE_MS) {
        lastTick = now
        send({ type: 'progress', phase: 'installing', done, total: job.unpackedSize, bytesPerSecond: 0, attempt })
      }
      cb(null, chunk)
    }
  })

  // 两个分支而不是拼数组：pipeline 的可变参数重载对动态数组表达不出类型，
  // 硬转会把整条管道的类型检查一起关掉。多写一行换回类型安全。
  if (job.encoding === 'gzip') {
    await pipeline(createReadStream(part), createGunzip(), hasher, createWriteStream(target))
  } else {
    await pipeline(createReadStream(part), hasher, createWriteStream(target))
  }

  const contentSha = hash.digest('hex')
  if (job.contentSha256 && contentSha !== job.contentSha256) {
    throw new Error(
      `解压后校验失败：sha256 不匹配（期望 ${job.contentSha256.slice(0, 12)}…，实际 ${contentSha.slice(0, 12)}…）`
    )
  }

  // **执行位不在 sha256 里**，必须显式设置并断言。实证：pptSkillWorker 解出来的
  // ensure-python.sh 是 644（adm-zip 丢 mode），那边靠 `source` 调用才没炸；
  // 对 Mach-O / PE 这么干就是 spawn EACCES。
  if (process.platform !== 'win32') {
    chmodSync(target, 0o755)
    if ((statSync(target).mode & 0o111) === 0) throw new Error('设置可执行权限失败')
  }

  // 结构走查：sha256 只能证明「拿到的和发布的一样」，证明不了「发布出去的那份
  // 本身是好的」，也抓不到架构发错平台（那种文件 sha 完全正确却 Exec format error）。
  const verdict = inspectExecutable(target, {
    format: process.platform === 'win32' ? 'pe' : 'macho',
    ...(job.expectArch ? { expectArch: job.expectArch } : {}),
    // 下限交给 unpackedSize 与 sha256 兜底，这里关掉硬编码的 120MB —— 将来若发布
    // 一个更小的 CLI，不该被一条经验常数拦住。
    minBytes: 0
  })
  if (!verdict.ok) throw new Error(`二进制完整性校验失败：${verdict.reason}`)

  return contentSha
}

function installArchive(staging: string): void {
  const args = ['-xzf', partPath()]
  if (job.stripComponents != null) args.push('--strip-components', String(job.stripComponents))
  args.push('-C', staging)
  try {
    execFileSync(tarBinary(), args, { stdio: 'pipe' })
  } catch (err) {
    if (!existsSync(tarBinary())) {
      throw new FatalError(`系统缺少 tar 命令（${tarBinary()}），无法解压`)
    }
    throw new Error(`解压失败：${err instanceof Error ? err.message : String(err)}`)
  }
  // 解压后判据必须在——tar 成功但内容不对（strip 层数错了）也要当场发现。
  if (!existsSync(join(staging, job.readyProbe))) {
    throw new Error(`解压后缺少预期文件 ${job.readyProbe}（归档结构与清单不符）`)
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function attemptOnce(attempt: number): Promise<string | undefined> {
  await downloadOnce(attempt)

  const actual = await verifyPart(attempt)
  if (actual !== job.sha256) {
    // 最可能的原因是上一次会话留下的坏 .part（撕裂写 / 服务器换了文件）。
    // 删掉让下一轮干净重下；干净重下后仍不匹配才是真的坏（由调用方判定）。
    rmSync(partPath(), { force: true })
    throw new Error(`校验失败：sha256 不匹配（期望 ${job.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
  }

  // staging 与 installRoot 同分区（都在 components/ 下），rename 永远不会 EXDEV。
  mkdirSync(job.cacheDir, { recursive: true })
  const staging = mkdtempSync(join(job.cacheDir, `${job.id}-stage-`))
  const targetDir = join(job.installRoot, job.id)
  let contentSha: string | undefined
  try {
    if (job.kind === 'executable') {
      contentSha = await installExecutable(staging, attempt)
    } else {
      installArchive(staging)
    }

    // 旧目录先挪走再换上新的，失败可回滚。照搬 pptSkillWorker 的 staging→rename。
    mkdirSync(job.installRoot, { recursive: true })
    const trash = `${targetDir}.old-${process.pid}`
    let moved = false
    if (existsSync(targetDir)) {
      try {
        renameSync(targetDir, trash)
        moved = true
      } catch (err) {
        // Windows：目标 .exe 正被某个 CLI 子进程占用 → EBUSY/EPERM。
        // main 侧在 fork 之前会先 recycleAllEnginesRuntimes()，这里是兜底文案。
        throw new FatalError(
          `无法替换正在使用的组件（${err instanceof Error ? err.message : String(err)}）——请结束正在运行的任务后重试`
        )
      }
    }
    try {
      renameSync(staging, targetDir)
    } catch (err) {
      if (moved) renameSync(trash, targetDir) // 回滚
      throw err
    }
    if (moved) rmSync(trash, { recursive: true, force: true })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  // 装好了才删 .part（中间任何一步失败，下次还能靠它续传/免下）。
  rmSync(partPath(), { force: true })
  return contentSha
}

async function run(): Promise<void> {
  if (!job.url || !job.sha256 || !job.installRoot) {
    send({ type: 'done', ok: false, error: 'componentWorker 参数不完整', retryable: false })
    return
  }

  try {
    mkdirSync(job.cacheDir, { recursive: true })
    sweepStaleParts()
    checkDiskSpace()
  } catch (err) {
    send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err), retryable: false })
    return
  }

  const maxAttempts = Math.max(1, job.maxAttempts || 1)
  let lastErr = 'unknown'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const contentSha = await attemptOnce(attempt)
      send({ type: 'done', ok: true, version: job.version, ...(contentSha ? { contentSha256: contentSha } : {}) })
      return
    } catch (err) {
      if (err instanceof FatalError) {
        send({ type: 'done', ok: false, error: err.message, retryable: false })
        return
      }
      lastErr = err instanceof Error ? err.message : String(err)
      if (attempt >= maxAttempts) break
      const delayMs = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!
      // 静默重试会被用户当成卡死，必须让 UI 说出来。
      send({ type: 'retry', attempt: attempt + 1, delayMs, reason: lastErr })
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  send({ type: 'done', ok: false, error: lastErr, retryable: true })
}

void run().catch((err: unknown) => {
  send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err), retryable: true })
})

// 防御：worker 里未捕获的异常也要收敛成 done，否则 main 侧只能靠 exit 兜底，
// 用户看到的是「安装进程异常退出」而不是真正的原因。
process.on('uncaughtException', (err) => {
  send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err), retryable: true })
})
