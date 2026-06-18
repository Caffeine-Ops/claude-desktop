# 多租户隔离设计（UX 级）

- 日期：2026-06-18
- 分支起点：`refactor/monorepo-skeleton`
- 隔离强度：**UX 级**（同机器、彼此信任的用户切换账号；数据明文落盘，不做加密，不做 OS 账号级方案）

## 1. 目标与非目标

### 目标
用户 A 登录后只能看到自己的对话、设置、外观偏好、最近工作区与日志；切到用户 B 后看到的是 B 的那一套，互不可见、互不串扰。每个手机号是一个独立租户。

### 非目标
- **不做加密**：数据仍明文落盘，懂技术的人翻文件系统能看到别人的——这是 UX 级隔离的明确边界。
- **不做 OS 账号级**：不依赖操作系统多用户。
- **不迁移旧数据**：升级前已存在于 `~/.claude/projects` 的会话不归入任何租户（成孤儿）。

## 2. 现状（为什么现在没隔离）

当前手机号登录只是**身份标记**（`stores/auth.ts` 注释明示），无 token、无真实后端（`authCodeService.ts` 是本地 stub）。各类数据现状：

| 数据 | 落盘位置 | 现在隔离吗 |
|---|---|---|
| 对话历史 JSONL | `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl` | 否（按工作区分，不按用户分） |
| 应用设置 settings.json | `<userData>/settings.json` | 否（全局一份，含 cliBackend + auth 字段） |
| 外观/语言/权限模式 | 渲染进程 localStorage | 否（按机器存，换账号不变） |
| 最近工作区 | localStorage `workspace.recent.v1` | 否 |
| 日志 | `<userData>/logs/runtime-YYYY-MM-DD.log` | 否 |
| Tab 状态 | 纯内存（`tabRegistry.ts`） | 是（重启即清） |

关键证据（fusion-code CLI 认 `CLAUDE_CONFIG_DIR`）——来自 SDK 内嵌 `cli.js`：

```js
A7 = () => (process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")).normalize("NFC")
function s$8(){ return join(A7(), "projects") }   // 会话目录 = CLAUDE_CONFIG_DIR/projects
```

即设置 `CLAUDE_CONFIG_DIR` 即可把子进程写的全部会话（连同 todos、agent-memory、凭据）重定向到独立目录。`sessionStore.ts:132` 当前硬编码 `join(homedir(), '.claude', 'projects')` 仅用于**读取列表**，需同步改为读同一目录。

## 3. 核心模型

### 3.1 tenantId
- 登录时由**原始手机号**计算 `tenantId = sha256(rawPhone)` 取 hex 前 16 位。
- 在**渲染进程**计算（`crypto.subtle.digest`，异步），保持「原始手机号绝不离开渲染进程」的现有不变量——只有哈希离开。
- 打码号 `138****8888` 仍只作显示用途，绝不当键（多个真号会映射到同一掩码）。

### 3.2 每用户根目录
```
<userData>/tenants/<tenantId>/
├── .claude/          # 作为 CLAUDE_CONFIG_DIR：会话/todos/agent-memory/凭据
├── settings.json     # 每用户应用设置（cliBackend 等）
└── logs/             # 每用户日志
```

`<userData>` = `app.getPath('userData')`（macOS `~/Library/Application Support/claude-desktop`，Windows `%APPDATA%/claude-desktop`）。

### 3.3 当前用户的权威
`activeTenantId` 由 **main 进程权威持有并持久化**，因为 engine spawn 子进程前就必须知道 `CLAUDE_CONFIG_DIR`。渲染进程的 auth store 是它的同步缓存（沿用现有 `AUTH_GET`/`AUTH_CHANGED` 机制）。

## 4. 鸡生蛋问题与设置文件拆分

「我是谁」必须先于「我的设置目录」可知，因此把当前混在一起的 `settings.json` 拆成两个文件：

| 文件 | 位置 | 内容 | 何时可读 |
|---|---|---|---|
| 全局 `auth.json` | `<userData>/auth.json` | `{ activeTenantId: string \| null, users: { [tenantId]: { phone: string, nickname: string } } }` | 任何时候（登录墙、账号菜单依赖它） |
| 每用户 `settings.json` | `<userData>/tenants/<tid>/settings.json` | `{ cliBackend, ... }` | 登录后 |

- 新增 main 模块 `authStore.ts`：读写全局 `auth.json`，持有 `activeTenantId` 与各租户身份（掩码号 + 昵称）。身份进全局 registry，是为了在尚未进入每用户目录时就能渲染登录墙/账号菜单，并让返回用户保留昵称。
- `appSettings.ts` 改造：`settingsPath()` 定位到 `<userData>/tenants/<activeTenantId>/settings.json`；`activeTenantId` 为 null（未登录）时返回 `DEFAULTS`、不写盘。auth 相关字段（`authLoggedIn`/`authPhone`/`authNickname`）从 `appSettings.ts` 移除，迁入 `authStore.ts`。

### 路径助手
新增 `tenantPaths(tenantId)` → `{ root, claudeConfigDir, settingsPath, logsDir }`，集中所有路径拼接，避免散落。

## 5. 数据流改造（按数据类别）

