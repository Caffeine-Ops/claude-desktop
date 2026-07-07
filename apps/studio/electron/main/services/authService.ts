import { app } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  AuthLoginPayload,
  AuthLoginResult,
  AuthState,
  AuthUser
} from '../../shared/ipc-channels'
import { broadcastAuthState } from '../tabRegistry'

/**
 * 登录/账号服务（用户管理 + 套餐系统的地基）。
 *
 * 状态是单份 module state：main 是唯一事实源，每次迁移全量推给所有
 * renderer（AUTH_STATE_CHANGED），renderer 只做整体替换不自己拼装——
 * 同 appUpdater 的状态纪律。
 *
 * 持久化：`<userData>/auth.json`，独立于 settings.json——凭据/会话类
 * 数据与 UI 偏好分文件存，将来接真实后端要塞 token 时不会把敏感字段
 * 混进被设置页整体读写的文件里。退出登录直接删文件（不留 signedOut
 * 壳）：盘上没有凭据就是登出的最诚实表达。
 *
 * ⚠️ 后端接入 seam：真实的凭证校验只住在 {@link verifyCredentials}
 * 一个函数里。接自家用户中心 / 第三方 API 时改它一处（换成 HTTP 调用、
 * 返回服务端 user + token），login/logout/持久化/广播链路全部复用——
 * 届时给 StoredAuth 加 token 字段即可，v1 刻意不放假 token。
 */

/** auth.json 的落盘形状。version 为将来迁移留位（同 ProposalDraftRecord）。 */
interface StoredAuth {
  version: 1
  user: AuthUser
}

let state: AuthState = { status: 'signedOut', user: null }
let loaded = false

function authPath(): string {
  return join(app.getPath('userData'), 'auth.json')
}

/**
 * 冷启动读回上次登录态。只认结构完整的记录——字段缺损（手改文件 /
 * 旧版本形状）按未登录处理并不删文件，让用户重新登录后自然覆盖。
 */
function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = readFileSync(authPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredAuth>
    const u = parsed.user
    if (
      parsed.version === 1 &&
      u &&
      typeof u.id === 'string' &&
      typeof u.email === 'string' &&
      typeof u.name === 'string' &&
      u.plan &&
      typeof u.plan.name === 'string' &&
      (u.plan.expiresAt === null || typeof u.plan.expiresAt === 'number')
    ) {
      state = { status: 'signedIn', user: u as AuthUser }
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

export function getAuthState(): AuthState {
  load()
  return { ...state }
}

/**
 * 凭证校验——【占位实现】，也是唯一的后端接入点（见文件头注释）。
 *
 * v1 规则：邮箱格式合法 + 密码 ≥ 6 位即通过，user 由邮箱本地生成，
 * 套餐固定「基础版 / 永久」。这让登录墙的完整流程（校验失败文案、
 * 成功放行、重启记住、退出登录）端到端可用、可演示；换成真实 API
 * 后本函数的返回契约不变。
 */
async function verifyCredentials(
  payload: AuthLoginPayload
): Promise<{ ok: true; user: AuthUser } | { ok: false; error: string }> {
  const email = payload.email.trim().toLowerCase()
  const password = payload.password
  // 宽松的结构校验（有 @ 有点、无空白）——真实校验属于后端，这里只拦
  // 明显的手误，不追求 RFC 5322。
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: '请输入正确的邮箱地址' }
  }
  if (password.length < 6) {
    return { ok: false, error: '密码至少需要 6 位' }
  }
  const user: AuthUser = {
    id: email,
    email,
    name: email.split('@')[0] || email,
    plan: { name: '基础版', expiresAt: null }
  }
  return { ok: true, user }
}

/**
 * 登录：校验 → 写盘 → 广播。发起窗口用 resolve 值即时更新（不必等
 * 广播绕一圈），其余窗口靠 AUTH_STATE_CHANGED 跟上。
 */
export async function login(payload: AuthLoginPayload): Promise<AuthLoginResult> {
  load()
  const result = await verifyCredentials(payload)
  if (!result.ok) return result

  const record: StoredAuth = { version: 1, user: result.user }
  const path = authPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
  } catch (err) {
    // 写盘失败不拦登录（本次会话仍可用，重启后要重登）——比「磁盘满
    // 就永远登不进去」友好；日志留痕。
    const e = err as NodeJS.ErrnoException
    console.error('[auth] persist failed', { path, message: e.message })
  }
  const next: AuthState = { status: 'signedIn', user: result.user }
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
  setState({ status: 'signedOut', user: null })
}
