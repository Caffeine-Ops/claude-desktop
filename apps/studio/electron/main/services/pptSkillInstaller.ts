import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess } from 'electron'

import { resolveEffectivePythonHome } from '../core/cliDetect'
import { ensureRuntimeComponents } from './componentInstaller'
import { broadcastPptSkillStatus, recycleAllEnginesRuntimes } from '../tabRegistry'
import {
  PPT_SKILL_LOG_TAIL_LINES,
  describePptBootstrapLine,
  initialPptSkillStatus,
  type PptSkillPhase,
  type PptSkillStatus
} from '../../shared/pptSkillStatus'
import { API_TIMEOUT_MS, fetchWithTimeout } from '../lib/http'

/**
 * ppt-creator skill 的按需安装器（main 侧薄壳：状态机 + fork worker + venv
 * 预热 + 广播；重活全在 pptSkillWorker 子进程里，见那边的注释）。
 *
 * 背景：这个 skill 未压缩 99MB / 12167 个文件，占安装包体积的一大半，而且
 * 只有做 PPT 的用户才需要它。改成不随包发布、首次用到时下载。
 *
 * 装到 `~/.cowork/plugins/<id>/`（cowork 插件根，engine 已经把这个根下的每个
 * 条目当独立 local plugin 传给 SDK），于是命令是 `/cowork:ppt-creator`。
 * 布局要求见 skillsDir.ts 的 resolveCoworkPluginEntries：条目目录下必须有
 * `.claude-plugin/plugin.json`，技能内容在 `skills/<subid>/`。
 *
 * **不阻塞应用启动**：应用照常秒开，只有 PPT 入口在未就绪时才挡（用户拍板
 * 2026-07-29）。启动后台先跑一次 ensure()，多数情况用户点进去时已经好了。
 */

/**
 * 远端清单地址。**正式配置在 `env.json` 的 `PPT_SKILL_BASE_URL`**（同
 * SELF_HOSTED_UPDATE_URL / COWORK_MARKET_BASE_URL 那批自建源地址，见
 * env.example.json）；这里的字面量只是 env 漏配时的兜底，让功能不至于因为
 * 一行配置缺失就整个不可用。
 *
 * 三层来源，后者覆盖前者：
 *   1. 本文件的兜底常量
 *   2. `env.json` → loadEnv 灌进 process.env（打包时随安装包分发）
 *   3. sub2api 的 client-config 远端下发（applyClientEnvConfig 同样写
 *      process.env）——**这层意味着换 CDN / 迁服务器不用发版**，后台改一处
 *      即可，是这个变量值得走 env 而不是硬编码的主要原因。
 *
 * 当前落点：ningbo-cowork（114.66.17.142）的 `/var/www/downloads/skills/`，经
 * nginx 已有的 `location /downloads/` alias 直发——**刻意复用既有段而不是新增
 * location**：那台机器同域还跑着付费的 sub2api 网关（`location /`，SSE 靠它的
 * buffering off + 3600s 超时），能不碰 nginx 就不碰。
 *
 * 清单与 zip 同目录，客户端拼 `<base>/<file>`（见 publish-ppt-skill.ts）。
 * 另注：**同域漏配路径不会 404**，会被 sub2api 的 SPA 兜底吃成 200 + text/html
 * ——排查这条链路时看 content-type，别只看状态码。
 */
const DEFAULT_BASE_URL = 'https://coworkapi.lizhiyun.net/downloads/skills'

/** 本地安装记账文件名（放在条目目录下，与 skill 内容同生共死）。 */
const INSTALL_META = '.ppt-skill.json'

const SKILL_ID = 'ppt-creator'

/**
 * preparePython 的输出停滞看门狗（毫秒）：pip 正常安装持续吐行
 * （PYTHONUNBUFFERED 已设），静默这么久只有两种解释——网络挂死，或者退化成了
 * python-runtime 组件本来要躲开的源码编译。比 componentWorker 下载看门狗的
 * 45s 宽松，因为 pip 解析依赖树本身有几十秒的合法静默。
 */
