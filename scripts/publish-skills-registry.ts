import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import {
  parseMarketRegistry,
  marketRemoteDirFor,
  MARKET_SAFE_ID,
  SkillManifestSchema,
  type MarketCategory,
  type MarketEntry,
  type MarketRegistry
} from '../packages/contracts/src/skills-market.ts'

// 技能市场 registry 发布脚本 —— 对 gitee 仓库工作副本跑，生成根部
// registry.json（客户端唯一入口）。用法：
//
//   bun scripts/publish-skills-registry.ts --dir <gitee 仓库副本> --now $(date +%s000)
//
// 仓库布局约定（apps/daemon/src/skills-market/market.ts 按同一约定下载，
// 完整说明见 packages/contracts/src/skills-market.ts 头注释）。2026-07-17
// 分家：技能与插件不再共用一个 `skills/` 前缀，manifest.kind 决定条目该放
// 进 `<dir>/skills/` 还是 `<dir>/plugins/`（marketRemoteDirFor 是唯一映射
// 源，本脚本会用它校验条目放没放错目录）：
//
//   <dir>/registry.json                        ← 本脚本产物，客户端唯一入口
//   <dir>/categories.json                      ← 可选：[{id,title,order}]，缺省从条目聚合
//   <dir>/skills/<id>/manifest.json            ← kind=skill 条目，市场展示元数据（SkillManifestSchema）
//   <dir>/skills/<id>/README.md                ← 建议提供，技能弹层/详情页展示
//   <dir>/skills/<id>/assets/icon.png          ← manifest.interface.composerIcon 指向的文件
//   <dir>/skills/<id>/assets/logo.png          ← manifest.interface.logo 指向的文件（可选）
//   <dir>/skills/<id>/skills/<subid>/SKILL.md  ← 真正喂给 CLI 的技能内容，至少一个
//   <dir>/plugins/<id>/...                     ← kind=plugin 条目，结构同上
//
// manifest.json 里的 `name` 字段必须等于目录名 `<id>`（一致性检查，避免
// 目录名和声明名对不上造成困惑）；`skills` 字段固定 "./skills/"（schema 用
// z.literal 卡死，写错直接拒收）；`kind` 必须与所在前缀目录一致（skills/ 下
// 必须 kind=skill，plugins/ 下必须 kind=plugin——放错目录直接报错，不静默
// 归类）。两个前缀目录下的 id 全局去重（同一 id 不能同时出现在两边）。
//
// 规矩沿用 publish-kb-manifest.ts：时间戳外部传入（脚本不调 Date.now）、
// tmp+rename 原子落盘（客户端任何时刻读到的都是完整 JSON）。

// gitee raw 匿名访问对大文件（约 >1MiB）可能要求登录——发布期硬卡，
// 比用户安装时 502 好定位得多。
const MAX_FILE_BYTES = 1 * 1024 * 1024

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!
  throw new Error(`缺少参数 --${name}`)
}

const dir = arg('dir')
const generatedAtMs = Number(arg('now'))
if (!Number.isFinite(generatedAtMs)) throw new Error('--now 必须是毫秒时间戳')

const PREFIX_DIRS = ['skills', 'plugins'] as const
const prefixRoots = PREFIX_DIRS.map((name) => ({ name, path: join(dir, name) })).filter((p) =>
  existsSync(p.path)
)
if (prefixRoots.length === 0) {
  throw new Error(`${join(dir, 'skills')} 与 ${join(dir, 'plugins')} 都不存在——仓库布局应至少有其中一个`)
}

/** 构建/缓存产物：不是条目内容，是「作者本机跑过一次脚本」的残留。dotfile
 * 已在 walk 里跳过，这些偏偏不带点号，所以要单列。不排掉的话，任何带 python
 * 脚本的条目只要发布前有人跑过它，`__pycache__/*.pyc` 就会进 files 清单——
 * 二进制、跟本机 python 版本绑定、对用户零价值，还得白下一遍。仓库的
 * .gitignore 挡不住这里：本函数读的是文件系统，不是 git 索引。 */
const IGNORED_DIRS = new Set(['__pycache__', 'node_modules', '__MACOSX'])
const IGNORED_FILE_SUFFIXES = ['.pyc', '.pyo']

/** 递归收整个条目目录下的全部文件（manifest.json、README.md、assets 与 skills
 * 两个子目录下的一切），排除 dotfile/dotdir 与上面的构建产物——剩下的原样
 * 下发，daemon 装到本地时就是这份拷贝。 */
