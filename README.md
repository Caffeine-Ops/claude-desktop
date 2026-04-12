# Claude Desktop

**English** · [简体中文](./README.zh.md)

An Electron desktop wrapper around the Claude Agent SDK, providing a native chat UI backed by the `@anthropic-ai/claude-agent-sdk` and powered by [`assistant-ui`](https://github.com/Yonom/assistant-ui).

Built with Electron + Vite + React 19 + TypeScript + Tailwind CSS.

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