const PY_STALL_TIMEOUT_MS = 120_000
/** 绝对上限：逐行慢速输出会骗过停滞检测，这道是第二重兜底。 */
const PY_HARD_TIMEOUT_MS = 15 * 60_000

interface RemoteManifest {
  id: string
  version: string
  file: string
  /**
   * zip 的完整下载地址。清单与包不在同一处时由发布方写死——典型场景是
   * Gitee：公开仓库的 raw 文件**超过 10MB 就要求认证**，49MB 的包只能挂
   * Release 附件，而附件地址里带一个上传后才分配的 ID
   * （`/attach_files/<ID>/download/<name>`），没法由 base 拼出来。
   * 缺省时回落 `<base>/<file>` 的同目录拼接（自建静态源/CDN 的形态）。
   */
  url?: string
  sha256: string
  size: number
  unpackedSize: number
}

let status: PptSkillStatus = initialPptSkillStatus
/** 单飞：并发的 ensure() 共享同一次安装，不会下两遍 49MB。 */
let inflight: Promise<PptSkillStatus> | null = null

function setStatus(next: Partial<PptSkillStatus>): void {
  status = { ...status, ...next }
  broadcastPptSkillStatus(status)
}

function setPhase(phase: PptSkillPhase, extra: Partial<PptSkillStatus> = {}): void {
  setStatus({ phase, done: 0, total: 0, error: null, ...extra })
}

export function getPptSkillStatus(): PptSkillStatus {
  // 冷启动第一次被问起时先照一眼磁盘——否则 UI 会在「其实已经装好了」的机器上
  // 先闪一下未就绪态。
  if (status.phase === 'idle' && status.installedVersion === null) {
    const local = readInstalledVersion()
    if (local) status = { ...status, phase: 'ready', installedVersion: local }
  }
  return status
}

