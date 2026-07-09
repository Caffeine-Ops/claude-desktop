/**
 * 本地知识库索引 KB-INDEX.json 的 schema 与解析（shared 纯函数，main 负责读写
 * 文件）。取代早期的 KB-INDEX.md——md 是给人看的追加日志，做不了「按类别统计 /
 * 结构化查询」；json 才承载得动「文档识别」分类卡片页。
 *
 * 索引有两个写手，schema 必须同时伺候：
 *  1. main 的 kbCatalogService（「更新知识库」按钮）：扫授权目录 → SDK 无头归类
 *     → 全量重建。字段填得全（size/mtime 来自 stat）。
 *  2. 对话里的 local-kb skill（「添加到知识库」菜单）：agent 读单个文件、写概览、
 *     upsert 一条。agent 不方便拿 stat——size/mtimeMs 允许缺省（解析补 0）。
 *
 * 类别是【可自定义集合】（分类管理页），持久化在 `~/.cowork/KB-CATEGORIES.json`
 * ——与索引同目录，这样对话里的 skill（用户机器裸进程，读不到 Electron userData）
 * 也触达得到。DEFAULT_KB_CATEGORIES 只是出厂默认；线协议函数一律接收调用方传入
 * 的当前集合，不再钉死。「其他」是系统级兜底：恒存在、恒在末尾、不可删改。
 *
 * 防御解析哲学同 parseKbConfig：任何残缺退安全值、绝不抛；单条坏 entry 丢弃
 * 不连坐整份索引（agent 手写 json 难免出格式偏差）。
 */

/** 兜底类别：归类永远全覆盖，不存在"未分类"状态。系统级，不可删/改名/移动。 */
export const KB_FALLBACK_CATEGORY = '其他'

/**
 * 归类域：文档与图片各自一套 索引 / 类别集合 / 重建任务（文件名、默认类别、
 * UI 页面全部按域隔离），但共用同一套 schema / 解析 / 线协议 / 管理操作——
 * 同构的第二份数据，不是第二套代码。
 */
export type KbCatalogDomain = 'docs' | 'images'

/**
 * 出厂默认类别（打工人视角）。用户没自定义过（KB-CATEGORIES.json 缺失/损坏）
 * 时的集合——改这里要同步 skills/local-kb/SKILL.md 里的默认清单（skill 是给
 * agent 读的文本，import 不到这个常量）。
 */
export const DEFAULT_KB_CATEGORIES: readonly string[] = [
  '数据报表', // 工资表、付款模板、csv 导出、统计台账
  '财务票据', // 打款凭证、发票、报销单
  '合同协议', // 合同、授权书、委托函、license
  '汇报演示', // PPT、pitch、汇报材料
  '报告方案', // 审查/审计报告、建设方案、白皮书
  '学习资料', // 教程、技术文档、笔记、课件
  '人事行政', // 简历、offer、绩效、行政通知
  KB_FALLBACK_CATEGORY
]

/**
 * 图片域的出厂默认类别。图片文件名信息量低于文档（IMG_1234 / CleanShot …），
 * 类别刻意按「命名模式可辨」的维度设计——截图/照片有极强的文件名指纹，
 * 归类 prompt 的 kindNote 会把这些指纹提示给模型。
 */
export const DEFAULT_KB_IMAGE_CATEGORIES: readonly string[] = [
  '截图', // Screenshot / CleanShot / 截屏 / SCR / snip
  '照片', // IMG_ / DSC / DCIM / 相机与手机导出
  '设计素材', // logo / icon / banner / poster / 切图导出
  '图表配图', // chart / diagram / 流程图 / 架构图 / 数据图
  '证件票据', // 证件照 / 发票凭证扫描件 / 合同页拍照
  '表情梗图', // meme / 表情包 / 沙雕图
  KB_FALLBACK_CATEGORY
]

/** 自定义类别的硬约束：单名长度与总数上限（防爆归类 prompt 与 UI）。 */
export const KB_CATEGORY_NAME_MAX = 12
export const KB_CATEGORY_COUNT_MAX = 20

/**
 * 规整一份类别列表：过滤非串/空串/超长、trim、去重、剔除「其他」后恒补到
 * 末尾、截断到数量上限。KB-CATEGORIES.json 的解析与分类管理页的写入共用。
 */
export function sanitizeKbCategories(list: unknown): string[] {
  const out: string[] = []
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item !== 'string') continue
      const name = item.trim()
      if (!name || name === KB_FALLBACK_CATEGORY) continue
      if (name.length > KB_CATEGORY_NAME_MAX) continue
      if (out.includes(name)) continue
      out.push(name)
      if (out.length >= KB_CATEGORY_COUNT_MAX - 1) break
    }
  }
  out.push(KB_FALLBACK_CATEGORY)
  return out
}

/**
 * 解析 KB-CATEGORIES.json 文本。缺失/损坏/空列表 → null（调用方回退
 * DEFAULT_KB_CATEGORIES）。「空列表 = null」是刻意的：只剩「其他」一个类别的
 * 集合没有归类价值，视同未配置。
 */
export function parseKbCategories(raw: string | null): string[] | null {
  if (!raw) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const cats = sanitizeKbCategories((obj as Record<string, unknown>).categories)
  return cats.length > 1 ? cats : null
}

