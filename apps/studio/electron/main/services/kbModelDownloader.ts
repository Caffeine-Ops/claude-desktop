// kb 嵌入模型「首次运行时下载」——把 bge 模型从 HuggingFace 下到 userData/kb-model/。
// 为何在此而非打包时：正式安装包从不含模型（见 kbModelDir.ts 头注释），生产语义检索因此
// 永久降级 BM25。改为运行时下载后模型落可写的 userData，安装包不撑大、CI 不需联网。
//
// 网络用 node:https 不用 fetch：环境常有 SSL-MITM 代理，node https 自动尊重 NODE_EXTRA_CA_CERTS；
// 下载核心（跟随重定向 + sha256 校验 + 幂等跳过）移植自 scripts/prebundle-kb-model.mjs，但跑在运行时
// main 进程，并加了：字节进度回调、临时文件 rename（防半截被当成功）、每请求 60s 超时（防卡死）、
// AbortController 取消。**故意不调 HF /api/models 端点**——版本号钉在 manifest（那个 API 正是
// 2026-07-06 害死 CI 下载的元凶），少一个失败点。
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { KB_MODEL_ID } from '../../shared/kbIndex'
import { INITIAL_KB_MODEL_DOWNLOAD_STATE, type KbModelDownloadState } from '../../shared/kbModelDownload'
import { KB_DOWNLOADABLE_MODELS } from '../core/kbModelManifest'
import { kbModelDir } from '../core/kbModelDir'
import { resetEmbedWorker, warmEmbedWorker } from '../core/kbSemanticSearch'
import { scheduleKbBuild } from '../core/kbBuildRunner'
import { kbStoreHasDocs } from '../core/kbIndexStore'

/** 单请求无数据超时（毫秒）：连上但不传数据也不会永久卡死。 */
const DOWNLOAD_TIMEOUT_MS = 60_000

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

/** 模型是否已就绪：判据与 kbBuildWorker 的 modelReady 完全一致（onnx 权重存在）。 */
export function isKbModelInstalled(): boolean {
  return existsSync(join(kbModelDir(), KB_MODEL_ID, 'onnx', 'model_quantized.onnx'))
}

/** 启动时刷新 installed 旗标，让设置页首帧就知道要不要显示「下载」。 */
export function refreshKbModelInstalled(): void {
  const installed = isKbModelInstalled()
  setState({ installed, phase: installed ? 'ready' : state.phase })
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

// 下载 url → filePath，跟随重定向、流式落盘，每收到数据块回调字节数（进度）。
// signal：AbortController.signal，abort 时请求报错 → 上层落进取消分支。
// setTimeout：DOWNLOAD_TIMEOUT_MS 内无数据即 destroy 请求（防连上却不传数据的永久卡死）。
function downloadFile(
  url: string,
  filePath: string,
  signal: AbortSignal,
  onBytes: (n: number) => void,
  maxRedirects = 10
): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string, remaining: number): void => {
      const req = https.get(u, { signal }, (res) => {
        const code = res.statusCode ?? 0
        const loc = res.headers.location
        if ([301, 302, 303, 307, 308].includes(code) && loc) {
          if (remaining <= 0) return reject(new Error(`Too many redirects for ${url}`))
          // location 极少是数组；收窄成 string 传下一跳。
          return follow(Array.isArray(loc) ? loc[0] : loc, remaining - 1)
        }
        if (code !== 200) return reject(new Error(`HTTP ${code} from ${u}`))
        const ws = createWriteStream(filePath)
        res.on('data', (c: Buffer) => onBytes(c.length))
        res.pipe(ws)
        ws.on('finish', () => resolve())
        ws.on('error', reject)
        res.on('error', reject)
      })
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('下载超时（60s 无响应）')))
      req.on('error', reject)
    }
    follow(url, maxRedirects)
  })
}

let downloading = false
let cancelled = false
let controller: AbortController | null = null

/**
 * 触发首次下载。按 KB_DOWNLOADABLE_MODELS 循环（P1 reranker 零改动复用）。
 * 每文件：临时 .part 下载 → 精确尺寸 + sha256 校验 → rename 到位（防半截被当成功）；已存在且 sha
 * 匹配则幂等跳过。全部成功后 resetEmbedWorker + warmEmbedWorker +（有文档才）scheduleKbBuild 重建向量。
 * 失败：phase='error'；取消：回未安装态、不当错误。两者都清残留 .part。现有降级链继续兜底，不崩不空。
 */
export async function startKbModelDownload(): Promise<void> {
  if (downloading) return
  downloading = true
  cancelled = false
  controller = new AbortController()
  setState({ phase: 'downloading', percent: 0, currentFile: null, errorMessage: null })

  // 进度分母 = 所有文件真实字节数之和（onnx 24MB 占绝对多数，进度条精确跟大文件走，不会早跳 100%）。
  const totalBytes = KB_DOWNLOADABLE_MODELS.flatMap((m) => m.files).reduce((sum, f) => sum + f.size, 0)
  let doneBytes = 0
  let currentTmp: string | null = null
  const pushPercent = (): void => setState({ percent: Math.min(100, Math.round((doneBytes / totalBytes) * 100)) })

  try {
    for (const model of KB_DOWNLOADABLE_MODELS) {
      const destRoot = join(kbModelDir(), model.dirName)
      for (const file of model.files) {
        const dest = join(destRoot, file.relPath)
        // 幂等：已存在且 sha 匹配则跳过（累加真实 size 让进度不倒退）。
        if (existsSync(dest) && (await sha256File(dest)) === file.sha256) {
          doneBytes += file.size
          pushPercent()
          continue
        }
        setState({ currentFile: file.relPath })
        mkdirSync(dirname(dest), { recursive: true })
        const tmp = `${dest}.part`
        currentTmp = tmp
        const base = doneBytes
        await downloadFile(
          `https://huggingface.co/${model.hfRepo}/resolve/${model.revision}/${file.relPath}`,
          tmp,
          controller.signal,
          (n) => {
            doneBytes += n
            pushPercent()
          }
        )
        // 校验：精确尺寸 + sha256，任一不符删临时文件并抛（不留半截污染幂等跳过）。
        const size = statSync(tmp).size
        const sha = await sha256File(tmp)
        if (size !== file.size || sha !== file.sha256) {
          rmSync(tmp, { force: true })
          throw new Error(`模型文件校验失败：${file.relPath}`)
        }
        renameSync(tmp, dest)
        currentTmp = null
        // 用真实 size 对齐进度（下载回调是流式累加，rename 后归位到 base+size）。
        doneBytes = base + file.size
        pushPercent()
      }
    }
    setState({ phase: 'ready', percent: 100, currentFile: null, installed: true })
    // 模型就绪：回收旧 worker 重热；有知识库文档才触发重建（守卫照 index.ts:302 现有模式）。
    resetEmbedWorker()
    warmEmbedWorker()
    if (kbStoreHasDocs()) scheduleKbBuild()
  } catch (err) {
    if (currentTmp) rmSync(currentTmp, { force: true }) // 清掉中断留下的半截 .part
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
