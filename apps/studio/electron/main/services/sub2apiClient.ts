/**
 * sub2api 后端的最小 HTTP client：base URL 解析 + 统一响应信封
 * `{ code, message, reason?, data? }`（code=0 为成功）的解析。协议层
 * 只住这一处；认证相关的业务语义（token 存取、错误文案翻译）留在各自
 * 调用方（authService.ts / sessionSyncService.ts）——这两个服务的错误
 * reason code 集合并不重叠，没有共同的翻译表可提。
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'

export function sub2apiBaseUrl(): string {
  return (process.env.SUB2API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

interface Sub2ApiEnvelope<T> {
  code: number
  message: string
  reason?: string
  data?: T
}

export type Sub2ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string | null; message: string }

async function sub2apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: unknown,
  accessToken?: string | null
): Promise<Sub2ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(`${sub2apiBaseUrl()}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[sub2api] request failed', { path, message })
    return { ok: false, reason: null, message }
  }
  let envelope: Sub2ApiEnvelope<T>
  try {
    envelope = (await res.json()) as Sub2ApiEnvelope<T>
  } catch {
    return { ok: false, reason: null, message: `HTTP ${res.status}` }
  }
  if (!res.ok || envelope.code !== 0 || envelope.data === undefined) {
    return { ok: false, reason: envelope.reason ?? null, message: envelope.message }
  }
  return { ok: true, data: envelope.data }
}

/**
 * GET，解析统一信封。`accessToken` 传了就带 `Authorization: Bearer`
 * ——GET 端点目前都是用户态接口（profile/subscriptions 这类），不存在
 * 匿名 GET 的场景，但仍保留可选是为了和 sub2apiPost 签名对称。
 */
export function sub2apiGet<T>(
  path: string,
  accessToken?: string | null
): Promise<Sub2ApiResult<T>> {
  return sub2apiRequest<T>('GET', path, undefined, accessToken)
}

/**
 * POST 一个 JSON body，解析统一信封。`accessToken` 传了就带
 * `Authorization: Bearer`（登录后的用户态接口），不传就是匿名请求
 * （登录/发码这类端点本身）。
 */
export function sub2apiPost<T>(
  path: string,
  body: unknown,
  accessToken?: string | null
): Promise<Sub2ApiResult<T>> {
  return sub2apiRequest<T>('POST', path, body, accessToken)
}

/** PUT 一个 JSON body，解析统一信封。目前只有用户态接口用它（改资料）。 */
export function sub2apiPut<T>(
  path: string,
  body: unknown,
  accessToken?: string | null
): Promise<Sub2ApiResult<T>> {
  return sub2apiRequest<T>('PUT', path, body, accessToken)
}
