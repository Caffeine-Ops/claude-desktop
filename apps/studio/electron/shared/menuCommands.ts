import type { ShellMenuAction } from './ipc-channels'

/**
 * 菜单项 + 加速键的**单一事实源**（2026-09-30 补键盘快捷键时新建）。
 *
 * 为什么是一张表而不是直接写在 index.ts 的菜单模板里：快捷键冲突和
 * 跨平台前缀写错都是**静默失效**——两项抢同一个键，Electron 不报错，
 * 只是其中一个永远不触发；写死 `Cmd+N` 则 mac 全好、Windows 整条不
 * 响应，跟 electronLanguages 那次「列错拼法 = 静默删光」同一类事故。
 * 抽成纯数据后 menuCommands.test.ts 能把这两条钉死；菜单模板只负责
 * 遍历它生成 MenuItem，不再是手写清单。
 *
 * **加新快捷键的完整链路**（漏一步都不会报错，除了第 1 步）：
 *   1. `ipc-channels.ts` 的 ShellMenuAction 加一个动作名（typecheck 守）
 *   2. 本表加一行
 *   3. 前端加分发分支——**看动作归哪棵树**：
 *      - 根层（新对话/侧栏/切面/搜索）→ src/components/ShellMenuBridge.tsx
 *      - chat 树（设置/日志/语言/导出）→ src/chat/App.tsx
 *   分发漏了不会报错，只是按键没反应，所以第 3 步必须手动按一遍验证。
 */
export type MenuCommandGroup = 'file' | 'view'

export interface MenuCommand {
  readonly action: ShellMenuAction
  readonly label: string
  /**
   * Electron accelerator 串。**一律用 `CmdOrCtrl` 前缀**（见测试里的
   * 跨平台断言）：Electron 在 mac 上解析成 ⌘、其它平台解析成 Ctrl，
   * 是唯一能同时活在三平台的写法。
   */
  readonly accelerator: string
  readonly group: MenuCommandGroup
  /**
   * 在本项之前画一条分隔线。纯视觉分组，用来把「作用于当前会话」的项
   * （导出）和上面的导航项隔开。组首不标——菜单开头画线会多出一条空线。
   */
  readonly separatorBefore?: boolean
}

/**
 * 已被别处占用、本表不得再用的加速键。
 *
 * - `CmdOrCtrl+,` —— 打开设置，渲染层自己监听（canvas/App.tsx，capture 相）。
 *   它没走菜单是历史原因，但键是实打实占着的。
 * - `CmdOrCtrl+W` / `CmdOrCtrl+Q` —— Electron 的 role close / quit，平台标配。
 * - `CmdOrCtrl+Alt+I` —— 自定义的 detach DevTools（index.ts 的 viewMenu），
 *   它的 click 直接操作 webContents、不走本总线，所以进不了本表。
 * - `CmdOrCtrl+R` / `CmdOrCtrl+Shift+R` —— role reload / forceReload。
 */
export const RESERVED_ACCELERATORS: readonly string[] = [
  'CmdOrCtrl+,',
  'CmdOrCtrl+W',
  'CmdOrCtrl+Q',
  'CmdOrCtrl+Alt+I',
  'CmdOrCtrl+R',
  'CmdOrCtrl+Shift+R'
]

/**
 * 声明顺序 = 用户在菜单里看到的顺序（menuCommandsIn 保序）。
 *
 * 键位取舍：
 * - ⌘N 新对话、⌘K 搜索 —— 与 ChatGPT / Claude.ai 一致，肌肉记忆直接迁移。
 * - ⇧⌘E 导出 —— 单 ⌘E 在 mac 上是「用选中内容查找」的系统惯例，避开。
 * - ⌘\ 切换侧边栏 —— 跟 Claude.ai 一致（VS Code 用 ⌘B，各家不统一）。
 * - ⌘1 / ⌘2 切面 —— 「第 N 个主视图」是跨应用的通用约定。
 */
export const MENU_COMMANDS: readonly MenuCommand[] = [
  { action: 'new-chat', label: '新对话', accelerator: 'CmdOrCtrl+N', group: 'file' },
  { action: 'open-search', label: '搜索对话', accelerator: 'CmdOrCtrl+K', group: 'file' },
  {
    action: 'export-transcript',
    label: '导出对话…',
    accelerator: 'Shift+CmdOrCtrl+E',
    group: 'file',
    separatorBefore: true
  },
  {
    action: 'toggle-sidebar',
    label: '切换侧边栏',
    accelerator: 'CmdOrCtrl+\\',
    group: 'view'
  },
  { action: 'go-chat', label: '聊天', accelerator: 'CmdOrCtrl+1', group: 'view' },
  { action: 'go-canvas', label: '工作画布', accelerator: 'CmdOrCtrl+2', group: 'view' }
]

/** 取某一组的命令，保持 MENU_COMMANDS 里的声明顺序。 */
export function menuCommandsIn(group: MenuCommandGroup): readonly MenuCommand[] {
  return MENU_COMMANDS.filter((c) => c.group === group)
}