function baseUrl(): string {
  const env = process.env.PPT_SKILL_BASE_URL
  return (env && env.trim() ? env.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function installRoot(): string {
  const env = process.env.COWORK_PLUGINS_DIR
  if (env && env.trim()) return env.trim()
  return join(homedir(), '.cowork', 'plugins')
}

/**
 * .part 与 staging 的家。
 *
 * **必须与 installRoot 同分区**——worker 最后要把 staging `renameSync` 到安装
 * 目录，跨分区会直接 EXDEV 失败。所以它跟着 installRoot 走（后者可被
 * `COWORK_PLUGINS_DIR` 改写），而不是硬编码 `~/.cowork`。放在插件根的**兄弟**
 * 位置而不是里面，免得下载残留被插件扫描器看见。
 */
function cacheDir(): string {
  return join(dirname(installRoot()), 'ppt-skill-cache')
}

export function pptSkillDir(): string {
  return join(installRoot(), SKILL_ID, 'skills', SKILL_ID)
}

/** venv 落点，与 bin/ensure-python.sh 的 `PPT_MASTER_VENV_DIR` 约定同源。 */
function venvDir(): string {
  const env = process.env.PPT_MASTER_VENV_DIR
  if (env && env.trim()) return env.trim()
  return join(homedir(), '.ppt-master', 'venv')
}

/**
 * ppt-creator 的**实际**根目录，供所有读它资源的地方共用（模板库、图标库、
 * pptx_to_svg.py 等）。只认下载安装的那一份，**刻意没有 dev 回落**。
 *
 * 曾经有过一版「dev 下回落到仓库源码目录」，删掉了：那正是本次踩坑的根源。
 * 源码当时住在 `skills/` 下，而 `skills/` 是内置插件根——dev 于是凭空多出一个
 * `/claude-desktop:ppt-creator`，与下载装的 `/cowork:ppt-creator` 并存，
 * 开发者永远测不出真实用户「尚未安装」时的样子（CLAUDE.md 点名的
 * 「dev/prod 分叉 = dev 测不出的一整类 bug」）。现在源码搬到了 `skills-src/`，
 * dev 与 prod 走同一条路：都得下载。
 *
 * 要在本地改 skill 源码又免于反复打包，手动挂个软链即可（一次性）：
 *   ln -s <repo>/skills-src/ppt-creator ~/.cowork/plugins/ppt-creator/skills/ppt-creator
 *
 * 返回 null = 尚未安装，调用方应报「PPT 组件尚未安装」而不是拼一个不存在的
 * 路径去读文件（那会得到一堆 ENOENT，报错信息离真因十万八千里）。
 */
export function resolvePptSkillRoot(): string | null {
  const installed = pptSkillDir()
  return existsSync(join(installed, 'SKILL.md')) ? installed : null
}

function readInstalledVersion(): string | null {
  const metaPath = join(installRoot(), SKILL_ID, INSTALL_META)
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { version?: string }
    // 记账在但 skill 目录被手删 → 视为未安装，别让 UI 报「已就绪」然后
    // 在会话里以「命令不存在」的形式失败。
    if (!meta.version || !existsSync(join(pptSkillDir(), 'SKILL.md'))) return null
    return meta.version
  } catch {
    return null
  }
}

/**
 * 确保 skill 就绪：已是最新则立刻返回，否则下载→解压→预热 venv。
 * 并发调用共享同一次执行（单飞）。任何失败都收敛成 `phase:'error'` 的返回值，
 * 不 throw——调用方（IPC handler / 启动预热）拿到的就是终态。
 */
export function ensurePptSkill(opts: { force?: boolean } = {}): Promise<PptSkillStatus> {
  if (inflight) return inflight
  inflight = run(opts).finally(() => {
    inflight = null
  })
  return inflight
}

async function run(opts: { force?: boolean }): Promise<PptSkillStatus> {
  setPhase('checking', { installedVersion: readInstalledVersion() })

  let manifest: RemoteManifest
  try {
    const res = await fetchWithTimeout(`${baseUrl()}/${SKILL_ID}.json`, undefined, {
      timeoutMs: API_TIMEOUT_MS
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    manifest = (await res.json()) as RemoteManifest
    if (!manifest?.version || !manifest.file || !/^[0-9a-f]{64}$/.test(manifest.sha256 ?? '')) {
      throw new Error('清单格式不正确')
    }
  } catch (err) {
    const local = readInstalledVersion()
    if (local && !opts.force) {
      // 拉不到清单但本地已装：离线可用优先，直接放行，不要为了「检查更新」
      // 把一个能用的功能挡住。
      setStatus({ phase: 'ready', installedVersion: local, error: null, done: 0, total: 0 })
      return status
    }
    setStatus({
      phase: 'error',
      error: `获取安装信息失败：${err instanceof Error ? err.message : String(err)}`
    })
    return status
  }

  const local = readInstalledVersion()
  if (local === manifest.version && !opts.force) {
    // 已是最新，但 venv 未必建好（用户可能删过 ~/.ppt-master）——仍要过一遍
    // 预热，它自带哨兵文件，装好的情况下是秒过。
    return preparePython(manifest.version)
  }

  const ok = await downloadAndExtract(manifest)
  if (!ok) return status

  writeFileSync(
    join(installRoot(), SKILL_ID, INSTALL_META),
    `${JSON.stringify({ id: SKILL_ID, version: manifest.version, installedAt: Date.now() }, null, 2)}\n`,
    'utf-8'
  )

  // **升级后必须让依赖重新过一遍 pip**：ensure-python.sh 的短路条件是
  // 「venv 在 + .deps-ok 哨兵在」，命中就直接返回。于是新版本若改了
  // requirements.txt（加包/升版本），老用户升级后哨兵还在 → 依赖压根不会更新
  // → skill 运行时 import 新包直接 ModuleNotFoundError，而且错误现场在 Python
  // 里，离「你升级了但依赖没跟上」这个真因十万八千里。
  //
  // 删掉哨兵强制重跑。代价很小：pip 对已装好的包是 "Requirement already
  // satisfied" 秒过，只有真正新增/变更的包才会下载。
  rmSync(join(venvDir(), '.deps-ok'), { force: true })

  // **刚装好的 plugin 对已经 spawn 的 fusion-code 子进程是不可见的**：
  // plugins 列表在 openSession() 里读一次就烤死在子进程里（见 engine.ts 那段
  // "plugins are baked into the child at spawn" 注释）。而 app 启动时的后台
  // 预热会在下载完成前就把 runtime 起起来——于是用户等完进度条、发第一条
  // 消息，CLI 回的是 `Unknown command: /cowork:ppt-creator`，重开 app 才好。
  //
  // 回收让下一次 send 冷启动重新读 plugins。安全性由 restartRuntimesForBackendChange
  // 保证：跳过 in-flight 的回合、保留 sessions entry 与磁盘 transcript、置
  // pendingResume 让下次 send 带 --resume，历史一条不丢。同
  // applyClientEnvConfig 换网关 key 后的处理。
  await recycleAllEnginesRuntimes()

  return preparePython(manifest.version)
}

/** fork worker 做下载+校验+解压，把它的进度转成状态广播。 */
function downloadAndExtract(manifest: RemoteManifest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    setPhase('downloading', { total: manifest.size })
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'pptSkillWorker.js')
    // 绝对 url 优先（Gitee Release 附件这类异地托管），否则同目录拼接。
    const zipUrl = manifest.url?.trim() ? manifest.url.trim() : `${baseUrl()}/${manifest.file}`
    // 一整个 JSON 而不是位置参数：字段到 7 个已过位置参数的可读极限（同
    // componentWorker）。maxAttempts=3 —— 有断点续传兜底，重试的边际成本很低，
    // 但也不必无限试，三次还不成多半是源站或网络本身有问题。
    const child = utilityProcess.fork(workerPath, [
      JSON.stringify({
        url: zipUrl,
        installRoot: installRoot(),
        skillId: SKILL_ID,
        sha256: manifest.sha256,
        size: Number(manifest.size) || 0,
        cacheDir: cacheDir(),
        maxAttempts: 3
      })
    ])
    let settled = false
    child.on(
      'message',
      (msg: {
        type?: string
        phase?: 'downloading' | 'extracting'
        done?: number
        total?: number
        detail?: string
        attempt?: number
        delayMs?: number
        reason?: string
        ok?: boolean
        error?: string
      }) => {
        if (msg?.type === 'progress' && msg.phase) {
          setStatus({
            phase: msg.phase,
            done: msg.done ?? 0,
            total: msg.total ?? 0,
            // worker 用 detail 说明当前在干嘛（如校验阶段）；没给就清空，
            // 免得上一阶段的说明字残留在界面上。
            detail: msg.detail ?? ''
          })
        } else if (msg?.type === 'retry') {
          // 静默重试会被用户当成卡死——必须让界面说出正在发生什么。
          setStatus({
            detail: `连接中断，第 ${msg.attempt ?? 2} 次重试（${Math.round(
              (msg.delayMs ?? 0) / 1000
            )} 秒后）…`
          })
        } else if (msg?.type === 'done') {
          settled = true
          if (msg.ok) {
            resolve(true)
          } else {
            setStatus({ phase: 'error', error: msg.error ?? '安装失败' })
            resolve(false)
          }
        }
      }
    )
    // worker 崩溃（OOM/被杀）不会发 done——exit 兜底收敛，否则进度层永远转下去
    child.on('exit', () => {
      if (settled) return
      setStatus({ phase: 'error', error: '安装进程异常退出' })
      resolve(false)
    })
  })
}

