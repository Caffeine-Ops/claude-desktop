import { applyRemoteEnvConfig } from '../bootstrap/loadEnv'
import { recycleAllEnginesRuntimes } from '../tabRegistry'
import { sub2apiGet } from './sub2apiClient'

/** Key name patterns that hold a real credential — mask these, not the rest. */
const SECRET_KEY_RE = /TOKEN|API_KEY|SECRET/i

/**
 * `sk-3185b8c4…(66)` for a credential value, verbatim for everything else
 * (BASE_URL / DEFAULT_*_MODEL / TRANSCRIBE_MODEL aren't secrets — printing
 * them in full is the whole point of this log, e.g. spotting "still
 * pointing at the wrong gateway"). Never write full token values to the
 * console: they land in log files / crash reports, one more copy of a
 * live credential to leak (same reasoning as the env.json warning in
 * loadEnv.ts).
 */
function maskEnvValueForLog(key: string, value: string): string {
  if (!SECRET_KEY_RE.test(key)) return value
  if (value.length <= 8) return '***'
  return `${value.slice(0, 8)}…(${value.length})`
}

/**
 * 把 env.json 里手工写死的网关配置（ANTHROPIC_BASE_URL/AUTH_TOKEN、
 * OPENAI_*、GEMINI_* 等——单份共享密钥，打进每一份分发的安装包）换成
 * sub2api 的 `GET /api/v1/keys/client-config`：每个登录用户自己的网关地址
 * + 自动配发的专属 API Key + 管理员维护的附加项（默认模型/转录模型/
 * PIXABAY_API_KEY 等，字段集合由后台自由配置，不是固定 schema，见
 * backend/internal/service/client_env_config_service.go 的
 * GetUserConfig）。响应本身就是扁平的 `{key: value}` 字符串表，跟
 * env.json 的 `env` 块同形状，直接喂给 loadEnv.applyRemoteEnvConfig 覆盖
 * process.env 即可。
 *
 * 调用方：authService.ts 的 login() 成功后，以及冷启动恢复登录态时的
 * refreshProfileInBackground（同一节奏，同一个 profileRefreshedThisSession
 * 门槛，不重复拉取）。两处都是 fire-and-forget——网络失败不该挡登录本身，
 * 失败时 process.env 保留 env.json 的旧值，下一轮成功的调用自然覆盖过去，
 * 同 sessionSyncService 的"失败不重试、下次成功自动纠正"设计。
 */
export async function applyClientEnvConfig(accessToken: string): Promise<void> {
  const result = await sub2apiGet<Record<string, string>>(
    '/api/v1/keys/client-config',
    accessToken
  )
  if (!result.ok) {
    console.error('[clientEnvConfig] fetch failed', {
      reason: result.reason,
      message: result.message
    })
    return
  }

  const applied = applyRemoteEnvConfig(result.data)
  if (applied.length === 0) return
  // 本地调试用：把这次实际生效（覆盖进 process.env）的键值打出来，凭据类
  // 字段掩码，其余（BASE_URL/默认模型等，本身不是密钥）原样打印——这正是
  // 用来排查"网关地址是不是配错了"这类问题的信息。
  const loggedValues = Object.fromEntries(
    applied.map((key) => [key, maskEnvValueForLog(key, result.data[key])])
  )
  console.log('[clientEnvConfig] applied', loggedValues)

  // 已经热起来的 bundled backend runtime 只在 spawn 时读一次 env——不主动
  // 回收就要等它们自然过期（下一次冷启动）才会用上新 key。同 CLI_BACKEND_SET
  // 的做法：跳过 in-flight 的回合，只回收空闲 runtime，让下一次 send 用新
  // 配置重新 spawn。
  await recycleAllEnginesRuntimes()
}
