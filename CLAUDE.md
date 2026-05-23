# Claude Desktop

Electron 桌面应用，封装 `@anthropic-ai/claude-agent-sdk`（实际驱动的是打包进去的 **fusion-code** CLI，也可切到系统 claude）。React 19 + Vite + Tailwind + zustand + assistant-ui。包管理器是 **bun**，不是 npm。

## 进程模型（改任何东西前先搞清在哪个进程）

三层，靠 `electron-vite` 分别打包：

- **main**（`src/main/`，Node 环境）— 拥有 `ChatEngine`，spawn fusion-code 子进程，管 SDK `query()` 生命周期、权限、会话。
- **preload**（`src/preload/`）— 通过 `contextBridge` 暴露 `chatApi` 给渲染进程，是唯一的 IPC 边界。
- **renderer**（`src/renderer/src/`，浏览器环境）— React UI，禁止直接 import Node 模块；一切主进程能力走 `window.chatApi`。

IPC 通道名集中在 `src/shared/ipc-channels.ts`，共享类型在 `src/shared/types.ts`。**加一条 IPC 要同时改四处**：`ipc-channels.ts`（通道常量）→ `preload/index.ts`（暴露方法）→ `preload/index.d.ts`（类型）→ main 侧 handler（`src/main/ipc/register.ts` 或 engine）。漏一处类型就报错，typecheck hook 会当场抓到。

## 核心：ChatEngine（`src/main/core/engine.ts`，~2400 行）

每个 tab 一个 `WebContentsView` + 一个独立 `ChatEngine`（绑定到自己的 `webContents`）。引擎内部用 **multi-runtime** 模型：一个 engine 可同时持有多个 `SessionRuntime`（每个对应一个 fusion-code 子进程）。

几条不变量，改之前务必读懂：
- **lazy spawn**：`switchToSession()` 只切指针不 spawn；真正的 cli 冷启动延迟到第一次 `send()`（或后台 warmup）。别在 switch 里同步等 `system init`。
- **`canUseTool` 用闭包捕获的 `sessionId`，不是 `this.activeSessionId`**——前台会话可能已经切走，权限请求必须回到发起它的 runtime。
- **`forkSession: false`** 是 resume 不分叉的前提，别改。
- 权限走 per-engine 的 `PermissionBroker`（`src/main/core/permissionBroker.ts`），不是全局单例——A 窗口的权限请求不能泄漏到 B 窗口。

## 权限 UI 是内联的，不是 modal

权限请求渲染在对应 tool card 内部（`InlinePermissionPrompt.tsx`），靠 `stores/permissions.ts` 的 `Map<requestId, PermissionRequest>` 支持多个并行 pending 各自独立渲染。取消走 `PERMISSION_CANCELLED` IPC。不要回退到单槽 modal——并行 `canUseTool` 会把它打爆（历史教训）。

## 环境变量与缓存

`src/main/index.ts` 第一行 `import './bootstrap/loadEnv'` 把 `env.json` 灌进 `process.env`，**必须保持第一**。openSession 对 bundled backend 注入三个缓存保护 env（`CLAUDE_CODE_MCP_INSTR_DELTA` / `CLAUDE_CODE_ATTRIBUTION_HEADER` / `ENABLE_TOOL_SEARCH`），都尊重父进程覆盖。改这块前读 engine.ts 里 openSession 那段长注释，每一项都解释了为什么。

## 命令

```bash
bun run dev          # electron-vite dev（热重载）
bun run typecheck    # tsc -p node + tsc -p web，CI 唯一的质量门
bun run build:mac    # build:icons + electron-vite build + electron-builder --mac
```

TypeScript 是 composite 工程：`tsconfig.node.json`（main+preload+shared）和 `tsconfig.web.json`（renderer+shared）。改完代码以 `bun run typecheck` 为准——**没有单元测试、没有 ESLint**，类型检查是唯一的自动化防线。

## 约定

- 注释密度很高，且专门解释「为什么这样而不是那样」。沿用这个风格——改不变量时把理由写进注释，别只写做了什么。
- CI（`.github/workflows/build.yml`）只在 `v*` tag 触发：下载 fusion-code CLI → typecheck → 打包 → 发 GitHub Release。fusion-code 版本钉在 workflow 的 `FUSION_CODE_VERSION`。
- 修了 bug 或踩了坑，按全局 CLAUDE.md 规范写进 Obsidian vault 的 errors/ 和 sessions/，并互相加双链。
