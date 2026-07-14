# Claude Desktop

Electron 桌面应用，封装 `@anthropic-ai/claude-agent-sdk`（实际驱动的是打包进去的 **fusion-code** CLI，也可切到系统 claude）。React 19 + Vite + Tailwind + zustand + assistant-ui。包管理器是 **bun**，不是 npm。

## 进程模型（改任何东西前先搞清在哪个进程）

**单包形态**：整个桌面应用住在 `apps/studio` 一个包里（原 apps/desktop 已并入并删除，2026-07-03）。包内两个世界，产物目录分家（electron-vite → `out-electron/`，next export → `out/`，谁也不许写对方的目录）：

- **main**（`electron/main/`，Node 环境）— 拥有 `ChatEngine`，spawn fusion-code 子进程，管 SDK `query()` 生命周期、权限、会话。shell 窗口自身承载静态闪屏（`electron/main/splash.html`，经 `splash.ts` 以 ?raw+data:URL 装载，零请求无 preload），splash 首帧就绪即 show，启动里程碑经 executeJavaScript 推进；studio 首帧就绪后被同底色的 view 盖住完成交接（`tabRegistry` 的 promote → `finishSplashThenSettle` → `activateTab`）。
- **preload**（`electron/preload/`）— 通过 `contextBridge` 暴露 `chatApi` 给 studio tab 的 webContents，是唯一的 IPC 边界。
- **UI = 本包 Next 侧**（`app/` + `src/`，浏览器环境）— dev 加载 `localhost:3100`（main 自动 spawn `dev:next`），prod 加载 `app://studio/`（static export 读盘 + daemon 反代，见 `electron/main/services/appProtocol.ts`）。禁止直接 import Node 模块；一切主进程能力走 `window.chatApi`。

**依赖分层铁律**：package.json 的 `dependencies` 只放 Electron 运行时真正 require 的包（externalizeDepsPlugin 和 electron-builder 都按它决策）；前端依赖（next/react/…）一律 `devDependencies`——UI 是构建期静态产物，放错层会把整个前端依赖树打进安装包。

**workspace 依赖**：studio 消费 8 个 workspace 包（`@open-design/composer`＝ProseMirror pmSchema+建议插件三端共用、contracts、host、platform、sidecar、sidecar-proto、ui、`@claude-desktop/design-tokens`）。**contracts / registry-protocol 是预构建包（`types` 指 dist）**——改其源码必须在包内 `bun run build`，否则下游 typecheck 读的还是陈旧 .d.ts。

IPC 通道名集中在 `electron/shared/ipc-channels.ts`，共享类型在 `electron/shared/types.ts`（前端经 `@desktop-shared/*` 别名 type-only 消费）。**加一条 IPC 要同时改四处**：`ipc-channels.ts`（通道常量）→ `preload/index.ts`（暴露方法）→ `preload/index.d.ts`（类型）→ main 侧 handler（`electron/main/ipc/register.ts` 或 engine）。漏一处类型就报错，typecheck hook 会当场抓到。

## 核心：ChatEngine（`electron/main/core/engine.ts`，~3200 行）

每个 tab 一个 `WebContentsView` + 一个独立 `ChatEngine`（绑定到自己的 `webContents`）。引擎内部用 **multi-runtime** 模型：一个 engine 可同时持有多个 `SessionRuntime`（每个对应一个 fusion-code 子进程）。

几条不变量，改之前务必读懂：
- **lazy spawn**：`switchToSession()` 只切指针不 spawn；真正的 cli 冷启动延迟到第一次 `send()`（或后台 warmup）。别在 switch 里同步等 `system init`。
- **`canUseTool` 用闭包捕获的 `sessionId`，不是 `this.activeSessionId`**——前台会话可能已经切走，权限请求必须回到发起它的 runtime。
- **`forkSession: false`** 是 resume 不分叉的前提，别改。
- 权限走 per-engine 的 `PermissionBroker`（`electron/main/core/permissionBroker.ts`），不是全局单例——A 窗口的权限请求不能泄漏到 B 窗口。

