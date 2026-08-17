import type { ScenarioCase, ScenarioCaseGallery } from '../../shared/ipc-channels'

/**
 * 技能案例 payload 的校验/归一化（纯函数，无 electron 依赖，便于单测）。
 *
 * 策略与 scenarioCatalogService.normalizeScenarioCatalog 同源：**顶层结构坏了
 * 整份拒收（null），单条案例坏了只跳过那一条**。服务端保存时已从严校验，
 * 这里是面向「缓存被手改 / 老版本格式 / 服务端升级后多出字段」的第二道。
 */

const MAX_TITLE = 60
const MAX_URL = 2048
const MAX_DESCRIPTION = 2000
const MAX_PROMPT = 4000
const MAX_IMAGES = 9

function nonEmptyString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/**
 * 只放行 http/https 绝对地址。这个值会被直接塞进 `<img src>`——data:/javascript:/
 * file: 一律拒，服务端也拒，这里是第二道。
 */
function httpUrl(v: unknown): string | null {
  const s = nonEmptyString(v, MAX_URL)
  if (!s) return null
  try {
    const u = new URL(s)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host !== '') return s
  } catch {
    /* fallthrough */
  }
  return null
}

function normalizeCase(raw: unknown, index: number): ScenarioCase | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  // hidden 的条目服务端下发前就剔掉了；万一（老缓存/手改）混进来也不显示。
  if (o.hidden === true) return null

  const skill = nonEmptyString(o.skill, 128)
  if (!skill || !/^\/[\w:-]+$/.test(skill)) return null
  const title = nonEmptyString(o.title, MAX_TITLE)
  if (!title) return null
  const cover = httpUrl(o.cover)
  if (!cover) return null
  const prompt = nonEmptyString(o.prompt, MAX_PROMPT)
  if (!prompt) return null

  const images: string[] = []
  if (Array.isArray(o.images)) {
    for (const img of o.images) {
      const u = httpUrl(img)
      if (u) images.push(u)
      if (images.length >= MAX_IMAGES) break
    }
  }

  const description = nonEmptyString(o.description, MAX_DESCRIPTION) ?? undefined
  // id 缺失时用下标兜底：渲染层要一个稳定 key，服务端正常一定会给。
  const id = nonEmptyString(o.id, 128) ?? `case-${index}`

  return { id, skill, title, cover, images, description, prompt }
}

/**
 * 整份校验。返回 null = 这份数据不可用（调用方保留旧缓存）。**空列表是合法
 * 值**（运营清空了案例）——与场景目录不同，这里没有内置默认表要回落，空就是空。
 */
export function normalizeScenarioCaseGallery(raw: unknown): ScenarioCaseGallery | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.cases)) return null
  const cases = o.cases
    .map((c, i) => normalizeCase(c, i))
    .filter((c): c is ScenarioCase => c !== null)
  const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : 0
  return { version, cases }
}
