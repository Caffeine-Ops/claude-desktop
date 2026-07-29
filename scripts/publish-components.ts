import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

import { inspectExecutable } from '../apps/studio/electron/shared/binaryIntegrity.ts'
import type {
  ComponentArtifact,
  ComponentEntry,
  ComponentPlatform,
  ComponentSource,
  ComponentsManifest
} from '../apps/studio/electron/shared/runtimeComponents.ts'

/**
 * 运行时组件发布脚本 —— 把 CLI 二进制与 python-runtime 打成客户端可下载的产物
 * 加一份校验清单。
 *
 * 两种模式：
 *
 *   # 单平台打包（CI 的每条矩阵腿各跑一次，或本机手工跑）
 *   bun scripts/publish-components.ts --platform darwin-arm64 --out out-components \
 *     --cli <可执行文件> --cli-version 2.1.212 --cli-source official \
 *     --python <tar.gz> --python-version 3.12.13
 *
 *   # 合并三份分片成最终清单
 *   bun scripts/publish-components.ts --merge out-components
 *
 * ── 为什么 CLI 要预压缩成 .gz ──
 * 自建源出口带宽实测约 1.1MB/s 且**所有用户共享**。CLI 二进制 233MB 裸传要
 * 3.5 分钟（单用户独占时），gzip 后约 80MB（实测压缩率 34.2%）只要 80 秒。
 * 在这个带宽下压缩不是优化，是可行性的前提。
 *
 * 用 `gzip -9 -n` 的等价实现（`-n` = 不写文件名与时间戳）保证**可重现**：
 * 同一份输入永远产出同一串字节，同一个 sha256。规矩沿用 publish-ppt-skill.ts
 * 钉 ZIP_EPOCH 的做法。
 *
 * ── 为什么 python 不重新压 ──
 * 上游 python-build-standalone 本来就是 .tar.gz。而且它里面有 9 个符号链接
 * （bin/python3 → python3.12）和一堆 mode 位，**必须用 tar 保留**——换成 zip
 * 走 adm-zip 会把 symlink 写成内容是路径字符串的普通文件，解出来是个跑不动的
 * runtime。原样透传，客户端 shell out 到系统 tar。
 *
 * ── 发布前的结构走查 ──
 * 算 sha256 **之前**先跑 inspectExecutable。这是唯一能挡住「把一份截断产物连同
 * 它自己的 sha 一起发布出去」的地方：那一刻还没有可信的基准，sha 正是此时算的。
 * 历史事故 errors/2026-05-23-fusion-code-cli截断致spawn-88.md 就是这个形状。
 */

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null
}

const PLATFORMS: ComponentPlatform[] = ['darwin-arm64', 'darwin-x64', 'win32-x64']

