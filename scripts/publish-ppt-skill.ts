import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'

/**
 * ppt-creator skill 发布脚本 —— 把仓库里的 skill 目录打成客户端可下载的 zip
 * 加一份校验清单。用法：
 *
 *   bun scripts/publish-ppt-skill.ts --out <输出目录> --version 1.0.0
 *   （可选 --skill-dir <路径>，默认 skills-src/ppt-creator）
 *
 * 为什么源码住在 `skills-src/` 而不是 `skills/`：`skills/` 是**打进安装包的
 * 内置插件根**（它的 .claude-plugin/plugin.json 把每个子目录暴露成
 * `claude-desktop:<name>`）。这个 skill 已改为按需下载，留在那儿会让 dev
 * 环境凭空多出一个 `/claude-desktop:ppt-creator`，与下载装的
 * `/cowork:ppt-creator` 并存——dev 于是永远测不出真实用户的未安装状态。
 * 换个目录就让「不打包」从一条容易失效的过滤规则变成目录位置本身的属性。
 *
 * 为什么是**整包 zip 而不是市场那套逐文件下载**：这个 skill 有 12175 个文件
 * （其中 templates/icons 一家就 11633 个）。市场下载器并发 3、每文件一次
 * HTTP，光 RTT 就是 4000 多轮，装一次要十几分钟；打成一个 zip 是一次请求。
 * 代价是失去逐文件增量更新——对一个整体发布、整体替换的 skill 来说无所谓。
 *
 * zip 内部结构直接对齐 cowork 插件布局（见 electron/main/core/skillsDir.ts
 * 的 resolveCoworkPluginEntries）：
 *
 *   skills/<id>/SKILL.md, scripts/, templates/, ...
 *
 * 客户端解压到 `~/.cowork/plugins/<id>/` 并补写 `.claude-plugin/plugin.json`
 * （name 恒为 "cowork"），于是 fusion-code 把它暴露成 `/cowork:<id>`。
 * **plugin.json 不进 zip**：它是安装器的产物而非 skill 内容，由客户端与
 * daemon 用同一份模板生成，避免两处各写一份迟早漂移。
 *
 * 时间戳外部传入、tmp 落盘、产物自校验——规矩沿用 publish-skills-registry.ts。
 */

/**
 * adm-zip 是 apps/studio 的依赖（客户端解压用的就是它，打包与解压同库行为一致），
 * 本脚本住在仓库根的 scripts/ 下解析不到——从 studio 的 package.json 出发解析，
 * 而不是往根 package.json 里再加一份依赖。
 */
const studioRequire = createRequire(
  new URL('../apps/studio/package.json', import.meta.url).pathname
)
interface AdmZipEntry {
  header: { time: Date }
}
interface AdmZipInstance {
  addFile(entryName: string, data: Buffer): void
  getEntries(): AdmZipEntry[]
  toBuffer(): Buffer
}
const AdmZip = studioRequire('adm-zip') as new () => AdmZipInstance

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null
}

const outDir = arg('out')
if (!outDir) throw new Error('缺少参数 --out <输出目录>')
const version = arg('version')
if (!version) throw new Error('缺少参数 --version <版本号，如 1.0.0>')
if (!/^[\w.-]{1,64}$/.test(version)) throw new Error(`版本号不合法：${version}`)

const repoRoot = new URL('..', import.meta.url).pathname
const skillDir = arg('skill-dir') ?? join(repoRoot, 'skills-src', 'ppt-creator')
if (!existsSync(skillDir)) {
  throw new Error(`skill 目录不存在：${skillDir}（可用 --skill-dir 指定其他位置）`)
}
/** zip 内的 skill 目录名 == 安装后的 subid == 斜杠命令名（/cowork:<id>）。 */
const skillId = arg('id') ?? 'ppt-creator'
if (!/^[a-z0-9][a-z0-9._-]*$/.test(skillId)) throw new Error(`skill id 不合法：${skillId}`)

/** 构建/缓存残留，与 publish-skills-registry.ts 的排除清单保持一致。 */
const IGNORED_DIRS = new Set(['__pycache__', 'node_modules', '__MACOSX'])
const IGNORED_FILE_SUFFIXES = ['.pyc', '.pyo']

