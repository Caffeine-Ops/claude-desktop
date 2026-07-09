/**
 * 知识库索引的读取与全量重建（main 侧），按【域】隔离的两套数据：
 *   - docs   → ~/.cowork/KB-INDEX.json        + KB-CATEGORIES.json（「文档识别」）
 *   - images → ~/.cowork/KB-IMAGE-INDEX.json  + KB-IMAGE-CATEGORIES.json（「图片识别」）
 * 同一套 schema / 解析 / 线协议 / 管理操作（shared/kbCatalog.ts），只是文件名、
 * 默认类别、扫描扩展名不同——同构的第二份数据，不是第二套代码。
 *
 * 「更新知识库」按钮 → rebuildKbCatalog(domain)：
 *   扫授权目录（复用 localDocsScan，按域选扩展名白名单）→ 分批喂给 SDK 无头
 *   调用归类（域各自的类别集合）→ 保留旧索引里写过的 summary → 全量重写该域
 *   索引。进度经 KB_CATALOG_STATUS 广播（payload 带 domain，仿 kbSyncScheduler）。
 *
 * 为什么用 SDK query() 而不是自己 spawn `fusion-code -p`：SDK 的 query() 底层
 * 就是无头 print 模式（spawn CLI + 单发 prompt + 收 result），但它替我们管好了
 * 子进程生命周期 / 超时中断（abortController）/ 结果流解析——engine.ts 同一个
 * import，零新依赖。
 *
 * 后端恒用 bundled fusion-code（不随 cliBackend 设置走）：这是应用自己的后台
 * 任务，凭 env.json 的网关跑，不该依赖用户系统 claude 的登录态。
 *
 * 归类只凭文件名（prompt 明令禁止读文件/用工具）：
 *  - 快：几百个文件 = 几次秒级无头调用，而读内容归类是分钟~小时级；
 *  - 稳：无工具 = 无权限请求 = 无头模式不会卡在审批上。
 * 图片文件名信息量低（IMG_1234…），靠 kindNote 把命名指纹提示给模型，
 * 归不出来的就落「其他」——诚实好过硬猜。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  buildKbClassifyPrompt,
  parseKbClassifyOutput,
  parseKbCatalog,
  parseKbCategories,
  sanitizeKbCategories,
  DEFAULT_KB_CATEGORIES,
  DEFAULT_KB_IMAGE_CATEGORIES,
  KB_FALLBACK_CATEGORY,
  KB_CATEGORY_NAME_MAX,
  KB_CATEGORY_COUNT_MAX,
  type KbCatalog,
  type KbCatalogDomain,
  type KbCatalogEntry,
  type KbCatalogStatus
} from '../../shared/kbCatalog'
import type { KbCategoriesUpdatePayload, KbCategoriesResult } from '../../shared/ipc-channels'
import { resolveBundledCliPath, resolveJsRuntimeBin } from './cliDetect'
import { kbLocalDir } from './kbIndexStore'
import { listLocalDocsDirs, scanLocalDocs, type LocalScanKind } from './localDocsScan'
import { broadcastKbCatalogStatus } from '../tabRegistry'

/** 每个域的静态差异面——加新域只动这张表。 */
const DOMAIN_CONFIG: Record<
  KbCatalogDomain,
  {
    indexFile: string
    categoriesFile: string
    defaults: readonly string[]
    scanKind: LocalScanKind
    kindNote?: string
  }
> = {
  docs: {
    indexFile: 'KB-INDEX.json',
    categoriesFile: 'KB-CATEGORIES.json',
    defaults: DEFAULT_KB_CATEGORIES,
    scanKind: 'docs'
  },
  images: {
    indexFile: 'KB-IMAGE-INDEX.json',
    categoriesFile: 'KB-IMAGE-CATEGORIES.json',
    defaults: DEFAULT_KB_IMAGE_CATEGORIES,
    scanKind: 'images',
    kindNote:
      '- 这批全是图片文件。命名指纹参考：Screenshot/CleanShot/截屏/SCR 开头多为截图；' +
      'IMG_/DSC/DCIM 开头多为照片；logo/icon/banner/poster 多为设计素材；' +
      'chart/diagram/流程图/架构图 多为图表配图。'
  }
}

