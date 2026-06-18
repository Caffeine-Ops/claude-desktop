# 多租户隔离（UX 级）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个手机号登录的用户成为独立租户——A 看不到 B 的对话、设置、外观偏好、最近工作区与日志，切账号时干净重来。

**Architecture:** 引入 `tenantId = sha256(原始手机号).slice(0,16)`（在渲染进程算，原号不离开渲染进程）。main 进程在租户激活时把 `process.env.CLAUDE_CONFIG_DIR` 指向 `<userData>/tenants/<tid>/.claude`——这一处同时让 fusion-code 子进程（继承 env）和 SDK 读取助手（同进程读 env）落到同一隔离目录。app 偏好拆成全局 `auth.json`（谁登录了）+ 每租户 `settings.json`。渲染进程的 localStorage 偏好按 tid 加后缀。切账号 = 杀掉所有 engine 子进程 + 拆 tab + reload 渲染进程。

**Tech Stack:** Electron（main/preload/renderer 三进程，electron-vite 打包）、React 19、zustand（含 persist 中间件）、`@anthropic-ai/claude-agent-sdk`、bun。

## Global Constraints

- 包管理器是 **bun**，不是 npm。命令：`bun run typecheck`、`bun run dev`。
- **唯一自动化质量门是 `bun run typecheck`**（tsc node + tsc web）。本仓库**没有单元测试、没有 ESLint**。因此每个任务的「测试」环节 = 跑 `bun run typecheck` 必须零错误 + 文末列出的手动验证。
- TypeScript 是 composite 工程：main+preload+shared 在 `tsconfig.node.json`，renderer+shared 在 `tsconfig.web.json`。
- **加一条 IPC 必须同时改四处**：`shared/ipc-channels.ts`（通道常量 + 类型）→ `preload/index.ts`（方法）→ `preload/index.d.ts`（类型，注：当前仓库该文件可能不含 auth，以 `ChatApi` 实际定义处为准）→ main handler（`ipc/register.ts` 或 engine）。漏一处 typecheck 当场报错。
- 渲染进程**禁止** import Node 模块；一切主进程能力走 `window.chatApi`。
- 注释密度高，且解释「为什么这样而不是那样」。新增不变量必须把理由写进注释。
- `src/main/index.ts` 第一行 `import './bootstrap/loadEnv'` **必须保持第一**，不要在它之前插入任何 import。
- 隔离强度 = **UX 级**：数据明文落盘，不加密。已确认决策：不迁移旧 `~/.claude/projects` 会话；system backend 凭据随 `CLAUDE_CONFIG_DIR` 按租户重定向。

---

## 关键设计点（所有任务共享的心智模型）

**为什么用 `process.env.CLAUDE_CONFIG_DIR` 而不是到处传 tid：** SDK 的读取助手（`sessionStore.ts` 里的 `sdkListSessions`/`getSessionMessages`）运行在 **main 进程**，内部按 `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude` 定位 `projects/` 目录（证据见 spec 第 2 节 cli.js 的 `A7()`/`s$8()`）。fusion-code 子进程也继承 main 的 `process.env`。所以**只要在租户激活时设一次 `process.env.CLAUDE_CONFIG_DIR`**，读侧和写侧同时落到隔离目录。任意时刻只有一个活跃租户（切换时拆掉全部 tab），所以进程级单变量是正确的。

**激活时机：** ① app 启动时按持久化的 `activeTenantId` 激活；② 每次 `AUTH_SET` 改变租户时激活。激活 = `mkdir` 租户目录 + 设 `process.env.CLAUDE_CONFIG_DIR` + 失效 appSettings 缓存 + 重开日志流。登出时 `activeTenantId=null` → `delete process.env.CLAUDE_CONFIG_DIR`。

---

### Task 1: 租户路径助手 `tenantPaths.ts`

**Files:**
- Create: `apps/desktop/src/main/core/tenantPaths.ts`

**Interfaces:**
- Produces: `tenantPaths(tenantId: string): { root: string; claudeConfigDir: string; settingsPath: string; logsDir: string }`

- [ ] **Step 1: 写文件**

