# 未登录预览 + 发送时门控登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 未登录用户能看到完整应用界面，只在「发送消息」这一消耗租户 token 的动作弹出登录框。

**Architecture:** 拆掉占满聊天区的 `LoginWall`，让 `FusionRuntimeProvider` 在未登录时也挂载（engine lazy-spawn，不发送就不起 cli、不耗 token）。唯一的 token 门控下沉到 `onNew` 发送入口。配套两处防御：渲染层未登录时跳过 `listSessions`（防系统全局会话泄漏），main 层 warmup 无租户时 skip（防噪声日志）。

**Tech Stack:** Electron + React 19 + zustand + assistant-ui + TypeScript（composite：tsconfig.node + tsconfig.web）。包管理器 **bun**。

## Global Constraints

- 包管理器是 **bun**，不是 npm。
- **没有单元测试、没有 ESLint**——`bun run typecheck` 是 CI 唯一质量门，也是本计划每个任务的自动验证手段。
- 加/改 IPC 要同步四处（本计划不新增 IPC，无需触碰）。
- 注释密度高，且解释「为什么这样而不是那样」——新增/修改不变量时把理由写进注释。
- `src/main/index.ts` 第一行 `import './bootstrap/loadEnv'` 必须保持第一（本计划不动它）。
- 登出时 `activateTenant(null)` 删除 `process.env.CLAUDE_CONFIG_DIR` → 回退默认 `~/.claude`：因此未登录绝不可调 `listSessions`，否则泄漏系统全局会话。
- `engine.openSession()` 的「无 tenant 抛错」守卫**保留**作最终兜底，不删。

---

### Task 1: 渲染层防泄漏 —— 未登录跳过 listSessions

未登录无租户、本质上没有可展示会话，且 `listSessions` 会读默认 `~/.claude` 的系统全局会话。在适配器的 `refresh()` 入口短路返回空列表。本任务在登录墙仍在（runtime 未挂载）时是无副作用的前置改动。

