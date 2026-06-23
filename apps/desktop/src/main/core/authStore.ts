import { app } from 'electron'
import { createHash } from 'node:crypto'
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

/**
 * 首次登录的默认昵称。后端没有用户名字段，新用户从这个占位名起步，可在账号菜单
 * 改名。刻意区别于手机号，免得两行 chrome 芯片（昵称在上、手机号在下）显示成同
 * 一串。曾在渲染进程，现随身份派生一起收归 main（见 loginTenant）。
 */
const DEFAULT_NICKNAME = 'Open Design 用户'

/**
 * tenantId = sha256(原始手机号) 前 16 hex。**信任根在 main**：登录身份的派生只发生
 * 在这里，渲染进程拿不到也伪造不了 tid（它只 mirror main 回传的快照）。
 *
 * 必须与渲染进程的历史算法逐位一致，否则老用户的 tenants/<tid>/ 目录会失配——
 * Node 的 createHash('sha256') 与渲染进程旧 Web Crypto 对相同 UTF-8 字节产出相同
 * 摘要，故这次「派生搬到 main」对已有数据无感。掩码号会撞，不能当键，故用此哈希。
 */
function computeTenantId(rawPhone: string): string {
  return createHash('sha256').update(rawPhone, 'utf8').digest('hex').slice(0, 16)
}

/** 138****8888 —— 留前 3 后 4，中间打码。非 11 位则整体打码，绝不回退到原号。 */
function maskPhone(raw: string): string {
  if (raw.length === 11) return `${raw.slice(0, 3)}****${raw.slice(7)}`
  return '*'.repeat(raw.length)
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
 * 处理来自渲染进程的 AUTH_SET。**只负责登出与改名**——绝不在这里引入/切换租户。
 * 登入身份的派生与租户切换走 loginTenant()（main 在短信验证后调用），渲染进程
 * 无从触碰 tid，故无法用一条 AUTH_SET 伪造任意租户、绕过验证码。
 *
 * 关键：身份字段（tenantId / phone）**完全不信任渲染进程传入值**——
 *   - 登出只看 `loggedIn` 标志；
 *   - 改名只作用于【当前 activeTenantId】，传入的 tenantId 一律忽略。
 * 这样渲染进程在跨窗口竞态里推来一个 stale tenantId（比如另一个窗口刚登出、本
 * 窗口还没 adopt）也不会把改名误判成登出、或被「tid 不匹配」拒掉而丢失。改名的
 * 权威定位始终是 main 自己的 activeTenantId。
 */
export function setAuthState(next: AuthSnapshot): AuthSnapshot {
  const f = load()
  const prevTid = f.activeTenantId

  // 登出：只凭 loggedIn 标志（不看 next.tenantId）。清 activeTenantId，保留 users
  // 注册表，返回用户昵称还在。
  if (!next.loggedIn) {
    persist({ ...f, activeTenantId: null })
    if (prevTid !== null) activateTenant(null)
    return getAuthState()
  }

  // 改名：只更新【当前激活租户】的昵称，忽略 next.tenantId。没有激活租户（已登出/
  // 竞态）则无可改，no-op 返回现状——绝不凭渲染进程传入的 tid 去新建或切换租户。
  if (!prevTid) return getAuthState()
  const users = { ...f.users }
  users[prevTid] = {
    // 掩码号不随改名变化，优先保留注册表里的既有值。
    phone: users[prevTid]?.phone ?? next.phone ?? '',
    nickname: next.nickname ?? users[prevTid]?.nickname ?? ''
  }
  persist({ activeTenantId: prevTid, users })
  return getAuthState()
}

/**
 * 权威登录：由 main 在短信验证通过后调用（AUTH_LOGIN handler，已 consume 过验证
 * 证明）。从【原始手机号】派生 tenantId 与掩码号——派生只发生在 main，这是租户
 * 隔离的信任根。持久化为 activeTenantId 并按需 activate，返回归一化快照。
 *
 * 原始号到此为止：只它的 sha256 前缀（tid）和掩码号被持久化，原号绝不落盘。
 * 返回用户保留旧昵称；新用户给默认占位名。
 */
export function loginTenant(rawPhone: string): AuthSnapshot {
  const f = load()
  const prevTid = f.activeTenantId
  const tid = computeTenantId(rawPhone)
  const users = { ...f.users }
  users[tid] = {
    phone: maskPhone(rawPhone),
    nickname: users[tid]?.nickname || DEFAULT_NICKNAME
  }
  persist({ activeTenantId: tid, users })
  if (prevTid !== tid) activateTenant(tid)
  return getAuthState()
}

/** app 启动时调用一次：按持久化的 activeTenantId 激活（或保持登出）。 */
export function initTenantOnBoot(): void {
  activateTenant(load().activeTenantId)
}
