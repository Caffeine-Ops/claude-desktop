import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

import { broadcastScenarioCatalog } from '../tabRegistry'
import type {
  ScenarioCatalog,
  ScenarioCatalogCategory,
  ScenarioCatalogItem,
  ScenarioCatalogPrompt
} from '../../shared/ipc-channels'
import type { AuthedGet } from './sub2apiClient'

/**
 * 空态场景导航（ScenarioRail）的远端配置：拉取 → 校验 → 落盘 → 广播。
 *
 * 在这之前分类 tab、技能 chip 的文案图标、每个技能的推荐 prompt 全硬编码
 * 在渲染层三个文件里（ScenarioRail.tsx / skillChipRegistry.ts /
 * scenarioSlash.ts），改一句文案要发一次版。现在后台（sub2api 管理端）
 * 维护一份 JSON，客户端登录后拉下来覆盖。
 *
 * 三条设计约束（与 clientEnvConfigService 同源的取舍，但结论不同）：
 *
 *   1. **磁盘缓存是渲染层的真正数据源，网络只负责更新它**。clientEnvConfig
 *      拉到的是 env，晚一点生效无所谓（下次 spawn 才读）；场景目录是首帧
 *      就要画出来的 UI 数据——让渲染层 await 一个 HTTP 往返，空态 rail 会
 *      先空一拍再蹦出来（同 2026-07-17 骨架屏那条教训：加载态的东西必须
 *      无条件立刻可见）。所以 SCENARIO_CATALOG_GET 只读内存里这份缓存，
 *      网络拉取一律后台进行、拿到新版本再广播。
 *   2. **顶层结构坏了整份拒收，单个条目坏了只跳过那一条**。后台把某个
 *      chip 的 value 写空，不该让整条 rail 消失（用户会看到一个空白空态，
 *      且完全无法自救）；但 categories 根本不是数组这种「整份不是我要的
 *      东西」则宁可当没配过，让内置默认表接管。
 *   3. **失败是静默的，且一定回落**。拉取失败保留上一次的缓存；缓存也没有
 *      就返回 null，渲染层用内置默认表。未登录用户（还没走过 login）永远
 *      走这条路——所以内置默认表必须一直维护，不能因为「反正远端会下发」
 *      就让它烂掉。
 */

/** 单个 prompt 文案长度上限——防一份手滑粘贴的巨型文本撑爆 composer。 */
const MAX_PROMPT_TEXT = 4000
/** 整份目录的落盘上限（字节）。远端配置只是文案表，正常不该到 1MB。 */
const MAX_CATALOG_BYTES = 1024 * 1024

function cachePath(): string {
  return join(app.getPath('userData'), 'scenario-catalog.json')
}

/**
 * 进程内的唯一副本。`null` 有两种含义合一：还没读过盘 / 读过但没有缓存。
 * 用 `loaded` 区分，避免每次 IPC 都去 stat 一次文件。
 */
let cached: ScenarioCatalog | null = null
let loaded = false

function nonEmptyString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/** 可选字符串字段：缺省/空 → undefined（让渲染层回落内置值），不是错误。 */
function optionalString(v: unknown, max: number): string | undefined {
  return nonEmptyString(v, max) ?? undefined
}

function normalizePrompts(raw: unknown): ScenarioCatalogPrompt[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ScenarioCatalogPrompt[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const label = nonEmptyString((p as { label?: unknown }).label, 60)
    const text = nonEmptyString((p as { text?: unknown }).text, MAX_PROMPT_TEXT)
    if (!label || !text) continue
    out.push({ label, text })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 一个 chip。`kind` 缺省按 'skill' 处理（后台最常配的就是技能行，让它可省）。
 * skill 必须有合法 value（前导 `/` + 命令名字符集，与渲染层
 * LEADING_SLASH_COMMAND_RE 认得的形状一致——value 不合法的 chip 插进
 * composer 会碎成半个节点，宁可这里就丢掉）。
 */
/**
 * 后台上传图标（data URI）。不合法一律 undefined —— 那样 chip 回落到内置
 * 切片图，是个体面的降级；而放行一个坏值会渲染成破图图标。
 *
 * **只收位图 mime，绝不放行 `image/svg+xml`**：这个值会被直接塞进
 * `<img src>`，位图由渲染器解码、不执行脚本；SVG 则可以携带 `<script>` 与
 * 事件属性，等于让后台配置能往客户端注入脚本。服务端也拒 SVG，这里是第二道。
 *
 * 上限 64KB（字符串长度，比服务端 48KB 解码后的限制略松，base64 本身有约
 * 33% 膨胀）：两边不必严格相等，这道只是防一份异常大的缓存把 IPC 撑爆。
 */
function normalizeIconData(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s.length === 0 || s.length > 64 * 1024) return undefined
  return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(s) ? s : undefined
}

function normalizeItem(raw: unknown): ScenarioCatalogItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const kind = o.kind === 'prompt' ? 'prompt' : 'skill'

  if (kind === 'prompt') {
    const label = nonEmptyString(o.label, 60)
    const text = nonEmptyString(o.text, MAX_PROMPT_TEXT)
    if (!label || !text) return null
    return { kind: 'prompt', label, text }
  }

  const value = nonEmptyString(o.value, 128)
  if (!value || !/^\/[\w:-]+$/.test(value)) return null
  return {
    kind: 'skill',
    value,
    label: optionalString(o.label, 60),
    // 图标名只收「切片文件名」本身：拒掉带路径分隔符/协议的值，防后台
    // 配置直接决定一个 URL（外链图要过 CSP，见 shared 侧 schema 注释）。
    icon: /^[\w-]{1,64}$/.test(String(o.icon ?? '')) ? String(o.icon) : undefined,
    iconData: normalizeIconData(o.iconData),
    description: optionalString(o.description, 200),
    pseudo: o.pseudo === true,
    prompts: normalizePrompts(o.prompts)
  }
}

