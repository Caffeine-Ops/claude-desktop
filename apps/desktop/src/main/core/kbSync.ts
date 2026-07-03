/**
 * 知识库远程同步引擎（electron-free、依赖注入——bun test 直测的前提）。
 *
 * 为什么整个文件不 import electron：调度器（main 侧）负责把 app.getPath 等 electron
 * 能力算好后经 deps 注入（outDir/stateDir/remote/nowMs/fetchImpl），引擎本身只吃纯数据
 * 与 node 内置 fs——于是 bun test 能不起 Electron 直接把 mock fetch 灌进来跑全流程。
 * 时间也走 deps.nowMs（规矩：引擎不碰 Date.now，测试可钉死时间做断言）。
 *
 * runKbSync 绝不 throw：一切失败（网络/损坏/越界/磁盘）都收敛成返回值
 * `{state:'error', ...}`，调度器拿到就是终态、无需 try/catch 兜异常。
 *
 * 落位策略见 diffManifests 与 spec ③：先文件后 index.json（目录卡垫后），
 * 任一文件失败则整轮不半应用（不落 index、不删旧、不更新基准），已成功文件留盘
 * 供下轮 sha1 diff 自动跳过 = 断点续传。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import { kbFileUrl, kbManifestUrl, manifestPathToPlatform, parseKbManifest } from '../../shared/kbManifest'
import type { KbManifest, KbManifestFile } from '../../shared/kbManifest'
import type { KbSyncStatus } from '../../shared/kbSyncStatus'
import { isPathInsideRoot } from '../services/localAssetProtocol'
import { diffManifests } from './kbSyncDiff'

export interface KbSyncDeps {
  outDir: string // 镜像目标（生产传 kbOutDir()）
  stateDir: string // 基准 manifest 目录（生产传 userData/kb-sync）
  remote: { baseUrl: string; kbId: string }
  nowMs: () => number // 时间注入（规矩：不调 Date.now）
  fetchImpl?: typeof fetch // 测试注入 mock；生产缺省 globalThis.fetch
  onStatus?: (s: KbSyncStatus) => void // 进度回调（调度器接去广播）
  concurrency?: number // 默认 4
  retries?: number // 每文件重试，默认 2
  // 磁盘预检用的 statfs 实现，默认 node:fs statfsSync；try/catch 跳过语义不变
  // （老 Node/不支持的平台照样宁漏检不误伤）。这是纯为可测性开的最小 DI 口——
  // bun test 跑在真实文件系统上，没有别的办法让「磁盘不足」这个分支可控地触发。
  statfsImpl?: (path: string) => { bavail: number; bsize: number }
}

const FETCH_TIMEOUT_MS = 10_000
const sha1Hex = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex')

/**
 * fetch 加 10s 硬超时——但只兜「发出请求到收到响应头」这一段：AbortController 的信号
 * 传给 fetch 后，一旦 fetchImpl 返回 Response（headers 到手）本函数就 resolve，10s 定时器
 * 随即被 finally 清掉；调用方后续 `await res.arrayBuffer()`/`res.text()` 读 body 不再受这个
 * timer 约束。生产 fetchImpl 是 undici，其自带的 bodyTimeout（默认更长）才是 body 读取阶段
 * 真正的兜底——两段各管一段，别把这里的 10s 误当成整个请求的总超时。
 * clearTimeout 放在 finally——无论 resolve 还是 reject 都要清掉定时器，别泄漏。
 */
async function fetchWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 清扫 outDir 下所有 `*.part` 残留（上轮下到一半断电/崩溃的产物）。
 * 递归 walk，逐个 rm；walk 自身可能与外部改动竞态，一律吞异常（清扫是尽力而为，
 * 漏掉某个 .part 也不影响正确性——下次会被同名新 .part 覆盖写）。
 */
function cleanupParts(dir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      cleanupParts(abs)
    } else if (e.isFile() && e.name.endsWith('.part')) {
      try {
        rmSync(abs)
      } catch {
        // 竞态删除失败不致命，忽略。
      }
    }
  }
}

