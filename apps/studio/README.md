# @claude-desktop/studio — 统一前端（迁移目标）

三个 app 的前端 UI 最终都收敛到这里，Electron 退化为薄壳。动机：现状下聊天
（desktop renderer）与设计工具（web 静态导出）是两个隔离的 WebContentsView，
跨页面通信要穿 IPC + daemon HTTP 两层，状态共享/拖拽/动画过渡都不丝滑；合并成
同一个 React 树后这些都是进程内操作。

## 架构决策（2026-07-03 用户拍板）

1. **聊天数据链路保留 Electron IPC**：studio 跑在桌面壳内时 preload 照常注入
   `window.chatApi`，聊天 UI 平移、数据层零重写。ChatEngine 留在 Electron main。
   将来若要纯浏览器聊天，再做 transport 抽象（IPC/WS 双实现），不堵路。
2. **放弃纯浏览器部署形态**（od CLI static export serve）：studio 只服务桌面壳，
   不背 static export 兼容包袱。打包形态（standalone vs export 回退）在聊天
   迁移完后再定。
3. **react 精确钉死 19.2.5**，与 apps/web、apps/desktop 三方一致——bun workspace
   出现两份 react 就会复发 @types/react 双版本穿透坑（errors/2026-05-23）。

## 迁移路线

- **Phase 1 ✅**：骨架 + 共享包接入（design-tokens / @open-design/ui）+
  daemon 反代 rewrite。Electron 壳 dev 下加载 `http://localhost:3100`。
- **Phase 2 ✅**：聊天 UI 从 `apps/desktop/src/renderer` 整体迁入
  `src/chat/`（60 文件，/chat 路由，dynamic ssr:false + HostGate）；
  composer 核心（pmSchema+suggestionPlugin）下沉 @open-design/composer
  三端合一（wire format 不变量：serialize 对 plain text 无损）。
- **单视图形态 ✅**：壳只建一个全屏 studio tab，AppRail 在 studio 内做导航
  （聊天 /chat、工作画布 /、设置 /?settings=1）。
- **Phase 3 ✅**：apps/web 的 SPA 全树（184k 行）整体平移到 src/canvas/，
  挂根 optional catch-all（canvas 自制 router 是根路径制）。
- **Phase 4 ✅**：`apps/web` 已物理删除；desktop renderer 已整体删除
  （electron-vite 不再有 renderer target，5173 dev server 不复存在；shell
  窗口不加载任何内容，保持隐藏直到 studio 首帧就绪才 show——用户看到的
  第一帧就是 studio）；
  legacy 三 tab 架构（含 LEGACY_TABS 回退门）删除，单视图是唯一形态；
  prod 走 static export + app://studio 协议（appProtocol.ts）；设置迁入
  /?settings=1（AppRail 硬导航 → canvas 的 isSettingsOverlay 模式）；
  @anthropic-ai/sdk 三端统一 ^0.105。

## 组件库：shadcn/ui（2026-07-03 起）

通用 UI 原语统一用 **shadcn/ui**（radix 底座），组件在 `src/components/ui/`，
`bunx shadcn@latest add <name>` 拉新组件（components.json 已配好 alias：
`@/src/components/ui`、cn() 在 `@/src/lib/utils`）。主题零对接成本——
`src/chat/styles/index.css` 的 `@theme inline` 已把 design-tokens 的 HSL
变量映射成 shadcn 语义 token（bg-primary / text-muted-foreground / …）；
动画 utilities 来自 `tw-animate-css`（import 在 tailwindcss 之后）。

- 生成的组件**手动补 `"use client"`**（components.json 设了 rsc:false，
  CLI 不会自动加）。
- 对话框底座用 `src/components/ui/dialog-shell.tsx`（API 兼容旧
  @open-design/ui 版，radix 接管 portal/focus trap/aria）；@open-design/ui
  的 DialogShell 已 deprecated。
- canvas（`src/canvas/`）的手写 CSS 组件**不强改**——27k 行手写样式的
  视觉回归风险高，替换按「碰到才换」增量进行（CustomSelect、各 *Modal
  是首选替换对象）。

## 命令

```bash
bun run dev        # next dev -p 3100（避开 web 的 3000 和 daemon 的 7456）
bun run typecheck  # tsc --noEmit，全 workspace 质量门的一部分
bun run build      # next build
```
