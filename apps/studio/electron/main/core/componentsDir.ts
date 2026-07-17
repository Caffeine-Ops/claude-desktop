// 通用组件安装根目录(P1c 起)。范式对齐 kbModelDir.ts:dev 与打包统一走 userData
// (可写、每用户独立)。embed 因历史落点仍在 kbModelDir(),不迁——见
// componentOrchestrator.core.ts 的 componentInstallRootFor 注释。
// 目录布局:<componentsDir>/<descriptor.destSubdir>/…(python-runtime 即
// <componentsDir>/python-runtime/bin/python3)。
import { app } from 'electron'
import { join } from 'node:path'

export function componentsDir(): string {
  return join(app.getPath('userData'), 'components')
}
