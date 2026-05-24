// 外部 MCP 配置桥接：把 Open Design daemon 持有的「外部 MCP 服务器」配置
// （设置 → 外部 MCP，存于 daemon 的 <dataDir>/mcp-config.json）拉到 desktop
// 这一侧，转成 Agent SDK 的 `mcpServers` option 形状，喂给 desktop tab 跑的
// fusion-code/claude。
//
// 为什么走 daemon HTTP 而不是自己读盘：
//   daemon 的 dataDir 解析有 dev（仓库 .od/）/ prod（userData/od-data）两套
//   规则（见 daemon server.ts:resolveDataDir + openDesignServices.ts 注入的
//   OD_DATA_DIR）。在 desktop 侧复刻那套路径逻辑就是又一处「同名契约多处手抄」
//   的隐患——daemon 哪天改了路径规则，这边会静默读错文件。让 daemon 始终当
//   mcp-config 的唯一真相源，desktop 只做消费者，最稳。
//
// 时序：desktop tab 是「立即打开、不等 daemon」的（main/index.ts），所以这个
//   fetch 必须容忍 daemon 尚未 ready —— 失败就当「无外部 MCP」，下次刷新/下次
//   spawn 再补。绝不阻塞 openSession。

// daemon 绑定端口。**故意不 import openDesignServices.DAEMON_PORT**：那个模块
// 顶层 import 了 electron 的 `app` + @electron-toolkit/utils，从这个底层 fetch
// 工具反向拉进整条 electron-app 依赖链，既扩大了 bundler 的模块图、又可能在
// main bundle 里引入「openDesignServices ↔ engine ↔ externalMcp」的加载顺序
// 问题（DAEMON_PORT 在本模块初始化时取到 undefined → URL 变成 :undefined →
// fetch 必败、且静默吞成空 MCP，正是当前症状的高度疑似根因）。这里写死成
// 字面量，与 openDesignServices.ts 的 `export const DAEMON_PORT = 7456` 保持
// 一致；那边改端口时这里要跟改（就一个数字，且都有注释互指）。
const DAEMON_PORT = 7456

