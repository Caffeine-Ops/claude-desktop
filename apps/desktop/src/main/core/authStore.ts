import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { invalidateSettingsCache } from './appSettings'
import { reopenLogFile } from './logCollector'
import { tenantPaths } from './tenantPaths'

/**
 * 全局 auth.json —— 「谁现在登录了」的权威，独立于每租户 settings.json。
 *
 * 为什么独立：要进入 <userData>/tenants/<tid>/settings.json 必须先知道 tid，
 * 而 tid 来自登录态——鸡生蛋。所以登录态（activeTenantId + 各租户身份）放在
 * 不依赖 tid 的全局文件里，settings.json 才能按 tid 定位。
 *
 * 身份（掩码号 + 昵称）放这里而非每租户目录，是为了在尚未激活租户时就能渲染
 * 登录墙 / 账号菜单，并让返回用户保留昵称。原始手机号绝不到这里——只有它的
 * sha256 前缀（tenantId）和掩码号。
 *
 * 落盘形状：
 *   {
 *     "activeTenantId": "ab12...",         // null 表示登出
 *     "users": { "ab12...": { "phone": "138****8888", "nickname": "张三" } }
 *   }
 */
export interface AuthSnapshot {
  loggedIn: boolean
  phone: string | null
  nickname: string | null
  tenantId: string | null
}

interface AuthFile {
  activeTenantId: string | null
  users: Record<string, { phone: string; nickname: string }>
}

let cached: AuthFile | null = null

function authPath(): string {
  return join(app.getPath('userData'), 'auth.json')
}

function load(): AuthFile {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(authPath(), 'utf8')) as Partial<AuthFile>
    cached = {
      activeTenantId:
        typeof parsed.activeTenantId === 'string' ? parsed.activeTenantId : null,
      // 信任边界：users 的形状只做浅校验（是对象就收）。即便某条身份被外部
      // 改坏（如 phone 非串），租户隔离也不受影响——路径键来自 activeTenantId，
      // 不来自 users；users 仅供 UI 显示掩码号/昵称。UX 级隔离不做深校验。
      users:
        parsed.users && typeof parsed.users === 'object'
          ? (parsed.users as AuthFile['users'])
          : {}
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      console.warn('[authStore] load failed — using defaults', { message: e.message })
    }
    cached = { activeTenantId: null, users: {} }
  }
  return cached
}

function persist(next: AuthFile): void {
  cached = next
  const path = authPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.error('[authStore] write failed', { message: (err as Error).message })
  }
}

export function getActiveTenantId(): string | null {
  return load().activeTenantId
}

/**
 * 激活某租户：把进程级 CLAUDE_CONFIG_DIR 指到它的 .claude，建好目录，并让
 * 依赖它的缓存/流刷新。这是隔离的真正开关——设完之后 SDK 读侧和 fusion-code
 * 子进程都会落到这个租户的目录。null = 登出，移除变量回到默认 ~/.claude。
 *
 * 不在这里 spawn / reload；那是调用方（IPC 切换流程）的事。
 */
export function activateTenant(tenantId: string | null): void {
  if (tenantId) {
    const p = tenantPaths(tenantId)
    try {
      mkdirSync(p.claudeConfigDir, { recursive: true })
      mkdirSync(p.logsDir, { recursive: true })
    } catch (err) {
      console.error('[authStore] mkdir tenant dirs failed', { message: (err as Error).message })
    }
    process.env.CLAUDE_CONFIG_DIR = p.claudeConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  // 让按租户定位的两处状态刷新到新目录。
  invalidateSettingsCache()
  reopenLogFile()
}

export function getAuthState(): AuthSnapshot {
  const f = load()
  const tid = f.activeTenantId
  const u = tid ? f.users[tid] : undefined
  return {
    loggedIn: tid != null,
    // `|| null`（而非 `?? null`）把退化的空串也规整成 null，与 AuthSnapshot
    // 的 `string | null` 类型一致——空串不是合法掩码号，调用方 `if (phone)`
    // 不该被它误判为有值。
    phone: u?.phone || null,
    nickname: u?.nickname || null,
    tenantId: tid
  }
}

/**
 * 写入登录态并（当租户变化时）激活。返回归一化后的快照。
 * 登出（loggedIn=false 或 tenantId=null）把 activeTenantId 置空但保留 users
 * 注册表，这样返回用户的昵称还在。
 */
export function setAuthState(next: AuthSnapshot): AuthSnapshot {
  const f = load()
  const prevTid = f.activeTenantId

  if (!next.loggedIn || !next.tenantId) {
    persist({ ...f, activeTenantId: null })
    if (prevTid !== null) activateTenant(null)
    return getAuthState()
  }

  const tid = next.tenantId
  const users = { ...f.users }
  // 用最新的掩码号/昵称覆盖该租户身份（昵称改名也走这条）。
  users[tid] = {
    phone: next.phone ?? users[tid]?.phone ?? '',
    nickname: next.nickname ?? users[tid]?.nickname ?? ''
  }
  persist({ activeTenantId: tid, users })
  if (prevTid !== tid) activateTenant(tid)
  return getAuthState()
}

/** app 启动时调用一次：按持久化的 activeTenantId 激活（或保持登出）。 */
export function initTenantOnBoot(): void {
  activateTenant(load().activeTenantId)
}
