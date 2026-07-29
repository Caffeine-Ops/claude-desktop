import { app } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  AccountProfile,
  AccountProfileResult,
  AccountUpdatePayload,
  AccountUpdateResult,
  AuthLoginPayload,
  AuthLoginResult,
  AuthSendSmsCodeResult,
  AuthState,
  AuthUser
} from '../../shared/ipc-channels'
import { broadcastAuthState } from '../tabRegistry'
import { applyClientEnvConfig } from './clientEnvConfigService'
import { refreshScenarioCatalog } from './scenarioCatalogService'
import {
  sub2apiGet,
  sub2apiPost,
  sub2apiPut,
  type AuthedGet,
  type Sub2ApiResult
} from './sub2apiClient'

/**
 * 登录/账号服务（用户管理 + 套餐系统的地基）。对接的是 sub2api 后端
 * （本地项目 `/Users/andersenaxel/Desktop/Projects/_其他/sub2api`）的手机号
 * + 短信验证码登录：`POST /api/v1/auth/send-sms-code` +
 * `POST /api/v1/auth/login/phone`。手机号不存在时后端自动注册，不需要
 * 独立的注册流程。
 *
 * 状态是单份 module state：main 是唯一事实源，每次迁移全量推给所有
 * renderer（AUTH_STATE_CHANGED），renderer 只做整体替换不自己拼装——
 * 同 appUpdater 的状态纪律。
 *
 * 持久化：`<userData>/auth.json`，独立于 settings.json——凭据/会话类
 * 数据与 UI 偏好分文件存。access/refresh token 只落这个文件 + 本模块内存
 * （见 {@link tokens}），刻意不放进跨 IPC 边界的 {@link AuthUser}：renderer
 * 目前没有功能需要直接持有 token（同 preload 暴露面「非必要不下放」的
 * 一贯纪律）；将来有功能要用 sub2api token 时，本模块加一个「取当前
 * access token」的 main-only 导出即可，不必改 IPC 契约。退出登录直接删
 * 文件（不留 signedOut 壳）：盘上没有凭据就是登出的最诚实表达。
 *
 * Turnstile：sub2api 只在 `server.mode=release` 且后台开了
 * `turnstile.required` 时强制人机验证，本地/开发环境不需要，故
 * `turnstile_token` 恒传空串——真上线到需要 Turnstile 的环境时再补客户端
 * 挑战流程。
 */

/** auth.json 的落盘形状。version 为将来迁移留位（同 ProposalDraftRecord）。 */
interface StoredAuth {
  version: 1
  user: AuthUser
  tokens: TokenPair
}

interface TokenPair {
  accessToken: string
  refreshToken: string | null
  /** epoch ms；后端未返回 expires_in 时为 null（当作长期有效）。 */
  expiresAt: number | null
}

let state: AuthState = { status: 'signedOut', user: null }
/** 当前登录用户的 token 对，main-only，不经 IPC 下放给 renderer。 */
let tokens: TokenPair | null = null
let loaded = false

function authPath(): string {
  return join(app.getPath('userData'), 'auth.json')
}

/**
 * 冷启动读回上次登录态。只认结构完整的记录——字段缺损（手改文件 /
 * 旧版本形状，含改造前的邮箱登录记录）按未登录处理并不删文件，让用户
 * 重新登录后自然覆盖。
 *
 * 这里刻意不做 token 过期校验，但理由跟最初那版不一样了：盘上的 access
 * token 过期（24h TTL，冷启动时多半已经过期）是**常态而非登录失效**，
 * 由 {@link ensureFreshAccessToken} 在第一次真正发请求时用 refresh token
 * 续上即可。在 load() 里判过期然后按未登录处理，会把每天第一次开 app
 * 的用户全踢回登录页——那才是真的错。
 */