```ts
import { app } from 'electron'
import { join } from 'node:path'

/**
 * 每个租户（= 一个手机号登录态）的隔离目录布局：
 *
 *   <userData>/tenants/<tenantId>/
 *   ├── .claude/        # 作为子进程与 SDK 读侧的 CLAUDE_CONFIG_DIR：
 *   │                   #   会话 JSONL / todos / agent-memory / 凭据
 *   ├── settings.json   # 每租户应用偏好（cliBackend 等）
 *   └── logs/           # 每租户运行时日志
 *
 * tenantId 是「原始手机号的 sha256 前 16 hex」（在渲染进程算，原号绝不落盘）。
 * 这里集中所有路径拼接，别在调用点散落 join()——改布局只动这一处。
 */
export interface TenantPaths {
  root: string
  claudeConfigDir: string
  settingsPath: string
  logsDir: string
}

export function tenantPaths(tenantId: string): TenantPaths {
  const root = join(app.getPath('userData'), 'tenants', tenantId)
  return {
    root,
    claudeConfigDir: join(root, '.claude'),
    settingsPath: join(root, 'settings.json'),
    logsDir: join(root, 'logs')
  }
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS（新文件无被引用也应通过；若报「未使用」类错误，确认 tsconfig 不开 noUnusedLocals 对未引用模块——通常不会报）

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/core/tenantPaths.ts
git commit -m "feat(tenant): 租户隔离目录路径助手"
```

---

### Task 2: 全局 `authStore.ts` + 租户激活

**Files:**
- Create: `apps/desktop/src/main/core/authStore.ts`
- Modify: `apps/desktop/src/main/index.ts`（启动时按持久化租户激活；保持 `loadEnv` import 第一）

**Interfaces:**
- Consumes: `tenantPaths` (Task 1)；`AuthState`（Task 4 会加 `tenantId`，本任务先用本地等价结构，Task 4 切到共享类型）
- Produces:
  - `getAuthState(): { loggedIn: boolean; phone: string | null; nickname: string | null; tenantId: string | null }`
  - `setAuthState(next): typeof next` —— 持久化到 `auth.json`，更新 users 注册表，**并在 tenant 变化时激活**
  - `getActiveTenantId(): string | null`
  - `activateTenant(tenantId: string | null): void`
  - `initTenantOnBoot(): void`

- [ ] **Step 1: 写 `authStore.ts`**

```ts
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

const DEFAULTS: AuthFile = { activeTenantId: null, users: {} }
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
    phone: u?.phone ?? null,
    nickname: u?.nickname ?? null,
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
```

- [ ] **Step 2: 在 main 入口启动时激活**

打开 `apps/desktop/src/main/index.ts`，找到 app `whenReady`/初始化处（在创建任何窗口/engine 之前），加入：

```ts
import { initTenantOnBoot } from './core/authStore'
// ... 在 app.whenReady().then(...) 内、createShellWindow() 之前：
initTenantOnBoot()
```