/** 索引文件绝对路径（docs 域与 local-kb skill 的 kbpath.mjs 输出保持一致）。 */
export const kbCatalogPath = (domain: KbCatalogDomain = 'docs'): string =>
  join(kbLocalDir(), DOMAIN_CONFIG[domain].indexFile)

/**
 * 自定义类别文件（分类管理页的持久化）。放 ~/.cowork 而非 userData：对话里的
 * local-kb skill（用户机器裸进程）读不到 Electron userData，但 ~/.cowork 已在
 * 它的可读范围——docs 域的归类集合必须两个写手都触达得到（images 域目前只有
 * app 一个写手，同放一处保持对称）。
 */
export const kbCategoriesPath = (domain: KbCatalogDomain = 'docs'): string =>
  join(kbLocalDir(), DOMAIN_CONFIG[domain].categoriesFile)

/** 单批文件数。输出只是「类别→编号数组」，批大点也撑不爆输出 token。 */
const BATCH_SIZE = 200
/** 单批无头调用超时。冷启动 + 归类推理，普通批 <60s，翻倍兜底。 */
const BATCH_TIMEOUT_MS = 180_000

const statusByDomain = new Map<KbCatalogDomain, KbCatalogStatus>()
const runningByDomain = new Set<KbCatalogDomain>()

export function getKbCatalogStatus(domain: KbCatalogDomain = 'docs'): KbCatalogStatus {
  return statusByDomain.get(domain) ?? { phase: 'idle' }
}

function setStatus(domain: KbCatalogDomain, next: KbCatalogStatus): void {
  statusByDomain.set(domain, next)
  broadcastKbCatalogStatus({ domain, status: next })
}

/** 读某域当前索引。缺失/损坏 → null（UI 显示「还没建索引」CTA）。 */
export function readKbCatalog(domain: KbCatalogDomain = 'docs'): KbCatalog | null {
  let raw: string | null
  try {
    raw = readFileSync(kbCatalogPath(domain), 'utf8')
  } catch {
    return null
  }
  return parseKbCatalog(raw)
}

/* ───────────────────────── 自定义类别 ───────────────────────── */

/** 读某域当前生效的类别集合。文件缺失/损坏/空 → 该域出厂默认。 */
export function readKbCategories(domain: KbCatalogDomain = 'docs'): string[] {
  let raw: string | null
  try {
    raw = readFileSync(kbCategoriesPath(domain), 'utf8')
  } catch {
    raw = null
  }
  return parseKbCategories(raw) ?? [...DOMAIN_CONFIG[domain].defaults]
}

function writeKbCategories(domain: KbCatalogDomain, categories: string[]): void {
  mkdirSync(kbLocalDir(), { recursive: true })
  writeFileSync(
    kbCategoriesPath(domain),
    JSON.stringify({ version: 1, updatedAt: Date.now(), categories }, null, 2),
    'utf8'
  )
}

/**
 * 对某域索引里的条目做类别改写（rename/remove 的数据迁移）。返回改动条数。
 * 索引缺失/损坏 → 0（没有可迁移的东西不算错）。写回走 tmp+rename，
 * 与 rebuild 同一条原子写纪律。
 */
function migrateCatalogCategories(
  domain: KbCatalogDomain,
  map: (category: string) => string
): number {
  const catalog = readKbCatalog(domain)
  if (!catalog) return 0
  let changed = 0
  for (const e of catalog.entries) {
    const next = map(e.category)
    if (next !== e.category) {
      e.category = next
      e.indexedAt = Date.now()
      changed += 1
    }
  }
  if (changed === 0) return 0
  catalog.updatedAt = Date.now()
  const tmp = kbCatalogPath(domain) + '.tmp'
  writeFileSync(tmp, JSON.stringify(catalog, null, 2), 'utf8')
  renameSync(tmp, kbCatalogPath(domain))
  return changed
}