function normalizeCategory(raw: unknown): ScenarioCatalogCategory | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = nonEmptyString(o.id, 64)
  if (!id || !Array.isArray(o.items)) return null
  const items = o.items.map(normalizeItem).filter((i): i is ScenarioCatalogItem => i !== null)
  // 空分类＝一个点进去什么都没有的 tab，不如不显示。
  if (items.length === 0) return null
  return {
    id,
    label: optionalString(o.label, 32),
    icon: /^[\w-]{1,32}$/.test(String(o.icon ?? '')) ? String(o.icon) : undefined,
    items
  }
}

/**
 * 整份校验。返回 null = 这份数据不可用（调用方据此保留旧缓存 / 回落内置表），
 * 而不是「一份空目录」——空目录会被渲染层当成「后台就是想清空 rail」。
 */
export function normalizeScenarioCatalog(raw: unknown): ScenarioCatalog | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.categories)) return null
  const categories = o.categories
    .map(normalizeCategory)
    .filter((c): c is ScenarioCatalogCategory => c !== null)
  if (categories.length === 0) return null
  const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : 0
  return { version, categories }
}

/**
 * 内存里那份目录（首次调用时懒加载磁盘缓存）。SCENARIO_CATALOG_GET 的
 * 唯一数据源——同步、不碰网络。
 */
export function getScenarioCatalog(): ScenarioCatalog | null {
  if (loaded) return cached
  loaded = true
  const path = cachePath()
  if (!existsSync(path)) return null
  try {
    const stat = readFileSync(path, 'utf-8')
    cached = normalizeScenarioCatalog(JSON.parse(stat))
  } catch (err) {
    // 缓存损坏（手改/写盘被打断）等同没有缓存：内置默认表接管，下一次
    // 成功的拉取会把文件覆盖回正常内容，不需要在这里删文件。
    console.error('[scenarioCatalog] read cache failed', {
      path,
      message: err instanceof Error ? err.message : String(err)
    })
    cached = null
  }
  return cached
}

/**
 * 后台拉取一次远端目录。由 authService 在 login 成功后、以及冷启动的
 * profile 刷新里调用（与 applyClientEnvConfig 同一节奏、同一个
 * 「每进程一次」的门槛）。fire-and-forget：网络失败不该挡登录，也不该
 * 影响已经在用的缓存。
 *
 * 版本没变就什么都不做——冷启动刷新对渲染层完全无感，不会平白重渲染
 * 整条 rail（`version` 由后台维护，改配置即 +1）。
 */
export async function refreshScenarioCatalog(get: AuthedGet): Promise<void> {
  const result = await get<unknown>('/api/v1/client/scenario-catalog')
  if (!result.ok) {
    console.error('[scenarioCatalog] fetch failed', {
      reason: result.reason,
      message: result.message
    })
    return
  }

  // 后台从未配置过时，服务端返回 `data: null`（刻意不用 404——「没配过」是
  // 正常状态，见 client_scenario_catalog_handler.go 的注释）。必须抢在
  // normalize 之前拦掉：它对 null 与对畸形数据一样返回 null，混在一起会让
  // 「还没配」每次登录/冷启动都在日志里躺一条 error，真正的格式故障反而被淹掉。
  if (result.data === null || result.data === undefined) return

  const next = normalizeScenarioCatalog(result.data)
  if (!next) {
    console.error('[scenarioCatalog] remote payload rejected (bad shape) — keeping cache')
    return
  }

  // 先确保内存里那份是「读过盘的」，否则首次刷新拿不到旧版本号，会误判成
  // 有变化而多广播一次（无害但会让 rail 白重渲染一次）。
  const prev = getScenarioCatalog()
  if (prev && prev.version === next.version) return

  const serialized = JSON.stringify(next)
  if (serialized.length > MAX_CATALOG_BYTES) {
    console.error('[scenarioCatalog] remote payload too large — keeping cache', {
      bytes: serialized.length
    })
    return
  }

  cached = next
  loaded = true
  try {
    writeFileSync(cachePath(), serialized, 'utf-8')
  } catch (err) {
    // 落盘失败不影响本次生效（内存已更新），只是下次冷启动拿不到它。
    console.error('[scenarioCatalog] write cache failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
  console.log('[scenarioCatalog] applied', {
    version: next.version,
    categories: next.categories.length
  })
  broadcastScenarioCatalog(next)
}
