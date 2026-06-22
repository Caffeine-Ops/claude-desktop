# 未登录预览 + 发送时门控登录

日期：2026-06-22
分支：Add-Login

## 背景

当前（commit `6e05df9e`）未登录时由 `LoginWall` 占满整个聊天区，挡住一切交互，
`FusionRuntimeProvider` 被 `loggedIn` 门控、根本不挂载。用户根本看不到产品界面。

目标改为：**未登录也能看到完整界面（三栏面板、输入框、文件树），只在真正
消耗租户 token 的那一刻——点发送提交一条消息——才弹登录框。**

## 核心判断：哪些操作消耗 token

引擎是 **lazy-spawn**：`switchToSession()` 只切指针，cli 冷启动延迟到第一次
`send()`（或后台 warmup）。`openSession()` 是唯一 spawn 点，且有硬守卫——无
tenant 直接抛错。基于此对所有用户可触发操作归类：

| 操作 | 底层行为 | 消耗租户 token | 门控登录 |
|------|---------|:---:|:---:|
| **发送消息**（文本/图/文件） | 用户 turn → Claude 推理回复 | ✅ | **是** |
| AI 自动起标题、tool 触发的后续推理 | 跟随一次 send 在服务端发生 | ✅ | 随 send 一起，不单独拦 |
| 新建对话 | 只分配 UUID，lazy 不推理 | ❌ | 否 |
| 切换会话 | 切指针 + 后台 warmup 起进程，不推理 | ❌ | 否 |
| 浏览文件树 / `/skills` `/mcp` `/logs` / 设置 | 纯本地 | ❌ | 否 |
| 输入框打字 / 粘贴拖入图片附件（未发送） | 纯本地 | ❌ | 否 |
| 语音听写（Whisper 转写） | OpenAI 共享 key，非租户 token | 与登录无关 | 否 |

**结论：真正消耗租户 token 的只有「发送消息」一个动作，门控点放在它一处即可。**

## 安全前提（务必保留）

- 登出时 `activateTenant(null)` 会 **删除 `process.env.CLAUDE_CONFIG_DIR`**，
  回退到默认 `~/.claude`。因此未登录若调 `listSessions()` 会读到**系统全局**
  会话并泄漏到侧栏——必须在渲染层跳过。
- `engine.openSession()` 的「无 tenant 抛错」守卫**保留**作最终兜底；本次改动
  不依赖它来拦发送（拦截在渲染层 `onNew` 已完成），它只防御任何未预期的 spawn
  路径污染默认 `~/.claude`。

## 改动清单

### 1. `apps/desktop/src/renderer/src/App.tsx` — 拆掉登录墙

- 删除 `loggedIn` 对 `<FusionRuntimeProvider>` 的门控条件，改为只要 `hasWorkspace`
  就挂载 runtime（未登录也挂）。
- 删除 `{hasWorkspace && !loggedIn && <LoginWall />}` 整段渲染，以及 `LoginWall`
  的 import。
- 保留 `hydrated` 的 loading 早返回（`workspace === 'loading' || !hydrated`）——
  适配器里的 `listSessions` 门控依赖 `loggedIn`，需等 auth 落定再决定，避免用
  尚未 hydrate 的 `loggedIn=false` 误跳过列举。
- `<LoginDialog>` 保持挂载（已在），它响应 dialog store 的 `open('login')`。
- 相应更新 `key={workspace}` 那段以及 `hasWorkspace && loggedIn` 注释，把「为何
  现在未登录也挂 runtime」「token 门控为何下沉到 onNew」写进注释。

### 2. `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx` — 唯一门控点

在 `onNew` 内，**slash 命令拦截之后**、`appendUserMessage` / `chatApi.send`
**之前**插入：

