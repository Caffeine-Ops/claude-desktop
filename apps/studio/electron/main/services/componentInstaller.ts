import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess } from 'electron'

import {
  detectSystemPythonHomeSync,
  invalidateSystemPythonCache,
  isCliAvailable,
  resolveBundledPythonHome,
  resolveEffectivePythonHome,
  verifySystemPython
} from '../core/cliDetect'
import {
  componentCacheDir,
  componentDir,
  componentsRoot,
  ensureComponentDirs,
  readComponentRecord,
  writeComponentRecord
} from '../core/componentPaths'
import { broadcastRuntimeComponentsState, recycleAllEnginesRuntimes } from '../tabRegistry'
import {
  artifactUrl,
  currentComponentPlatform,
  describeComponent,
  initialComponentStatus,
  initialRuntimeComponentsState,
  parseComponentsManifest,
  pickArtifact,
  type ComponentEntry,
  type ComponentId,
  type ComponentPlatform,
  type ComponentStatus,
  type ComponentsManifest,
  type RuntimeComponentsState
} from '../../shared/runtimeComponents'

/**
 * 运行时组件（AI 引擎 / Python 环境）的按需安装器。
 *
 * main 侧薄壳：状态表 + 拉清单 + fork worker + 广播；重活全在 componentWorker
 * 子进程里（见那边的注释）。范式照搬 pptSkillInstaller，但有两处本质差异：
 *
 *   ① **CLI 是必需品**。缺了整个应用不能聊天，所以渲染层的门是不可关闭的。
 *      （pptSkill 那边缺了只挡 PPT 入口，用户拍板「不挡应用启动」。）
 *   ② **就绪判据不是「下载装过没有」，而是 `isCliAvailable()`** —— 与 engine
 *      spawn 时用的是同一个解析函数。于是「包里还带着二进制」的中间态用户一次
 *      门都不会看到，这是拆桥前不打扰任何人的保证。
 */

/**
 * 远端清单地址。**正式配置在 `env.json` 的 `RUNTIME_COMPONENTS_BASE_URL`**；
 * 这里的字面量只是 env 漏配时的兜底。
 *
 * 三层来源，后者覆盖前者（同 PPT_SKILL_BASE_URL 的设计）：
 *   1. 本文件的兜底常量
 *   2. `env.json` → loadEnv 灌进 process.env
 *   3. sub2api 的 client-config 远端下发（applyRemoteEnvConfig 同样写
 *      process.env）——**这层意味着换 CDN / 迁服务器不用发版**，是这个变量值得
 *      走 env 而不是硬编码的主要原因，也是这条链路唯一近乎零成本的止血杠杆。
 *
 * 当前落点：ningbo-cowork 的 `/var/www/downloads/components/`，经 nginx 已有的
 * `location /downloads/` alias 直发——**刻意复用既有段而不是新增 location**：
 * 那台机器同域还跑着付费的 sub2api 网关（`location /`，SSE 靠它的 buffering off
 * + 3600s 超时）。已实测：`/downloads/` 下不存在的路径正确返回 404，而**顶层新增
 * 的路径若配错会被 sub2api 的 SPA 兜底吃成 200 + text/html**。能不碰 nginx 就不碰。
 */
const DEFAULT_BASE_URL = 'https://cowork.cntcn.com/downloads/components'

const MANIFEST_FILE = 'components.json'

/** required 组件多试几轮（用户在门后面干等，值得多争取）；可选的少试。 */
const MAX_ATTEMPTS_REQUIRED = 6
const MAX_ATTEMPTS_OPTIONAL = 3

let state: RuntimeComponentsState = initialRuntimeComponentsState
let inflight: Promise<RuntimeComponentsState> | null = null
/** 上一次成功拉到的清单，重试时免得再拉一遍。 */
let cachedManifest: ComponentsManifest | null = null

function baseUrl(): string {
  const env = process.env.RUNTIME_COMPONENTS_BASE_URL
  return (env && env.trim() ? env.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '')
}

// ── 就绪探测 ──────────────────────────────────────────────────────────

/**
 * 单个组件「现在能用吗」。
 *
 * 刻意不只看下载记账：CLI 走 `isCliAvailable()`（= resolveBundledCliPath 能解析
 * 出路径，随包/dev/下载三种来源通吃），python 走 `resolveEffectivePythonHome()`
 * （= 捆绑/已下载 runtime，或系统检测到的 3.11/3.12）。这样中间态、dev 环境、
 * 以及装了系统 python 的用户都不会被误催下载。
 */
