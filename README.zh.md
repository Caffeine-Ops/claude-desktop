# Claude Desktop

[English](./README.md) · **简体中文**

一个封装 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) 的 Electron 桌面应用。它 spawn 一个打包进去的 **fusion-code** CLI 作为子进程（也可切换到系统 `claude`），并把 agent 循环配上一套基于 React 19 与 [`assistant-ui`](https://github.com/Yonom/assistant-ui) 的聊天 + 设计画布 UI。

本仓库是一个 **Bun workspace monorepo**——一个桌面壳、一个后台设计 daemon，以及一组共享 TypeScript 包。

> **注意：** 包管理器是 **Bun**，不是 npm/pnpm。全程用 `bun install` 和 `bun run …`。

---

## 目录

- [架构总览](#架构总览)
- [仓库结构](#仓库结构)
- [模块详解](#模块详解)
  - [`apps/studio` — 桌面应用](#appsstudio--桌面应用-claude-desktopstudio)
  - [`apps/daemon` — 设计 daemon](#appsdaemon--设计-daemon-open-designdaemon)
  - [`packages/*` — 共享库](#packages--共享库)
  - [`tools/*` — 开发与发布工具](#tools--开发与发布工具)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [命令](#命令)
- [约定与红线](#约定与红线)
- [许可](#许可)

---

## 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  Electron 壳  (apps/studio/electron)                           │
│                                                                │
│  main 进程 ──── ChatEngine ──spawn──▶ fusion-code CLI          │
│    │  (Node)       (Agent SDK query() 生命周期、                │
│    │                权限、会话)                                  │
│    │                                                           │
│    └── preload ──contextBridge──▶  window.chatApi              │
│           (唯一的 IPC 边界)                                     │
│                          │                                     │
│  ┌───────────────────────┼───────────────────────────────┐    │
│  │  统一前端  (apps/studio/app + src) — Next.js           │    │
│  │                                                        │    │
│  │   src/chat    ── 流式聊天 UI    (shadcn/Tailwind)      │    │
│  │   src/canvas  ── 设计工作画布   (手写 CSS)             │    │
│  │        两面共存同一个 document (SurfaceHost)           │    │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
             │  HTTP (localhost) / app:// 协议
             ▼
┌──────────────────────────────────────────────────────────────┐
│  apps/daemon  (@open-design/daemon) — 独立 Node 服务           │
│  better-sqlite3 存储 · 设计系统工具 · 插件 · 连接器 ·          │
│  live-artifact 预览 · 部署 · 媒体生成                          │
└──────────────────────────────────────────────────────────────┘
```

**改任何东西前，第一件事是搞清进程模型**——每个文件都恰好属于三个世界之一：

| 世界 | 位置 | 环境 | 拥有 |
|---|---|---|---|
| **main** | `apps/studio/electron/main/` | Node | `ChatEngine`、spawn fusion-code、SDK `query()` 生命周期、权限、会话、窗口 |
| **preload** | `apps/studio/electron/preload/` | 隔离桥 | 通过 `contextBridge` 暴露 `window.chatApi`——**唯一**的 IPC 边界 |
| **renderer / UI** | `apps/studio/app/` + `apps/studio/src/` | 浏览器 | 整个 React 应用；禁止 import Node 模块——一切主进程能力走 `window.chatApi` |

daemon 是**第四个、独立的进程**——一个独立 Node 服务，prod 下由 Electron 主进程 spawn，经 `localhost` HTTP（以及静态资源用的自定义 `app://` 协议）访问。

---

## 仓库结构

```
claude-desktop/
├── apps/
│   ├── studio/          # 桌面应用：Electron 壳 + 统一 Next.js 前端
│   └── daemon/          # 独立设计 daemon (@open-design/daemon)
├── packages/            # 共享 TypeScript 库（见下）
│   ├── composer/          # 聊天 composer 的 ProseMirror 核心（schema + 建议）
│   ├── contracts/         # web/daemon 边界的纯 TS 契约
│   ├── host/              # renderer ↔ host 桥协议
│   ├── platform/          # 跨平台原语
│   ├── sidecar/           # sidecar 客户端
│   ├── sidecar-proto/     # sidecar 线协议
│   ├── ui/                # 共享 React UI 原语（Tailwind，source-only）
│   ├── design-tokens/     # 颜色 token 单一真源（CSS）
│   ├── plugin-runtime/    # 纯 TS 插件 manifest/adapter 运行时
│   ├── registry-protocol/ # 插件注册后端协议
│   ├── diagnostics/       # 日志收集 / 脱敏 / 打包
│   └── agui-adapter/      # 到 AG-UI 事件协议的适配器
├── tools/               # 开发与发布工具（dev / pack / pr / serve）
├── package.json         # workspace 根：dev/build/dist/typecheck 编排
├── bun.lock             # 已提交的 lockfile——不要删了重装
└── CLAUDE.md            # 深度架构笔记与踩坑不变量
```

---

## 模块详解

### `apps/studio` — 桌面应用 (`@claude-desktop/studio`)

整个桌面应用住在这一个包里。包内两个世界，产物目录严格分家（electron-vite → `out-electron/`，Next.js static export → `out/`）。

#### Electron 壳 — `electron/`

| 路径 | 职责 |
|---|---|
| `electron/main/index.ts` | 应用入口。**第一行**就 import `bootstrap/loadEnv`，保证读 token 前 `env.json` 已灌进 `process.env`。 |
| `electron/main/core/engine.ts` | **`ChatEngine`**（~3200 行）。每 tab 一个引擎，绑定自己的 `webContents`。采用 **multi-runtime** 模型：一个引擎可持有多个 `SessionRuntime`，每个对应一个 fusion-code 子进程。管 lazy-spawn、会话切换、流式、`canUseTool`。 |
| `electron/main/core/permissionBroker.ts` | per-engine 的 `PermissionBroker`——工具权限请求限定在发起它的引擎里，不是全局单例。 |
| `electron/main/core/`（其余） | `sessionStore`、`asyncMessageQueue`、`appSettings`、`cliDetect`、`externalMcp`、`fileSuggestions`、`logCollector`、`permissionScope`、`seedSkills`。 |
| `electron/main/ipc/register.ts` | 注册所有 IPC handler（~2000 行）——`window.chatApi` 的 main 侧实现。 |
| `electron/main/pilot/sdkPilot.ts` | 驱动 Claude Agent SDK 的 `query()` 循环。 |
| `electron/main/services/` | `appProtocol`（`app://` 静态文件服务 + daemon 反代）、`appUpdater`、`openDesignServices`（daemon 生命周期）。 |
| `electron/main/bootstrap/loadEnv.ts` | 把 `env.json` 灌进 `process.env`——**必须最先跑**。 |
| `electron/preload/` | `contextBridge` 桥，暴露 `window.chatApi`。`index.d.ts` 承载渲染层可见的类型。 |
| `electron/shared/` | `ipc-channels.ts`（通道名常量）与 `types.ts`（共享类型，前端经 `@desktop-shared/*` 别名 type-only 消费）。 |

> **加一条 IPC 通道要同时改四处**：`ipc-channels.ts` → `preload/index.ts` → `preload/index.d.ts` → main 侧 handler。漏一处 typecheck 会当场抓到。

#### 统一前端 — `app/` + `src/`

一个 Next.js 应用，dev 加载 `http://localhost:3100`，prod 以 static export 经 `app://studio/` 协议提供。两个面共存于**同一个 document**（由 `SurfaceHost` 挂载）——这正是「跨面 CSS 泄漏是本项目最大坑源」的原因。

| 路径 | 职责 |
|---|---|
| `app/` | Next.js 路由（`[[...slug]]` catch-all 给 canvas router、`chat/`）、`layout.tsx`、`globals.css`（chat CSS 链）。 |
| `src/chat/` | **聊天面**——流式 assistant UI，基于 shadcn/ui + Tailwind v4。含 `stores/`（zustand）、`runtime/`、`composer/`、`shell/` 及自己的 `styles/`。 |
| `src/canvas/` | **设计工作画布**——从原 `apps/web` 整体平移的 SPA（~184k 行）。`styles/` 里约 4 万行手写 CSS，组件按 feature 分组（`home/`、`plugins/`、`settings/`、`files/`、`project/`、`chat/`、`memory/` …），另有 `state/`、`runtime/`、`providers/`、`i18n/`、`artifacts/`、`edit-mode/`。 |
| `src/components/` | 根级 layout 外壳：`AppRail`（左侧导航）、`SurfaceHost`（挂载两个面）、`ChatSurface`、`RailProjectList`、`RailSessionList`。**这些一律用 shadcn 原语，不写裸元素**（裸元素会被 canvas 的 reset 填成描边卡片）。 |
| `src/components/ui/` | shadcn/ui 原语（`bunx shadcn@latest add <name>` 拉新组件）。 |
| `src/lib/`、`src/types/` | 前端共享工具（`cn()` 等）与类型。 |

### `apps/daemon` — 设计 daemon (`@open-design/daemon`)

一个独立 Node 服务（入口 `dist/cli.js`），提供 canvas 面对接的 Open Design 能力。用 **`better-sqlite3`**（同步 API——大查询会阻塞它的事件循环，改这块要留意）。prod 下由 Electron 主进程 spawn，经 `localhost` HTTP 访问。

| 路径 | 职责 |
|---|---|
| `src/server.ts` | HTTP/WS 服务器（~12k 行）——路由、流式端点、请求处理。 |
| `src/cli.ts` | daemon CLI 入口与启动。 |
| `src/http/` | HTTP adapter、请求解析、响应工具，以及 `origin-guard.ts`（本地同源校验）。 |
| `src/storage/` | `daemon-db`（better-sqlite3）、`project-storage`、`db-inspect`、AWS SigV4 签名。 |
| `src/db.ts` | 聊天/事件持久化。 |
| `src/runtimes/` | agent 运行时探测、能力、认证、模型解析、launch/invocation、prompt-budget。 |
| `src/plugins/`、`src/registry/` | 插件加载与插件注册。 |
| `src/connectors/`、`src/memory-connectors.ts` | 外部连接器与记忆集成。 |
| `src/live-artifacts/`、`src/genui/` | live-artifact 预览与生成式 UI 事件。 |
| `src/critique/`、`src/qa/`、`src/lint-artifact.ts` | 设计评审、QA、产物 lint。 |
| `src/media.ts`、`src/deploy.ts` | 图片/视频生成工具与部署。 |
| `src/design-systems.ts`、`src/design-system-import.ts` | 设计系统定义与导入。 |
| `src/logging/`、`src/metrics/`、`src/prompts/`、`src/tools/`、`src/research/` | 日志、指标、prompt 组装、工具定义、研究。 |

### `packages/*` — 共享库

跨 workspace 消费，按构建方式分三类：

**Source-only**（入口直指 `src/`，让各宿主的 bundler 和 Tailwind 扫描器直接看到代码）：

| 包 | 是什么 |
|---|---|
| `@open-design/composer` | 聊天 composer 的 ProseMirror 核心——`pmSchema`、`serializeDoc`、建议状态机。desktop renderer / studio / web 三端共享。交互层（输入组件、chip node view）刻意留在各宿主。 |
| `@open-design/ui` | 共享 React UI 原语（Tailwind）。除针对共享 token 解析的 utility 外不带任何自有样式。 |
| `@claude-desktop/design-tokens` | 颜色单一真源——一份 `tokens.css` 的 HSL 三元组，两个面共同消费。 |

**预构建**（`types` 指向 `dist/`——**改源码后必须在包内 `bun run build`**，否则下游 typecheck 读陈旧 `.d.ts`）：

| 包 | 是什么 |
|---|---|
| `@open-design/contracts` | web ↔ daemon 边界的纯 TS 契约（connection-test、orbit、finalize、handoff、provider-models、research、critique、analytics）。 |
| `@open-design/registry-protocol` | 插件源 / 插件注册的后端协议。 |
| `@open-design/host` | renderer ↔ host 桥协议（另有 `testing` 入口）。 |
| `@open-design/platform` | 跨平台原语。 |
| `@open-design/sidecar` / `@open-design/sidecar-proto` | sidecar 客户端及其线协议。 |
| `@open-design/plugin-runtime` | 纯 TS 插件运行时——manifest 解析、adapter、merger、ref resolver、validator、digest。不 import `node:fs`；由宿主注入 loader。 |
| `@open-design/diagnostics` | daemon 与 desktop 共享的日志收集、脱敏、zip 打包。 |
| `@open-design/agui-adapter` | Open Design 事件联合类型与 [AG-UI](https://github.com/CopilotKit/CopilotKit) 规范事件协议之间的双向适配器。 |

### `tools/*` — 开发与发布工具

workspace 本地工具：`tools/dev`（`@open-design/tools-dev`）、`tools/pack`、`tools/pr`、`tools/serve`。

---

## 技术栈

| 层 | 工具 |
|---|---|
| 壳 | Electron |
| 打包 | electron-vite（壳）· Next.js static export（前端） |
| UI | React 19 · Tailwind CSS v4 · shadcn/ui · assistant-ui |
| 聊天 composer | ProseMirror（`@open-design/composer`） |
| 状态 | Zustand |
| Agent 运行时 | `@anthropic-ai/claude-agent-sdk` 驱动打包的 **fusion-code** CLI |
| daemon 存储 | better-sqlite3 |
| 校验 | Zod |
| 包管理器 | **Bun**（lockfile 已提交） |
| 打包发布 | electron-builder（macOS / Windows / Linux） |

---

## 快速开始

### 前置

- [Bun](https://bun.sh)（本仓库的包管理器）
- Node.js ≥ 20（用于 better-sqlite3 原生模块编译）
- 一个 Claude API key 或兼容端点

### 安装

```bash
bun install
```

### 配置

在 `apps/studio/env.json`（已 gitignore）里配置。它由 `electron/main/bootstrap/loadEnv.ts` 在**任何读 token 的模块之前**灌进 `process.env`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

完整可选键见 `apps/studio/env.example.json`。

### 开发

```bash
bun run dev
```

启动 electron-vite dev（main 热重载）。Next.js dev server（端口 3100）与 daemon 由主进程自动 spawn。

---

## 命令

从仓库根运行：

```bash
bun run dev          # Electron dev（main 热重载；daemon + Next dev server 自动 spawn）
bun run typecheck    # 全 workspace 类型检查——唯一的自动化质量门

# 发布构建 ─ 发版一律用 dist:*，不是 build:*
bun run dist:mac     # 重建 contracts→registry-protocol→daemon→前端，再打 macOS 包
bun run dist:win     # …Windows
bun run dist:linux   # …Linux

# 只打壳（假设 daemon dist/ 与前端 out/ 已最新）
bun run build:mac    # 只把 Electron 壳打成 macOS 包
```

> **发版用 `dist:*` 不是 `build:*`。** `build:*` 只是**拷贝**现成的 daemon 与前端产物，不重新构建。改了前端/daemon/契约包后直接 `build:mac`，打进包的是陈旧代码且零报错。`dist:*` 在前面补上了重建步骤。

> **没有单元测试、没有 ESLint**——`bun run typecheck` 是唯一的自动化防线。每次提交前先跑类型检查。

---

## 约定与红线

几条忽略了就会咬人的不变量——完整、带详细注释的版本见 [`CLAUDE.md`](./CLAUDE.md)：

- **依赖分层。** `apps/studio/package.json` 的 `dependencies` *只*放 Electron 运行时真正 `require` 的包。前端依赖（next/react/…）一律 `devDependencies`——UI 是构建期静态产物，放错层会把整个前端依赖树打进安装包。
- **CSS 没有作用域。** chat（shadcn/Tailwind）与 canvas（手写 CSS）两面共存一个 document。共享色 token 独占 shadcn 名（`--accent`、`--border` …）；canvas 的 legacy 名一律 `--od-*` 前缀。往 `:root` 加任何 token 前先查另一侧有没有同名。
- **暗色用两个标记。** chat CSS 认 `.dark` 类，canvas CSS 认 `[data-theme]`。两个写手互相桥接——改一个要让两个一起落。
- **预构建契约包改源码后必须重建**（`contracts`、`registry-protocol` 及其余 `types` 指 `dist` 的包）。
- **绝不删了重装 lockfile**——`^` 范围会漂到破坏性新版。

---

## 许可

私有——尚未授权再分发。