注意：`import './bootstrap/loadEnv'` 必须仍是文件第一行；新 import 放其后。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 会因 Task 3 尚未创建 `invalidateSettingsCache`、Task 7 尚未创建 `reopenLogFile` 而**报缺失导出**。这是预期的——这两个由 Task 3 / Task 7 补上。**本步先确认错误仅限这两个未定义导出**；其余无新错。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/core/authStore.ts apps/desktop/src/main/index.ts
git commit -m "feat(tenant): 全局 authStore + 租户激活（CLAUDE_CONFIG_DIR 切换）"
```

---

### Task 3: `appSettings.ts` 改为每租户 + 移除 auth 字段

**Files:**
- Modify: `apps/desktop/src/main/core/appSettings.ts`

**Interfaces:**
- Consumes: `getActiveTenantId`, `tenantPaths`
- Produces: `getAppSettings()`、`updateAppSettings()`（签名不变，但 `AppSettings` 去掉 auth 字段）、新增 `invalidateSettingsCache(): void`

- [ ] **Step 1: 重写 `appSettings.ts`**

把整个文件替换为下面版本（移除 `authLoggedIn/authPhone/authNickname`，路径改为按租户，新增缓存失效）：

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getActiveTenantId } from './authStore'
import { tenantPaths } from './tenantPaths'

/**
 * 每租户应用偏好。文件位于 <userData>/tenants/<activeTenantId>/settings.json。
 * 登录态本身不在这里（见 authStore.ts / auth.json）——那是定位本文件所需的前置，
 * 不能再塞回来，否则又变回鸡生蛋。
 *
 * 未登录（无 activeTenantId）时：读返回 DEFAULTS、写是 no-op（没有租户目录可落）。
 * 切换租户时 authStore.activateTenant() 会调用 invalidateSettingsCache()，
 * 使下一次读重新从新租户的文件加载。
 */
export type CliBackend = 'bundled' | 'system'

export interface AppSettings {
  cliBackend: CliBackend
}

const DEFAULTS: AppSettings = {
  cliBackend: 'bundled'
}

let cached: AppSettings | null = null

function settingsPath(): string | null {
  const tid = getActiveTenantId()
  return tid ? tenantPaths(tid).settingsPath : null
}

function load(): AppSettings {
  if (cached) return cached
  const path = settingsPath()
  if (!path) {
    // 未登录——返回默认，且不缓存（登录后路径会变）。
    return { ...DEFAULTS }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppSettings>
    cached = { ...DEFAULTS, ...normalize(parsed) }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      console.warn('[appSettings] load failed — using defaults', {
        path,
        message: e.message
      })
    }
    cached = { ...DEFAULTS }
  }
  return cached
}

function normalize(raw: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {}
  if (raw.cliBackend === 'bundled' || raw.cliBackend === 'system') {
    out.cliBackend = raw.cliBackend
  }
  return out
}

export function getAppSettings(): AppSettings {
  return { ...load() }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const path = settingsPath()
  if (!path) {
    // 未登录时不该有人写设置（UI 被登录墙挡住）；防御性地 no-op。
    console.warn('[appSettings] update ignored — no active tenant')
    return { ...DEFAULTS }
  }
  const next = { ...load(), ...normalize(patch) }
  cached = next
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.error('[appSettings] write failed', { path, message: (err as Error).message })
  }
  return { ...next }
}

/** 切换租户时调用，丢弃当前租户的缓存，下一次读重新加载新租户文件。 */
export function invalidateSettingsCache(): void {
  cached = null
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 现在会在 **`register.ts`** 报错——AUTH_GET/SET 还在读写 `s.authLoggedIn` 等已删除字段。这由 Task 4 修。本步确认 `appSettings.ts` 自身无错、`authStore.ts` 的 `invalidateSettingsCache` 缺失错误消失。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/core/appSettings.ts
git commit -m "refactor(settings): appSettings 改为每租户定位，移除 auth 字段"
```

---

### Task 4: IPC 接线 —— AuthState 加 tenantId、TENANT_ID_GET、AUTH_GET/SET 重接 + 切换编排

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts`（`AuthState` 加 `tenantId`；新增 `TENANT_ID_GET` 常量 + `ChatApi.tenantId` 类型）
- Modify: `apps/desktop/src/main/ipc/register.ts`（AUTH_GET/SET 改走 authStore；AUTH_SET 触发切换；加 `TENANT_ID_GET` 同步 handler）
- Modify: `apps/desktop/src/preload/index.ts`（`getAuth`/`setAuth` 透传 tenantId；暴露同步 `tenantId`）

**Interfaces:**
- Consumes: `getAuthState`/`setAuthState`/`getActiveTenantId`（Task 2）；`resetForTenantSwitch`（Task 7）
- Produces: `AuthState` 含 `tenantId: string | null`；`window.chatApi.tenantId: string | null`（同步快照）

- [ ] **Step 1: 扩展 `AuthState` + 新通道常量（ipc-channels.ts）**

把 `AuthState`（约第 804 行）改为：

```ts
export type AuthState = {
  loggedIn: boolean
  phone: string | null
  nickname: string | null
  /**
   * 稳定的租户唯一键 = sha256(原始手机号) 前 16 hex（在渲染进程算，原号绝不
   * 离开渲染进程——只有这个哈希离开）。掩码号会撞，不能当键，故单列此字段。
   * null 表示登出。
   */
  tenantId: string | null
}
```

在 AUTH 常量块（约第 426–464 行）末尾加一条同步通道常量：

```ts
  AUTH_VERIFY_CODE: 'auth:verify-code',
  /**
   * 同步取当前 activeTenantId（preload 用 ipcRenderer.sendSync）。渲染进程的
   * localStorage 偏好键要在首帧前（bootAppearance / store 创建）就拼上 tid，
   * 异步 invoke 来不及，故用 sendSync。
   */
  TENANT_ID_GET: 'tenant:id-get'
```

（注意：把原 `AUTH_VERIFY_CODE` 那一行的结尾逗号补好，再追加新行。）

在 `ChatApi` 接口（含 `getAuth`/`setAuth` 处，约第 1161 行附近）加：

```ts
  /** 当前租户 id 的同步快照（preload 在加载时经 sendSync 取得）。null=登出。 */
  tenantId: string | null
