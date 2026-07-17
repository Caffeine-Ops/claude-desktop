// 通用组件安装编排器：整张 ComponentTable 的唯一写手 + 按档案卡 strategy 分派到三种实现。
// 泛化自 kbModelDownloader（单模型）——那份薄壳在收尾任务里退役。
//
// 分账铁律（承接 b5636bb3）：安装「成功」与「成功后的业务收尾（重热 embed / 重建索引）」分开——
// 收尾挂 per-id SUCCESS_HOOKS 钩子表、单独 try 包住，失败不把已成功安装翻成 error；且收尾副作用
// 不泄进通用编排逻辑（只 embed 有）。
import { existsSync } from 'node:fs'
import {
  initialComponentState, type ComponentState, type ComponentTable,
} from '../../../shared/componentDownload'
import {
  COMPONENT_REGISTRY, getComponentDescriptor, EMBED_COMPONENT_ID,
} from '../../core/componentRegistry'
import { installComponent, isComponentInstalled } from './hostedFilesInstaller'
import { installMarkitdown, detectTooling } from '../../core/kbTooling'
import { kbModelDir } from '../../core/kbModelDir'
import { resetEmbedWorker, warmEmbedWorker } from '../../core/kbSemanticSearch'
import { scheduleKbBuild } from '../../core/kbBuildRunner'
import { kbStoreHasDocs } from '../../core/kbIndexStore'

// 纯函数（applyComponentPatch/mapPipxResult）已拆进 componentOrchestrator.core.ts（electron-free，
// bun test 可直测，不必再靠 mock.module 打桩 'electron' 绕开本文件顶层的 electron 依赖链）。
// re-export 保住对外契约：后续任务仍从 './componentOrchestrator' import 这两个名字。
export { applyComponentPatch, mapPipxResult } from './componentOrchestrator.core'
import { applyComponentPatch, mapPipxResult } from './componentOrchestrator.core'

// ── 状态单例 + 广播 ────────────────────────────────────────────────

let table: ComponentTable = Object.fromEntries(
  COMPONENT_REGISTRY.map((d) => [d.id, initialComponentState(d.id)]),
)
type Listener = (t: ComponentTable) => void
const listeners = new Set<Listener>()

