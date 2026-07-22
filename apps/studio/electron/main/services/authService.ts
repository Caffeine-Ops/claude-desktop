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
import { sub2apiGet, sub2apiPost, sub2apiPut } from './sub2apiClient'

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
 * 重新登录后自然覆盖。不做 token 过期校验：目前没有其它功能会用这个
 * token 发起请求，冷启动阶段验它属于「为不存在的场景加校验」。
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

/** login() 之外的第二个刷新入口（冷启动路径），逻辑见 {@link getAuthState}。 */
async function refreshProfileInBackground(): Promise<void> {
  if (!tokens) return
  // 与 profile 刷新并行、互不阻塞：client-config 失败不该连累 profile 展示，
  // 反之亦然——两者是正交的两份数据，各自 best-effort（见各自函数内部的
  // 错误处理）。
  void applyClientEnvConfig(tokens.accessToken).catch((err) => {
    console.error('[auth] apply client env config failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  })
  const refreshed = await fetchProfile(tokens.accessToken)
  // state.status 可能在这次网络请求期间因为用户手动登出而变化——刷新
  // 结果这时应当丢弃，不能把一份「迟到」的登录态重新写回去。
  if (!refreshed || state.status !== 'signedIn') return
  persist(refreshed, tokens)
  setState({ status: 'signedIn', user: refreshed })
}

/**
 * 当前登录用户的 sub2api access token，main-only（同 {@link getAuthState}
 * 的读接口对称）；未登录时为 null。给将来对接 sub2api 其它接口（套餐/
 * 额度等）的 service 用，本次改造暂无消费方。
 */
export function getAccessToken(): string | null {
  load()
  return tokens?.accessToken ?? null
}

/**
 * 把 sub2api 的错误 reason code（见 backend/internal/service/sms_service.go
 * 与 auth_service.go 的 infraerrors.* 常量）翻成中文。未知 reason 落回
 * message 本身（多半是英文），message 也没有则给通用兜底文案。
 */
function translateError(reason: string | null, message: string, fallback: string): string {
  switch (reason) {
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
      return '账号已被禁用，请联系管理员'
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
 */
async function fetchProfile(accessToken: string): Promise<AuthUser | null> {
  const [profileResult, subsResult] = await Promise.all([
    sub2apiGet<Sub2ApiProfile>('/api/v1/user/profile', accessToken),
    sub2apiGet<Sub2ApiSubscription[]>('/api/v1/subscriptions/active', accessToken)
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
  load()
  if (!tokens) return { ok: false, error: '请先登录' }
  const result = await sub2apiGet<Sub2ApiProfile>('/api/v1/user/profile', tokens.accessToken)
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
  load()
  if (!tokens) return { ok: false, error: '请先登录' }
  const body: Record<string, string> = {}
  if (payload.username !== undefined) body.username = payload.username
  if (payload.avatarDataUrl !== undefined) body.avatar_url = payload.avatarDataUrl
  const result = await sub2apiPut<Sub2ApiProfile>('/api/v1/user', body, tokens.accessToken)
  if (!result.ok) {
    return { ok: false, error: translateError(result.reason, result.message, '保存失败，请稍后重试') }
  }
  const profile = mapAccountProfile(result.data)
  // AuthUser.name/avatarUrl 跟着 username/头像变化同步——rail 账户 chip
  // 立刻跟上，不必等下次登录/冷启动刷新。phone/id 不会因为这次更新变化，
  // plan 保留当前 state 里已有的值（这个接口不返回套餐信息，不能拿
  // 「没有套餐信息」误判成「套餐没了」）。
  if (state.status === 'signedIn' && state.user) {
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

  const user = (await fetchProfile(result.tokens.accessToken)) ?? result.user
  persist(user, result.tokens)
  tokens = result.tokens
  // 换掉 env.json 里写死的共享 ANTHROPIC_AUTH_TOKEN/OPENAI_API_KEY/
  // GEMINI_API_KEY——每个刚登录的用户都要立刻拿到自己名下的网关配置，而
  // 不是等下次冷启动的后台刷新才生效。fire-and-forget：网络失败不该挡登录
  // 本身，失败时沿用 env.json 的旧值，下次成功的调用自然覆盖过去。
  void applyClientEnvConfig(result.tokens.accessToken).catch((err) => {
    console.error('[auth] apply client env config failed', {
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
  try {
    rmSync(authPath(), { force: true })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    console.error('[auth] remove auth.json failed', {
      path: authPath(),
      message: e.message
    })
  }
  tokens = null
  setState({ status: 'signedOut', user: null })
}