function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = readFileSync(authPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredAuth>
    const u = parsed.user
    const t = parsed.tokens
    if (
      parsed.version === 1 &&
      u &&
      typeof u.id === 'string' &&
      typeof u.phone === 'string' &&
      typeof u.name === 'string' &&
      u.plan &&
      typeof u.plan.name === 'string' &&
      (u.plan.expiresAt === null || typeof u.plan.expiresAt === 'number') &&
      t &&
      typeof t.accessToken === 'string' &&
      (t.refreshToken === null || typeof t.refreshToken === 'string') &&
      (t.expiresAt === null || typeof t.expiresAt === 'number')
    ) {
      state = { status: 'signedIn', user: u as AuthUser }
      tokens = t as TokenPair
    }
  } catch (err) {
    // ENOENT（从未登录过）是常态，静默；其余错误（权限/坏 JSON）留一条
    // 日志便于排查，但都回落未登录——auth 读不出来绝不能挡 app 启动。
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      console.warn('[auth] load failed — treating as signed out', {
        path: authPath(),
        message: e.message
      })
    }
  }
}

function setState(next: AuthState): void {
  state = next
  broadcastAuthState(state)
}

/** 写 `<userData>/auth.json`。写盘失败不抛出，只留日志——调用方（login /
 * 后台刷新）都不能因为磁盘问题中断已经拿到的登录态。 */
function persist(user: AuthUser, tokenPair: TokenPair): void {
  const record: StoredAuth = { version: 1, user, tokens: tokenPair }
  const path = authPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    console.error('[auth] persist failed', { path, message: e.message })
  }
}

/** 删盘上凭据。主动 {@link logout} 与被动 {@link invalidateSession} 共用——
 * 两条路径必须清得一模一样，否则「被踢下线」会留下半份凭据。 */
function clearStoredAuth(): void {
  try {
    rmSync(authPath(), { force: true })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    console.error('[auth] remove auth.json failed', { path: authPath(), message: e.message })
  }
}

let profileRefreshedThisSession = false

export function getAuthState(): AuthState {
  load()
  // 冷启动从磁盘恢复的 signedIn 快照可能已经过期（套餐到期/改名不会主动
  // 通知客户端；client-config 那份网关配置同理——后端可能轮换了这个用户
  // 的 API Key）——每个 main 进程生命周期只在第一次有人问起时后台刷新
  // 一次，刷新结果通过 setState 广播，AppRail/AuthGate 等 renderer 自动
  // 跟上，不需要它们自己再发起任何请求。
  if (state.status === 'signedIn' && tokens && !profileRefreshedThisSession) {
    profileRefreshedThisSession = true
    void refreshProfileInBackground()
  }
  return { ...state }
}

/**
 * login() 之外的第二个刷新入口（冷启动路径），逻辑见 {@link getAuthState}。
 *
 * 这里是 access token 过期的**主战场**：盘上那份多半是上一次开 app 时签发
 * 的，24h TTL 早过了。三个请求（client-config / profile / 订阅）全走
 * {@link authedGet}，第一个发现过期的触发续期，其余的等同一次刷新（单飞），
 * 用户对整个过程无感。
 */
