import React from 'react'

/**
 * 单视图形态的启动画面 —— shell webContents 以 `?shell=1&singleview=1`
 * 加载时渲染（见 main.tsx 分支与 tabRegistry.createShellWindow）。
 *
 * 为什么需要它：单视图下唯一的 studio tab 要等 studio dev server 探活 +
 * 页面首帧（dev 按需编译 /chat）才上屏（newStudioTab 的 deferred
 * activate），这几秒窗口露出的是 shell webContents。旧 ShellApp 会在
 * 这里画出完整的 legacy rail（新对话/智能助手/工作画布），用户看到的
 * 就是「先闪旧界面再跳 studio」——所以单视图下 shell 只画这个极简
 * 启动画面，样式走既有 token（自动跟随明暗主题）。
 */
export default function StudioSplash(): React.ReactElement {
  return (
    <div className="studio-splash">
      <div className="studio-splash__dot" />
      <div className="studio-splash__label">正在启动…</div>
    </div>
  )
}