/**
 * 分类管理页的四种操作（add / rename / remove / move）。校验失败返回
 * error 文案（中文，UI 直接展示）而不抛——非法输入是常态不是异常。
 * rename/remove 同步迁移该域索引里的存量条目（migrated 条数带回
 * UI 提示）；「其他」是系统兜底，恒在末尾、不可删改不可移动。
 */
export function updateKbCategories(
  domain: KbCatalogDomain,
  payload: KbCategoriesUpdatePayload
): KbCategoriesResult {
  const categories = readKbCategories(domain)
  // 可编辑区 = 「其他」之外的前缀段（sanitize 保证「其他」恒在末尾）。
  const editable = categories.slice(0, -1)

  const validateName = (name: string): string | null => {
    if (!name) return '分类名不能为空'
    if (name.length > KB_CATEGORY_NAME_MAX) return `分类名最长 ${KB_CATEGORY_NAME_MAX} 个字`
    if (name === KB_FALLBACK_CATEGORY || editable.includes(name)) return '已有同名分类'
    return null
  }

  let migrated = 0
  switch (payload.action) {
    case 'add': {
      const name = payload.name.trim()
      const err = validateName(name)
      if (err) return { categories, migrated: 0, error: err }
      if (categories.length >= KB_CATEGORY_COUNT_MAX) {
        return { categories, migrated: 0, error: `最多 ${KB_CATEGORY_COUNT_MAX} 个分类` }
      }
      editable.push(name)
      break
    }
    case 'rename': {
      const from = payload.from
      const to = payload.to.trim()
      const idx = editable.indexOf(from)
      if (idx < 0) return { categories, migrated: 0, error: '要重命名的分类不存在' }
      if (to === from) return { categories, migrated: 0 }
      const err = validateName(to)
      if (err) return { categories, migrated: 0, error: err }
      editable[idx] = to
      migrated = migrateCatalogCategories(domain, (c) => (c === from ? to : c))
      break
    }
    case 'remove': {
      const idx = editable.indexOf(payload.name)
      if (idx < 0) return { categories, migrated: 0, error: '要删除的分类不存在' }
      editable.splice(idx, 1)
      // 被删类别的存量文件归「其他」——索引与集合必须保持一致，孤儿类别
      // 只应来自 agent 越界，不应来自我们自己的管理操作。
      migrated = migrateCatalogCategories(domain, (c) =>
        c === payload.name ? KB_FALLBACK_CATEGORY : c
      )
      break
    }
    case 'move': {
      const idx = editable.indexOf(payload.name)
      if (idx < 0) return { categories, migrated: 0, error: '分类不存在' }
      const to = payload.dir === 'up' ? idx - 1 : idx + 1
      if (to < 0 || to >= editable.length) return { categories, migrated: 0 }
      ;[editable[idx], editable[to]] = [editable[to]!, editable[idx]!]
      break
    }
  }

  const next = sanitizeKbCategories(editable)
  writeKbCategories(domain, next)
  return { categories: next, migrated }
}

/* ───────────────────────── 无头归类与重建 ───────────────────────── */

/** 一次 SDK 无头调用，返回 result 文本。超时/非 success 一律抛（调用方统一兜）。 */
async function runHeadlessClassify(prompt: string): Promise<string> {
  const cliPath = resolveBundledCliPath()
  // bundled CLI 是原生二进制时不需要 node；若被 FUSION_CODE_CLI_PATH 指到 .js
  // 入口则镜像 engine 的做法用自带 node 跑（见 cliDetect.resolveJsRuntimeBin）。
  const jsRuntimeBin = /\.m?js$/i.test(cliPath) ? resolveJsRuntimeBin() : null
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), BATCH_TIMEOUT_MS)
  try {
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        ...(jsRuntimeBin ? { executable: jsRuntimeBin as 'node' } : {}),
        // cwd 用知识库目录：无工具任务不依赖 cwd，但它必须存在（rebuild 入口
        // 已 mkdir）；绝不用用户工作区——无头任务不该出现在任何会话语境里。
        cwd: kbLocalDir(),
        abortController: ac,
        // 归类是纯文本单发任务；给 3 轮余量（模型偶尔先自言自语一轮再答），
        // 但 prompt 已明令禁止工具，正常一轮就 success。
        maxTurns: 3
      }
    })
    for await (const msg of q) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') return msg.result
        throw new Error(`无头归类调用失败（${msg.subtype}）`)
      }
    }
    throw new Error('无头归类调用没有产生结果')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 全量重建某域索引。互斥按域独立（文档与图片可并行跑，各自一个子进程）。
 * 立即返回 'started'，进度与结果走 KB_CATALOG_STATUS 广播——invoke 不 await
 * 几分钟的长任务（窗口关掉/刷新也不影响后台跑完）。
 */