function assertPlatform(p: string): ComponentPlatform {
  if (!PLATFORMS.includes(p as ComponentPlatform)) {
    throw new Error(`--platform 必须是 ${PLATFORMS.join(' / ')}，收到：${p}`)
  }
  return p as ComponentPlatform
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** gzip 到目标路径，返回压缩后字节数。 */
async function gzipTo(src: string, dest: string): Promise<number> {
  await pipeline(
    createReadStream(src),
    // level 9 + 不写原文件名/时间戳（mtime:0）→ 同输入同输出，可重现。
    createGzip({ level: 9 }),
    createWriteStream(dest)
  )
  return statSync(dest).size
}

// ── 单平台打包 ────────────────────────────────────────────────────────

async function buildPlatform(): Promise<void> {
  const platform = assertPlatform(arg('platform') ?? '')
  const outDir = arg('out')
  if (!outDir) throw new Error('缺少 --out <输出目录>')
  mkdirSync(outDir, { recursive: true })

  const components: ComponentEntry[] = []

  // ── CLI ──
  const cliPath = arg('cli')
  if (cliPath) {
    if (!existsSync(cliPath)) throw new Error(`CLI 二进制不存在：${cliPath}`)
    const cliVersion = arg('cli-version')
    if (!cliVersion) throw new Error('给了 --cli 就必须给 --cli-version')
    const source = (arg('cli-source') ?? 'official') as ComponentSource
    if (source !== 'fusion' && source !== 'official') {
      throw new Error(`--cli-source 必须是 fusion / official，收到：${source}`)
    }

    const isWin = platform === 'win32-x64'
    const expectArch = platform === 'darwin-arm64' ? 'arm64' : 'x64'

    // 结构走查 + 架构断言。架构这条在这里格外重要：--platform 是人给的参数，
    // 传错完全可能，而错架构的产物 sha256 完全正确、装到用户机器上才
    // `spawn Exec format error`。
    const verdict = inspectExecutable(cliPath, {
      format: isWin ? 'pe' : 'macho',
      expectArch,
      minBytes: 0
    })
    if (!verdict.ok) throw new Error(`CLI 二进制走查未通过：${verdict.reason}`)
    console.log(`[publish-components] CLI 走查 ok（${platform}，${verdict.detail}）`)

    const binName = isWin ? 'fusion-code-cli.exe' : 'fusion-code-cli'
    const unpackedSize = statSync(cliPath).size
    const contentSha256 = await sha256File(cliPath)
    const file = `cli-${cliVersion}-${platform}.gz`
    const gzPath = join(outDir, file)
    const size = await gzipTo(cliPath, gzPath)
    const sha256 = await sha256File(gzPath)
    console.log(
      `[publish-components] CLI ${cliVersion} ${platform}: ${(unpackedSize / 1048576).toFixed(1)}MB → ` +
        `${(size / 1048576).toFixed(1)}MB（${((size / unpackedSize) * 100).toFixed(1)}%）`
    )

    components.push({
      id: 'cli',
      kind: 'executable',
      required: true,
      artifacts: {
        [platform]: {
          version: cliVersion,
          source,
          file,
          sha256,
          size,
          unpackedSize,
          encoding: 'gzip',
          contentSha256,
          // binName / readyProbe 挂在 artifact 上而不是 entry 上：它们按平台不同
          // （Windows 带 .exe），放 entry 层合并三平台时会被互相覆盖。
          binName,
          readyProbe: binName
        } satisfies ComponentArtifact
      }
    })
  }

  // ── python-runtime ──
  const pyPath = arg('python')
  if (pyPath) {
    if (!existsSync(pyPath)) throw new Error(`python tarball 不存在：${pyPath}`)
    const pyVersion = arg('python-version')
    if (!pyVersion) throw new Error('给了 --python 就必须给 --python-version')
    const unpackedSize = Number(arg('python-unpacked') ?? 0) || statSync(pyPath).size * 3

    const file = `python-${pyVersion}-${platform}.tar.gz`
    const dest = join(outDir, file)
    // 原样拷贝（已是 tar.gz，再压一层纯浪费且破坏 tar 语义）。
    await pipeline(createReadStream(pyPath), createWriteStream(dest))
    const size = statSync(dest).size
    const sha256 = await sha256File(dest)
    console.log(`[publish-components] python ${pyVersion} ${platform}: ${(size / 1048576).toFixed(1)}MB`)

    components.push({
      id: 'python-runtime',
      kind: 'tar.gz',
      // 缺了只降级到系统 python3，不挡应用——所以是可选的。
      required: false,
      stripComponents: 1,
      artifacts: {
        [platform]: {
          version: pyVersion,
          file,
          sha256,
          size,
          unpackedSize,
          encoding: 'none',
          // 解释器路径按平台不同，必须挂在 artifact 上（见 CLI 那段注释）。
          readyProbe: platform === 'win32-x64' ? 'python.exe' : 'bin/python3'
        } satisfies ComponentArtifact
      }
    })
  }

  if (components.length === 0) throw new Error('至少要给 --cli 或 --python 之一')

  const shard = { platform, components }
  writeFileSync(join(outDir, `components.${platform}.json`), `${JSON.stringify(shard, null, 2)}\n`, 'utf-8')
  console.log(`[publish-components] 分片已写入 components.${platform}.json`)
}

// ── 合并 ──────────────────────────────────────────────────────────────

interface Shard {
  platform: ComponentPlatform
  components: ComponentEntry[]
}

async function mergeShards(): Promise<void> {
  const dir = arg('merge')
  if (!dir) throw new Error('缺少 --merge <分片目录>')
  const shards: Shard[] = readdirSync(dir)
    .filter((f) => /^components\.[\w-]+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Shard)
  if (shards.length === 0) throw new Error(`${dir} 下没有 components.<platform>.json 分片`)

  const byId = new Map<string, ComponentEntry>()
  for (const shard of shards) {
    for (const entry of shard.components) {
      const existing = byId.get(entry.id)
      if (!existing) {
        byId.set(entry.id, { ...entry, artifacts: { ...entry.artifacts } })
        continue
      }
      // 同一组件的元信息必须跨平台一致，否则清单会自相矛盾。
      if (existing.kind !== entry.kind || existing.required !== entry.required) {
        throw new Error(`组件 ${entry.id} 的 kind/required 在不同平台分片里不一致`)
      }
      Object.assign(existing.artifacts, entry.artifacts)
    }
  }

  const components = [...byId.values()]

  // **必需组件必须三平台齐全**：缺一个就意味着那个平台的用户永远装不上必需组件，
  // 而且会失败得很晚（用户装完应用打开才发现）。宁可在这里 fail。
  for (const entry of components) {
    if (!entry.required) continue
    const missing = PLATFORMS.filter((p) => !entry.artifacts[p])
    if (missing.length > 0) {
      throw new Error(`必需组件 ${entry.id} 缺少平台产物：${missing.join(', ')}——补齐后再发布`)
    }
  }

  /**
   * 平台相关字段的守卫。
   *
   * 这条断言是**踩过坑之后加的**：binName / readyProbe 最初放在 entry 层，合并
   * 三平台分片时后一个平台的值被前一个覆盖，产出的清单里 Windows 用着 mac 的
   * 文件名——装完落盘没有 .exe、cliDetect 找不到；python 的判据永远不满足于是
   * 每次启动都重下一遍。两个症状都离真因极远。
   *
   * 字段搬到 artifact 层之后，再加这道断言把「平台与文件名对不上」挡在发布前。
   */
  for (const entry of components) {
    for (const p of PLATFORMS) {
      const a = entry.artifacts[p]
      if (!a) continue
      if (!a.readyProbe) throw new Error(`${entry.id} / ${p} 缺 readyProbe`)
      if (entry.kind === 'executable') {
        if (!a.binName) throw new Error(`${entry.id} / ${p} 是 executable 却没有 binName`)
        const isWin = p === 'win32-x64'
        if (isWin !== a.binName.endsWith('.exe')) {
          throw new Error(`${entry.id} / ${p} 的 binName「${a.binName}」与平台不符（Windows 必须 .exe，其余不能带）`)
        }
      }
      if (entry.id === 'python-runtime') {
        const want = p === 'win32-x64' ? 'python.exe' : 'bin/python3'
        if (a.readyProbe !== want) {
          throw new Error(`python-runtime / ${p} 的 readyProbe 应为「${want}」，实际「${a.readyProbe}」`)
        }
      }
      // 同一文件名出现在两个平台下 = 分片串了，客户端会给用户装错架构的产物。
      const dupe = PLATFORMS.filter((q) => q !== p && entry.artifacts[q]?.file === a.file)
      if (dupe.length > 0) {
        throw new Error(`${entry.id} 的 ${p} 与 ${dupe.join(',')} 指向同一个文件 ${a.file}——分片串了`)
      }
    }
  }

  const publishedAt = Number(arg('published-at') ?? 0) || 0
  if (!publishedAt) {
    throw new Error('缺少 --published-at <毫秒时间戳>（外部传入以保证可重现，同 publish-ppt-skill 的 ZIP_EPOCH 纪律）')
  }

  const manifest: ComponentsManifest = { schemaVersion: 1, publishedAt, components }

  // 自校验：清单里的每个产物都要真的在目录里、且 size/sha256 对得上。
  // 这一步挡的是「分片写完之后有人动过文件」和「合并逻辑漏抄字段」。
  for (const entry of components) {
    for (const [platform, artifact] of Object.entries(entry.artifacts)) {
      const path = join(dir, artifact.file)
      if (!existsSync(path)) throw new Error(`清单引用了不存在的文件：${artifact.file}（${entry.id} / ${platform}）`)
      const size = statSync(path).size
      if (size !== artifact.size) throw new Error(`${artifact.file} 大小不符：清单 ${artifact.size}，实际 ${size}`)
      const sha = await sha256File(path)
      if (sha !== artifact.sha256) throw new Error(`${artifact.file} sha256 不符——产物与清单已漂移`)
    }
  }

  const outFile = arg('out') ?? join(dir, 'components.json')
  writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  console.log(`[publish-components] 清单已写入 ${basename(outFile)}（${components.length} 个组件，自校验通过）`)
}

const isMerge = process.argv.includes('--merge')
await (isMerge ? mergeShards() : buildPlatform())