interface Collected {
  /** 相对 skill 根的 POSIX 路径 */
  rel: string
  abs: string
  size: number
}

function collect(root: string): Collected[] {
  const out: Collected[] = []
  const walk = (cur: string): void => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const full = join(cur, ent.name)
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name) || ent.name.endsWith('.egg-info')) continue
        walk(full)
        continue
      }
      if (!ent.isFile()) continue
      if (IGNORED_FILE_SUFFIXES.some((s) => ent.name.endsWith(s))) continue
      out.push({
        rel: relative(root, full).split('\\').join('/'),
        abs: full,
        size: statSync(full).size
      })
    }
  }
  walk(root)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

const files = collect(skillDir)
if (files.length === 0) throw new Error(`${skillDir} 下没有可打包的文件`)
if (!files.some((f) => f.rel === 'SKILL.md')) {
  // 没有 SKILL.md 的目录装到插件根下 fusion-code 也加载不到任何东西——
  // 与其让用户装完发现命令不存在，不如发布期就拒掉。
  throw new Error(`${skillDir}/SKILL.md 不存在——这个包装完 CLI 加载不到任何技能`)
}

/**
 * 所有条目钉死同一个时间戳，让打包**可重现**：同样的源码打多少次，产出的
 * zip 字节与 sha256 都一致。
 *
 * 不这么做的话 adm-zip 会把「当前时间」写进每个条目的头部，于是同一份源码
 * 每打一次就换一个 sha256——既没法通过重新打包验证「服务器上那个包确实来自
 * 这份源码」，重复发布同一版本时对不上的校验值也只会让人怀疑是不是传坏了。
 *
 * 取 1980-01-01：zip 的 DOS 时间戳纪元起点，是这个格式能表示的最早时刻。
 * 这也不违反「脚本不调 Date.now」的约定——它是常量，不是当前时间。
 */
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1, 0, 0, 0))

const zip = new AdmZip()
for (const f of files) {
  // zip 内路径统一 `skills/<id>/...`，与 cowork 插件布局一一对应。
  zip.addFile(`skills/${skillId}/${f.rel}`, readFileSync(f.abs))
}
for (const entry of zip.getEntries()) entry.header.time = ZIP_EPOCH
const buffer = zip.toBuffer()
const sha256 = createHash('sha256').update(buffer).digest('hex')
const unpackedSize = files.reduce((s, f) => s + f.size, 0)

mkdirSync(outDir, { recursive: true })
const zipName = `${skillId}-${version}.zip`
writeFileSync(join(outDir, zipName), buffer)

/**
 * 客户端拉的清单。两种部署形态都支持：
 *
 *   - **同目录**（自建静态源/CDN）：只有 `file`，客户端拼 `<base>/<file>`。
 *   - **异地** （如 Gitee Release 附件）：额外带 `url` 绝对地址，客户端优先用它。
 *     Gitee 的公开仓库 raw 文件**超过 10MB 就要求认证**，49MB 的包只能走
 *     Release 附件；而附件地址里带一个上传后才分配的 ID
 *     （`/attach_files/<ID>/download/<name>`），无法由 base 拼出来——`url`
 *     字段就是为这种「清单和包不在同一处」的托管方式留的。
 */
const manifest: Record<string, unknown> = {
  id: skillId,
  version,
  file: zipName,
  sha256,
  /** zip 字节数，用于下载进度条与磁盘预检 */
  size: buffer.byteLength,
  /** 解压后字节数，磁盘空间预检用（zip 大小会严重低估占用） */
  unpackedSize,
  fileCount: files.length
}
// --url 传了就写进清单（部署到 Release 附件/对象存储时用），不传则省略该字段，
// 客户端回落到 `<base>/<file>` 的同目录拼接。
const absoluteUrl = arg('url')
if (absoluteUrl) manifest.url = absoluteUrl
writeFileSync(join(outDir, `${skillId}.json`), `${JSON.stringify(manifest, null, 2)}\n`)

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`
console.log(`${zipName} → ${join(outDir, zipName)}`)
console.log(`  ${files.length} 文件 / 压缩 ${mb(buffer.byteLength)} / 解压后 ${mb(unpackedSize)}`)
console.log(`  sha256 ${sha256}`)
console.log(`${skillId}.json → ${join(outDir, `${skillId}.json`)}`)