function isComponentAvailable(id: ComponentId): boolean {
  return id === 'cli' ? isCliAvailable() : resolveEffectivePythonHome() !== null
}

/**
 * 已下载安装的版本（随包/dev 来源没有记账，返回 null）。
 *
 * 判据取**本平台 artifact 的** readyProbe：它按平台不同（mac 的 bin/python3
 * vs Windows 的 python.exe），用错平台的值会让整个平台永远判定「没装好」。
 */
function installedVersion(entry: ComponentEntry, platform: ComponentPlatform | null): string | null {
  const artifact = pickArtifact(entry, platform)
  if (!artifact) return null
  const probe = entry.kind === 'executable' ? (artifact.binName ?? artifact.readyProbe) : artifact.readyProbe
  return readComponentRecord(entry.id, probe)?.version ?? null
}

function patch(id: ComponentId, next: Partial<ComponentStatus>): void {
  const components = state.components.map((c) => (c.id === id ? { ...c, ...next } : c))
  state = { ...state, components, requiredReady: computeRequiredReady(components) }
  broadcastRuntimeComponentsState(state)
}

function computeRequiredReady(components: ComponentStatus[]): boolean {
  const required = components.filter((c) => c.required)
  // 一个 required 组件都没有（清单没拉到 / 平台不支持）时不能报 true——那会让门
  // 直接放行，用户随后在发第一条消息时撞上原始的 spawn 报错。
  if (required.length === 0) return false
  return required.every((c) => c.phase === 'ready')
}

/**
 * 冷启动第一次被问起时同步照一眼磁盘，让 IPC 第一次 resolve 就是准确结论。
 *
 * 为什么重要：渲染层 store 初值是 null、null 不渲染门（绝大多数用户早已就绪，
 * 闪一下门比闪一下界面更糟）。准确性全靠这里——而这几毫秒里 splash 还压在上面。
 */
export function getRuntimeComponentsState(): RuntimeComponentsState {
  if (state.components.length === 0) {
    // 还没拉过清单：先按「本机现状」给一张表。CLI 恒定 required——它是聊天的
    // 前提，这一点不依赖清单（清单拉不到时更需要这个保守判断）。
    const cli: ComponentStatus = {
      ...initialComponentStatus('cli', true),
      phase: isComponentAvailable('cli') ? 'ready' : 'idle'
    }
    const py: ComponentStatus = {
      ...initialComponentStatus('python-runtime', false),
      phase: isComponentAvailable('python-runtime') ? 'ready' : 'idle'
    }
    state = { components: [cli, py], requiredReady: cli.phase === 'ready', manifestOk: state.manifestOk }
  }
  return state
}

/** 供 main 侧（如 CHAT_SEND 守卫）廉价同步查询，不触发任何 io 之外的工作。 */
export function requiredComponentsReady(): boolean {
  return getRuntimeComponentsState().requiredReady
}

// ── 编排 ──────────────────────────────────────────────────────────────

/**
 * 确保组件就绪。并发调用共享同一次执行（单飞）。任何失败都收敛成状态里的
 * `phase:'error'`，**不 throw**——调用方拿到的就是终态。
 */
export function ensureRuntimeComponents(opts: { force?: boolean } = {}): Promise<RuntimeComponentsState> {
  if (inflight) return inflight
  inflight = run(opts).finally(() => {
    inflight = null
  })
  return inflight
}

/**
 * 启动后台预热。**fire-and-forget，刻意不 await**——挡用户的是渲染层那道门，
 * 不是 whenReady。splash 照常走完、studio 首帧照常出，门在 studio 里立起来。
 * 这样即使要下一两分钟，用户看到的也是一个正常窗口 + 说明清楚的进度层，
 * 而不是一个卡在闪屏上的死壳。
 */
export function ensureRuntimeComponentsInBackground(): void {
  void ensureRuntimeComponents().catch((err: unknown) => {
    console.error('[components] background ensure failed:', err)
  })
}