## 权限 UI 是内联的，不是 modal

权限请求渲染在对应 tool card 内部（`InlinePermissionPrompt.tsx`），靠 `stores/permissions.ts` 的 `Map<requestId, PermissionRequest>` 支持多个并行 pending 各自独立渲染。取消走 `PERMISSION_CANCELLED` IPC。不要回退到单槽 modal——并行 `canUseTool` 会把它打爆（历史教训）。

## 环境变量与缓存

`electron/main/index.ts` 第一行 `import './bootstrap/loadEnv'` 把 `env.json` 灌进 `process.env`，**必须保持第一**。openSession 对 bundled backend 注入三个缓存保护 env（`CLAUDE_CODE_MCP_INSTR_DELTA` / `CLAUDE_CODE_ATTRIBUTION_HEADER` / `ENABLE_TOOL_SEARCH`），都尊重父进程覆盖。改这块前读 engine.ts 里 openSession 那段长注释，每一项都解释了为什么。

## 样式分层（studio 两面共存一个 document，跨面泄漏是最大坑源）

chat（`src/chat/`，shadcn/Tailwind v4）与 canvas（`src/canvas/`，~40k 行手写 CSS）由 SurfaceHost 常驻同一 document，CSS 没有作用域。改样式前记住四条铁律：

- **token 命名空间**：共享色 token（`packages/design-tokens/tokens.css`，HSL 三元组）独占 `--accent`/`--border` 等 shadcn 名；canvas 的 legacy 名一律 `--od-*` 前缀（完整颜色值）。**任何一侧往 `:root` 加新 token 前先查另一侧有没有同名**——三元组被完整色覆盖后 `hsl(var(--x))` 静默失效零报错（2026-07-03 事故）。
- **裸元素选择器必须带守卫**：canvas 里的 `button`/`input`/`select`/`textarea`/`code` reset 统一 `:where(:not([data-slot], .chat-app *))`（shadcn 原语带 data-slot、聊天树在 .chat-app 下）。新加裸选择器照抄这个模式；`@layer` 治不了「对方没声明的属性被填空」。反过来，**rail/根 layout 层（`src/components/`）的交互元素一律用 shadcn 原语**，不写裸 `<button>`/`<input>`——它们不在任何豁免范围内，裸写必被 canvas reset 填成描边卡片（RailSessionList 会话行踩过）。**chat 组件里 `createPortal(…, document.body)` 的子树同样脱离 `.chat-app` 豁免**——portal 里的裸交互元素必须加 `data-slot` 逃逸（打开方式菜单/全文弹窗/图片 lightbox 都踩过，2026-07-04）。
- **dark 双标记必须同步**：chat CSS 认 `.dark` 类、canvas CSS 认 `[data-theme]`，两个运行时写手（`chat/stores/appearance.applier.ts` 与 `canvas/state/appearance.ts`）已做双向桥接——改任何一个都要保持两标记一起落。
- **CSS 入口**：`app/globals.css` 只挂 chat 链（唯一的 `@import 'tailwindcss'`，别再引第二份）；canvas 链在 `app/layout.tsx` 用 JS import（顺序原因见 globals.css 注释）。品牌绿身份色用 `--brand`（不跟用户主题走），用户可调主题色才用 `--accent`。
- **窗口拖拽面只有一个写手（2026-07-08 收敛重构，2026-07-14 清死代码后名副其实）**：根 layout 的 `.window-drag-strip`（fixed 全宽 46px 常驻）是唯一的 `app-region:drag` 声明——组件顶栏**禁止再标 drag**（它们随会话/分栏/切面重挂载，曾是「整窗拖不动 + 双击不缩放」间歇复发的根源，errors/ 里 7 条同族记录）。历史冗余 drag 已全部清除：canvas 多标签顶栏（WorkspaceTabsBar）连同其 `.workspace-tabs-chrome` drag 于 07-14 删除，chat 的 `.header`/`.shell-chrome` 死代码 drag 声明同日清掉。全屏 overlay（Login/Upgrade）盖住主 strip，各自带一条顶部 drag 条是必要例外。顶部 46px 带内的交互元素（含 portal 出去的全屏弹层、ProjectView 返回栏 AppChromeHeader）一律 `[-webkit-app-region:no-drag]` 挖洞，DOM 在 strip 之后即有效——**删掉/上移一个原本在 strip 带外的顶栏时，务必确认它的交互元素挖了 no-drag，否则落进 strip 带会被拖拽吞点击（07-14 ProjectView 返回栏踩过）**。完整事故链与纪律见 globals.css 的 `.window-drag-strip` 注释。
- **设置页正在迁 chat 栈（2026-07-04 起）**：`src/canvas/components/SettingsDialog/` 与 `src/canvas/components/settings/` 两目录已加进 chat 链 `@source`（scoped，绝不扫整个 canvas 树），V2 壳 + 执行模式 section 已换 shadcn + Tailwind utility。规矩：这两个目录里的**新/改 markup 一律 shadcn 原语 + utility，禁止复用 `.settings-*`/`.sv2-*`/`.field*` 等 legacy 类**（canvas CSS 未分层，同名属性会压过 utility）；原生 `<select>`/裸交互元素加 `data-slot` 逃逸 canvas reset；V2 壳根节点的 `sv2` 类是未迁移 section 的 reskin 兼容层，全部迁完后随 settings-v2.css / settings-modal.css 一起退役。剩余待迁 section 清单见 SettingsDialogV2.tsx 头注释。