```ts
// Token 门控：发送消息是唯一消耗租户 token 的动作。未登录时不发送，改弹登录框。
// 放在 slash 命令拦截之后——/skills /mcp 只开本地弹窗、不消耗 token，未登录也放行。
// 用 getState() 即时读取（非 hook 订阅），保证拿到最新登录态。
if (!useAuthStore.getState().loggedIn) {
  useDialogStore.getState().openDialog('login')
  return
}
```

- 需 import `useAuthStore`（`../stores/auth`）。`useDialogStore` 已在文件内使用。
- 位置在现有 `if (images.length === 0 && filePaths.length === 0) { matchSlashCommand … }`
  之后、`if (sessionId === null) …` 之前。这样未登录连 `sessionId===null` 的分支
  都走不到，无需为 null 会话特判。
- 语音听写不改动：它只把转写文字填进输入框，不触发 `onNew`/send。

### 3. `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx` — `useThreadListAdapter` 防泄漏

- 新建对话 / 切换会话 / auto-select **不门控**（都不消耗 token，正常运行，未登录
  也能起一个空会话准备打字）。
- **唯一改动**：未登录时 `listSessions()` 返回空，跳过 IPC，防止读到默认
  `~/.claude` 的系统全局会话泄漏到侧栏。
  - 在 `useThreadListAdapter` 内订阅 `useAuthStore` 的 `loggedIn`。
  - `refresh()` 内：`if (!useAuthStore.getState().loggedIn) { setThreads([]); setThreadsLoaded(true); return [] }`
    再走原 `window.chatApi.listSessions()`。
  - `onSessionListChanged` 回调天然复用 `refresh()`，登出态下同样早返回。
  - 登录成功后 main 的 `resetForTenantSwitch()` 会 reload 渲染进程，适配器以
    `loggedIn=true` 全新挂载，正常列举恢复——无需在适配器里手写「登录后重新列举」。
- auto-select 效果：登出态 `threads=[]` → 触发 `onSwitchToNewThread` 起一个空会话
  （lazy，无 token），输入框就绪。该会话在 send 之前不写 jsonl，故不会作为 row
  出现在侧栏；符合「空预览态」。

### 4. `apps/desktop/src/main/core/engine.ts` — 后台 warmup 跳过无租户（polish）

`switchToSession()` 末尾的 fire-and-forget warmup 会调 `ensureSessionReady →
openSession`，未登录时抛 `openSession blocked`、被 catch 成 warning。功能无害，
但每次未登录建/切会话都会刷一条噪声日志。

- 在 warmup 的 IIFE 起始处加：`if (!getActiveTenantId()) return`（`getActiveTenantId`
  已 import）。注释说明：无租户时不预热，发送门控在渲染层已完成，`openSession`
  的硬守卫仍作兜底。
- 这是可选 polish，不影响正确性；保留是为干净日志。

### 5. 清理

- 删除 `apps/desktop/src/renderer/src/components/auth/LoginWall.tsx`（不再被引用）。
- 删除 `i18n.ts` 中 zh/en 的 `loginWallTitle` / `loginWallSubtitle` /
  `loginWallButton` 三个 key（死代码）。
- 确认无其它文件 import `LoginWall` 或引用这三个 i18n key。

## 不改动

- `engine.openSession()` 无 tenant 抛错守卫（兜底保留）。
- 权限 broker、IPC 通道、preload 边界、shell 进程登录入口。
- `LoginDialog` 本身（已有 phone + SMS 流程）。

## 验证

- `bun run typecheck` 通过（CI 唯一质量门）。
- 手动：登出态下应用启动 → 看到三栏完整界面 + 空侧栏（无全局会话泄漏）+ 可用
  输入框；打字点发送 → 弹 `LoginDialog`，**未** spawn cli、未消耗 token。
- 登录成功 → 渲染进程 reload → 正常列举会话、发送走通。
- `ThreadView` 在 `sessionId===null` 下渲染空线程 + 可用输入框，不崩。
- `/skills` `/mcp` 在登出态仍能打开本地弹窗（不被登录拦）。