```

- [ ] **Step 2: 重写 AUTH_GET / AUTH_SET + 加 TENANT_ID_GET（register.ts）**

把 `register.ts` 顶部对 `getAppSettings`/`updateAppSettings` 的 auth 相关用法替换为 authStore。先确保有 import：

```ts
import {
  getAuthState,
  setAuthState,
  getActiveTenantId
} from '../core/authStore'
import { resetForTenantSwitch } from '../tabRegistry'
```

把 AUTH_GET（约 883–890）替换为：

```ts
  ipcMain.handle(IPC_CHANNELS.AUTH_GET, async (): Promise<AuthState> => {
    return getAuthState()
  })
```

把 AUTH_SET（约 892–912）替换为：

```ts
  ipcMain.handle(
    IPC_CHANNELS.AUTH_SET,
    async (event, state: AuthState): Promise<AuthState> => {
      const prevTid = getActiveTenantId()
      // setAuthState 内部在租户变化时已调用 activateTenant（切 CLAUDE_CONFIG_DIR、
      // 失效设置缓存、重开日志流）。
      const next = setAuthState({
        loggedIn: !!state?.loggedIn,
        phone: state?.phone ?? null,
        nickname: state?.nickname ?? null,
        tenantId: state?.loggedIn ? (state?.tenantId ?? null) : null
      })

      // 广播给其它窗口（写入方已本地更新）。
      broadcastAuthChanged(event.sender.id, next)

      // 租户真的换了（含登出）→ 杀掉所有 engine 子进程、拆 tab、reload 渲染进程。
      // 仅改昵称（同租户）不触发，避免无谓重置。
      if (next.tenantId !== prevTid) {
        await resetForTenantSwitch()
      }
      return next
    }
  )
```

在 AUTH_VERIFY_CODE handler 之后，加同步 handler：

```ts
  // 同步：preload 启动时取 tid 拼 localStorage 命名空间键。
  ipcMain.on(IPC_CHANNELS.TENANT_ID_GET, (event) => {
    event.returnValue = getActiveTenantId()
  })
```

- [ ] **Step 3: preload 透传 tenantId + 暴露同步快照（preload/index.ts）**

`getAuth`/`setAuth` 已透传整个 `AuthState`，`tenantId` 自动随之走，无需改这两个方法体。仅需暴露同步快照。在构造 `chatApi` 对象处加一个字段（与 `getAuth` 同级）：

```ts
  // 同步取一次 tid（preload 在 renderer 脚本前运行，sendSync 可用）。渲染进程
  // 切租户时整页 reload，preload 重新执行 → 重新取到新 tid。
  tenantId: ipcRenderer.sendSync(IPC_CHANNELS.TENANT_ID_GET) as string | null,
```

若 `preload/index.d.ts` 存在并镜像了 `ChatApi`，同步加 `tenantId: string | null`。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 仅剩 `resetForTenantSwitch`（Task 7）未定义的错误。其余 auth 相关错误应清零。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/main/ipc/register.ts apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.d.ts
git commit -m "feat(tenant): AuthState 加 tenantId + TENANT_ID_GET + AUTH_SET 触发切换"
```

---

### Task 5: engine 注入 CLAUDE_CONFIG_DIR + spawn 守卫

**Files:**
- Modify: `apps/desktop/src/main/core/engine.ts`（`openSession` 的两个 env 块；spawn 前守卫）

**Interfaces:**
- Consumes: `getActiveTenantId`（Task 2）

- [ ] **Step 1: import + spawn 守卫**

在 `engine.ts` 顶部 import 区加：

```ts
import { getActiveTenantId } from './authStore'
```

在 `openSession`（约第 1122 行）方法体最前面，`const backend = getAppSettings().cliBackend` 之前加守卫：

```ts
    // 未登录绝不 spawn：登录墙本就挡住 send/warmup，这里再加显式断言，确保没有
    // 任何代码路径在无租户时把子进程的会话写进默认 ~/.claude（会污染全局）。
    if (!getActiveTenantId()) {
      throw new Error('openSession blocked: no active tenant')
    }
```

- [ ] **Step 2: 两个 env 块显式加 CLAUDE_CONFIG_DIR**

`process.env.CLAUDE_CONFIG_DIR` 已在租户激活时设好，子进程继承 `...process.env` 时本就带上。但为防御 `systemBackendEnv()` 将来收紧白名单，**两个分支都显式带上**。

bundled 分支（约第 1322 行 `{ ...process.env,` 之后）加一行：