async function refreshProfileInBackground(): Promise<void> {
  if (!tokens) return
  // 与 profile 刷新并行、互不阻塞：client-config 失败不该连累 profile 展示，
  // 反之亦然——两者是正交的两份数据，各自 best-effort（见各自函数内部的
  // 错误处理）。
  void applyClientEnvConfig(authedGet).catch((err) => {
    console.error('[auth] apply client env config failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  })
  // 场景目录同理：与另外两个请求并行，各自 best-effort。版本没变时它连
  // 广播都不会发，冷启动对已经画好的 rail 完全无感。
  void refreshScenarioCatalog(authedGet).catch((err) => {
    console.error('[auth] refresh scenario catalog failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  })
  const refreshed = await fetchProfile(authedGet)
  // state.status / tokens 都可能在这次网络请求期间变化——用户手动登出，
  // 或续期失败触发了 invalidateSession。刷新结果这时应当丢弃，不能把一份
  // 「迟到」的登录态重新写回去。注意 tokens 也要重新判空：它可能已经被
  // 续期换成了新的一对（那正是要落盘的值），也可能已经被清成 null。
  if (!refreshed || state.status !== 'signedIn' || !tokens) return
  persist(refreshed, tokens)
  setState({ status: 'signedIn', user: refreshed })
}

/**
 * 当前登录用户的 sub2api access token，main-only（同 {@link getAuthState}
 * 的读接口对称）；未登录时为 null。
 *
 * ⚠️ 这个函数**不保证 token 没过期**（access token 只有 24h），拿它直接
 * 发请求会在过期后一路 401。除非你只是想判断「有没有登录」，否则一律走
 * {@link callWithAuth} / {@link authedGet} 系列——它们负责续期与重放。
 */
export function getAccessToken(): string | null {
  load()
  return tokens?.accessToken ?? null
}

/* ─────────────────────────── token 续期 ───────────────────────────
 * sub2api 的 access token TTL 是 24 小时，refresh token 则是「一次性 +
 * 轮转」的：每次 `POST /api/v1/auth/refresh` 会立刻删掉旧的、签发新的一
 * 对，并对旧 token 的二次使用做重用检测（REFRESH_TOKEN_REUSED 会连坐撤销
 * 整个会话家族）。这两条约束直接决定了下面的设计：
 *
 *  1. 刷新必须**单飞**（{@link refreshTokens}）——冷启动时 profile、订阅、
 *     client-config、usage 面板可能同时发现 token 过期，各刷各的就会拿同
 *     一个旧 refresh token 打并发，第二个之后全部判重用，整条会话被撤销。
 *  2. 拿到新 token 必须**立刻落盘**——旧的那份在服务端已经失效了，进程
 *     这时崩掉而盘上还留着旧值，下次冷启动就会撞重用检测。
 *  3. 网络失败**绝不能**当成登录失效（见 {@link performTokenRefresh}）。
 *
 * 已知限制：同一台机器上同时跑两个实例（比如 dev 版和安装版）会共享同
 * 一份 auth.json，却各自持有内存里的 token——先刷新的那个把 refresh token
 * 轮转掉，后刷新的那个拿着已失效的旧值去刷，撞重用检测后两边一起被踢
 * 下线。要根治得给刷新加跨进程锁（文件锁/单例代理），本轮不做；日常
 * 「同时只开一个实例」的用法不受影响。
 */

/**
 * 剩余寿命低于这个阈值就提前刷新。60s 用来覆盖「刚检查完还没发出去就
 * 过期」的窗口，同时吸收客户端与服务端之间的时钟漂移。
 */
const TOKEN_REFRESH_SKEW_MS = 60_000

/** access token 过期但会话本身还在——刷一次就能救回来。 */
const REFRESHABLE_REASONS = new Set(['TOKEN_EXPIRED', 'ACCESS_TOKEN_EXPIRED'])

/**
 * 会话已被服务端作废，刷新也救不回来（refresh 端点会以同样的理由拒绝），
 * 只能重新登录。取自 sub2api 的 jwt_auth.go（请求路径）与 auth_service.go
 * 的 RefreshTokenPair（刷新路径）。注意 `INVALID_TOKEN` 之类**不在**这张
 * 表里——那更像客户端把 token 传坏了，宁可原样报错也别贸然登出。
 */
const FATAL_AUTH_REASONS = new Set([
  'TOKEN_REVOKED', // 改密后 token_version 前进，旧 token 全作废
  'SESSION_BINDING_MISMATCH', // IP/UA 变了，整个会话家族被撤销
  'USER_INACTIVE',
  'USER_NOT_ACTIVE',
  'USER_NOT_FOUND',
  'REFRESH_TOKEN_INVALID',
  'REFRESH_TOKEN_EXPIRED',
  'REFRESH_TOKEN_REUSED'
])

/** 本模块自造的 reason（不来自后端），给 {@link translateError} 认。 */
const NOT_SIGNED_IN = 'NOT_SIGNED_IN'

/** RefreshTokenResponse（见 auth_handler.go:734）。 */
interface RefreshTokenData {
  access_token: string
  refresh_token: string
  /** Access Token 有效期（秒）。 */
  expires_in: number
  token_type?: string
}

/** 见 {@link refreshTokens} 的单飞说明。 */
let refreshInFlight: Promise<boolean> | null = null

/**
 * 刷新 token 对。并发调用共享同一次请求（单飞）——原因见本节开头的第 1
 * 条：并发刷新会撞上后端的 refresh token 重用检测。
 */
function refreshTokens(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performTokenRefresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

/** 真正干活的那半，只经 {@link refreshTokens} 调用（否则绕过单飞）。 */
async function performTokenRefresh(): Promise<boolean> {
  load()
  const refreshToken = tokens?.refreshToken
  if (!refreshToken) {
    // 登录响应没带 refresh token（后端老版本 / 异常响应）——没有续期材料，
    // access token 过期就是会话终点，直接进登录页比让用户对着一串 401 猜
    // 要诚实。
    invalidateSession('no refresh token stored')
    return false
  }

  const result = await sub2apiPost<RefreshTokenData>('/api/v1/auth/refresh', {
    refresh_token: refreshToken
  })
  if (!result.ok) {
    // reason === null 是网络/解析层失败（离线、后端没起来、代理抽风）。
    // 把这种情况当「登录失效」踢下线是最糟的体验——保留登录态，等下一次
    // 请求自然重试。未知 reason 同样保守处理。
    if (result.reason === null || !FATAL_AUTH_REASONS.has(result.reason)) {
      console.error('[auth] token refresh failed — keeping session', {
        reason: result.reason,
        message: result.message
      })
      return false
    }
    invalidateSession(`refresh rejected: ${result.reason}`)
    return false
  }

  const data = result.data
  const next: TokenPair = {
    accessToken: data.access_token,
    // 轮转后的新 refresh token；后端理论上必给，真没给就沿用旧的（旧的
    // 已经被删了，下次刷新会失败并走 invalidateSession，不会静默死循环）。
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null
  }
  tokens = next
  // 立刻落盘，理由见本节开头第 2 条。state.user 理论上必然存在（tokens 与
  // signedIn 由 load/login/logout 成对维护），真没有就只留内存态——盘上那份
  // 旧 refresh token 已经失效，写不进去也不会更坏。
  if (state.status === 'signedIn' && state.user) {
    persist(state.user, next)
  } else {
    console.warn('[auth] refreshed tokens but no signedIn user to persist with')
  }
  console.log('[auth] token refreshed', { expiresAt: next.expiresAt })
  return true
}

/**
 * 会话被服务端作废时的**被动**登出（改密 / 会话绑定变化 / refresh token
 * 失效）。清理动作与用户主动 {@link logout} 完全一致——删盘上凭据、清内存
 * 态、广播 signedOut 让 AuthGate 弹回登录页——区别只在那条 warn 日志：它是
 * 事后排查「怎么突然要我重新登录」的唯一线索。
 */
function invalidateSession(reason: string): void {
  if (state.status === 'signedOut' && !tokens) return // 幂等
  console.warn('[auth] session invalidated — signing out', { reason })
  clearStoredAuth()
  tokens = null
  setState({ status: 'signedOut', user: null })
}

/**
 * 取一份「尽量新鲜」的 access token：本地记录显示已过期或即将过期就先
 * 续期。刷新失败但会话没被作废（网络问题）时仍返回手里这份过期的——让
 * 请求自己去撞 401，由 {@link callWithAuth} 的重放路径兜底，不在这里替
 * 调用方判死刑。
 */
async function ensureFreshAccessToken(): Promise<string | null> {
  load()
  if (!tokens) return null
  const { expiresAt } = tokens
  if (expiresAt !== null && expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS) {
    // 刷新失败若是致命原因，invalidateSession 已经把 tokens 清成 null，
    // 下面这行自然返回 null（= 未登录），不需要看返回值。
    await refreshTokens()
  }
  return tokens?.accessToken ?? null
}

/**
 * 所有用户态 sub2api 请求的统一入口：续期 → 执行 → （被判过期就）刷新
 * 后**重放一次**。
 *
 * 为什么本地 expiresAt 已经查过了还要留重放这条路：服务端可以在 TTL 之前
 * 单方面让 token 失效（改密、会话撤销），老记录的 expiresAt 也可能是 null
 * （后端没回 expires_in 时当长期有效）。重放只做一次——刷新后仍被判过期
 * 说明问题不在 token 新鲜度上，再转圈只会把 401 变成死循环。
 */
export async function callWithAuth<T>(
  run: (accessToken: string) => Promise<Sub2ApiResult<T>>
): Promise<Sub2ApiResult<T>> {
  const token = await ensureFreshAccessToken()
  if (!token) return { ok: false, reason: NOT_SIGNED_IN, message: '请先登录' }

  const first = await run(token)
  if (first.ok) return first

  const reason = first.reason ?? ''
  if (FATAL_AUTH_REASONS.has(reason)) {
    invalidateSession(`request rejected: ${reason}`)
    return first
  }
  if (!REFRESHABLE_REASONS.has(reason)) return first
  if (!(await refreshTokens())) {
    // 续期没成功。会话被作废的话 tokens 已经清空，原样返回 first——它的
    // reason 翻出来就是「请重新登录」，正合适；tokens 还在则说明失败在
    // 网络/服务端临时故障上，别把「连不上」说成「登录过期」让用户白跑
    // 一趟重新登录。
    if (tokens) return { ok: false, reason: null, message: '网络异常，请稍后重试' }
    return first
  }
  const refreshedToken = tokens?.accessToken
  if (!refreshedToken) return first
  return run(refreshedToken)
}

/** {@link callWithAuth} 的三个便捷包装，签名与 sub2apiGet/Post/Put 对齐（少了手传 token 那一位）。 */
export function authedGet<T>(path: string): Promise<Sub2ApiResult<T>> {
  return callWithAuth<T>((token) => sub2apiGet<T>(path, token))
}

export function authedPost<T>(path: string, body: unknown): Promise<Sub2ApiResult<T>> {
  return callWithAuth<T>((token) => sub2apiPost<T>(path, body, token))
}

export function authedPut<T>(path: string, body: unknown): Promise<Sub2ApiResult<T>> {
  return callWithAuth<T>((token) => sub2apiPut<T>(path, body, token))
}

/**
 * 把 sub2api 的错误 reason code（见 backend/internal/service/sms_service.go
 * 与 auth_service.go 的 infraerrors.* 常量）翻成中文。未知 reason 落回
 * message 本身（多半是英文），message 也没有则给通用兜底文案。
 *
 * 认证类 reason 是**兜底**：正常情况下 {@link callWithAuth} 已经把过期
 * token 续上了，用户不该看到它们；真漏到 UI 说明续期也失败了（那时会话
 * 已被 {@link invalidateSession} 清掉，登录页正在弹），所以文案一律指向
 * 「重新登录」而不是「稍后重试」。在这张表补全之前，账号页会把后端原样
 * 的英文 "Token has expired" 直接显示给用户（2026-07-28 实测）。
 */
export function translateError(reason: string | null, message: string, fallback: string): string {
  switch (reason) {
    case NOT_SIGNED_IN:
      return '请先登录'
    case 'TOKEN_EXPIRED':
    case 'ACCESS_TOKEN_EXPIRED':
    case 'REFRESH_TOKEN_EXPIRED':
    case 'REFRESH_TOKEN_INVALID':
    case 'REFRESH_TOKEN_REUSED':
      return '登录已过期，请重新登录'
    case 'TOKEN_REVOKED':
      return '账号密码已变更，请重新登录'
    case 'SESSION_BINDING_MISMATCH':
      return '网络环境已变化，出于安全考虑请重新登录'
    case 'INVALID_TOKEN':
    case 'UNAUTHORIZED':
      return '登录状态异常，请重新登录'
    case 'PHONE_LOGIN_DISABLED':
      return '手机号登录尚未开启，请联系管理员'
    case 'INVALID_PHONE_NUMBER':
      return '请输入正确的手机号'
    case 'INVALID_SMS_CODE':
      return '验证码错误或已过期'
    case 'SMS_CODE_TOO_FREQUENT':
      return '验证码发送太频繁，请稍后再试'
    case 'SMS_CODE_MAX_ATTEMPTS':
      return '验证码错误次数过多，请重新获取验证码'
    case 'TURNSTILE_VERIFICATION_FAILED':
      return '人机验证失败，请重试'
    case 'TURNSTILE_NOT_CONFIGURED':
      return '人机验证服务未配置，请联系管理员'
    case 'USER_NOT_ACTIVE':
    case 'USER_INACTIVE':
      return '账号已被禁用，请联系管理员'
    case 'USER_NOT_FOUND':
      return '账号不存在，请重新登录'
    default:
      return message?.trim() ? message : fallback
  }
}

/** SendSmsCodeResponse.data（见 auth_handler.go 的 SendVerifyCodeResponse）。 */
interface SendSmsCodeData {
  message: string
  countdown: number
}

export async function sendSmsCode(phone: string): Promise<AuthSendSmsCodeResult> {
  const trimmed = phone.trim()
  if (!/^\+?\d{6,20}$/.test(trimmed)) {
    return { ok: false, error: '请输入正确的手机号' }
  }
  const result = await sub2apiPost<SendSmsCodeData>('/api/v1/auth/send-sms-code', {
    phone: trimmed,
    turnstile_token: ''
  })
  if (!result.ok) {
    return {
      ok: false,
      error: translateError(result.reason, result.message, '验证码发送失败，请稍后重试')
    }
  }
  return { ok: true, countdown: result.data.countdown }
}

/** dto.User 的子集（见 backend/internal/handler/dto/types.go）。 */
interface Sub2ApiUser {
  id: number
  phone: string
  username: string
}

/** AuthResponse.data（成功登录）（见 auth_handler.go）。 */
interface LoginSuccessData {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type: string
  user: Sub2ApiUser
}

/** TotpLoginResponse.data（账号绑了 2FA，需要二次验证）。 */
interface Totp2FAData {
  requires_2fa: true
  temp_token?: string
  user_email_masked?: string
}

/** 未拉到真实 profile 时的登录态兜底——仅用登录响应自带的字段，套餐
 * 固定「基础版」占位（会被 {@link fetchProfile} 的结果尽快覆盖）。 */
function placeholderUser(u: Sub2ApiUser): AuthUser {
  return {
    id: String(u.id),
    phone: u.phone,
    name: u.username || u.phone,
    // 登录响应本身不带头像字段（LoginSuccessData.user 是精简子集）——
    // 留 null，紧跟着的 fetchProfile() 会把真实值补上。
    avatarUrl: null,
    plan: { name: '基础版', expiresAt: null }
  }
}

/**
 * GET /api/v1/user/profile 的 data（dto.User 的子集 + handler 外层加的
 * avatar_url，见 user_handler.go 的 userProfileResponse）。
 */
interface Sub2ApiProfile {
  id: number
  phone: string
  username: string
  avatar_url?: string
  role: string
  status: string
  balance: number
  concurrency: number
  created_at: string
}

function mapAccountProfile(p: Sub2ApiProfile): AccountProfile {
  return {
    id: String(p.id),
    phone: p.phone,
    username: p.username,
    avatarUrl: p.avatar_url?.trim() ? p.avatar_url : null,
    role: p.role,
    status: p.status,
    balance: p.balance,
    concurrency: p.concurrency,
    createdAt: Date.parse(p.created_at) || 0
  }
}

/** GET /api/v1/subscriptions/active 的 data 数组元素（dto.UserSubscription 子集）。 */
interface Sub2ApiSubscription {
  expires_at: string
  /** `omitempty`——没有关联分组时这个 key 整个不出现，不是显式 null。 */
  group?: { name: string } | null
}

/**
 * 拉真实用户资料 + 当前生效套餐，取代登录响应里那份不完整的快照——登录
 * 接口本身只回 id/phone/username，没有套餐信息。多个生效订阅时取第一个
 * （多订阅场景下「当前套餐」这个单值展示概念本身就模糊，选择策略留给
 * 真正做多订阅 UI 时再定）；没有生效订阅 = 免费档「基础版」。
 *
 * 两个接口任一网络失败都不阻塞——profile 拿不到就返回 null（调用方回落
 * 已有数据），订阅拿不到就当作「无生效订阅」处理（宁可套餐名暂时保守，
 * 不能让一次订阅查询失败连累整个登录/刷新流程报错）。
 *
 * `get` 由调用方注入而不是内部固定走 {@link authedGet}，是因为两条调用
 * 路径手里的 token 状态不同：login() 刚拿到崭新的 token（此时 module 里的
 * `tokens` 还没赋值，走 authedGet 会读到旧值），冷启动刷新则拿的是盘上
 * 那份可能已经过期的（必须走续期路径）。两个请求并发都撞过期时，单飞
 * 保证只刷一次。
 */
async function fetchProfile(get: AuthedGet): Promise<AuthUser | null> {
  const [profileResult, subsResult] = await Promise.all([
    get<Sub2ApiProfile>('/api/v1/user/profile'),
    get<Sub2ApiSubscription[]>('/api/v1/subscriptions/active')
  ])
  if (!profileResult.ok) {
    console.error('[auth] fetch profile failed', {
      reason: profileResult.reason,
      message: profileResult.message
    })
    return null
  }
  const activeSub = subsResult.ok ? subsResult.data[0] : undefined
  const p = profileResult.data
  const result: AuthUser = {
    id: String(p.id),
    phone: p.phone,
    name: p.username || p.phone,
    avatarUrl: p.avatar_url?.trim() ? p.avatar_url : null,
    plan: activeSub
      ? {
          name: activeSub.group?.name ?? '订阅版',
          expiresAt: Date.parse(activeSub.expires_at) || null
        }
      : { name: '基础版', expiresAt: null }
  }
  console.log('[auth] fetched profile', { user: result, activeSubscriptions: subsResult.ok ? subsResult.data.length : 'n/a' })
  return result
}

/**
 * 设置页「账号」面用：拉一份完整账户资料（余额/并发/角色/状态/注册
 * 时间——AuthUser 精简版没有这些字段）。
 */
export async function getAccountProfile(): Promise<AccountProfileResult> {
  const result = await authedGet<Sub2ApiProfile>('/api/v1/user/profile')
  if (!result.ok) {
    return { ok: false, error: translateError(result.reason, result.message, '获取账户信息失败，请稍后重试') }
  }
  return { ok: true, profile: mapAccountProfile(result.data) }
}

/**
 * 改用户名/头像（sub2api 的 `PUT /api/v1/user` 是部分更新——只传变化的
 * 字段）。成功后顺带把 AuthState.user.name 同步更新 + 广播，rail 账户
 * chip 立刻跟上新名字，不必等下次登录/冷启动刷新。
 */
export async function updateAccountProfile(
  payload: AccountUpdatePayload
): Promise<AccountUpdateResult> {
  const body: Record<string, string> = {}
  if (payload.username !== undefined) body.username = payload.username
  if (payload.avatarDataUrl !== undefined) body.avatar_url = payload.avatarDataUrl
  const result = await authedPut<Sub2ApiProfile>('/api/v1/user', body)
  if (!result.ok) {
    return { ok: false, error: translateError(result.reason, result.message, '保存失败，请稍后重试') }
  }
  const profile = mapAccountProfile(result.data)
  // AuthUser.name/avatarUrl 跟着 username/头像变化同步——rail 账户 chip
  // 立刻跟上，不必等下次登录/冷启动刷新。phone/id 不会因为这次更新变化，
  // plan 保留当前 state 里已有的值（这个接口不返回套餐信息，不能拿
  // 「没有套餐信息」误判成「套餐没了」）。tokens 也要判：请求飞在路上时
  // 用户可能已经登出（或续期失败被 invalidateSession 清了），这时不该把
  // 一份「迟到」的登录态重新写回盘上。
  if (state.status === 'signedIn' && state.user && tokens) {
    const updatedUser: AuthUser = {
      ...state.user,
      name: profile.username || profile.phone,
      avatarUrl: profile.avatarUrl
    }
    persist(updatedUser, tokens)
    setState({ status: 'signedIn', user: updatedUser })
  }
  return { ok: true, profile }
}

/**
 * 凭证校验——真实实现：调用 sub2api 的手机号+验证码登录。
 *
 * 账号绑了 TOTP 二次验证时后端返回 `requires_2fa`（同邮箱登录路径）；
 * 桌面客户端暂不做 TOTP 输入 UI（超出「对接手机号登录」这次的范围），
 * 提示用户改走网页端完成一次登录再回来。
 */
async function verifyCredentials(
  payload: AuthLoginPayload
): Promise<{ ok: true; user: AuthUser; tokens: TokenPair } | { ok: false; error: string }> {
  const phone = payload.phone.trim()
  const code = payload.code.trim()
  if (!/^\+?\d{6,20}$/.test(phone)) {
    return { ok: false, error: '请输入正确的手机号' }
  }
  if (!/^\d{4,8}$/.test(code)) {
    return { ok: false, error: '请输入验证码' }
  }

  const result = await sub2apiPost<LoginSuccessData | Totp2FAData>('/api/v1/auth/login/phone', {
    phone,
    code
  })
  if (!result.ok) {
    return { ok: false, error: translateError(result.reason, result.message, '登录失败，请稍后重试') }
  }
  if ('requires_2fa' in result.data && result.data.requires_2fa) {
    return { ok: false, error: '该账号已开启双重验证，请先在网页端完成登录后再试' }
  }
  const data = result.data as LoginSuccessData
  const user = placeholderUser(data.user)
  const tokenPair: TokenPair = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null
  }
  return { ok: true, user, tokens: tokenPair }
}

/**
 * 登录：校验 → 拉真实 profile/套餐 → 写盘 → 广播。发起窗口用 resolve
 * 值即时更新（不必等广播绕一圈），其余窗口靠 AUTH_STATE_CHANGED 跟上。
 *
 * 登录接口本身回的 user 只有 id/phone/username，没有套餐信息，直接拿去
 * 用账户菜单会一直显示占位「基础版」；这里紧接着拉一次真实 profile +
 * 生效订阅替换掉它，账户菜单从第一帧就是真实数据，不会有「先占位后跳变」
 * 的二次刷新感。profile 拉取失败（网络问题）不影响登录本身，回落到
 * 占位数据——宁可套餐名暂时不准，也不能因为这一步失败就让整次登录失败。
 */
export async function login(payload: AuthLoginPayload): Promise<AuthLoginResult> {
  load()
  const result = await verifyCredentials(payload)
  if (!result.ok) return result

  // 刚签发的 token 不需要续期，直接用它发请求（此时 module 里的 `tokens`
  // 还是上一次会话的旧值 / null，走 authedGet 反而会读错）。
  const freshGet: AuthedGet = <T,>(path: string) =>
    sub2apiGet<T>(path, result.tokens.accessToken)
  const user = (await fetchProfile(freshGet)) ?? result.user
  persist(user, result.tokens)
  tokens = result.tokens
  // 换掉 env.json 里写死的共享 ANTHROPIC_AUTH_TOKEN/OPENAI_API_KEY/
  // GEMINI_API_KEY——每个刚登录的用户都要立刻拿到自己名下的网关配置，而
  // 不是等下次冷启动的后台刷新才生效。fire-and-forget：网络失败不该挡登录
  // 本身，失败时沿用 env.json 的旧值，下次成功的调用自然覆盖过去。
  void applyClientEnvConfig(freshGet).catch((err) => {
    console.error('[auth] apply client env config failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  })
  // 空态场景导航的远端配置，与 client-config 同一节奏、同样 fire-and-forget：
  // 拉到了就广播刷新 rail，拉不到渲染层继续用上一次的缓存/内置默认表。
  void refreshScenarioCatalog(freshGet).catch((err) => {
    console.error('[auth] refresh scenario catalog failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  })
  // 已经拿到新鲜数据——避免 getAuthState() 的冷启动刷新守卫紧接着又
  // 触发一次多余的重复请求。
  profileRefreshedThisSession = true
  const next: AuthState = { status: 'signedIn', user }
  setState(next)
  return { ok: true, state: next }
}

/** 退出登录：删盘上凭据 + 清内存态 + 广播。幂等。 */
export function logout(): void {
  load()
  clearStoredAuth()
  tokens = null
  setState({ status: 'signedOut', user: null })
}