/**
 * 把磁盘现状伪造成一份 base manifest（rule 3）：stateDir 无基准时（例如从「本地构建
 * 索引」模式首次切到远程同步），以 outDir 磁盘内容当基准喂 diffManifests——同 sha1 的
 * 文件零重下、磁盘上远端没有的文件自然进 toDelete。
 * walk 跳 `.` 开头（.DS_Store / .git 等）与 `.part`（半截产物不该算基准）。
 * builtAtMs:0 是哨兵——伪基准不代表任何真实构建时刻。路径用 POSIX '/' 拼，与
 * manifest.path 同源，diff 才能对得上。
 */
function scanDiskAsManifest(outDir: string): KbManifest {
  const files: KbManifestFile[] = []
  const walk = (dir: string, relPrefix: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.name.endsWith('.part')) continue
      const abs = join(dir, e.name)
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(abs, rel)
      } else if (e.isFile()) {
        const buf = readFileSync(abs)
        files.push({ path: rel, sha1: sha1Hex(buf), size: buf.length })
      }
    }
  }
  walk(outDir, '')
  return { schemaVersion: 1, kbId: '', name: '', builtAtMs: 0, files }
}

export async function runKbSync(deps: KbSyncDeps): Promise<KbSyncStatus> {
  const {
    outDir,
    stateDir,
    remote,
    nowMs,
    fetchImpl = globalThis.fetch,
    onStatus,
    concurrency = 4,
    retries = 2,
    statfsImpl = statfsSync
  } = deps

  const emit = (s: KbSyncStatus): KbSyncStatus => {
    try {
      onStatus?.(s)
    } catch {
      // 回调方（广播到已销毁的 webContents 等）的异常不是同步失败——引擎契约是
      // 「绝不 throw、终态=返回值」，回调坏了只丢通知不丢结果。不兜住的话：成功
      // 路径末尾的 emit 抛出会落进外层 catch，fail() 再 emit 又抛，异常直接逃出
      // runKbSync；且哪怕只抛一次，落盘已完成的 success 也会被错转成 error。
    }
    return s
  }
  // 终态收口：一切失败都经这里，既 onStatus 广播又作返回值（rule 9：终态双发）。
  const fail = (message: string, failedCount: number): KbSyncStatus =>
    emit({ state: 'error', message, failedCount })

  try {
    // ── rule 1：开工先清 `*.part` 残留 ────────────────────────────────────
    cleanupParts(outDir)

    // ── rule 2：拉 manifest（10s 超时）→ 解析 → kbId 校验；任一失败镜像不动 ──
    let remoteManifest: KbManifest | null
    try {
      const res = await fetchWithTimeout(fetchImpl, kbManifestUrl(remote.baseUrl, remote.kbId))
      if (!res.ok) return fail(`manifest 拉取失败：HTTP ${res.status}`, 0)
      remoteManifest = parseKbManifest(JSON.parse(await res.text()))
    } catch (e) {
      return fail(`manifest 拉取/解析异常：${String(e)}`, 0)
    }
    if (!remoteManifest) return fail('manifest 损坏或不合协议', 0)
    if (remoteManifest.kbId !== remote.kbId) {
      // kbId 不匹配：拿到的是别的知识库的目录卡，绝不能拿它去改这个 outDir。
      return fail(`kbId 不匹配：期望 ${remote.kbId}，收到 ${remoteManifest.kbId}`, 0)
    }

    // ── rule 3：base = stateDir/manifest.json（防御解析），无则以磁盘为基准 ──
    const basePath = join(stateDir, 'manifest.json')
    let base: KbManifest | null = null
    if (existsSync(basePath)) {
      try {
        base = parseKbManifest(JSON.parse(readFileSync(basePath, 'utf8')))
      } catch {
        base = null // 基准损坏就当没有——退化成磁盘对账，安全侧。
      }
    }
    if (!base) base = scanDiskAsManifest(outDir)

    // ── rule 4：diff 出计划；每个下载/删除目标过 isPathInsideRoot（纵深第二道）──
    const plan = diffManifests(base, remoteManifest)
    for (const f of plan.toDownload) {
      const target = resolve(outDir, manifestPathToPlatform(f.path, sep))
      if (!isPathInsideRoot(target, outDir)) return fail(`下载目标越界：${f.path}`, 0)
    }
    for (const p of plan.toDelete) {
      const target = resolve(outDir, manifestPathToPlatform(p, sep))
      if (!isPathInsideRoot(target, outDir)) return fail(`删除目标越界：${p}`, 0)
    }

    // ── rule 5：磁盘预检（statfsImpl 抛错则跳过——老 Node 前宁漏检不误伤）──────
    try {
      const st = statfsImpl(outDir)
      const availBytes = Number(st.bavail) * Number(st.bsize)
      const needed = plan.toDownload.reduce((s, f) => s + f.size, 0) * 1.1
      if (availBytes < needed) return fail('磁盘空间不足', 0)
    } catch {
      // statfsImpl 不可用：跳过预检。
    }

    const total = plan.toDownload.length
    // index.json 单独垫后（rule 6/8）：它是目录卡，必须等全部内容文件落地、且零失败才落。
    const indexFile = plan.toDownload.find((f) => f.path === 'index.json')
    const poolFiles = plan.toDownload.filter((f) => f.path !== 'index.json')

    /**
     * 单文件下载：重试循环包整个「fetch→校验→落位」。非 200 / sha1 不符 / 抛异常都算
     * 一次失败并重试；重试用尽仍失败返回 false（计入 failed）。
     * .part 原子落位：先写 `<target>.part` 再 renameSync 到位——rename 在同分区是原子的，
     * 绝不出现「读到写了一半的文件」；sha1 不符时 .part 根本不 rename，脏内容不落位。
     */
    const downloadOne = async (file: KbManifestFile): Promise<boolean> => {
      const url = kbFileUrl(remote.baseUrl, remote.kbId, file.path)
      const target = resolve(outDir, manifestPathToPlatform(file.path, sep))
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await fetchWithTimeout(fetchImpl, url)
          if (!res.ok) continue
          const buf = Buffer.from(await res.arrayBuffer())
          if (sha1Hex(buf) !== file.sha1) continue
          mkdirSync(dirname(target), { recursive: true })
          const partPath = `${target}.part`
          writeFileSync(partPath, buf)
          renameSync(partPath, target)
          return true
        } catch {
          // 网络/写盘异常：进入下一次重试。
        }
      }
      return false
    }

    // ── rule 6/9：并发池下载（index.json 不进池）；每文件落位/失败发一次递增进度 ──
    emit({ state: 'syncing', done: 0, total })
    let done = 0
    let failed = 0
    let firstFailPath: string | null = null
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++
        if (i >= poolFiles.length) return
        const file = poolFiles[i]
        const ok = await downloadOne(file)
        done++
        if (!ok) {
          failed++
          if (firstFailPath === null) firstFailPath = file.path
        }
        emit({ state: 'syncing', done, total })
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))

    // ── rule 7：任一内容文件失败 ⇒ 不下 index、不删、不更新基准，成功文件留盘 ──
    if (failed > 0) {
      return fail(`同步失败 ${failed} 个文件，首个：${firstFailPath}`, failed)
    }

    // ── rule 8：零失败才落 index.json（垫后）──────────────────────────────
    if (indexFile) {
      const ok = await downloadOne(indexFile)
      done++
      if (!ok) return fail('index.json 下载失败', 1)
      emit({ state: 'syncing', done, total })
    }

    // 执行删除（逐条再过一遍越界守卫，纵深）。
    for (const p of plan.toDelete) {
      const target = resolve(outDir, manifestPathToPlatform(p, sep))
      if (!isPathInsideRoot(target, outDir)) continue
      try {
        rmSync(target, { force: true })
      } catch {
        // 删除失败不回退整轮：新 index 已不引用它，残留一个孤儿文件不致命。
      }
    }

    // 基准 manifest 原子写入 stateDir（tmp+rename，mkdir -p）——落到这里代表本轮全绿，
    // 下轮就以这份 remote 为 base 做增量 diff。
    mkdirSync(stateDir, { recursive: true })
    const tmpBase = join(stateDir, 'manifest.json.tmp')
    writeFileSync(tmpBase, JSON.stringify(remoteManifest))
    renameSync(tmpBase, basePath)

    // ── rule 9：终态 success 双发（onStatus + 返回值）──────────────────────
    return emit({ state: 'success', atMs: nowMs(), builtAtMs: remoteManifest.builtAtMs })
  } catch (e) {
    // 兜底：任何漏网异常都收敛成 error 返回，绝不让 runKbSync 向外 throw。
    return fail(`同步未预期异常：${String(e)}`, 0)
  }
}