```ts
            ...process.env,
            // 租户隔离：子进程把会话 JSONL / todos / 凭据写到这个目录。
            // 激活时已设进 process.env，这里显式重申以防 env 过滤误删。
            CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
            CLAUDE_CODE_MCP_INSTR_DELTA:
```

system 分支（约第 1340 行 `{ ...systemBackendEnv(),` 之后）加：

```ts
            ...systemBackendEnv(),
            // system claude 的凭据/会话也按租户隔离（已确认：每租户各自登录一次）。
            CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
```

注意：env 块的类型是 `Record<string, string>`，而 `process.env.CLAUDE_CONFIG_DIR` 是 `string | undefined`。由于守卫保证激活态下它必为字符串，但 TS 不知道——若 typecheck 报 `string | undefined` 不可赋给 `string`，用非空断言 `process.env.CLAUDE_CONFIG_DIR!`（注释说明守卫已保证），或在守卫处取局部 `const claudeConfigDir = tenantPaths(getActiveTenantId()!).claudeConfigDir` 并引用它。优先后者更干净——若选后者，记得 `import { tenantPaths }`。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 关于 env 的类型错误（若有）按 Step 2 末尾处理后清零；`resetForTenantSwitch` 仍缺（Task 7）。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/core/engine.ts
git commit -m "feat(tenant): engine 注入 CLAUDE_CONFIG_DIR + 无租户禁止 spawn"
```

---

### Task 6: sessionStore 读侧指向租户目录

**Files:**
- Modify: `apps/desktop/src/main/core/sessionStore.ts`（`findSessionJsonl` 的 `projectsDir`）

- [ ] **Step 1: 改 projectsDir 来源**

`sessionStore.ts` 第 132 行：

```ts
  const projectsDir = join(homedir(), '.claude', 'projects')
```

改为：

```ts
  // 与 fusion-code CLI 的 A7() 一致：projects 目录 = CLAUDE_CONFIG_DIR/projects。
  // 租户激活时 CLAUDE_CONFIG_DIR 已指向 <userData>/tenants/<tid>/.claude，所以
  // 这里读到的是当前租户的会话；无租户时回退默认 ~/.claude（守卫下不会发生）。
  const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const projectsDir = join(configRoot, 'projects')
```

注：`listSessions`/`loadSession` 走 SDK 的 `sdkListSessions`/`getSessionMessages`，它们**自身**就读 `process.env.CLAUDE_CONFIG_DIR`（同进程），无需改——只有我们手写的 `findSessionJsonl` 这处硬编码要改。`homedir` import 仍被回退分支用到，保留。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 无新错（仍仅剩 `resetForTenantSwitch`）。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/core/sessionStore.ts
git commit -m "feat(tenant): sessionStore 读侧改用 CLAUDE_CONFIG_DIR/projects"
```

---

### Task 7: 日志按租户 + tabRegistry 切换重置

**Files:**
- Modify: `apps/desktop/src/main/core/logCollector.ts`（`logsDir` 按租户；新增 `reopenLogFile`）
- Modify: `apps/desktop/src/main/tabRegistry.ts`（新增 `resetForTenantSwitch`）

**Interfaces:**
- Produces: `reopenLogFile(): void`（logCollector）；`resetForTenantSwitch(): Promise<void>`（tabRegistry）
- Consumes: `getActiveTenantId`, `tenantPaths`

- [ ] **Step 1: logCollector 按租户定位 + 重开**

`logCollector.ts` import 区加：

```ts
import { getActiveTenantId } from './authStore'
import { tenantPaths } from './tenantPaths'
```

把 `logsDir()`（约第 60–62 行）改为：

```ts
/** 日志目录：登录后 <userData>/tenants/<tid>/logs；未登录回退 <userData>/logs。 */
function logsDir(): string {
  const tid = getActiveTenantId()
  return tid ? tenantPaths(tid).logsDir : join(app.getPath('userData'), 'logs')
}
```

在 `clearLogs` 之后（约第 168 行后）加：

```ts
/**
 * 切换租户时调用：关掉当前日志写流并置空，使下一条 push 触发 openFileStream
 * 在新租户的 logs/ 目录重建当天文件。内存环形缓冲不动（切换会随即 reload
 * 渲染进程，面板自会重新拉取）。
 */
export function reopenLogFile(): void {
  if (fileStream) {
    try {
      fileStream.end()
    } catch {
      /* ignore */
    }
    fileStream = null
  }
  fileStreamFailed = false
}
```

- [ ] **Step 2: tabRegistry 切换重置**

