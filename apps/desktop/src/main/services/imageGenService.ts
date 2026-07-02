/**
 * 主进程出图 service。移植 ~/.claude/skills/gpt-image-2（generate.js/edit.js/shared.js）
 * 的出图逻辑到 app 内——因为要分发给终端用户，不能 spawn 本机脚本 + ~/.codex 凭据。
 *
 * 端点（OpenAI 兼容）：
 *   文生图  POST {baseURL}/images/generations   JSON  { model, prompt, size?, quality? }
 *   改图    POST {baseURL}/images/edits          multipart  image + prompt + model + size? + quality?
 * 响应：data[0].b64_json（优先）或 data[0].url（回落下载）。
 * 健壮性：每模型最多 MAX_ATTEMPTS_PER_MODEL 次；5xx/网络错重试；模型间降级
 *   gpt-image-2 → gpt-image-1.5 → gpt-image-1。对话端点能用 ≠ 图像端点同时可用。
 */

import { extForImageMime } from '../../shared/imageMime'
import type { ProposalImageApiConfig } from '../../shared/ipc-channels'

/**
 * 出图凭据配置。直接复用 shared 的 IPC 类型而非再声明一份结构双胞胎（评审发现：两份
 * 「字段同构、handler 透传」的定义靠人肉同步，单侧加字段时结构化类型照样编译、新字段
 * 却静默不过 IPC/不落盘）。方向是 main import shared（合法依赖），不是反过来。
 */
export type ImageApiConfig = ProposalImageApiConfig

const DEFAULT_DOWNGRADE = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1']
const MAX_ATTEMPTS_PER_MODEL = 3

/** 图像端点需要 /vN 前缀，而中转网关 base_url 常只到域名。去尾斜杠；末段已是 /vN 则保留，否则补 /v1。 */
export function normalizeBaseUrl(url: string): string {
  const stripped = url.trim().replace(/\/+$/, '')
  if (/\/v\d+$/.test(stripped)) return stripped
  return `${stripped}/v1`
}

export function buildModelList(startModel: string): string[] {
  const seq = [startModel, ...DEFAULT_DOWNGRADE]
  return [...new Set(seq.filter(Boolean))]
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRetryable(err: unknown): boolean {
  return /Image API error \(5\d\d\)|upstream|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|EAI_AGAIN/i.test(
    errMsg(err)
  )
}

/**
 * 与模型无关的致命错误（凭据/权限）。换模型必然同错，须立即中止整条降级链——否则坏 key
 * 场景下改图会对着 401 连传三次多 MB multipart 才报同一个错（评审发现）。429 不算：限流
 * 可能是按模型配额，降级换模型仍有意义。
 */
function isFatal(err: unknown): boolean {
  return /Image API error \((401|403)\)/.test(errMsg(err))
}

/**
 * 重试间线性退避（1.5s、3s）。draw.js 原版就有 `sleep(1500 * attempt)`，移植时被静默丢掉
 * ——没有退避的「重试」全打在同一个 5xx 故障窗内，形同虚设（评审发现，属移植回归）。
 * sleepImpl 可注入：测试里换成立即 resolve，免得 502 重试用例真等 4.5 秒。
 */
const RETRY_BACKOFF_BASE_MS = 1500
let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
export function __setSleepForTest(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn
}

async function postJson(url: string, apiKey: string, payload: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`Image API error (${res.status}): ${await res.text()}`)
  return res.json()
}

async function postMultipart(url: string, apiKey: string, form: FormData): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form
  })
  if (!res.ok) throw new Error(`Image API error (${res.status}): ${await res.text()}`)
  return res.json()
}

async function extractBytes(json: unknown): Promise<Buffer> {
  const first = (json as { data?: Array<{ b64_json?: string; url?: string }> })?.data?.[0]
  if (!first) throw new Error('API 响应缺 data[0]')
  if (first.b64_json) return Buffer.from(first.b64_json, 'base64')
  if (first.url) {
    const res = await fetch(first.url)
    if (!res.ok) throw new Error(`下载生成图失败 (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('API 响应既无 b64_json 也无 url')
}

/** 对每个候选模型重试若干次，失败则降级到下一模型；全败则抛错。 */
async function withModelDowngrade(
  cfg: ImageApiConfig,
  call: (model: string) => Promise<unknown>
): Promise<Buffer> {
  const models = buildModelList(cfg.model)
  const failures: string[] = []
  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        return await extractBytes(await call(model))
      } catch (err) {
        failures.push(`${model}#${attempt}: ${errMsg(err).slice(0, 120)}`)
        if (isFatal(err)) {
          throw new Error(`出图 API 认证失败，请检查设置里的 key 与地址。${failures[failures.length - 1]}`)
        }
        if (!isRetryable(err)) break // 非 5xx（如 400 提示词违规）不重试、直接换下一模型
        if (attempt < MAX_ATTEMPTS_PER_MODEL) await sleepImpl(RETRY_BACKOFF_BASE_MS * attempt)
      }
    }
  }
  throw new Error(
    `所有模型都失败了（${models.join(', ')}）。多半是中转网关图像后端临时 5xx。\n${failures.join('\n')}`
  )
}

/**
 * 产出字节的真实格式（魔数嗅探）。API 的 url 兜底分支下载 CDN 图时不看 content-type，
 * 字节可能是 jpeg/webp——若一律落 .png，docx ImageRun 按扩展名声明媒体类型，Word 收到
 * 错标字节（WebP-as-PNG 直接裂图），且再改这张图时 sourceMime 也会跟着错（评审发现）。
 * 识别不了返回 null，由调用方决策。
 */
export function sniffImageExt(bytes: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
    return 'webp'
  return null
}

export async function generateImage(
  cfg: ImageApiConfig,
  opts: { prompt: string; size?: string; quality?: string }
): Promise<Buffer> {
  const url = `${normalizeBaseUrl(cfg.baseURL)}/images/generations`
  return withModelDowngrade(cfg, (model) => {
    const payload: Record<string, unknown> = { model, prompt: opts.prompt }
    if (opts.size) payload.size = opts.size
    if (opts.quality) payload.quality = opts.quality
    return postJson(url, cfg.apiKey, payload)
  })
}

/** sourceMime → multipart 文件名后缀，'source.png' 硬编码会把 jpg/webp 源图错误贴成 png 扩展名。
 *  逆映射收口在 shared/imageMime.ts（此前全仓四份手抄映射，加格式要同步四处）。 */
function multipartFileName(sourceMime: string): string {
  return `source.${extForImageMime(sourceMime)}`
}

export async function editImage(
  cfg: ImageApiConfig,
  opts: { prompt: string; sourceBytes: Buffer; sourceMime: string; size?: string; quality?: string }
): Promise<Buffer> {
  const url = `${normalizeBaseUrl(cfg.baseURL)}/images/edits`
  // Blob 不可变、可跨 attempt 复用；FormData 必须每次请求新建。放在闭包外只拷贝一次源图字节，
  // 否则重试/降级最多 9 次 attempt 每次都白拷贝整张多 MB 源图（评审发现）。
  const imageBlob = new Blob([new Uint8Array(opts.sourceBytes)], { type: opts.sourceMime })
  const imageFileName = multipartFileName(opts.sourceMime)
  return withModelDowngrade(cfg, (model) => {
    const form = new FormData()
    form.append('image', imageBlob, imageFileName)
    form.append('prompt', opts.prompt)
    form.append('model', model)
    if (opts.size) form.append('size', opts.size)
    if (opts.quality) form.append('quality', opts.quality)
    return postMultipart(url, cfg.apiKey, form)
  })
}
