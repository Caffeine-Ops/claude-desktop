# Claude Desktop

An Electron desktop wrapper around the Claude Agent SDK, providing a native chat UI backed by the `@anthropic-ai/claude-agent-sdk` and powered by [`assistant-ui`](https://github.com/Yonom/assistant-ui).

Built with Electron + Vite + React 19 + TypeScript + Tailwind CSS.

---

## Features

- **Native desktop chat UI** — hidden-inset title bar, thread list sidebar, streaming assistant responses, markdown rendering with GFM.
- **Agent SDK integration** — drives the Claude Agent SDK from the Electron main process, with an IPC bridge to the renderer.
- **Configurable endpoints** — point at Anthropic, a self-hosted gateway, or any OpenAI-compatible proxy via `env.json`.
- **Permission broker** — centralized scope/permission handling for tool use inside the agent loop.
- **Cross-platform builds** — macOS, Windows, and Linux targets via `electron-builder`.

## Tech Stack

| Layer         | Tool                                       |
| ------------- | ------------------------------------------ |
| Shell         | Electron 33                                |
| Bundler       | electron-vite / Vite 5                     |
| UI            | React 19 + Tailwind CSS 3 + assistant-ui   |
| Agent runtime | `@anthropic-ai/claude-agent-sdk`           |
| State         | Zustand                                    |
| Validation    | Zod                                        |
| Package mgr   | Bun (lockfile committed)                   |

## Project Structure

```
src/
├── main/                 # Electron main process
│   ├── bootstrap/        # env loader (runs before anything else)
│   ├── core/             # engine, permission broker, message queue
│   ├── ipc/              # IPC handler registration
│   ├── pilot/            # Agent SDK driver
│   └── index.ts          # app entry
├── preload/              # contextBridge bridge (window.api / window.chatApi)
└── renderer/             # React UI
    └── src/components/chat/  # ThreadView, ThreadListSidebar, etc.
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (or npm/pnpm — adjust commands accordingly)
- Node.js ≥ 20 for native module compilation
- A Claude API key or compatible endpoint

### Install

```bash
bun install
```

### Configure

Create `env.json` in the project root (it is gitignored):

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

The values are loaded by `src/main/bootstrap/loadEnv.ts` into `process.env` **before** any module that reads auth tokens runs.

### Develop

```bash
bun run dev
```

### Type-check

```bash
bun run typecheck
```

### Build

```bash
bun run build          # bundle only
bun run build:mac      # macOS .app / .dmg
bun run build:win      # Windows installer
bun run build:linux    # Linux AppImage / deb
```

## License

Private — not yet licensed for redistribution.

---

# Claude Desktop（中文）

一个基于 Electron 的桌面应用，封装了 Claude Agent SDK，提供原生聊天 UI，底层由 `@anthropic-ai/claude-agent-sdk` 驱动，UI 使用 [`assistant-ui`](https://github.com/Yonom/assistant-ui)。

技术栈：Electron + Vite + React 19 + TypeScript + Tailwind CSS。

## 特性

- **原生桌面聊天界面** — 隐藏式标题栏、会话侧边栏、流式响应、GFM Markdown 渲染。
- **Agent SDK 集成** — 主进程驱动 Agent SDK，通过 IPC 与渲染进程通信。
- **可配置的接入端点** — 通过 `env.json` 指向 Anthropic 官方、自建网关或任意兼容代理。
- **权限代理** — 统一管理 agent 循环中工具调用的作用域与权限。
- **跨平台构建** — 通过 `electron-builder` 产出 macOS、Windows、Linux 安装包。

## 技术栈

| 层级     | 工具                                       |
| -------- | ------------------------------------------ |
| 外壳     | Electron 33                                |
| 构建     | electron-vite / Vite 5                     |
| UI       | React 19 + Tailwind CSS 3 + assistant-ui   |
| Agent    | `@anthropic-ai/claude-agent-sdk`           |
| 状态管理 | Zustand                                    |
| 校验     | Zod                                        |
| 包管理   | Bun（已提交 lockfile）                     |

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── bootstrap/        # 环境加载器（先于一切）
│   ├── core/             # 引擎、权限代理、消息队列
│   ├── ipc/              # IPC 注册
│   ├── pilot/            # Agent SDK 驱动
│   └── index.ts          # 入口
├── preload/              # contextBridge（window.api / window.chatApi）
└── renderer/             # React 界面
    └── src/components/chat/  # ThreadView、ThreadListSidebar 等
```

## 快速开始

### 前置条件

- [Bun](https://bun.sh) ≥ 1.1（也可用 npm/pnpm，相应调整命令）
- Node.js ≥ 20（用于编译原生模块）
- Claude API Key 或任意兼容端点

### 安装

```bash
bun install
```

### 配置

在项目根目录创建 `env.json`（已加入 gitignore）：

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

这些值会在 `src/main/bootstrap/loadEnv.ts` 中被加载到 `process.env`，**先于**任何读取 token 的模块执行。

### 开发

```bash
bun run dev
```

### 类型检查

```bash
bun run typecheck
```

### 构建

```bash
bun run build          # 仅打包
bun run build:mac      # macOS .app / .dmg
bun run build:win      # Windows 安装包
bun run build:linux    # Linux AppImage / deb
```

## 许可证

私有仓库，暂未发布许可。
