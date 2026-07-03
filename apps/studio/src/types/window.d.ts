import type { ChatApi, DesktopLogsApi, TabApi } from '@desktop-shared/ipc-channels'

/**
 * Window 增强：studio 跑在 Electron 壳的 studio tab 里时，preload
 * （apps/desktop/src/preload/index.mjs，与 chat tab 同一份）通过
 * contextBridge 注入 chatApi / tabApi。类型从 desktop 的 shared 单一来源
 * type-only 引入（见 tsconfig paths 的 @desktop-shared 注释）。
 *
 * 声明为**非可选**——与 desktop 的 preload/index.d.ts 一致——是为了让
 * 迁移进 src/chat/ 的 60 个 renderer 文件零改动通过 typecheck（它们全部
 * 假定 chatApi 恒存在）。运行时的真实情况是浏览器直开时两者都是
 * undefined：宿主 gate 收在聊天路由入口一处（app/chat/page.tsx 的
 * HostGate），gate 不过就不渲染任何触碰 chatApi 的组件树，类型谎言
 * 因此永不兑现。新写的 studio 代码若在 gate 之外触碰 chatApi，必须
 * 自己做 typeof 检查（探针页就是这么写的）。
 */
declare global {
  interface Window {
    chatApi: ChatApi
    tabApi: TabApi
    /**
     * 与 chatApi/tabApi 不同，这里声明为**可选**：唯一消费方
     * （LogAnalysisSection）不在 HostGate 之后，浏览器直开时要靠
     * `window.desktopLogs` 为 undefined 来渲染「仅桌面应用内可用」
     * 空态——类型如实反映运行时，判空逻辑才能被 typecheck 覆盖。
     */
    desktopLogs?: DesktopLogsApi
  }
}

export {}
