import { app } from 'electron'
import { join } from 'node:path'

/**
 * 每个租户（= 一个手机号登录态）的隔离目录布局：
 *
 *   <userData>/tenants/<tenantId>/
 *   ├── .claude/        # 作为子进程与 SDK 读侧的 CLAUDE_CONFIG_DIR：
 *   │                   #   会话 JSONL / todos / agent-memory / 凭据
 *   ├── settings.json   # 每租户应用偏好（cliBackend 等）
 *   └── logs/           # 每租户运行时日志
 *
 * tenantId 是「原始手机号的 sha256 前 16 hex」（在渲染进程算，原号绝不落盘）。
 * 这里集中所有路径拼接，别在调用点散落 join()——改布局只动这一处。
 */
export interface TenantPaths {
  root: string
  claudeConfigDir: string
  settingsPath: string
  logsDir: string
}

export function tenantPaths(tenantId: string): TenantPaths {
  const root = join(app.getPath('userData'), 'tenants', tenantId)
  return {
    root,
    claudeConfigDir: join(root, '.claude'),
    settingsPath: join(root, 'settings.json'),
    logsDir: join(root, 'logs')
  }
}
