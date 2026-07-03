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
- **Phase 2（进行中）**：聊天 UI 已从 `apps/desktop/src/renderer` 整体迁入
  `src/chat/`（60 文件，/chat 路由，dynamic ssr:false + HostGate）。
  剩余：composer 四件套下沉 packages（与 web 版本合并，wire format 不变量：
  serialize 对 plain text 无损）。
- **单视图形态 ✅（dev 默认）**：壳只建一个全屏 studio tab（LEGACY_TABS=1
  找回旧三 tab），AppRail 在 studio 内做导航；/canvas 先以 iframe 嵌完整
  web 应用（NEXT_PUBLIC_OD_WEB_ORIGIN 由壳注入），是 Phase 3 完成前的过渡。
- **Phase 3**：设计工具 UI 从 `apps/web` 按路由逐步真迁入（184k 行，大头），
  逐路由替换 /canvas 的 iframe，直到 web 清空。
- **Phase 4**：下线 `apps/web` 与 desktop renderer，desktop 只剩 main/preload
  薄壳；打包链路从 prebundle web/out 切换为 studio 产物。

## 命令

```bash
bun run dev        # next dev -p 3100（避开 web 的 3000 和 daemon 的 7456）
bun run typecheck  # tsc --noEmit，全 workspace 质量门的一部分
bun run build      # next build
```