// daemon /api/mcp/servers 返回体里 server 的 wire 形状。镜像
// packages/contracts/src/api/mcp.ts 的 McpServerConfig（daemon 已 sanitize 过，
// 这里只取我们要转的字段，多余字段忽略）。两侧 MUST stay in sync。
interface DaemonMcpServer {
  id: string
  label?: string
  transport: 'stdio' | 'sse' | 'http'
  enabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

// Agent SDK 的 `mcpServers` option 是 `Record<string, McpServerConfig>`
// （见 @anthropic-ai/claude-agent-sdk sdk.d.ts:1469）。每个值按 transport 分：
//   - stdio: { type?: 'stdio', command, args?, env? }
//   - sse/http: { type: 'sse' | 'http', url, headers? }
// 这里手写最小镜像而非 import SDK 类型：SDK 的 McpServerConfig 联合里含带活
// McpServer 实例的 sdk 分支（不可序列化），用它会拖进无关约束。我们只产出
// 可序列化的 stdio/sse/http 三种。
type SdkStdioServer = {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}
type SdkRemoteServer = {
  type: 'sse' | 'http'
  url: string
  headers?: Record<string, string>
}
export type SdkExternalMcpServers = Record<string, SdkStdioServer | SdkRemoteServer>

const DAEMON_ORIGIN = `http://127.0.0.1:${DAEMON_PORT}`

/**
 * 把 daemon 侧的 server 列表转成 SDK 的 mcpServers map。
 *
 * 只收 `enabled` 的条目（与 daemon spawn 时一致：禁用的留着凭据但不接线）。
 * 缺关键字段的（stdio 没 command / remote 没 url）跳过，免得 SDK 起一个必崩
 * 的子进程或连一个空 URL。OAuth Bearer 的注入**故意不做**：那需要 daemon 的
 * mcp-tokens.json + 刷新逻辑，desktop 这侧拿不到，留给后续；当前对需要 OAuth
 * 的 remote server，header 里没 token 时 fusion-code 会走它自己的 re-auth。
 */
export function toSdkMcpServers(
  servers: readonly DaemonMcpServer[]
): SdkExternalMcpServers {
  const out: SdkExternalMcpServers = {}
  for (const s of servers) {
    if (!s || s.enabled === false) continue
    if (typeof s.id !== 'string' || !s.id) continue
    if (s.transport === 'stdio') {
      const command = typeof s.command === 'string' ? s.command.trim() : ''
      if (!command) continue
      const entry: SdkStdioServer = { type: 'stdio', command }
      if (Array.isArray(s.args) && s.args.length > 0) entry.args = [...s.args]
      if (s.env && Object.keys(s.env).length > 0) entry.env = { ...s.env }
      out[s.id] = entry
    } else if (s.transport === 'sse' || s.transport === 'http') {
      const url = typeof s.url === 'string' ? s.url.trim() : ''
      if (!url) continue
      const entry: SdkRemoteServer = { type: s.transport, url }
      if (s.headers && Object.keys(s.headers).length > 0) {
        entry.headers = { ...s.headers }
      }
      out[s.id] = entry
    }
  }
  return out
}

/** fetch 一次的结果。`reachable=false` = daemon 没起/连接失败（值得重试）；
 *  `reachable=true` = daemon 应答了，`servers` 是它当前的真实配置（可能为空，
 *  代表用户没配——这种不该重试）。区分这两者是「等 daemon ready」逻辑的核心：
 *  只在不可达时重试，避免「用户真没配 MCP」时白等满超时。 */
interface FetchResult {
  reachable: boolean
  servers: SdkExternalMcpServers
}

/**
 * 单次从 daemon 拉外部 MCP 配置。不抛，永远返回 FetchResult。
 *
 * 不带 Origin 头：daemon 的 isLocalSameOrigin 对 origin==null + Host 在
 * 127.0.0.1:<OD_PORT> 的请求直接放行（origin-validation.ts:170-185），所以
 * Node 主进程的裸 fetch 天然过校验，无需伪造跨源头。
 */
async function fetchOnce(timeoutMs: number): Promise<FetchResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const url = `${DAEMON_ORIGIN}/api/mcp/servers`
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) {
      // daemon 应答了但状态码异常（403/500）——视作「可达但拿不到有效配置」，
      // 不重试（重试也是同样结果）。
      console.warn(`[external-mcp] fetch ${url} -> HTTP ${res.status}`)
      return { reachable: true, servers: {} }
    }
    const body = (await res.json()) as { servers?: DaemonMcpServer[] }
    const servers = Array.isArray(body?.servers) ? body.servers : []
    return { reachable: true, servers: toSdkMcpServers(servers) }
  } catch (err) {
    // ECONNREFUSED（daemon 没起）、abort（超时）、JSON 解析错 —— 一律当不可达，
    // 值得重试。打出来便于诊断。
    console.warn(
      `[external-mcp] fetch ${url} failed:`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    )
    return { reachable: false, servers: {} }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉外部 MCP 配置，**带「等 daemon ready」重试**。返回 SDK 形状的 map（绝不抛）。
 *
 * 为什么要重试：desktop tab 在 app 启动时会立刻 resume 上个会话并 warmup spawn
 * fusion-code（main/index.ts + engine warmup），而 daemon 要晚一两秒才 listening。
 * 单次 fetch 这时必失败 → spawn 用空 MCP → 进程起来后不再加载新 server，那次
 * 晚到的成功 fetch 白拿。所以这里轮询直到 daemon 可达（或超时），再让 warmup
 * spawn。冷启动本就有 ~30s spinner，多等这一两秒 daemon 无感。
 *
 * 重试只针对「不可达」；一旦 daemon 应答（哪怕返回空=用户没配），立即返回，绝不
 * 为「真的没 MCP」白等满超时。
 */
export async function loadExternalMcpServers(
  opts: { waitForDaemon?: boolean } = {}
): Promise<SdkExternalMcpServers> {
  const deadline = Date.now() + (opts.waitForDaemon ? 8000 : 0)
  for (;;) {
    const { reachable, servers } = await fetchOnce(3000)
    if (reachable) {
      console.log(
        `[external-mcp] loaded; wired:`,
        Object.keys(servers)
      )
      return servers
    }
    if (Date.now() >= deadline) {
      // daemon 始终不可达（没装/崩了/超时）。返回空当「本次无外部 MCP」，
      // 下次刷新再试。绝不卡死调用方。
      return {}
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}