**Files:**
- Modify: `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（import 区 + `useThreadListAdapter` 内 `refresh`，约 565-580 行）

**Interfaces:**
- Consumes: `useAuthStore`（`../stores/auth`，导出 `useAuthStore`，含 `loggedIn: boolean`）。
- Produces: 无新导出；`refresh()` 行为变化——登出态返回 `[]` 且置 `threadsLoaded=true`。

- [ ] **Step 1: 加 useAuthStore import**

在文件顶部 import 区（紧接 `import { useDialogStore, type DialogKind } from '../stores/dialogs'` 之后）加入：

```ts
import { useAuthStore } from '../stores/auth'
```

- [ ] **Step 2: 在 refresh 入口加登出短路**

找到 `useThreadListAdapter` 内的 `refresh`（当前形如）：

```ts
    const refresh = async (): Promise<readonly ThreadSummary[] | null> => {
      try {
        const result = await window.chatApi.listSessions()
```

改为在 `try` 前插入登出短路：

```ts
    const refresh = async (): Promise<readonly ThreadSummary[] | null> => {
      // 未登录无租户：跳过 listSessions。登出时 activateTenant(null) 删除了
      // CLAUDE_CONFIG_DIR，listSessions 会落到默认 ~/.claude 读出系统全局会话
      // 并泄漏到侧栏。返回空列表并标记已加载，让下游 auto-select 起一个空会话。
      if (!useAuthStore.getState().loggedIn) {
        setThreads([])
        setThreadsLoaded(true)
        return []
      }
      try {
        const result = await window.chatApi.listSessions()
```

（其余 `try`/`catch`/`finally` 原样不动。）

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: PASS（无错误输出，两个工程 node + web 均通过）

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx
git commit -m "fix(tenant): 未登录跳过 listSessions 防系统全局会话泄漏

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 唯一 token 门控 —— onNew 发送前拦截

「发送消息」是唯一消耗租户 token 的动作。未登录时不发送，改弹登录框。位置在 slash 命令拦截之后（`/skills` `/mcp` 不耗 token，放行）、`sessionId===null` 判断与 `appendUserMessage`/`send` 之前。

**Files:**
- Modify: `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（`onNew` 内，slash 拦截块之后）

**Interfaces:**
- Consumes: `useAuthStore.getState().loggedIn`（Task 1 已 import）；`useDialogStore`（文件已有 import）。
- Produces: 无。

- [ ] **Step 1: 插入登录门控**

找到 `onNew` 内的 slash 命令拦截块（当前形如）：

```ts
      if (images.length === 0 && filePaths.length === 0) {
        const dialogKind = matchSlashCommand(baseText)
        if (dialogKind) {
          useDialogStore.getState().openDialog(dialogKind)
          return
        }
      }
```

在该 `}` 之后、紧接其下的 `// 1) Push user turn into the store` 注释之前，插入：

```ts
      // Token 门控：发送消息是唯一消耗租户 token 的动作。未登录时不发送，改弹
      // 登录框。放在 slash 拦截之后——/skills /mcp 只开本地弹窗、不消耗 token，
      // 未登录也放行。用 getState() 即时读最新登录态（非 hook 订阅）。engine 的
      // openSession 无 tenant 守卫仍是兜底，但拦截在此完成，未登录永远走不到 send。
      if (!useAuthStore.getState().loggedIn) {
        useDialogStore.getState().openDialog('login')
        return
      }
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(tenant): 发送消息未登录时弹登录框（唯一 token 门控点）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: main 层 polish —— warmup 无租户时 skip

`switchToSession()` 末尾的 fire-and-forget warmup 会 `openSession`，未登录时抛 `openSession blocked` 被 catch 成噪声 warning。无租户直接 skip 保持日志干净；功能正确性不依赖此改动。

**Files:**
- Modify: `apps/desktop/src/main/core/engine.ts`（`switchToSession` 末尾的后台 warmup IIFE，约 1599 行）

**Interfaces:**
- Consumes: `getActiveTenantId()`（文件已 import 自 `./authStore`）。
- Produces: 无。

- [ ] **Step 1: 在 warmup IIFE 起始加无租户短路**

找到（当前形如）：

```ts
    void (async () => {
      if (Object.keys(this.externalMcpServers).length === 0) {
        await this.refreshExternalMcpServers({ waitForDaemon: true })
      }
      await this.ensureSessionReady(newId)
    })().catch((err) => {
      console.warn('[engine] background warmup failed:', err)
    })
```

在 IIFE 第一行插入无租户短路：

```ts
    void (async () => {
      // 无租户（未登录）不预热：openSession 会因无 tenant 抛错、被下面 catch 成
      // 噪声 warning。发送门控在渲染层 onNew 完成、openSession 硬守卫仍兜底，这里
      // 直接 skip。未登录用户建/切会话时不再刷 openSession blocked。
      if (!getActiveTenantId()) return
      if (Object.keys(this.externalMcpServers).length === 0) {
        await this.refreshExternalMcpServers({ waitForDaemon: true })
      }
      await this.ensureSessionReady(newId)
    })().catch((err) => {
      console.warn('[engine] background warmup failed:', err)
    })
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/core/engine.ts
git commit -m "fix(tenant): 后台 warmup 无租户时 skip，免刷 openSession blocked 噪声

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 拆掉登录墙 —— App.tsx 未登录也挂 runtime

激活性改动：移除 `loggedIn` 对 `FusionRuntimeProvider` 的门控、移除 `<LoginWall>` 渲染。此时 Task 1/2 的防泄漏与 token 门控已就位，墙一拆即安全。

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`（import 区第 23 行、loggedIn 选择器第 85 行、runtime 门控约 259-264 行、登录墙渲染约 288-293 行）

**Interfaces:**
- Consumes: `hasWorkspace`（局部）、`hydrated`（`useAuthStore`，保留）。
- Produces: 未登录时也渲染 `<FusionRuntimeProvider>` 子树。

- [ ] **Step 1: 移除 LoginWall import**

删除第 23 行：

```ts
import { LoginWall } from './components/auth/LoginWall'
```

- [ ] **Step 2: 移除未使用的 loggedIn 选择器**

删除第 85 行（`hydrated` 那行保留）：

```ts
  const loggedIn = useAuthStore((s) => s.loggedIn)
```

注意：`useAuthStore` 的 import 因 `hydrated` 仍在使用而**保留**，不要删 import。

- [ ] **Step 3: 改 runtime 门控条件 + 注释**

把（约 259-264 行）：

```tsx
        {/* Chat runtime — only mounted when workspace AND login are both
            ready. Keeping these two guards together means the runtime is
            never spawned (no warmup, no engine IPC, no fusion-code child)
            until the user is authenticated. The login wall below covers
            the case where workspace is known but the user is signed out. */}
        {hasWorkspace && loggedIn && (
```

改为：

```tsx
        {/* Chat runtime — 只要 workspace 就绪即挂载，未登录也挂。engine 是
            lazy-spawn：switchToSession 只切指针、不起 cli，真正的子进程冷启动
            延迟到第一次 send()。未登录时 send 在 FusionRuntimeProvider.onNew
            被拦截弹登录框（唯一 token 门控点），所以挂载 runtime 不会 spawn、
            不耗 token。以前用 loggedIn 门控 + LoginWall 挡住整块的写法已移除。 */}
        {hasWorkspace && (
```

- [ ] **Step 4: 移除登录墙渲染块**

删除（约 288-293 行）整段：

```tsx
        {/* Login wall — shown when the workspace is known but the user is
            signed out. Occupies the same flex-1 area the runtime would fill,
            so the three-pane layout never forms (and the runtime is never
            spawned). LoginDialog is still mounted below and responds to the
            wall's button click via the dialog store. */}
        {hasWorkspace && !loggedIn && <LoginWall />}
```

（`<LoginDialog>`、`<SettingsView>` 等保持不动；`</FusionRuntimeProvider>` 闭合的 `)}` 也保持。）

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS（确认无 `loggedIn` 未定义、无 `LoginWall` 未导入残留报错）

- [ ] **Step 6: 手动验证（dev）**

Run: `bun run dev`
确认（在登出态下；如当前已登录，从账号菜单登出，会触发 reload 回到登出态）：
- 启动后看到三栏完整界面 + **空侧栏**（无系统全局会话泄漏）+ 可用输入框。
- 输入框打字、点发送 → 弹出 `LoginDialog`；观察 LogsDialog/终端**未**出现 cli 冷启动或 `openSession blocked` 噪声。
- `/skills`、`/mcp` 在登出态仍能打开本地弹窗（不被登录拦）。
- 完成登录 → 渲染进程 reload → 正常列举会话、发送走通。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(tenant): 拆掉登录墙，未登录也挂 runtime（发送时才门控）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 清理死代码 —— 删 LoginWall 组件与 i18n key

Task 4 后 `LoginWall` 与三个 `loginWall*` i18n key 已无引用，删除以免死代码。

**Files:**
- Delete: `apps/desktop/src/renderer/src/components/auth/LoginWall.tsx`
- Modify: `apps/desktop/src/renderer/src/i18n.ts`（zh 约 93-97 行、en 约 338-342 行）

**Interfaces:**
- Consumes: 无。
- Produces: 无。

- [ ] **Step 1: 确认无残留引用**

Run: `grep -rn "LoginWall\|loginWallTitle\|loginWallSubtitle\|loginWallButton" apps/desktop/src`
Expected: 仅剩 `i18n.ts` 内待删的 key 行与 `LoginWall.tsx` 自身（App.tsx 在 Task 4 已不再引用）。若有其它引用，先处理。

- [ ] **Step 2: 删除 LoginWall 组件**

```bash
git rm apps/desktop/src/renderer/src/components/auth/LoginWall.tsx
```

- [ ] **Step 3: 删除 zh 的 loginWall key**

删除 `i18n.ts` zh 段（约 93-97 行）：

```ts
    // Login wall — shown in the chat area when auth has hydrated but the user
    // is signed out. Replaces the chat runtime until the user logs in.
    loginWallTitle: '请先登录',
    loginWallSubtitle: '登录后即可开始对话。你的对话与设置仅你自己可见。',
    loginWallButton: '登录',
```

- [ ] **Step 4: 删除 en 的 loginWall key**

删除 `i18n.ts` en 段（约 338-342 行）：

```ts
    // Login wall — shown in the chat area when auth has hydrated but the user
    // is signed out. Replaces the chat runtime until the user logs in.
    loginWallTitle: 'Please sign in',
    loginWallSubtitle: 'Sign in to start chatting. Your conversations and settings are visible only to you.',
    loginWallButton: 'Sign in',
```

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS（i18n 字典类型 zh/en 仍对齐；无 `useT('loginWall*')` 残留消费者）

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/i18n.ts
git commit -m "chore(tenant): 删除不再使用的 LoginWall 组件与 i18n key

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 验证总览

- 每个任务以 `bun run typecheck` 自动验证（CI 唯一质量门）。
- Task 4 额外做 `bun run dev` 手动验证未登录预览 + 发送弹框 + 无 cli 冷启动 + 登录后走通。
- 全部完成后再跑一次 `bun run typecheck` 兜底。