/**
 * 预热 Python venv：跑 skill 自带的 bootstrap 脚本，把 `~/.ppt-master/venv`
 * 建好并 pip install 依赖。**这是三段里最慢的一段**（首次几分钟，之后靠
 * `.deps-ok` 哨兵秒过），把它纳入安装流程，用户看到的进度层结束时才是真的
 * 能用；否则会在进入会话后再干等一次且毫无提示。
 *
 * 脚本自身设计成可重入（就绪即秒返回），所以每次 ensure 都跑一遍是安全的。
 * 失败不算致命：venv 也可能在会话里由 skill 自己重试，所以这里降级为「已就绪
 * 但带一条错误说明」而不是把整个功能判死。
 */
async function preparePython(version: string): Promise<PptSkillStatus> {
  // 与运行时组件的 python-runtime ensure 汇合：任何触发路径（启动预热/用户点
  // PPT 入口/重试）都要等它跑完（下载完成，或判定系统 python 可用）再决定
  // base 解释器——否则会在下载还没完成前就拿到 pythonHome=null、回退系统
  // python，若用户机器是 3.13/3.14 就直接踩进 python-runtime 本来要躲开的
  // 源码编译卡死坑（2026-08 胶囊「一直显示」的根因之一）。
  // ensureRuntimeComponents 内部单飞，这里只是 join，已在跑的那次不会被
  // 重复触发；已经 ready（不管是下载来的还是检测到的系统 python）时秒过。
  await ensureRuntimeComponents()

  return new Promise<PptSkillStatus>((resolve) => {
    const skillDir = pptSkillDir()
    const isWin = process.platform === 'win32'
    const script = join(skillDir, 'bin', isWin ? 'ensure-python.cmd' : 'ensure-python.sh')
    if (!existsSync(script)) {
      setStatus({ phase: 'ready', installedVersion: version, error: null, done: 0, total: 0 })
      resolve(status)
      return
    }

    setPhase('preparing-python', { installedVersion: version, detail: '正在启动环境准备…' })
    const pythonHome = resolveEffectivePythonHome()
    const env = {
      ...process.env,
      ...(pythonHome ? { PPT_MASTER_PYTHON_HOME: pythonHome } : {}),
      // 让 pip 逐行吐进度而不是攒在缓冲区里——不设的话 stdout 非 tty 时会被
      // 块缓冲，用户盯着一个不动的界面等几分钟，最后所有输出一次性涌出来。
      PYTHONUNBUFFERED: '1'
    }

    let settled = false
    let stallTimer: ReturnType<typeof setInterval> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    let lastOutputAt = Date.now()

    const clearWatchdogs = (): void => {
      if (stallTimer) clearInterval(stallTimer)
      if (hardTimer) clearTimeout(hardTimer)
      stallTimer = null
      hardTimer = null
    }

    let stderr = ''
    // 行缓冲：chunk 边界不等于行边界，直接 split 会把一行劈成两半（尤其
    // pip 的长下载行），译出来的 detail 就会是半截包名。
    let pending = ''
    const tail: string[] = []
    let lastTick = 0

    /** 收到一行输出：更新 detail（认得出才更新）+ 追加日志尾巴，节流广播。 */
    const onLine = (raw: string): void => {
      const line = raw.replace(/\r$/, '')
      if (line.trim().length === 0) return
      tail.push(line)
      if (tail.length > PPT_SKILL_LOG_TAIL_LINES) tail.shift()

      const described = describePptBootstrapLine(line)
      const now = Date.now()
      // 认出新动作立刻推（用户要的就是这个反馈），其余按 200ms 节流——
      // pip 一次安装能吐上千行，逐行广播只会把 IPC 打爆、反过来拖慢主进程。
      if (described || now - lastTick >= 200) {
        lastTick = now
        setStatus({
          detail: described ?? status.detail,
          logTail: [...tail]
        })
      }
    }

    const feed = (chunk: Buffer): void => {
      lastOutputAt = Date.now()
      pending += chunk.toString()
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) onLine(line)
    }

    /** 幂等收敛：error/exit/看门狗/spawn 同步 throw 四个入口都可能调用它，
     *  只有第一次真正生效——否则 setStatus 会被后到者的文案覆盖。 */
    function finish(error: string | null): void {
      if (settled) return
      settled = true
      clearWatchdogs()
      // 冲掉行缓冲里最后一截没换行的输出（脚本正常结束时常留一行没 \n）。
      if (pending.trim().length > 0) onLine(pending)
      pending = ''
      setStatus({
        phase: 'ready',
        installedVersion: version,
        error,
        done: 0,
        total: 0,
        // 成功就把过程文案收掉；失败保留日志尾巴——那几行原文是排查的唯一线索。
        detail: error ? '环境准备未完成' : '',
        logTail: error ? [...tail] : []
      })
      resolve(status)
    }

    /** 看门狗触发时杀掉整个进程树，不只是直接子进程——mac 侧 bash 之下还挂着
     *  pip/编译器，只杀 bash 会留下孤儿进程继续烧 CPU 到用户手动结束任务。 */
    function killProcessTree(child: ReturnType<typeof spawn>): void {
      try {
        if (isWin) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else if (child.pid) {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch {
        /* 进程可能已经自己退出了，忽略 */
      }
    }

    let child: ReturnType<typeof spawn>
    try {
      // Windows 的 .cmd 不能裸 spawn：Node ≥18.20.2（CVE-2024-27980 收紧后）
      // 禁止不带 shell 执行 .cmd/.bat，会**同步 throw** EINVAL（不是 emit
      // 'error'！）——本仓 cliDetect.ts 的 resolveSystemClaudeJsEntry 早就
      // 踩过同一个坑并写了注释，这里当时没跟上，是 Windows 上胶囊永远不消失
      // 的确定性根因。用 cmd.exe /c 显式起一层 shell 解决。
      //
      // mac 的 .sh 必须 source（它靠 export PPT_PY 回灌调用方 shell），直接
      // 执行拿不到结果——但这里只关心副作用（venv 建好），source 完即可退出。
      // detached:true 让它自成进程组，供上面的看门狗连子子进程一起杀。
      child = isWin
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', script], { env, windowsHide: true })
        : spawn('bash', ['-c', `source ${JSON.stringify(script)}`], { env, detached: true })
    } catch (err) {
      finish(`Python 环境准备失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    stallTimer = setInterval(() => {
      if (Date.now() - lastOutputAt > PY_STALL_TIMEOUT_MS) {
        killProcessTree(child)
        finish('Python 环境准备超时（输出停滞超过 2 分钟），已中止。可稍后在 PPT 入口重试。')
      }
    }, 10_000)
    hardTimer = setTimeout(() => {
      killProcessTree(child)
      finish('Python 环境准备超时（超过 15 分钟），已中止。可稍后在 PPT 入口重试。')
    }, PY_HARD_TIMEOUT_MS)

    child.stdout?.on('data', feed)
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString()
      // stderr 同样进日志尾巴：pip 的报错、编译警告都走这里，只收 stdout
      // 会让失败现场在 UI 上一片空白。
      feed(b)
    })
    child.on('error', (err) => {
      finish(`Python 环境准备失败：${err.message}`)
    })
    child.on('exit', (code) => {
      finish(code === 0 ? null : `Python 环境准备失败（退出码 ${code}）：${stderr.slice(-300)}`)
    })
  })
}

/**
 * 应用启动后的后台预热。刻意 fire-and-forget 且不挡任何 UI——只挡 PPT 入口
 * 是用户拍板的产品决策，这里只是让「点进去时多半已经好了」成为常态。
 */
export function warmPptSkillInBackground(): void {
  if (readInstalledVersion() && status.phase === 'idle') {
    // 已装：仍跑一次 ensure 以便检查更新与补建 venv，但状态先置就绪，
    // 免得 UI 在后台检查期间把入口挡住。
    setStatus({ phase: 'ready', installedVersion: readInstalledVersion(), error: null })
  }
  void ensurePptSkill().catch((err: unknown) => {
    console.error('[pptSkill] background warm failed', err)
  })
}
