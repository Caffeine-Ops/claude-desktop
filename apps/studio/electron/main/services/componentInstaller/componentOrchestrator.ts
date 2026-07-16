// 通用组件安装编排器：整张 ComponentTable 的唯一写手 + 按档案卡 strategy 分派到三种实现。
// 泛化自 kbModelDownloader（单模型）——那份薄壳在收尾任务里退役。
//
// 分账铁律（承接 b5636bb3）：安装「成功」与「成功后的业务收尾（重热 embed / 重建索引）」分开——
// 收尾挂 per-id SUCCESS_HOOKS 钩子表、单独 try 包住，失败不把已成功安装翻成 error；且收尾副作用
// 不泄进通用编排逻辑（只 embed 有）。
import { existsSync } from 'node:fs'
import {
  initialComponentState, type ComponentState, type ComponentStatus, type ComponentTable,
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
import type { KbToolingInstallResult } from '../../../shared/kbAdmin'

// ── 纯函数（可单测）────────────────────────────────────────────────

/** 不可变地更新一格；未知 id 先补初态。 */
export function applyComponentPatch(
  table: ComponentTable, id: string, patch: Partial<ComponentState>,
): ComponentTable {
  const cur = table[id] ?? initialComponentState(id)
  return { ...table, [id]: { ...cur, ...patch } }
}

/** pipx 安装结果 → 状态标签。unsupported=缺 python 前置（装不了）；普通失败带 log 摘要供排查。 */
export function mapPipxResult(r: KbToolingInstallResult): { status: ComponentStatus; errorMessage: string | null } {
  if (r.ok) return { status: 'ready', errorMessage: null }
  if (r.unsupported) return { status: 'unavailable', errorMessage: null }
  const tail = (r.log || '').trim().slice(-400) // 只留尾部摘要，别把整段日志塞状态
  return { status: 'error', errorMessage: tail || '安装失败' }
}

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

/** 探测磁盘/工具链，重设整表就绪态（启动时 + 每次 status-get 前调）。 */
export function refreshComponentInstalled(): void {
  const t = detectTooling() // { markitdown, soffice }
  for (const d of COMPONENT_REGISTRY) {
    const i = d.install
    let status: ComponentStatus
    if (i.kind === 'files' || i.kind === 'archive') {
      status = isComponentInstalled(d, kbModelDir(), existsSync) ? 'ready' : 'idle'
    } else if (i.kind === 'pipx') {
      status = t.markitdown ? 'ready' : 'idle'
    } else {
      status = t.soffice ? 'ready' : 'unavailable' // detect-only：没探到 = 需手动
    }
    // 正在装的格别被探测覆盖（探测在装的中途可能仍为 false）。
    if (table[d.id]?.status !== 'installing') patch(d.id, { status, percent: null, currentFile: null, errorMessage: null })
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
      // pipx：无字节进度（percent 恒 null），不可取消。
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