`tabRegistry.ts` 复用 shell-close 已有的「dispose 每个 engine」模式（约第 245–260 行）。在文件末尾（或 `closeTab` 附近）加导出函数。**先读该文件确认 `tabs` map、`activeTabId`、视图从 shell 移除的具体调用**，下面是按已知 API 写的实现，落地时让它与现有 `closeTab`/shell-close 的拆卸方式一致：

```ts
/**
 * 切换租户（登录/登出/切号）时的整机软重置：dispose 全部 engine（杀掉各自钉在
 * 旧 CLAUDE_CONFIG_DIR 的 fusion-code 子进程）、销毁全部 tab 视图、清空注册表，
 * 然后 reload shell 渲染进程并开一个干净 tab。
 *
 * 为什么 reload 而非就地 rehydrate：新租户的 CLAUDE_CONFIG_DIR 已切换，旧 engine
 * 必须重起；且渲染进程的 localStorage 偏好按 tid 命名空间，reload 后 preload 取到
 * 新 tid、boot 读新键，比就地重置每个 store 干净得多、bug 面小得多。
 */
export async function resetForTenantSwitch(): Promise<void> {
  const all = Array.from(tabs.values())
  tabs.clear()
  // 先清空 map，避免拆卸期间有人看到半销毁的 engine。
  for (const ctx of all) {
    void ctx.engine?.dispose().catch((err) => {
      console.warn('[tabRegistry] engine.dispose failed on tenant switch:', err)
    })
    // 与 closeTab 一致地从 shell 移除并销毁视图（用该文件已有的移除/关闭调用）。
    try {
      ctx.view.webContents.close()
    } catch {
      /* 视图可能已在销毁 */
    }
  }
  // 重置活动指针（沿用文件内对 activeTabId 的声明方式）。
  activeTabId = null

  // reload shell 渲染进程：它重新 hydrate auth（已是新租户/登出态），登录墙据此
  // 显示或放行。reload 后开一个新 tab 作为干净起点。
  const shell = getShellWindow() // 用本文件已有的 shell 持有方式（createShellWindow 返回值/模块变量）
  if (shell && !shell.isDestroyed()) {
    shell.webContents.reload()
  }
  newTab()
}
```

落地注意：`activeTabId`、`tabs`、shell window 的持有方式以 `tabRegistry.ts` 现有声明为准（读第 159–160、187–276、500–605 行确认变量名）。若 shell 没有现成 getter，用模块内已存的 `BrowserWindow` 引用；`ctx.view` 的字段名以 `TabContext` 定义为准（第 145–177 行）。目标行为固定：**所有 engine dispose + 所有视图销毁 + 清空 + reload shell + 开一个新 tab**。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: PASS（至此所有跨任务的未定义导出都补齐：`invalidateSettingsCache`、`reopenLogFile`、`resetForTenantSwitch`）。若仍报错，按报错点对齐变量名/字段名。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/core/logCollector.ts apps/desktop/src/main/tabRegistry.ts
git commit -m "feat(tenant): 日志按租户 + 切换时整机软重置（dispose engines + reload）"
```

---

### Task 8: 渲染进程 —— tenantId 哈希 + localStorage 按租户命名空间

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/tenantKey.ts`
- Modify: `apps/desktop/src/renderer/src/stores/auth.ts`（login 计算 tenantId 并透传）
- Modify: `apps/desktop/src/renderer/src/stores/appearance.ts`（persist name 加 tid）
- Modify: `apps/desktop/src/renderer/src/stores/permissionMode.ts`（persist name 加 tid）
- Modify: `apps/desktop/src/renderer/src/i18n.ts`（persist name 加 tid）
- Modify: `apps/desktop/src/renderer/src/stores/workspace.ts`（STORAGE_KEY 加 tid）
- Modify: `apps/desktop/src/renderer/src/main.tsx`（bootAppearance 读命名空间键——若它直接读 localStorage）

**Interfaces:**
- Consumes: `window.chatApi.tenantId`（Task 4）；`AuthState.tenantId`
- Produces: `tenantKey(base: string): string`

- [ ] **Step 1: tenantKey 助手**

写 `apps/desktop/src/renderer/src/lib/tenantKey.ts`：

