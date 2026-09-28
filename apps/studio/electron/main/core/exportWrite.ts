import { writeFile } from 'node:fs/promises'

import { BrowserWindow, dialog } from 'electron'

import type { FileExportResult } from '../../shared/ipc-channels'

/**
 * 「保存框选好路径之后把字节写下去」的统一收尾（2026-09-28 代码审查⑥）。
 *
 * 为什么需要这一层
 * ----------------
 * 写盘是会失败的：目标目录没有写权限、磁盘满、选完路径后目录被删、文件被
 * 另一个程序独占。此前这族 handler 一律裸 `await writeFile(...)`——异常直接
 * 冒到 renderer，而那边普遍只 `console.warn`。于是**保存框关掉了、文件没有
 * 出现、界面一声不吭**，用户有充分理由以为导出成功了，直到某天去找那个文件。
 *
 * 两件事一起做：
 *
 *  1. **弹原生错误框**。写盘失败是系统级故障（权限/磁盘），原生框是恰当的
 *     表达；更要紧的是，这族入口里有 ChatHeader 的 ··· 菜单这种**没有任何
 *     消息位**的调用方，不在 main 侧提示就只能继续静默。放在这里，6 条导出
 *     通道一次性全部获得可见反馈，前端不必各自造 UI。
 *  2. **回传 `{ ok: false, error }`**。让调用方仍能在自己的反馈条里显示
 *     （方案/写作面板都有 exportMsg 条），并且**和「用户取消」区分开**——
 *     两者此前都是 `path: null`，这正是审查指出的病根。
 *
 * 成功/取消不在这里弹任何东西：成功的反馈是各调用方自己的（Finder 定位或
 * 消息条），取消本来就该静默。
 */
export async function writeExportFile(
  win: BrowserWindow | null,
  filePath: string,
  data: Parameters<typeof writeFile>[1]
): Promise<FileExportResult> {
  try {
    await writeFile(filePath, data)
    return { ok: true, path: filePath }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const detail = `${filePath}\n\n${msg}`
    // 窗口可能在保存框开着的时候被关掉——无窗口版本同样能弹（同
    // ipc/register.ts 里 showMessageBox 的双分支写法）。
    if (win && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'error',
        title: '导出失败',
        message: '文件没能写入磁盘',
        detail,
        buttons: ['好']
      })
    } else {
      dialog.showErrorBox('导出失败', detail)
    }
    return { ok: false, error: `写入文件失败：${msg}` }
  }
}