export function onComponentStatus(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export function getComponentTable(): ComponentTable {
  return table
}
function patch(id: string, p: Partial<ComponentState>): void {
  table = applyComponentPatch(table, id, p)
  for (const cb of listeners) cb(table)
}

// 成功收尾钩子（只 embed 有）：下载成功后重热 worker + 有文档则重建索引。不泄进通用逻辑。
const SUCCESS_HOOKS: Record<string, () => void> = {
  [EMBED_COMPONENT_ID]: () => {
    resetEmbedWorker()
    warmEmbedWorker()
    if (kbStoreHasDocs()) scheduleKbBuild()
  },
}

// 探测后覆盖状态的公共规则（hosted-files/archive 与 pipx 共用）：
// - 探到「已就绪」→ 落 ready（清空 percent/currentFile/errorMessage）。这是唯一能覆盖
//   error/unavailable 的情形——用户手动装好了，理应转正。
// - 没探到「未就绪」→ **保留** installing/error/unavailable 三态原样（连同 errorMessage）不动；
//   refresh 会在每次 status-get 前跑（Task 4 接线），若在此处也把 error 抹掉，用户永远看不到
//   失败原因（下载失败→error→切走设置页再切回→refresh→error 被抹成 idle）。其余（idle/ready，
//   即之前 ready 但磁盘上的东西被用户删了）才落 idle——正确地把已失效的 ready 降级。
//   基线 kbModelDownloader.refreshKbModelInstalled 写的是
//   `phase: installed ? 'ready' : state.phase`，同样刻意保留非 ready 态，这里对齐同一语义。
function applyDetectedStatus(id: string, ready: boolean): void {
  // 正在装的格由 run() 独占写：探测既不该把它降级、也不该提前转正（提前转正会清空 percent，
  // UI 在装完前一直显示「已就绪」）。双向守卫，勿只挡一边。
  if (table[id]?.status === 'installing') return
  if (ready) {
    patch(id, { status: 'ready', percent: null, currentFile: null, errorMessage: null })
    return
  }
  const cur = table[id]?.status
  if (cur === 'error' || cur === 'unavailable') return // 保留原态，不覆盖（installing 已在函数顶部早返回挡掉）
  patch(id, { status: 'idle', percent: null, currentFile: null, errorMessage: null })
}

// detectTooling() 是 execFileSync + timeout:4000 × 两个探针（markitdown/soffice）＝最坏约 8 秒
// 同步阻塞主进程（阻塞期间所有窗口 + IPC 都卡住）。只应由 status-get 这类用户触发的懒路径
// 调用；不可挂在启动路径上（会卡住 splash 交接，见 CLAUDE.md 启动里程碑一段）。
//
// 但「用户触发」不等于「只触发一次」：<ComponentPrompt /> 常挂 App 根，它的 init() 无条件调
// componentStatusGet()，于是每个 studio tab 首帧后都会发一次；四个消费方各自 init() 又互相
// 不去重（前端那侧的去重见 stores/components.ts 的 fetchSnapshotOnce，但那只挡得住同一个
// 渲染进程内的并发 in-flight 请求，挡不住「先后两次都各自等到了上一次已经 resolve」的情形，
// 也挡不住不同 tab/不同窗口各发各的）。冷开一个挂了知识库管理页的窗口，实测能背靠背触发
// 2~3 次完整 detect；装了 LibreOffice 的机器上 `soffice --version` 还会真起一次 LibreOffice
// 进程，主进程同步等它——首帧后全窗口卡顿、splash 交接期 IPC 停摆（终审 Important 3）。
// TTL 就是这道防线的兜底：距上次真正探测不足 TTL 就直接跳过、复用现表，不管调用方是谁、
// 隔了几个 tab。安全性：安装成功后的状态由 run() 直接 patch、不依赖这里的探测结果，所以
// TTL 不会让「刚装好却仍显示没装」——它只影响「用户在别处手动装好/卸载了，我们多久才发现」，
// 30s 对这种小概率的手动操作完全够用。
const REFRESH_TTL_MS = 30_000
let lastRefreshAt = 0

/** 探测磁盘/工具链，重设整表就绪态（启动时 + 每次 status-get 前调，TTL 内的重复调用直接跳过）。 */
export function refreshComponentInstalled(): void {
  const now = Date.now()
  if (now - lastRefreshAt < REFRESH_TTL_MS) return
  lastRefreshAt = now
  const t = detectTooling() // { markitdown, soffice }
  for (const d of COMPONENT_REGISTRY) {
    const i = d.install
    if (i.kind === 'files' || i.kind === 'archive') {
      applyDetectedStatus(d.id, isComponentInstalled(d, kbModelDir(), existsSync))
    } else if (i.kind === 'pipx') {
      // 本期唯一 pipx 组件是 markitdown，探测写死 t.markitdown；加第二个 pipx 组件时须按
      // 档案卡 probeCmd 分派探测，勿再写死——本期 YAGNI。
      applyDetectedStatus(d.id, t.markitdown)
    } else {
      // 本期唯一 detect-only 组件是 soffice，探测写死 t.soffice；加第二个时须按档案卡
      // probeCmd 分派探测，勿再写死——本期 YAGNI。
      // detect-only 状态纯由探测派生（探到→ready、没探到→unavailable），两个值本就是探测
      // 结论，不需要上面 applyDetectedStatus 的「保留」逻辑。
      patch(d.id, { status: t.soffice ? 'ready' : 'unavailable', percent: null, currentFile: null, errorMessage: null })
    }
  }
}

// ── 安装编排（io，靠 typecheck + 手动验证）────────────────────────

const inFlight = new Set<string>()
const controllers = new Map<string, AbortController>()

/** 触发某组件安装；触发即返回，进度经广播推。detect-only 无此动作（UI 不给按钮）。 */
export function startComponentInstall(id: string): void {
  if (inFlight.has(id)) return
  const d = getComponentDescriptor(id)
  if (!d) return
  if (d.install.kind === 'detect-only') return // 装不了，UI 不该触发
  inFlight.add(id)
  void run(id).finally(() => { inFlight.delete(id); controllers.delete(id) })
}

async function run(id: string): Promise<void> {
  const d = getComponentDescriptor(id)!
  const i = d.install
  patch(id, { status: 'installing', percent: i.kind === 'files' || i.kind === 'archive' ? 0 : null, currentFile: null, errorMessage: null })

  try {
    if (i.kind === 'files' || i.kind === 'archive') {
      const controller = new AbortController()
      controllers.set(id, controller)
      await installComponent(d, kbModelDir(), controller.signal, (p) => {
        patch(id, { percent: p.percent, currentFile: p.currentFile })
      })
      patch(id, { status: 'ready', percent: 100, currentFile: null })
    } else {
      // pipx：无字节进度（percent 恒 null），不可取消。本期唯一 pipx 组件是 markitdown，
      // 装法写死 installMarkitdown()、没读档案卡的 PipxInstall.pkg；加第二个 pipx 组件时须
      // 按 pkg 分派装法，勿再写死——本期 YAGNI。
      const r = await installMarkitdown()
      const { status, errorMessage } = mapPipxResult(r)
      patch(id, { status, percent: null, currentFile: null, errorMessage })
      if (status !== 'ready') return // 失败/装不了：不跑收尾
    }
    // 成功收尾（锦上添花，隔离 try）：失败不把已成功安装翻成 error。
    try { SUCCESS_HOOKS[id]?.() } catch { /* 收尾失败：安装仍算成功，降级链兜底 */ }
  } catch (err) {
    // hosted-files 取消：controller.abort() 落这。回未装/已装态，不当错误。
    if (controllers.get(id)?.signal.aborted) {
      const installed = isComponentInstalled(d, kbModelDir(), existsSync)
      patch(id, { status: installed ? 'ready' : 'idle', percent: null, currentFile: null, errorMessage: null })
    } else {
      patch(id, { status: 'error', currentFile: null, errorMessage: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** 取消进行中的安装（仅 hosted-files 真能取消；其余 no-op）。 */
export function cancelComponentInstall(id: string): void {
  controllers.get(id)?.abort()
}
