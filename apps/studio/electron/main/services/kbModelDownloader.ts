// kb 嵌入模型「首次运行时下载」——把 bge 模型从 HuggingFace 下到 userData/kb-model/。
// 为何在此而非打包时：正式安装包从不含模型（见 kbModelDir.ts 头注释），生产语义检索因此
// 永久降级 BM25。改为运行时下载后模型落可写的 userData，安装包不撑大、CI 不需联网。
//
// 本文件现为薄壳：实际下载/校验/落盘编排已收拢进通用组件下载引擎
// （componentRegistry.ts 的档案卡 + componentInstaller/hostedFilesInstaller.ts 的 installComponent），
// P1a 把 embed 迁到通用引擎，此文件只负责保持对外导出签名不变（IPC/UI 零改动）并接住
// 下载成功后的业务收尾（重热 embed worker / 有文档则重建索引）。
import { existsSync } from 'node:fs'
import { INITIAL_KB_MODEL_DOWNLOAD_STATE, type KbModelDownloadState } from '../../shared/kbModelDownload'
import { getComponentDescriptor, EMBED_COMPONENT_ID } from '../core/componentRegistry'
import { isComponentInstalled, installComponent } from './componentInstaller/hostedFilesInstaller'
import { kbModelDir } from '../core/kbModelDir'
import { resetEmbedWorker, warmEmbedWorker } from '../core/kbSemanticSearch'
import { scheduleKbBuild } from '../core/kbBuildRunner'
import { kbStoreHasDocs } from '../core/kbIndexStore'

const embedDescriptor = getComponentDescriptor(EMBED_COMPONENT_ID)!

let state: KbModelDownloadState = { ...INITIAL_KB_MODEL_DOWNLOAD_STATE }

type Listener = (s: KbModelDownloadState) => void
const listeners = new Set<Listener>()

/** 订阅状态推送。返回 unsubscribe。 */
export function onKbModelDownload(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function setState(patch: Partial<KbModelDownloadState>): void {
  state = { ...state, ...patch }
  for (const cb of listeners) cb(state)
}

export function getKbModelDownloadState(): KbModelDownloadState {
  return state
}

/** 模型是否已就绪：判据等价于原 onnx 权重存在——embed 档案卡的 readyCheck 就是该路径。 */
export function isKbModelInstalled(): boolean {
  return isComponentInstalled(embedDescriptor, kbModelDir(), existsSync)
}

/** 启动时刷新 installed 旗标，让设置页首帧就知道要不要显示「下载」。 */
export function refreshKbModelInstalled(): void {
  const installed = isKbModelInstalled()
  setState({ installed, phase: installed ? 'ready' : state.phase })
}

let downloading = false
let cancelled = false
let controller: AbortController | null = null

/**
 * 触发首次下载。委托通用引擎 installComponent（临时 .part → 精确尺寸 + sha256 校验 →
 * rename 到位，已存在且 sha 匹配则幂等跳过，`.part` 残留清理已在引擎内部完成）。
 * 全部成功后 resetEmbedWorker + warmEmbedWorker +（有文档才）scheduleKbBuild 重建向量——
 * 这段收尾是"锦上添花"，单独 try 包住，失败不把已成功的下载翻成 error（现有降级链继续兜底）。
 * 失败：phase='error'；取消：回未安装态、不当错误。
 */
export async function startKbModelDownload(): Promise<void> {
  if (downloading) return
  downloading = true
  try {
    cancelled = false
    controller = new AbortController()
    setState({ phase: 'downloading', percent: 0, currentFile: null, errorMessage: null })

    await installComponent(embedDescriptor, kbModelDir(), controller.signal, (p) => {
      setState({ percent: p.percent, currentFile: p.currentFile })
    })

    setState({ phase: 'ready', percent: 100, currentFile: null, installed: true })
    // 下载已落盘成功；下面的重热/重建是"锦上添花"，其失败不该把已成功的下载翻成 error
    // （建库本身已有降级）。故单独 try 包住（承接 b5636bb3）。
    try {
      resetEmbedWorker()
      warmEmbedWorker()
      if (kbStoreHasDocs()) scheduleKbBuild()
    } catch {
      // 重热/重建失败：下载仍视为成功，降级链兜底，不改 state。
    }
  } catch (err) {
    if (cancelled) {
      // 用户主动取消：回到未安装/已安装态，不当错误。
      const installed = isKbModelInstalled()
      setState({ phase: installed ? 'ready' : 'idle', percent: 0, currentFile: null, errorMessage: null, installed })
    } else {
      setState({ phase: 'error', currentFile: null, errorMessage: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    downloading = false
    controller = null
  }
}

/** 取消进行中的下载（无下载时 no-op）。abort 当前请求，落进 startKbModelDownload 的取消分支。 */
export function cancelKbModelDownload(): void {
  if (!downloading) return
  cancelled = true
  controller?.abort()
}
