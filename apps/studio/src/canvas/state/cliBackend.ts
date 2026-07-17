import type { AppConfig } from '../types';

/**
 * 统一 CLI 后端（2026-07-16 起的执行模型）：canvas 项目 run 与 chat 会话
 * 共用同一个「Bundled fusion-code / System claude」选择，真源是 main 进程
 * 的 appSettings.cliBackend（经 window.chatApi.getCliBackend/setCliBackend
 * 读写、chat 面即时生效）。canvas 这一侧的传导不新增任何 daemon 协议——
 * 复用 daemon 已有的 CLAUDE_BIN 覆盖机制（runtimes/executables.ts 的
 * AGENT_BIN_ENV_KEYS：agentCliEnv.claude.CLAUDE_BIN 指向的绝对路径优先于
 * PATH 检测，spawn / detectAgents 探测 / 模型拉取全部跟随）：
 *
 *   - bundled → agentCliEnv.claude.CLAUDE_BIN = 打包 fusion-code 的绝对路径
 *   - system  → 删掉 CLAUDE_BIN，回到 daemon 自己的 PATH 检测（系统 claude）
 *
 * 同时把 agentId 钉到 'claude'——执行模式 UI 已收敛为 Claude 双后端二选一
 * （其余 CLI 的 daemon 底层适配保留，仅 UI 下线）。
 *
 * 写入点有两个，都走本函数：
 *   1. 设置页切换（CliBackendCard）——setCliBackend 成功后同步 cfg；
 *   2. App bootstrap 对账（App.tsx）——main 默认 bundled 而 daemon 侧
 *      app-config 开箱没有 CLAUDE_BIN（= system），不对账就开箱不一致；
 *      用户绕过 UI 改了 main 设置同理。
 */
export function applyCliBackendToConfig(
  cfg: AppConfig,
  mode: 'bundled' | 'system',
  bundledPath: string | null,
): AppConfig {
  const prevClaudeEnv = cfg.agentCliEnv?.claude ?? {};
  const wantBin = mode === 'bundled' && bundledPath ? bundledPath : undefined;

  // 无变化 → 返回原引用，调用方以引用相等判断「不用保存」，避免每次
  // bootstrap 对账都触发一轮 saveConfig/syncConfigToDaemon 回声。
  if (cfg.agentId === 'claude' && (prevClaudeEnv.CLAUDE_BIN ?? undefined) === wantBin) {
    return cfg;
  }

  const claudeEnv: Record<string, string> = { ...prevClaudeEnv };
  if (wantBin) claudeEnv.CLAUDE_BIN = wantBin;
  else delete claudeEnv.CLAUDE_BIN;

  const agentCliEnv = { ...(cfg.agentCliEnv ?? {}) };
  if (Object.keys(claudeEnv).length > 0) agentCliEnv.claude = claudeEnv;
  else delete agentCliEnv.claude;

  return { ...cfg, agentId: 'claude', agentCliEnv };
}