export interface KbCatalogEntry {
  /** 文件绝对路径（条目主键，upsert 按它去重）。 */
  path: string
  /** 文件名（含扩展名）。 */
  name: string
  /** 小写扩展名（不带点）。 */
  ext: string
  /**
   * 类别名（自定义集合的成员）。解析层保留任意非空字符串——集合此刻长什么样
   * 是消费方（归类/渲染）才知道的事；不在集合里的孤儿类别由 UI 诚实展示。
   */
  category: string
  /** 一句话概览。全量归类不读内容填 ''；skill 单文件添加时 agent 写。 */
  summary: string
  /** stat 元数据。skill 写手拿不到时缺省 0。 */
  size: number
  mtimeMs: number
  /** 本条目最后写入时间（epoch ms）。 */
  indexedAt: number
}

export interface KbCatalog {
  version: 1
  /** 整份索引最后一次全量重建/追加的时间（epoch ms）。 */
  updatedAt: number
  entries: KbCatalogEntry[]
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 解析 KB-INDEX.json 文本。文件缺失/整体损坏 → null（UI 显示「还没建索引」CTA）；
 * 单条残缺 → 丢那一条继续。同 path 后写覆盖先写（agent 追加式 upsert 的容错）。
 */
export function parseKbCatalog(raw: string | null): KbCatalog | null {
  if (!raw) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  const rawEntries = Array.isArray(o.entries) ? o.entries : []
  const byPath = new Map<string, KbCatalogEntry>()
  for (const item of rawEntries) {
    if (typeof item !== 'object' || item === null) continue
    const e = item as Record<string, unknown>
    const path = typeof e.path === 'string' && e.path.length > 0 ? e.path : null
    if (!path) continue
    const fallbackName = path.split('/').pop() ?? path
    const name = typeof e.name === 'string' && e.name.length > 0 ? e.name : fallbackName
    const dot = name.lastIndexOf('.')
    const fallbackExt = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    const rawCategory = typeof e.category === 'string' ? e.category.trim() : ''
    byPath.set(path, {
      path,
      name,
      ext: typeof e.ext === 'string' && e.ext.length > 0 ? e.ext.toLowerCase() : fallbackExt,
      category: rawCategory || KB_FALLBACK_CATEGORY,
      summary: typeof e.summary === 'string' ? e.summary : '',
      size: num(e.size),
      mtimeMs: num(e.mtimeMs),
      indexedAt: num(e.indexedAt)
    })
  }
  return {
    version: 1,
    updatedAt: num(o.updatedAt),
    entries: [...byPath.values()]
  }
}

/**
 * 「更新知识库」后台任务的状态机（main → renderer push，仿 KbSyncStatus）。
 * classifying 的 done/total 按【文件数】计——用户关心"归类到哪了"，不关心批次。
 */
export type KbCatalogStatus =
  | { phase: 'idle' }
  | { phase: 'scanning' }
  | { phase: 'classifying'; done: number; total: number }
  | { phase: 'success'; fileCount: number; at: number }
  | { phase: 'error'; message: string; at: number }

/* ─────────────── 无头归类的线协议（纯函数，bun 可测） ─────────────── */

/**
 * 组一批文件的归类 prompt。只给编号 + 文件名 + 来源位置——刻意不给完整路径、
 * 不让读文件：归类依据就是文件名语义，几百个文件一次 SDK 无头调用秒级返回；
 * 读内容归类是另一个量级的任务（也用不着——文件名对打工人文档几乎恒等价于
 * 内容类别）。输出要求「类别 → 编号数组」而非逐条对象：几百条输出只有几行
 * 数字，省 token 也省解析。`categories` 是当前生效的自定义集合（末位恒「其他」）。
 */
export function buildKbClassifyPrompt(
  files: ReadonlyArray<{ name: string; dirLabel: string }>,
  categories: readonly string[],
  /** 域特定提示（如图片域的文件名指纹说明），拼在规则之后。缺省无。 */
  kindNote?: string
): string {
  const lines = files.map((f, i) => `${i + 1}. ${f.name}（${f.dirLabel}）`)
  return (
    '你是文件归类助手。下面是一批带编号的文件（文件名 + 所在文件夹）。把每个编号归入且仅归入以下类别之一：\n' +
    categories.join('、') +
    '\n\n规则：\n' +
    '- 只凭文件名/扩展名/所在文件夹判断，不要读取任何文件、不要调用任何工具。\n' +
    `- 拿不准的编号一律归「${KB_FALLBACK_CATEGORY}」。\n` +
    '- 每个编号必须出现且只出现一次。\n' +
    '- 直接输出一个 JSON 对象（不要 markdown 代码块、不要任何解释文字）：键是类别名，值是编号数组。\n' +
    (kindNote ? `${kindNote}\n` : '') +
    '\n文件清单：\n' +
    lines.join('\n')
  )
}

/**
 * 解析归类输出为「按输入顺序的类别数组」（长度恒等于 count）。全防御：
 * code fence 剥壳、JSON 提取（首个 { 到末个 }）、不在 `categories` 里的类别名
 * /越界编号丢弃、AI 漏掉的编号补「其他」。解析彻底失败返回 null（调用方按批
 * 失败处理），而部分残缺不失败——宁可个别文件归「其他」也不废掉整批。
 */
export function parseKbClassifyOutput(
  text: string,
  count: number,
  categories: readonly string[]
): string[] | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj: unknown
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const valid = new Set(categories)
  const result: string[] = new Array<string>(count).fill(KB_FALLBACK_CATEGORY)
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (!valid.has(key) || !Array.isArray(value)) continue
    for (const n of value) {
      const idx = typeof n === 'number' ? n - 1 : Number.parseInt(String(n), 10) - 1
      if (Number.isInteger(idx) && idx >= 0 && idx < count) {
        result[idx] = key
      }
    }
  }
  return result
}