## 命令

```bash
bun run dev          # electron-vite dev（main 热重载；daemon 与 Next dev server 由 main 自动 spawn）
bun run typecheck    # 全 workspace；studio 包的 typecheck = 双 tsc（Next 侧 + electron 侧 tsconfig.node.json）
bun run dist:mac     # 全量发布：prebuild:resources（重建 contracts→registry-protocol→daemon→Next 前端）+ build:mac
bun run build:mac    # 只打 Electron 壳：verify:fusion + build:icons + prebundle:daemon(拷现成产物) + electron-vite build + electron-builder
```

**发版必须走 `dist:*` 不是 `build:*`**：`build:mac` 的 prebundle 只是拷贝 daemon dist 与 studio out/ 的现成产物，不重新构建它们——改了前端/daemon/契约包后直接 `build:mac`，打进安装包的是陈旧代码且零报错。

包内脚本约定（apps/studio）：`dev` = 整个桌面应用；`dev:next`/`build:next` = Next 前端独立入口（main 的 spawnStudioDev 调 `dev:next`，root 的 `prebuild:resources` 调 `build:next`）；刻意没有裸 `build`。改完代码以 `bun run typecheck` 为准——**没有单元测试、没有 ESLint**，类型检查是唯一的自动化防线。

## 约定

- 注释密度很高，且专门解释「为什么这样而不是那样」。沿用这个风格——改不变量时把理由写进注释，别只写做了什么。
- **组件文件超 ~1500 行就拆同名目录 + index 重导出**（对外 import 路径不变，moduleResolution: bundler 解析目录 index）；canvas/components 按 feature 子目录分组（home/ plugins/ settings/ files/ project/ chat/ …），新组件放进对应组。canvas 样式按节拆在 `src/canvas/styles/`，`index.css` 是纯 @import 清单——**顺序即级联，别乱动**。
- CI（`.github/workflows/build.yml`）在 `v*` tag（或手动 workflow_dispatch）触发：下载 fusion-code CLI → typecheck → 打包 → 发 GitHub Release。fusion-code 版本钉在 workflow 的 `FUSION_CODE_VERSION`。
- 项目已索引进 codebase-memory-mcp（图检索协议由 SessionStart hook 注入，不在此重复）；大规模移动/重命名文件后索引会陈旧，重跑 `index_repository` 再查。
- 修了 bug 或踩了坑，按全局 CLAUDE.md 规范写进 Obsidian vault 的 errors/ 和 sessions/，并互相加双链。
