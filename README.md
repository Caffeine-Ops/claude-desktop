# Claude Desktop

**English** · [简体中文](./README.zh.md)

An Electron desktop application that wraps the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). It spawns a bundled **fusion-code** CLI as a child process (with the option to fall back to the system `claude`), and pairs the agent loop with a rich chat + design-canvas UI built on React 19 and [`assistant-ui`](https://github.com/Yonom/assistant-ui).

This repository is a **Bun workspace monorepo** — one desktop shell, one background design daemon, and a set of shared TypeScript packages.

> **Note:** The package manager is **Bun**, not npm/pnpm. Use `bun install` and `bun run …` throughout.

---

## Table of contents

- [Architecture at a glance](#architecture-at-a-glance)
- [Repository layout](#repository-layout)
- [Modules in detail](#modules-in-detail)
  - [`apps/studio` — the desktop app](#appsstudio--the-desktop-app-claude-desktopstudio)
  - [`apps/daemon` — the design daemon](#appsdaemon--the-design-daemon-open-designdaemon)
  - [`packages/*` — shared libraries](#packages--shared-libraries)
  - [`tools/*` — dev & release tooling](#tools--dev--release-tooling)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Commands](#commands)
- [Conventions & guardrails](#conventions--guardrails)
- [License](#license)

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│  Electron shell  (apps/studio/electron)                        │
│                                                                │
│  main process ──── ChatEngine ──spawn──▶ fusion-code CLI       │
│    │  (Node)         (Agent SDK query() lifecycle,             │
│    │                  permissions, sessions)                   │
│    │                                                           │
│    └── preload  ──contextBridge──▶  window.chatApi             │
│           (the single IPC boundary)                            │
│                          │                                     │
│  ┌───────────────────────┼───────────────────────────────┐    │
│  │  Unified front end  (apps/studio/app + src)  — Next.js │    │
│  │                                                        │    │
│  │   src/chat    ── streaming chat UI  (shadcn/Tailwind)  │    │
│  │   src/canvas  ── design workspace   (hand-written CSS) │    │
│  │        both surfaces share ONE document (SurfaceHost)  │    │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
             │  HTTP (localhost) / app:// protocol
             ▼
┌──────────────────────────────────────────────────────────────┐
│  apps/daemon  (@open-design/daemon) — standalone Node service  │
│  better-sqlite3 storage · design-system tooling · plugins ·    │
│  connectors · live-artifact preview · deploy · media           │
└──────────────────────────────────────────────────────────────┘
```

**The process model is the first thing to internalize** before changing anything — every file lives in exactly one of three worlds:

| World | Where | Environment | Owns |
|---|---|---|---|
| **main** | `apps/studio/electron/main/` | Node | `ChatEngine`, spawns fusion-code, SDK `query()` lifecycle, permissions, sessions, windows |
| **preload** | `apps/studio/electron/preload/` | isolated bridge | exposes `window.chatApi` via `contextBridge` — the **only** IPC boundary |
| **renderer / UI** | `apps/studio/app/` + `apps/studio/src/` | browser | the entire React app; never imports Node modules — all native capability goes through `window.chatApi` |

The daemon is a **fourth, separate process** — a standalone Node service that in production is spawned by the Electron main process and reached over `localhost` HTTP (and the custom `app://` protocol for static assets).

---

## Repository layout

```
claude-desktop/
├── apps/
│   ├── studio/          # The desktop app: Electron shell + unified Next.js front end
│   └── daemon/          # Standalone design daemon (@open-design/daemon)
├── packages/            # Shared TypeScript libraries (see below)
│   ├── composer/          # ProseMirror chat-composer core (schema + suggestions)
│   ├── contracts/         # Pure-TS contracts for the web/daemon boundary
│   ├── host/              # Renderer ↔ host bridge protocol
│   ├── platform/          # Cross-platform primitives
│   ├── sidecar/           # Sidecar client
│   ├── sidecar-proto/     # Sidecar wire protocol
│   ├── ui/                # Shared React UI primitives (Tailwind, source-only)
│   ├── design-tokens/     # Single source of truth for color tokens (CSS)
│   ├── plugin-runtime/    # Pure-TS plugin manifest/adapter runtime
│   ├── registry-protocol/ # Plugin-registry backend protocol
│   ├── diagnostics/       # Log collection / redaction / zip packaging
│   └── agui-adapter/      # Adapter to the AG-UI event protocol
├── tools/               # Dev & release tooling (dev / pack / pr / serve)
├── package.json         # Workspace root: dev/build/dist/typecheck orchestration
├── bun.lock             # Committed lockfile — do not delete-and-reinstall
└── CLAUDE.md            # Deep architecture notes & hard-won invariants
```

---

## Modules in detail

### `apps/studio` — the desktop app (`@claude-desktop/studio`)

The whole desktop application lives in this single package. It contains two worlds whose build outputs are kept strictly separate (electron-vite → `out-electron/`, Next.js static export → `out/`).

#### Electron shell — `electron/`

| Path | Responsibility |
|---|---|
| `electron/main/index.ts` | App entry. **First line** imports `bootstrap/loadEnv` so `env.json` is in `process.env` before anything reads a token. |
| `electron/main/core/engine.ts` | **`ChatEngine`** (~3,200 lines). One engine per tab, bound to its own `webContents`. Uses a **multi-runtime** model: a single engine can hold several `SessionRuntime`s, each a fusion-code child process. Owns lazy-spawn, session switching, streaming, and `canUseTool`. |
| `electron/main/core/permissionBroker.ts` | Per-engine `PermissionBroker` — tool-permission requests are scoped to the engine that raised them, never a global singleton. |
| `electron/main/core/` (rest) | `sessionStore`, `asyncMessageQueue`, `appSettings`, `cliDetect`, `externalMcp`, `fileSuggestions`, `logCollector`, `permissionScope`, `seedSkills`. |
| `electron/main/ipc/register.ts` | Registers every IPC handler (~2,000 lines) — the main-side end of `window.chatApi`. |
| `electron/main/pilot/sdkPilot.ts` | Drives the Claude Agent SDK `query()` loop. |
| `electron/main/services/` | `appProtocol` (the `app://` static-file server + daemon reverse proxy), `appUpdater`, `openDesignServices` (daemon lifecycle). |
| `electron/main/bootstrap/loadEnv.ts` | Loads `env.json` into `process.env` — **must run first**. |
| `electron/preload/` | `contextBridge` bridge exposing `window.chatApi`. `index.d.ts` carries the renderer-facing types. |
| `electron/shared/` | `ipc-channels.ts` (channel-name constants) and `types.ts` (shared types, consumed type-only from the front end via the `@desktop-shared/*` alias). |

> **Adding an IPC channel means editing four places** in lockstep: `ipc-channels.ts` → `preload/index.ts` → `preload/index.d.ts` → the main-side handler. Miss one and typecheck catches it.

#### Unified front end — `app/` + `src/`

A Next.js app that in dev loads `http://localhost:3100` and in production is served as a static export via the `app://studio/` protocol. Two surfaces co-exist in **one document** (mounted by `SurfaceHost`), which is why cross-surface CSS leakage is the project's single biggest source of bugs.

| Path | Responsibility |
|---|---|
| `app/` | Next.js routes (`[[...slug]]` catch-all for the canvas router, `chat/`), `layout.tsx`, `globals.css` (the chat CSS chain). |
| `src/chat/` | **Chat surface** — streaming assistant UI, built on shadcn/ui + Tailwind v4. Holds `stores/` (zustand), `runtime/`, `composer/`, `shell/`, and its own `styles/`. |
| `src/canvas/` | **Design workspace** — the SPA (~184k lines) migrated wholesale from the former `apps/web`. Ships ~40k lines of hand-written CSS in `styles/`, feature-grouped components (`home/`, `plugins/`, `settings/`, `files/`, `project/`, `chat/`, `memory/`, …), plus `state/`, `runtime/`, `providers/`, `i18n/`, `artifacts/`, `edit-mode/`. |
| `src/components/` | Root-level layout shell: `AppRail` (left nav), `SurfaceHost` (mounts both surfaces), `ChatSurface`, `RailProjectList`, `RailSessionList`. **These use shadcn primitives, never bare elements** (bare elements get reskinned by the canvas CSS reset). |
| `src/components/ui/` | shadcn/ui primitives (add with `bunx shadcn@latest add <name>`). |
| `src/lib/`, `src/types/` | Shared front-end utilities (`cn()`, etc.) and types. |

### `apps/daemon` — the design daemon (`@open-design/daemon`)

A standalone Node service (entry `dist/cli.js`) that provides the Open Design capabilities the canvas surface talks to. It uses **`better-sqlite3`** (a synchronous API — heavy queries block its event loop, so watch for that). In production it's spawned by the Electron main process and reached over `localhost` HTTP.

| Path | Responsibility |
|---|---|
| `src/server.ts` | The HTTP/WS server (~12k lines) — routes, streaming endpoints, request handling. |
| `src/cli.ts` | Daemon CLI entry & bootstrap. |
| `src/http/` | HTTP adapter, request parsing, response helpers, and `origin-guard.ts` (local same-origin enforcement). |
| `src/storage/` | `daemon-db` (better-sqlite3), `project-storage`, `db-inspect`, AWS SigV4 signing. |
| `src/db.ts` | Chat/event persistence. |
| `src/runtimes/` | Agent-runtime detection, capabilities, auth, model resolution, launch/invocation, prompt-budget. |
| `src/plugins/`, `src/registry/` | Plugin loading and the plugin registry. |
| `src/connectors/`, `src/memory-connectors.ts` | External connectors & memory integrations. |
| `src/live-artifacts/`, `src/genui/` | Live-artifact preview & generative-UI events. |
| `src/critique/`, `src/qa/`, `src/lint-artifact.ts` | Design critique, QA, and artifact linting. |
| `src/media.ts`, `src/deploy.ts` | Image/video generation tooling and deployment. |
| `src/design-systems.ts`, `src/design-system-import.ts` | Design-system definitions and import. |
| `src/logging/`, `src/metrics/`, `src/prompts/`, `src/tools/`, `src/research/` | Logging, metrics, prompt assembly, tool definitions, research. |

### `packages/*` — shared libraries

Consumed across the workspace. They fall into three build categories:

**Source-only** (entrypoints point straight at `src/` so each host's bundler and Tailwind scanner see the code directly):

| Package | What it is |
|---|---|
| `@open-design/composer` | ProseMirror core for the chat composer — `pmSchema`, `serializeDoc`, the suggestion state machine. Shared by desktop renderer / studio / web. The interactive layer (input component, chip node view) deliberately stays in each host. |
| `@open-design/ui` | Shared React UI primitives (Tailwind-based). Carries no styles beyond utilities resolved against the shared design tokens. |
| `@claude-desktop/design-tokens` | The single source of truth for color — a `tokens.css` of HSL triplets consumed by both surfaces. |

**Pre-built** (`types` point at `dist/` — **edit the source and you must `bun run build` inside the package**, or downstream typecheck reads a stale `.d.ts`):

| Package | What it is |
|---|---|
| `@open-design/contracts` | Pure-TS contracts for the web ↔ daemon boundary (connection-test, orbit, finalize, handoff, provider-models, research, critique, analytics). |
| `@open-design/registry-protocol` | Backend protocol for plugin sources / the plugin registry. |
| `@open-design/host` | The renderer ↔ host bridge protocol (plus a `testing` entry). |
| `@open-design/platform` | Cross-platform primitives. |
| `@open-design/sidecar` / `@open-design/sidecar-proto` | Sidecar client and its wire protocol. |
| `@open-design/plugin-runtime` | Pure-TS plugin runtime — manifest parsers, adapters, merger, ref resolver, validator, digest. No `node:fs` imports; hosts inject loaders. |
| `@open-design/diagnostics` | Log collection, redaction, and zip packaging shared by daemon and desktop. |
| `@open-design/agui-adapter` | Bidirectional adapter between Open Design's event union and the [AG-UI](https://github.com/CopilotKit/CopilotKit) canonical event protocol. |

### `tools/*` — dev & release tooling

Workspace-local tooling: `tools/dev` (`@open-design/tools-dev`), `tools/pack`, `tools/pr`, `tools/serve`.

---

## Tech stack

| Layer | Tool |
|---|---|
| Shell | Electron |
| Bundlers | electron-vite (shell) · Next.js static export (front end) |
| UI | React 19 · Tailwind CSS v4 · shadcn/ui · assistant-ui |
| Chat composer | ProseMirror (`@open-design/composer`) |
| State | Zustand |
| Agent runtime | `@anthropic-ai/claude-agent-sdk` driving the bundled **fusion-code** CLI |
| Daemon storage | better-sqlite3 |
| Validation | Zod |
| Package manager | **Bun** (lockfile committed) |
| Packaging | electron-builder (macOS / Windows / Linux) |

---

## Getting started

### Prerequisites

- [Bun](https://bun.sh) (the package manager for this repo)
- Node.js ≥ 20 for native-module (better-sqlite3) compilation
- A Claude API key or a compatible endpoint

### Install

```bash
bun install
```

### Configure

Create `apps/studio/env.json` (gitignored). It's loaded into `process.env` by `electron/main/bootstrap/loadEnv.ts` **before** any module that reads auth tokens runs:

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

See `apps/studio/env.example.json` for the full set of supported keys.

### Develop

```bash
bun run dev
```

This starts electron-vite dev with main hot-reload. The Next.js dev server (port 3100) and the daemon are auto-spawned by the main process.

---

## Commands

Run from the repository root:

```bash
bun run dev          # Electron dev (main hot-reloads; daemon + Next dev server auto-spawned)
bun run typecheck    # Whole-workspace type check — the only automated quality gate

# Release builds ─ ALWAYS use dist:* to ship, not build:*
bun run dist:mac     # Rebuild contracts→registry-protocol→daemon→front end, THEN package for macOS
bun run dist:win     # …Windows
bun run dist:linux   # …Linux

# Shell-only builds (assume daemon dist/ and front-end out/ are already fresh)
bun run build:mac    # Package the Electron shell for macOS only
```

> **Ship with `dist:*`, not `build:*`.** `build:*` only *copies* the existing daemon and front-end artifacts — it does not rebuild them. Run `build:mac` after changing the front end / daemon / contract packages and you'll silently package stale code with zero errors. `dist:*` prepends the rebuild steps.

> **There are no unit tests and no ESLint** — `bun run typecheck` is the only automated defense line. Type-check before every commit.

---

## Conventions & guardrails

A few invariants that will bite if ignored — see [`CLAUDE.md`](./CLAUDE.md) for the full, heavily-commented set:

- **Dependency layering.** In `apps/studio/package.json`, `dependencies` holds *only* packages the Electron runtime actually `require`s at runtime. Front-end deps (next/react/…) go in `devDependencies` — the UI is a build-time static artifact, and misplacing a dep bundles the entire front-end dependency tree into the installer.
- **CSS has no scope.** The chat (shadcn/Tailwind) and canvas (hand-written CSS) surfaces share one document. Shared color tokens own the shadcn names (`--accent`, `--border`, …); canvas legacy names are all `--od-*`-prefixed. Before adding any `:root` token, check the other side for a name clash.
- **Dark mode uses two markers.** Chat CSS keys off the `.dark` class; canvas CSS keys off `[data-theme]`. Both writers bridge to each other — change one, keep both in sync.
- **Pre-built contract packages must be rebuilt after source edits** (`contracts`, `registry-protocol`, and the rest with `types` → `dist`).
- **Never delete-and-reinstall the lockfile** — `^` ranges will drift to breaking versions.

---

## License

Private — not yet licensed for redistribution.
