# Claude Desktop

[English](./README.md) · **简体中文**

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