### 5.1 对话历史（CLAUDE_CONFIG_DIR 重定向）
- `engine.openSession()`：spawn 子进程的 env 注入 `CLAUDE_CONFIG_DIR = tenantPaths(activeTenantId).claudeConfigDir`，**bundled 与 system 两种 backend 都注入**，保持一致。
- 守卫：`activeTenantId` 为 null 时绝不 spawn（登录墙天然挡住 send/warmup，这里再加显式断言）。
- `sessionStore.ts:132`：读取路径从 `join(homedir(), '.claude', 'projects')` 改为 `join(tenantPaths(activeTenantId).claudeConfigDir, 'projects')`，读写指同一处。
- **已知影响**：`system` backend 用户的 claude 凭据也随 `CLAUDE_CONFIG_DIR` 重定向 → 每租户需各自登录一次 claude。对「各用户独立」目标合理，已与用户确认接受。

### 5.2 渲染进程偏好（外观/语言/权限模式/最近工作区）
- localStorage 键加 tenantId 后缀：
  - `claude-desktop:appearance` → `claude-desktop:appearance:<tid>`
  - `claude-desktop:permission-mode` → `:<tid>`
  - `claude-desktop:i18n` → `:<tid>`
  - `workspace.recent.v1` → `workspace.recent.v1:<tid>`
- preload 通过 `sendSync` 暴露 `getActiveTenantIdSync()`，让 `main.tsx` 的 `bootAppearance()` 在 React 挂载前（首帧前）就拿到 tid 拼出正确的键——**保住现有的 FOUC 防闪烁**。
- 各 zustand `persist` 的 `name` 带上 tid 后缀。

### 5.3 日志
- `logCollector.logsDir()`：登录后返回 `tenantPaths(activeTenantId).logsDir`；登录前（启动到登录之间）写全局 `<userData>/logs`。
- 租户切换时重开当天的日志文件 stream。

## 6. 切换账号 = 整机软重置

为避免就地 rehydrate 的复杂度与 bug 面，`activeTenantId` 一旦变化（登录 / 登出 / 切号），main 执行：

1. kill 所有 engine 的 `SessionRuntime`（旧 fusion-code 子进程钉死在旧 `CLAUDE_CONFIG_DIR`，必须杀）。
2. 拆掉所有 tab（内存态，无落盘）。
3. 持久化新 `activeTenantId` 到 `auth.json`；`mkdir -p` 新用户目录（`.claude/`、`logs/`）。
4. 广播 `AUTH_CHANGED` 给所有窗口；**reload 渲染进程**。
5. reload 后 preload 给出新 tid，boot 读新命名空间的 localStorage，engine 按新 `CLAUDE_CONFIG_DIR` 懒 spawn。

登出即 `activeTenantId = null` → 登录墙挡住所有交互，天然保证未登录不 spawn。

## 7. IPC 改动（遵守 CLAUDE.md「四处一起改」）

- 扩展现有 `AuthState`：增加 `tenantId: string | null`。复用现有 `AUTH_GET` / `AUTH_SET` / `AUTH_CHANGED`。
- main 在 `AUTH_SET` 收到与当前 `activeTenantId` 不同的 tenantId（含 null）时，触发第 6 节的软重置流程。
- 新增**同步**通道 `TENANT_ID_GET`：preload 用 `ipcRenderer.sendSync` 实现 `getActiveTenantIdSync()`，供 boot 期同步取 tid。
- 每条改动覆盖四处：`shared/ipc-channels.ts`（通道常量 + 类型）→ `preload/index.ts`（方法）→ `preload/index.d.ts`（类型）→ main handler（`ipc/register.ts` 或 engine）。

## 8. 受影响文件清单（实现时细化）

- `apps/desktop/src/main/core/authStore.ts`（新）——全局 auth.json 读写 + activeTenantId。
- `apps/desktop/src/main/core/appSettings.ts`——改为每租户定位；移除 auth 字段。
- `apps/desktop/src/main/core/tenantPaths.ts`（新）——路径助手。
- `apps/desktop/src/main/core/engine.ts`——openSession 注入 CLAUDE_CONFIG_DIR；spawn 守卫。
- `apps/desktop/src/main/core/sessionStore.ts`——读取目录改用 tenant CLAUDE_CONFIG_DIR。
- `apps/desktop/src/main/core/logCollector.ts`——logsDir 按租户。
- `apps/desktop/src/main/tabRegistry.ts` + 切换协调点——软重置：杀 runtime、拆 tab、reload。
- `apps/desktop/src/main/ipc/register.ts`——AUTH_SET 触发切换；新增 TENANT_ID_GET。
- `apps/desktop/src/shared/ipc-channels.ts`——AuthState 加 tenantId；TENANT_ID_GET 常量。
- `apps/desktop/src/preload/index.ts` + `index.d.ts`——getActiveTenantIdSync（sendSync）。
- `apps/desktop/src/renderer/src/stores/auth.ts`——login 计算 tenantId（sha256）。
- `apps/desktop/src/renderer/src/stores/appearance.ts` / `permissionMode.ts` / `workspace.ts` / `i18n.ts`——persist name 加 tid 后缀。
- `apps/desktop/src/renderer/src/main.tsx`——bootAppearance 用 tid 拼键。

## 9. 质量门

- 唯一自动化防线：`bun run typecheck`（tsc node + web）。无单测、无 ESLint。
- 手动验证：A 登录建对话/改设置 → 登出 → B 登录看不到 A 的对话/设置/外观/最近工作区/日志 → 切回 A 一切还在。

## 10. 已确认的决策

1. 切号采用**整机软重置 + reload**（非就地 rehydrate）。
2. **不迁移**升级前的旧 `~/.claude/projects` 会话。
3. **system backend 凭据**也随 `CLAUDE_CONFIG_DIR` 按租户重定向，接受每租户各自登录 claude。