export function rebuildKbCatalog(
  domain: KbCatalogDomain = 'docs'
): 'started' | 'alreadyRunning' {
  if (runningByDomain.has(domain)) return 'alreadyRunning'
  runningByDomain.add(domain)
  const cfg = DOMAIN_CONFIG[domain]
  void (async () => {
    try {
      setStatus(domain, { phase: 'scanning' })
      const scan = await scanLocalDocs(true, cfg.scanKind)
      if (!scan.ok) throw new Error(scan.error ?? '目录扫描失败')

      // 目录路径 → 展示名（prompt 里给「所在文件夹」当归类线索）。
      const dirLabel = new Map<string, string>()
      for (const d of listLocalDocsDirs()) dirLabel.set(d.path, d.label)

      const files = scan.files
      const total = files.length
      setStatus(domain, { phase: 'classifying', done: 0, total })

      // 归类用【该域当前生效的自定义类别集合】（分类管理页维护，末位恒
      // 「其他」）。任务开始时读一次快照——中途改类别不影响本次运行。
      const activeCategories = readKbCategories(domain)
      const assigned: string[] = []
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE)
        const prompt = buildKbClassifyPrompt(
          batch.map((f) => ({
            name: f.name,
            dirLabel: dirLabel.get(f.source) ?? basename(f.source)
          })),
          activeCategories,
          cfg.kindNote
        )
        const out = await runHeadlessClassify(prompt)
        const parsed = parseKbClassifyOutput(out, batch.length, activeCategories)
        // 单批解析彻底失败 → 整体失败并保留旧索引。不静默把整批塞「其他」：
        // 那会产出一份看起来成功、实际全错的索引，比明着失败更坑。
        if (!parsed) throw new Error('归类结果解析失败，请重试')
        assigned.push(...parsed)
        setStatus(domain, {
          phase: 'classifying',
          done: Math.min(i + batch.length, total),
          total
        })
      }

      // 保留旧索引里写过的一句话概览（docs 域来自对话 agent 的「添加到知识
      // 库」）；类别以本次归类为准——全量重建就是重新归类。
      const oldSummary = new Map<string, string>()
      for (const e of readKbCatalog(domain)?.entries ?? []) {
        if (e.summary) oldSummary.set(e.path, e.summary)
      }

      const now = Date.now()
      const entries: KbCatalogEntry[] = files.map((f, i) => ({
        path: f.absPath,
        name: f.name,
        ext: f.ext,
        category: assigned[i] ?? KB_FALLBACK_CATEGORY,
        summary: oldSummary.get(f.absPath) ?? '',
        size: f.size,
        mtimeMs: f.mtimeMs,
        indexedAt: now
      }))
      const catalog: KbCatalog = { version: 1, updatedAt: now, entries }

      // 写盘：先 tmp 再 rename——对话里的 local-kb skill 可能随时读这份文件，
      // 不能让它读到半截 json。
      mkdirSync(kbLocalDir(), { recursive: true })
      const tmp = kbCatalogPath(domain) + '.tmp'
      writeFileSync(tmp, JSON.stringify(catalog, null, 2), 'utf8')
      renameSync(tmp, kbCatalogPath(domain))

      setStatus(domain, { phase: 'success', fileCount: entries.length, at: Date.now() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[kb-catalog] rebuild(${domain}) failed:`, message)
      setStatus(domain, { phase: 'error', message, at: Date.now() })
    } finally {
      runningByDomain.delete(domain)
    }
  })()
  return 'started'
}