```ts
/**
 * 把一个 localStorage 基名加上当前租户后缀，实现按用户隔离的渲染进程偏好。
 *
 * tenantId 取自 preload 在加载时同步取得的 window.chatApi.tenantId（切租户会整页
 * reload，preload 重新执行 → 这里自然拿到新 tid）。未登录用 'anon'，其偏好不会
 * 泄漏给任何已登录用户。
 *
 * 注意：在模块加载期（zustand persist 创建、bootAppearance）调用是安全的——preload
 * 先于 renderer 脚本运行，此时 window.chatApi.tenantId 已就绪。
 */
export function tenantKey(base: string): string {
  const tid = window.chatApi?.tenantId ?? 'anon'
  return `${base}:${tid}`
}
```

- [ ] **Step 2: auth.ts 计算并透传 tenantId**

`stores/auth.ts`：`AuthIpcState` 现在含 `tenantId`（Task 4 已加）。加哈希函数并改 `login` 为异步先算 tid 再 set+push。

在文件顶部加：

```ts
/** tenantId = sha256(原始手机号) 前 16 hex。Web Crypto，异步。原号不离开本函数。 */
async function hashTenant(rawPhone: string): Promise<string> {
  const data = new TextEncoder().encode(rawPhone)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}
```

把 store 里 `login` 字段类型与实现改为异步（接口 `login: (rawPhone: string) => Promise<void>`），实现：

```ts
  login: async (rawPhone) => {
    const phone = maskPhone(rawPhone)
    const tenantId = await hashTenant(rawPhone)
    // 同号重登保留旧昵称；不同号是不同账号，绝不继承上一个用户的昵称。
    const sameUser = get().tenantId === tenantId
    const nickname = sameUser ? (get().nickname ?? DEFAULT_NICKNAME) : DEFAULT_NICKNAME
    set({ loggedIn: true, phone, nickname })
    pushToMain({ loggedIn: true, phone, nickname, tenantId })
  },
```

在 `AuthStoreState` 接口加 `tenantId: string | null`，初值 `tenantId: null`；`setNickname` 的 `pushToMain` 和 `logout` 的 `pushToMain`、`_adopt` 都带上 `tenantId`：

```ts
  // setNickname 内：
    pushToMain({ loggedIn: true, phone, nickname, tenantId: get().tenantId })
  // logout 内：
    set({ loggedIn: false, phone: null, nickname: null, tenantId: null })
    pushToMain({ loggedIn: false, phone: null, nickname: null, tenantId: null })
  // _adopt 内：
    set({
      loggedIn: state.loggedIn,
      phone: state.phone,
      nickname: state.nickname,
      tenantId: state.tenantId
    })
```

LoginDialog 调用 `login(rawPhone)` 处现在返回 Promise——若它原来不 await，加 `await`（或 `void login(...)` 后照常关闭弹窗；登录后会整页 reload，本地 set 只为过渡）。读 `LoginDialog.tsx` 确认调用点并按需加 `await`。

- [ ] **Step 3: 四个 persist 键加租户后缀**

`stores/appearance.ts` 第 115 行 `name: 'claude-desktop:appearance',` →

```ts
      name: tenantKey('claude-desktop:appearance'),
```

并在文件顶部 `import { tenantKey } from '../lib/tenantKey'`。

`stores/permissionMode.ts` 第 77 行 `name: 'claude-desktop:permission-mode',` →
```ts
      name: tenantKey('claude-desktop:permission-mode'),
```
（同样 import tenantKey，路径 `'../lib/tenantKey'`）

`i18n.ts` 第 46 行 `{ name: 'claude-desktop:lang' }` →
```ts
    { name: tenantKey('claude-desktop:lang') }
```
（import 路径 `'./lib/tenantKey'`）

`stores/workspace.ts` 第 23 行 `const STORAGE_KEY = 'workspace.recent.v1'` →
```ts
import { tenantKey } from '../lib/tenantKey'
const STORAGE_KEY = tenantKey('workspace.recent.v1')
```

- [ ] **Step 4: main.tsx bootAppearance 用命名空间键**

