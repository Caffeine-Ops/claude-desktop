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

export interface ImageApiConfig {
  apiKey: string
  baseURL: string
  model: string
}

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

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /Image API error \(5\d\d\)|upstream|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|EAI_AGAIN/i.test(
    msg
  )
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
        failures.push(`${model}#${attempt}: ${(err as Error).message.slice(0, 120)}`)
        if (!isRetryable(err)) break // 非 5xx（如 400 提示词违规）不重试、直接换下一模型
      }
    }
  }
  throw new Error(
    `所有模型都失败了（${models.join(', ')}）。多半是中转网关图像后端临时 5xx。\n${failures.join('\n')}`
  )
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

export async function editImage(
  cfg: ImageApiConfig,
  opts: { prompt: string; sourceBytes: Buffer; sourceMime: string; size?: string; quality?: string }
): Promise<Buffer> {
  const url = `${normalizeBaseUrl(cfg.baseURL)}/images/edits`
  return withModelDowngrade(cfg, (model) => {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(opts.sourceBytes)], { type: opts.sourceMime }), 'source.png')
    form.append('prompt', opts.prompt)
    form.append('model', model)
    if (opts.size) form.append('size', opts.size)
    if (opts.quality) form.append('quality', opts.quality)
    return postMultipart(url, cfg.apiKey, form)
  })
}