async function fetchManifest(): Promise<ComponentsManifest | null> {
  const url = `${baseUrl()}/${MANIFEST_FILE}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // 同域 SPA 兜底会把漏配路径变成 200 + text/html，先看类型再解析，
  // 免得把一个网页丢进 JSON.parse 得到一句没头没脑的语法错误。
  const ctype = res.headers.get('content-type') ?? ''
  if (ctype.includes('text/html')) throw new Error('远端返回网页而非清单——下载地址配置有误')
  const parsed = parseComponentsManifest(await res.json())
  if (!parsed) throw new Error('清单格式不正确')
  return parsed
}

async function run(opts: { force?: boolean }): Promise<RuntimeComponentsState> {
  getRuntimeComponentsState() // 保证表已初始化
  ensureComponentDirs()

  for (const c of state.components) {
    if (c.phase !== 'ready') patch(c.id, { phase: 'checking', error: null, detail: '正在检查…' })
  }

  let manifest: ComponentsManifest
  try {
    manifest = (await fetchManifest())!
    cachedManifest = manifest
    state = { ...state, manifestOk: true }
  } catch (err) {
    // 拉不到清单但必需组件本地可用 → **直接放行**。断网用户能继续用应用，
    // 比「检查更新」重要得多（同 pptSkillInstaller 的离线降级纪律）。
    if (cachedManifest && !opts.force) {
      manifest = cachedManifest
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      for (const c of state.components) {
        if (isComponentAvailable(c.id)) {
          patch(c.id, { phase: 'ready', error: null, detail: '' })
        } else {
          patch(c.id, {
            phase: 'error',
            error: `获取安装信息失败：${msg}`,
            detail: ''
          })
        }
      }
      return state
    }
  }

  const platform = currentComponentPlatform()
  // required 排前面：门只等它们，可选组件不该拖慢放行。
  const ordered = [...manifest.components].sort((a, b) => Number(b.required) - Number(a.required))

  for (const entry of ordered) {
    await ensureOne(entry, platform, opts.force === true)
  }
  return state
}

async function ensureOne(
  entry: ComponentEntry,
  platform: ReturnType<typeof currentComponentPlatform>,
  force: boolean
): Promise<void> {
  const id = entry.id
  // 清单里的 required 是权威（可后台改一行就把 CLI 降级成可选），但表里可能还是
  // 初始化时的保守值，这里对齐。
  patch(id, { required: entry.required })

  const artifact = pickArtifact(entry, platform)
  const local = installedVersion(entry, platform)
  let available = isComponentAvailable(id)

  if (!artifact) {
    // 该平台不发这个组件。可选的静默跳过；必需的且本机也没有 → 只能报错。
    patch(id, {
      phase: available ? 'ready' : entry.required ? 'error' : 'idle',
      error: available || !entry.required ? null : `当前平台没有可用的${describeComponent(id)}`,
      detail: ''
    })
    return
  }

  patch(id, { targetVersion: artifact.version, installedVersion: local })

  /**
   * python-runtime 的「已经能用」如果来自**系统检测**（捆绑/已下载 runtime 为
   * null，isComponentAvailable 转而落到 detectSystemPythonHomeSync）——在跳过
   * 70MB 下载前先 verifySystemPython() 验真一次。existsSync 扫到的目录，解释器
   * 可能已损坏或被系统隔离（企业杀软/macOS Gatekeeper 隔离属性），existsSync
   * 看不出这些；宁可多花几百毫秒验证，也不能让一个假 ready 换来 venv 建不出来
   * 的「正在准备运行环境」胶囊卡死。
   */
  let systemPythonDetail: string | null = null
  if (id === 'python-runtime' && available && !force && resolveBundledPythonHome() === null) {
    const systemPython = detectSystemPythonHomeSync()
    const verified = systemPython ? await verifySystemPython(systemPython) : false
    if (verified && systemPython) {
      systemPythonDetail = `检测到系统 Python ${systemPython.version}，无需下载`
    } else {
      // 验真失败：这份系统 python 不可信，本轮当作不可用，强制落到下载分支——
      // 缓存也要失效，否则 30s 内的重试还会拿到同一个坏结论。
      invalidateSystemPythonCache()
      available = false
    }
  }

  /**
   * 已经能用就不下载——**哪怕清单里有更新的版本**，只要它不是我们下载装的。
   *
   * 这条是「中间态不打扰任何人」的关键：包里还带着二进制的版本里，用户本来就能
   * 用，没有任何理由让他为了一个版本号去下 200MB。真正的版本升级只对
   * 「已经是下载来的那一份」生效（local !== null），此时用户本就在这条链路上。
   */
  if (available && !force && (local === null || local === artifact.version)) {
    patch(id, {
      phase: 'ready',
      error: null,
      detail: systemPythonDetail ?? '',
      installedVersion: local
    })
    return
  }
  if (!force && local === artifact.version && available) {
    patch(id, { phase: 'ready', error: null, detail: systemPythonDetail ?? '' })
    return
  }

  // Windows 上目标 .exe 若正被某个 CLI 子进程占用，rename 会 EBUSY。先回收，
  // 让 worker 拿到一个没人握着的目标。首次安装无此问题，只影响升级。
  if (local !== null) {
    try {
      await recycleAllEnginesRuntimes()
    } catch {
      /* 回收失败不致命，worker 侧还有 EBUSY 的中文兜底文案 */
    }
  }

  const result = await runWorker(entry, artifact, force)
  if (!result.ok) return

  writeComponentRecord({
    id,
    version: artifact.version,
    platform: platform ?? '',
    installedAt: Date.now(),
    ...(result.contentSha256 ? { contentSha256: result.contentSha256 } : {})
  })
  patch(id, { phase: 'ready', installedVersion: artifact.version, error: null, detail: '', bytesPerSecond: 0 })

  // 刚装好的 CLI 对已 spawn 的子进程不可见（路径在 spawn 时就烤死了）。回收让
  // 下一次 send 冷启动重新解析。同 pptSkillInstaller 装完 plugin 后的处理。
  try {
    await recycleAllEnginesRuntimes()
  } catch {
    /* 同上 */
  }
}

interface WorkerResult {
  ok: boolean
  /** 落盘可执行文件的 sha256，写进记账供将来每次 spawn 前的廉价复验。 */
  contentSha256?: string
}

function runWorker(
  entry: ComponentEntry,
  artifact: NonNullable<ReturnType<typeof pickArtifact>>,
  force: boolean
): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolve) => {
    const id = entry.id
    patch(id, { phase: 'downloading', done: 0, total: artifact.size, error: null, detail: '正在下载…', attempt: 1 })

    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'componentWorker.js')
    const job = {
      id,
      kind: entry.kind,
      encoding: artifact.encoding,
      url: artifactUrl(baseUrl(), artifact),
      sha256: artifact.sha256,
      contentSha256: artifact.contentSha256,
      size: artifact.size,
      unpackedSize: artifact.unpackedSize,
      // binName / readyProbe 取自**本平台的 artifact**（它们按平台不同）。
      binName: artifact.binName,
      stripComponents: entry.stripComponents,
      readyProbe: artifact.readyProbe,
      version: artifact.version,
      installRoot: componentsRoot(),
      cacheDir: componentCacheDir(),
      maxAttempts: entry.required ? MAX_ATTEMPTS_REQUIRED : MAX_ATTEMPTS_OPTIONAL,
      expectArch: process.arch === 'arm64' ? 'arm64' : 'x64',
      force
    }
    const child = utilityProcess.fork(workerPath, [JSON.stringify(job)])

    let settled = false
    child.on('message', (msg: Record<string, unknown>) => {
      if (msg?.type === 'progress') {
        const phase = msg.phase as ComponentStatus['phase']
        patch(id, {
          phase,
          done: Number(msg.done) || 0,
          total: Number(msg.total) || 0,
          bytesPerSecond: Number(msg.bytesPerSecond) || 0,
          attempt: Number(msg.attempt) || 1,
          detail: phase === 'downloading' ? '正在下载…' : phase === 'verifying' ? '正在校验…' : '正在安装…'
        })
      } else if (msg?.type === 'retry') {
        // 静默重试会被用户当成卡死，必须说出来。
        patch(id, {
          attempt: Number(msg.attempt) || 1,
          detail: `连接中断，第 ${msg.attempt} 次重试（${Math.round(Number(msg.delayMs) / 1000)} 秒后）…`
        })
      } else if (msg?.type === 'done') {
        settled = true
        if (msg.ok) {
          resolve({
            ok: true,
            ...(typeof msg.contentSha256 === 'string' ? { contentSha256: msg.contentSha256 } : {})
          })
        } else {
          patch(id, { phase: 'error', error: String(msg.error ?? '安装失败'), detail: '', bytesPerSecond: 0 })
          resolve({ ok: false })
        }
      }
    })
    // worker 崩溃（OOM / 被杀）不会发 done——exit 兜底，否则进度层永远转下去。
    child.on('exit', () => {
      if (settled) return
      patch(id, { phase: 'error', error: '安装进程异常退出', detail: '', bytesPerSecond: 0 })
      resolve({ ok: false })
    })
  })
}

/** 诊断用：组件根目录（设置页/日志里显示）。 */
export function runtimeComponentsRoot(): string {
  return componentsRoot()
}

/** 诊断用：某组件的安装目录。 */
export function runtimeComponentDir(id: ComponentId): string {
  return componentDir(id)
}