function collectFiles(skillDir: string): MarketEntry['files'] {
  const out: MarketEntry['files'] = []
  const walk = (cur: string) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const full = join(cur, ent.name)
      if (ent.isDirectory()) {
        // .egg-info 是后缀不是固定名（<pkg>.egg-info），只能后缀匹配
        if (IGNORED_DIRS.has(ent.name) || ent.name.endsWith('.egg-info')) continue
        walk(full)
        continue
      }
      if (!ent.isFile()) continue
      if (IGNORED_FILE_SUFFIXES.some((s) => ent.name.endsWith(s))) continue
      const rel = relative(skillDir, full).split('\\').join('/')
      const bytes = readFileSync(full)
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new Error(`${rel} 超过单文件上限 ${MAX_FILE_BYTES} 字节（gitee raw 匿名拉不动大文件），请瘦身或改走外链`)
      }
      out.push({
        path: rel,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength
      })
    }
  }
  walk(skillDir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function hasAnySkillMd(skillsSubdir: string): boolean {
  if (!existsSync(skillsSubdir)) return false
  return readdirSync(skillsSubdir, { withFileTypes: true }).some(
    (ent) => ent.isDirectory() && existsSync(join(skillsSubdir, ent.name, 'SKILL.md'))
  )
}

const entries: MarketEntry[] = []
const seenIds = new Set<string>()
for (const { name: prefixName, path: prefixRoot } of prefixRoots) {
  for (const ent of readdirSync(prefixRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    const id = ent.name
    if (!MARKET_SAFE_ID.test(id)) throw new Error(`目录名不合法（须匹配 ${MARKET_SAFE_ID}）：${prefixName}/${id}`)
    if (seenIds.has(id)) throw new Error(`id 重复：${id} 同时出现在 skills/ 与 plugins/ 下`)
    seenIds.add(id)
    const skillDir = join(prefixRoot, id)

    const manifestPath = join(skillDir, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error(`${prefixName}/${id}/ 缺少 manifest.json`)
    const manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const manifestParsed = SkillManifestSchema.safeParse(manifestRaw)
    if (!manifestParsed.success) {
      throw new Error(`${prefixName}/${id}/manifest.json 不合法：${manifestParsed.error.issues.map((i) => i.message).join('; ')}`)
    }
    const manifest = manifestParsed.data
    if (manifest.name !== id) {
      throw new Error(`${prefixName}/${id}/manifest.json 的 name（"${manifest.name}"）必须和目录名一致`)
    }
    if (marketRemoteDirFor(manifest.kind) !== prefixName) {
      throw new Error(
        `${prefixName}/${id}/manifest.json 的 kind（"${manifest.kind}"）应放进 ${marketRemoteDirFor(manifest.kind)}/ 目录，不是 ${prefixName}/`
      )
    }
    if (!hasAnySkillMd(join(skillDir, 'skills'))) {
      throw new Error(`${prefixName}/${id}/skills/ 下没有任何 <subid>/SKILL.md——这个条目装完 CLI 加载不到任何技能`)
    }
    for (const relPath of [manifest.interface.composerIcon, manifest.interface.logo, ...manifest.interface.screenshots]) {
      if (relPath && !existsSync(join(skillDir, relPath))) {
        throw new Error(`${prefixName}/${id}/manifest.json 引用的资源文件不存在：${relPath}`)
      }
    }

    const files = collectFiles(skillDir)
    const entry: MarketEntry = {
      id,
      kind: manifest.kind,
      name: manifest.name,
      displayName: manifest.interface.displayName,
      description: manifest.description,
      version: manifest.version,
      keywords: manifest.keywords,
      featured: manifest.featured,
      capabilities: manifest.interface.capabilities,
      defaultPrompt: manifest.interface.defaultPrompt,
      screenshots: manifest.interface.screenshots,
      files,
      totalSize: files.reduce((s, f) => s + f.size, 0)
    }
    if (manifest.interface.longDescription) entry.longDescription = manifest.interface.longDescription
    if (manifest.author) entry.author = manifest.author
    if (manifest.interface.developerName) entry.developerName = manifest.interface.developerName
    if (manifest.homepage) entry.homepage = manifest.homepage
    if (manifest.repository) entry.repository = manifest.repository
    if (manifest.license) entry.license = manifest.license
    if (manifest.interface.category) entry.category = manifest.interface.category
    if (manifest.interface.websiteURL) entry.websiteURL = manifest.interface.websiteURL
    if (manifest.interface.privacyPolicyURL) entry.privacyPolicyURL = manifest.interface.privacyPolicyURL
    if (manifest.interface.termsOfServiceURL) entry.termsOfServiceURL = manifest.interface.termsOfServiceURL
    if (manifest.interface.composerIcon) entry.composerIcon = manifest.interface.composerIcon
    if (manifest.interface.logo) entry.logo = manifest.interface.logo
    if (manifest.interface.brandColor) entry.brandColor = manifest.interface.brandColor
    entries.push(entry)
  }
}
entries.sort((a, b) => a.id.localeCompare(b.id))

// 分类表：repo 根 categories.json 优先，缺省从条目聚合（id 即 title）
let categories: MarketCategory[]
const categoriesPath = join(dir, 'categories.json')
if (existsSync(categoriesPath)) {
  categories = JSON.parse(readFileSync(categoriesPath, 'utf8'))
} else {
  const ids = [...new Set(entries.map((e) => e.category).filter((c): c is string => !!c))]
  categories = ids.map((id, i) => ({ id, title: id, order: i + 1 }))
}

const registry: MarketRegistry = { schemaVersion: 2, generatedAtMs, categories, entries }

// 出厂前用与客户端完全相同的解析器自检——脚本产出的清单不可能被客户端拒收
if (!parseMarketRegistry(JSON.parse(JSON.stringify(registry)))) {
  throw new Error('自检失败：生成的 registry 没通过 parseMarketRegistry（schema/路径安全校验）')
}

const tmp = join(dir, '.registry.json.tmp')
writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
renameSync(tmp, join(dir, 'registry.json'))
console.log(`registry.json → ${join(dir, 'registry.json')}（${entries.length} 条目）`)
for (const e of entries) {
  const sizeKb = Math.ceil(e.totalSize / 1024)
  console.log(`  ${e.kind === 'plugin' ? '插件' : '技能'}  ${e.id}@${e.version}  ${e.files.length} 文件 / ${sizeKb}KB`)
}