读 `apps/desktop/src/renderer/src/main.tsx` 的 `bootAppearance()`。它在 React 挂载前同步读 `localStorage.getItem('claude-desktop:appearance')` 防 FOUC。把那个键改成 `tenantKey('claude-desktop:appearance')`（import `./lib/tenantKey`）。zustand persist 实际存的键是 `name`，与之必须一致——两处都用 `tenantKey('claude-desktop:appearance')` 即可保证一致。若 bootAppearance 不直接读 localStorage（而是别的机制），跳过本步。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS（node 与 web 两侧均零错误）。`login` 变异步若导致调用点类型错误，按 Step 2 末尾在 LoginDialog 加 await 解决。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/tenantKey.ts apps/desktop/src/renderer/src/stores/auth.ts apps/desktop/src/renderer/src/stores/appearance.ts apps/desktop/src/renderer/src/stores/permissionMode.ts apps/desktop/src/renderer/src/i18n.ts apps/desktop/src/renderer/src/stores/workspace.ts apps/desktop/src/renderer/src/main.tsx
git commit -m "feat(tenant): 渲染进程 tenantId 哈希 + localStorage 按租户命名空间"
```

---

### Task 9: 端到端手动验证

**Files:** 无（验证任务）

本仓库无 e2e 框架，手动跑一遍隔离闭环。

- [ ] **Step 1: 起 dev**

Run: `bun run dev`
Expected: 应用启动，显示登录墙。

- [ ] **Step 2: 用户 A 建数据**

用手机号 A（如 `13800000001`，验证码看 Electron 终端 `[authCodeService] STUB code`）登录。
- 发起一个对话，发一条消息让 fusion-code 真正 spawn（建出 JSONL）。
- 打开设置，把 cliBackend 切到一个可辨识值（若可切）；改一次外观主题；改昵称；打开过一个工作区。
- 终端确认：`<userData>/tenants/<tidA>/.claude/projects/...` 下出现 JSONL；`<userData>/tenants/<tidA>/settings.json` 存在。

验证命令（另开终端，macOS）：
Run: `ls -la "$HOME/Library/Application Support/claude-desktop/tenants"`
Expected: 出现一个以 tidA 命名的目录，内含 `.claude/`、`settings.json`、`logs/`。

- [ ] **Step 3: 登出 → 用户 B**

从账号菜单登出 → 应整页重置回登录墙（终端可见 engine dispose / reload）。用手机号 B（如 `13800000002`）登录。
Expected:
- 会话侧边栏为空（看不到 A 的对话）。
- 外观/语言/权限模式回到默认（不是 A 改过的值）。
- 最近工作区为空。
- 昵称是 B 的默认占位名。

- [ ] **Step 4: 切回 A 验证数据还在**

登出 B → 登录 A。
Expected: A 的对话、设置、外观、昵称、最近工作区**全部还在**。

- [ ] **Step 5: 目录隔离确认**

Run: `ls "$HOME/Library/Application Support/claude-desktop/tenants"`
Expected: 两个租户目录（tidA、tidB）各自独立；`cat .../auth.json` 显示 `activeTenantId` 为当前登录者、`users` 含两条身份。

- [ ] **Step 6: typecheck 收尾**

Run: `bun run typecheck`
Expected: PASS。

若任一验证不符，回到对应任务排查（对话泄漏→Task 5/6 的 CLAUDE_CONFIG_DIR；设置泄漏→Task 3；外观/最近工作区泄漏→Task 8 的命名空间键；切换不重置→Task 7）。

---

## Self-Review（作者自检）

- **Spec 覆盖：**
  - tenantId 派生（spec 3.1）→ Task 8 Step 2 ✅
  - 每用户根目录（3.2）→ Task 1 ✅
  - 鸡生蛋/设置拆分（spec 4）→ Task 2（auth.json）+ Task 3（每租户 settings）✅
  - 对话隔离 CLAUDE_CONFIG_DIR（5.1）→ Task 2（激活设 env）+ Task 5（子进程）+ Task 6（读侧）✅
  - 渲染偏好命名空间（5.2）→ Task 8 ✅
  - 日志按租户（5.3）→ Task 7 ✅
  - 切号软重置（spec 6）→ Task 7（resetForTenantSwitch）+ Task 4（AUTH_SET 触发）✅
  - IPC 改动（spec 7）→ Task 4 ✅
  - 不迁移/不加密/不 OS 级（spec 7 YAGNI）→ 计划中无相关任务 ✅（刻意不做）
- **占位符扫描：** 无 TODO/TBD；orchestration（Task 7 Step 2）给了完整实现骨架 + 明确「以现有变量名为准」的对齐说明，行为固定，非占位。
- **类型一致性：** `tenantId` 贯穿 AuthState（Task 4）↔ authStore.AuthSnapshot（Task 2）↔ auth.ts store（Task 8）字段名一致；`invalidateSettingsCache`/`reopenLogFile`/`resetForTenantSwitch` 在定义任务与消费任务中拼写一致。
- **跨任务编译依赖：** Task 2/3/4/5/6 中途 typecheck 会有「下游导出未定义」的预期错误，已在各任务 Expected 标注，到 Task 7 全部收敛——这是有意的自底向上顺序，非疏漏。
