// Prebundle the Open Design daemon + resources into a self-contained tree that
// electron-builder copies into the packaged app's Resources/prebundled.
//
// Why: in dev the Electron shell spawns the daemon from the live monorepo
// (apps/daemon/dist/cli.js) with the whole 2.8G node_modules on disk. A
// packaged .app can't carry that. Mirroring open-design's tools-pack approach,
// we esbuild-bundle the daemon's ENTIRE JS dependency graph into one mjs and
// keep only the one remaining non-bundlable module (blake3-wasm, loads a .wasm)
// as external, copied alongside. Resource dirs the daemon reads at runtime
// (skills, design-systems, …) and the web static export are copied verbatim.
//
// NOTE (2026-07-15): better-sqlite3 (the only NATIVE .node module) is gone —
// the daemon's SQLite layer moved to node:sqlite (built into the runtime).
// So there is no .node to ship, no ABI to pin, and the daemon now runs on
// Electron's own node (see resolveNodeBin). That removed the standalone
// node-runtime and the .nvmrc copy this script used to do.
//
// Layout produced (must mirror the monorepo so daemon's resolveProjectRoot(
// __dirname) === <prebundled root>, satisfying its OD_RESOURCE_ROOT-under-root
// security check):
//
//   prebundled/
//     apps/daemon/dist/daemon-cli.mjs        ← esbuild bundle (entry)
//     apps/daemon/dist/node_modules/         ← blake3-wasm (+ its runtime deps)
//     apps/studio/out/                       ← next static export (app://studio serves it)
//     skills/ design-systems/ design-templates/ craft/ assets/
//     prompt-templates/ plugins/             ← daemon resource roots
//
// Run from apps/studio via `bun run prebundle:daemon` (bun resolves esbuild
// from the workspace store; plain `node` can't resolve it under bun's layout).

import { build } from 'esbuild'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// apps/studio/scripts → apps/studio → apps → repo root
const repoRoot = join(__dirname, '..', '..', '..')
const pkgRoot = join(__dirname, '..')
const out = join(pkgRoot, 'prebundled')

const daemonEntry = join(repoRoot, 'apps', 'daemon', 'dist', 'cli.js')
if (!existsSync(daemonEntry)) {
  console.error(`[prebundle] daemon entry not found: ${daemonEntry}\n` +
    `  build it first: bun run --filter='@open-design/daemon' build`)
  process.exit(1)
}

// Clean previous output so stale files never leak into the package.
rmSync(out, { recursive: true, force: true })

const daemonDistOut = join(out, 'apps', 'daemon', 'dist')
mkdirSync(daemonDistOut, { recursive: true })

console.log('[prebundle] bundling daemon with esbuild…')
const result = await build({
  bundle: true,
  format: 'esm',
  platform: 'node',
  // Match the system Node the shell spawns the daemon with (.nvmrc → 24).
  target: 'node24',
  entryPoints: [daemonEntry],
  outfile: join(daemonDistOut, 'daemon-cli.mjs'),
  // blake3-wasm can't be bundled (it loads a .wasm at runtime) — keep it
  // external and ship its node_modules folder next to the bundle (resolved via
  // the dist/node_modules dir below). (better-sqlite3 used to be here too; it's
  // gone now — SQLite is node:sqlite, nothing to externalize.)
  external: ['blake3-wasm'],
  // Several transitive deps are CJS and call require(); an ESM bundle has no
  // require by default, so inject one bound to the bundle's own URL.
  banner: {
    js: 'import { createRequire as __odCreateRequire } from "node:module"; const require = __odCreateRequire(import.meta.url);'
  },
  logLevel: 'warning',
  metafile: true
})
console.log(`[prebundle] daemon bundle ok — ${Object.keys(result.metafile.inputs).length} inputs`)

// Copy the external package(s) into the bundle-adjacent node_modules so the
// external require() resolves them. Only blake3-wasm remains (loads a .wasm).
const nativeNodeModules = join(daemonDistOut, 'node_modules')
mkdirSync(nativeNodeModules, { recursive: true })

/** Find a package's real dir under bun's flat store (node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>). */
function findPkgDir(pkg) {
  const bunStore = join(repoRoot, 'node_modules', '.bun')
  // Glob-free: scan store entries that start with "<pkg>@".
  const entries = readdirSync(bunStore)
  const match = entries.find((e) => e === pkg || e.startsWith(`${pkg}@`))
  if (!match) return null
  const dir = join(bunStore, match, 'node_modules', pkg)
  return existsSync(dir) ? dir : null
}

// blake3-wasm pulls in no native .node and no transitive runtime deps we need
// to hand-copy (it's self-contained wasm). Ship just the one package.
const RUNTIME_EXTERNAL_PKGS = ['blake3-wasm']
for (const pkg of RUNTIME_EXTERNAL_PKGS) {
  const src = findPkgDir(pkg)
  if (!src) {
    console.error(`[prebundle] external runtime package not found in store: ${pkg}`)
    process.exit(1)
  }
  cpSync(src, join(nativeNodeModules, pkg), { recursive: true, dereference: true })
  console.log(`[prebundle] copied external pkg: ${pkg}`)
}

// No .nvmrc copy and no native-addon sanity-check anymore: the daemon has no
// native module and runs on Electron's own node (ELECTRON_RUN_AS_NODE), so
// there is no ABI to pin. See resolveNodeBin in openDesignServices.ts.

// （apps/web 已随 Phase 4 物理下线——prod 唯一 UI 是 studio/out。）

// studio 静态产物（单视图形态 prod 的唯一 UI，app://studio 读这里）。
// 缺失=打出来的包开屏就 404，按硬错误处理而不是 warning——单视图已是默认
// 形态，没有 studio 的包是废包（LEGACY_TABS 用户除外，但那是逃生门不是常态）。
const studioOut = join(repoRoot, 'apps', 'studio', 'out')
if (existsSync(studioOut)) {
  cpSync(studioOut, join(out, 'apps', 'studio', 'out'), { recursive: true, dereference: true })
  console.log('[prebundle] copied apps/studio/out')
} else {
  console.error(
    '[prebundle] apps/studio/out missing — 单视图 prod 开屏即 404。' +
      "先构建：bun run --filter='@claude-desktop/studio' build"
  )
  process.exit(1)
}

const RESOURCE_DIRS = [
  'skills',
  'design-systems',
  'design-templates',
  'craft',
  'assets',
  'prompt-templates',
  'plugins'
]

// 运行时产物目录名——skill 本机跑起来之后才出现的东西（用户数据/生成产物/
// 字节码缓存），不是随仓库发布的源码。按**目录名**而不是扩展名排除：
// - workspace/、projects/ 是 tender-review 招标复核、ppt-master PPT 生成等
//   skill 在真实使用中往里写的工作文件，可能装着用户上传机密文档的逐行全文/
//   摘录（本机现在就有 skills/tender-review/workspace/ 是这种）；按扩展名过滤
//   永远猜不全（用户能塞任何格式：.xlsx/.docx/.pdf/纯文本……），按目录名一刀切
//   才兜得住，且不会误伤将来新增的合法资源文件。
// - __pycache__/、.pytest_cache/、venv/、.venv/ 是 Python 工具链自己生成的
//   字节码缓存/虚拟环境，纯体积浪费，没有发布价值。
// 根 .gitignore（第 34-42 行）早把同一批目录标记为「skill 运行时产物，非源码」，
// 但那份 gitignore 只守 git 提交、不守这里的 cpSync——不单独排除的话，构建机上
// 任何一次跑过 skill 留下的产物会原样进 prebundled/，再被 package.json 的
// extraResources 整个打进 dmg/nsis，随公开的 GitHub Release 发出去：这是用户
// 机密泄露，不是省几十 KB 体积的事。对全部 RESOURCE_DIRS 生效，不只 skills——
// 运行时产物出现在哪个资源目录里都不该进包。
const RUNTIME_ARTIFACT_DIR_NAMES = new Set([
  'workspace',
  'projects',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv'
])

/**
 * cpSync 的 filter：按路径中的目录名分段匹配，命中即整棵子树跳过（filter 对
 * 目录返回 false 时 cpSync 根本不递归进去，子文件不会被逐个问一遍）。
 *
 * 匹配范围刻意限定在「相对资源目录根的路径」而不是绝对路径——如果直接对
 * cpSync 传进来的绝对 src 做分段匹配，repoRoot 之上的目录名（比如某个开发者
 * 习惯把仓库放在 ~/workspace/ 或 ~/projects/ 下）会被误判命中，导致整个资源目录
 * 都被跳过复制。只看资源根以下的相对路径就不会有这个问题。
 */
function makeRuntimeArtifactFilter(resourceRoot, resourceDirName) {
  return (source) => {
    const rel = relative(resourceRoot, source)
    if (rel === '') return true // 资源目录根自身
    const segments = rel.split(/[\\/]/)
    if (segments.some((seg) => RUNTIME_ARTIFACT_DIR_NAMES.has(seg))) {
      console.log(`[prebundle] 排除运行时产物：${join(resourceDirName, rel)}`)
      return false
    }
    return true
  }
}

for (const dir of RESOURCE_DIRS) {
  const src = join(repoRoot, dir)
  if (!existsSync(src)) {
    console.warn(`[prebundle] resource dir missing, skipping: ${dir}`)
    continue
  }
  cpSync(src, join(out, dir), {
    recursive: true,
    dereference: true,
    filter: makeRuntimeArtifactFilter(src, dir)
  })
  console.log(`[prebundle] copied resource dir: ${dir}`)
}

/**
 * 运行时产物残留断言（与 afterPack.cjs 的 assertLocalesSurvived 同一类硬拦，
 * 写法与语气照抄它）。
 *
 * 为什么必须有：上面的 filter 是这条防线唯一的守门人，一旦写错（目录名拼错、
 * 逻辑写反、cpSync 未来版本改了 filter 的调用时机……）后果是「复制看起来完全
 * 正常、日志一条报错都没有」——跟 CLAUDE.md 里 electronLanguages 拼错导致
 * Windows locales 被清空那次事故（v0.0.43~0.0.45 三个版本装完打不开）是同一种
 * 失败模式：**这类裁剪永远静默，列错了跟「本来就没有产物」长得一模一样**。
 * 所以拷贝完之后必须真的扫一遍 prebundled/ 产物树，确认排除名单里的目录一个
 * 都不剩；不符合预期就 throw 让构建 exit 非 0，绝不能让漏网的用户机密文档
 * 静默流入安装包。
 */
function assertNoRuntimeArtifacts(root, resourceDirs) {
  const leaked = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = join(dir, e.name)
      if (RUNTIME_ARTIFACT_DIR_NAMES.has(e.name)) {
        leaked.push(p) // 命中的子树本身就是问题，不用再往下探
        continue
      }
      walk(p)
    }
  }
  for (const dir of resourceDirs) {
    const dirRoot = join(root, dir)
    if (existsSync(dirRoot)) walk(dirRoot)
  }
  if (leaked.length > 0) {
    throw new Error(
      `[prebundle] 发现 ${leaked.length} 个运行时产物目录残留在 prebundled/ 里，构建已中止：\n` +
        leaked.map((p) => `  - ${relative(root, p)}`).join('\n') +
        '\n\n' +
        '  这些目录本该被 cpSync 的 filter 排除（workspace/projects/__pycache__/' +
        '.pytest_cache/venv/.venv 均属 skill 运行时产物，可能含用户上传文档的全文/摘录）。\n' +
        '  出现残留多半是 filter 逻辑被改动或绕过，或 RUNTIME_ARTIFACT_DIR_NAMES 漏列了新出现的' +
        '产物目录名。\n' +
        '  为什么必须硬失败：这些目录一旦进包会随 dmg/nsis 原样发进公开的 GitHub Release——' +
        '是用户机密泄露，不是体积问题，绝不能静默放过。'
    )
  }
  console.log(
    '[prebundle] 运行时产物排除断言通过（workspace/projects/__pycache__/.pytest_cache/venv/.venv 均未残留）'
  )
}

assertNoRuntimeArtifacts(out, RESOURCE_DIRS)

// ── 图片量化（2026-07-30）────────────────────────────────────────────────────
// RESOURCE_DIRS 里的示例插图/截图原本是无损直出 PNG，124 张共 64M，占安装包的
// 一大块（open-design-landing 那 16 张就 21.8M，而且它在 design-templates/ 与
// plugins/_official/examples/ 下各存了一份完全相同的副本）。256 色量化后降到
// 22.6M，实测视觉无可见劣化（平坦区无色带、细节保留）；PNG 在 dmg 里几乎不再
// 二次压缩，所以省下的字节接近 1:1 落到安装包上。
//
// 刻意**只压 prebundled 里的副本，不碰源仓库**：源资产保持无损原图，其它用途
// 和二次编辑都不受影响，plugins/_official 从上游同步回来也不会打架。
//
// 范围就是 RESOURCE_DIRS —— apps/studio/out 是上面单独拷的 next 静态导出，故
// 天然被排除在外（它由 next build 产出，在这里压了下次构建就被覆盖，要治得去
// 前端侧改）。
//
// 缓存：prebundled 每次 rm 重建，压缩结果落在 repo 外的 .image-cache/（按源文件
// 的 路径+mtime+size 做 key），否则每次打包都要重压 124 张图。
const SKIP_IMAGE_OPTIMIZE = process.env.SKIP_IMAGE_OPTIMIZE === '1'
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg'])
const cacheDir = join(pkgRoot, '.image-cache')

/** sharp 是 @huggingface/transformers 的传递依赖，不在 studio 的直接 deps 里，
 *  裸 `import 'sharp'` 在 bun 的扁平 store 布局下解析不到——沿用 findPkgDir
 *  那套按 store 目录名前缀扫描的办法拿到真实路径。 */
async function loadSharp() {
  const dir = findPkgDir('sharp')
  if (!dir) return null
  try {
    return (await import(join(dir, 'lib', 'index.js'))).default
  } catch (err) {
    console.warn(`[prebundle] sharp 加载失败：${err.message}`)
    return null
  }
}

function collectImages(root) {
  const found = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && IMAGE_EXTS.has(extname(e.name).toLowerCase())) found.push(p)
    }
  }
  walk(root)
  return found
}

if (SKIP_IMAGE_OPTIMIZE) {
  console.log('[prebundle] SKIP_IMAGE_OPTIMIZE=1，跳过图片量化（安装包会大约 35M）')
} else {
  const sharp = await loadSharp()
  if (!sharp) {
    // 硬失败而不是静默跳过：prebundle 是发版链的一环，「少压了 35M」这种问题
    // 在产物里看不出任何异常，正是这个仓库反复踩过的静默失败模式。真要绕开
    // 用 SKIP_IMAGE_OPTIMIZE=1 显式声明。
    console.error(
      '[prebundle] 找不到 sharp（@huggingface/transformers 的传递依赖）——' +
        '图片量化无法执行，安装包会比预期大约 35M。\n' +
        '  先跑 bun install；确实要跳过就显式声明 SKIP_IMAGE_OPTIMIZE=1。'
    )
    process.exit(1)
  }

  mkdirSync(cacheDir, { recursive: true })
  const targets = RESOURCE_DIRS.map((d) => join(out, d)).filter((d) => existsSync(d))
  const images = targets.flatMap(collectImages)

  let before = 0
  let after = 0
  let cacheHits = 0
  let grew = 0

  // 并发压缩：sharp 内部走 libvips 线程池，同时喂 8 个任务能吃满多核又不至于
  // 把内存顶爆（单张 1024² RGBA 解码约 4M）。
  const CONCURRENCY = 8
  let cursor = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < images.length) {
      const p = images[cursor++]
      const st = statSync(p)
      before += st.size

      // key 用**文件内容**的 hash，不用 path+mtime：cpSync 默认不保留时间戳
      // （preserveTimestamps 缺省 false），每趟 prebundle 拷出来的 mtime 都是新
      // 的，拿它做 key 会几乎全部 miss 还把废条目堆进缓存目录。内容 hash 既稳定
      // 又天然给两份相同的 open-design-landing 插图共用同一条缓存。
      const raw = readFileSync(p)
      const key = createHash('sha1').update(raw).digest('hex')
      const cached = join(cacheDir, `${key}${extname(p).toLowerCase()}`)

      if (existsSync(cached)) {
        const buf = readFileSync(cached)
        writeFileSync(p, buf)
        after += buf.length
        cacheHits++
        continue
      }

      try {
        const isPng = extname(p).toLowerCase() === '.png'
        const buf = isPng
          ? await sharp(raw).png({ quality: 90, compressionLevel: 9, palette: true }).toBuffer()
          : await sharp(raw).jpeg({ quality: 82, mozjpeg: true }).toBuffer()

        // 透明度护栏（兜底，正常走不到）：实测 sharp 的 palette PNG 会正确保留真
        // 实的 alpha（拿一张左半全透明的图验证过，产物 hasAlpha 仍为 true）；它只
        // 会丢掉“通道存在但全是 255”的冗余 alpha，那种丢弃无害——当前资产里唯一
        // 带 alpha 的 social-media-dashboard/.preview/hero.png 正是这种。留这道检查
        // 是防止日后换 sharp 版本或加新格式时静默压掉真透明：只要源图有 alpha 而
        // 产物没了，就数一遍源图有没有非满值像素，真用到了就整张放弃压缩。raw
        // 解码不便宜，但它只在这个窄路径上触发。
        if (isPng && buf.length < st.size) {
          const srcMeta = await sharp(raw).metadata()
          if (srcMeta.hasAlpha && !(await sharp(buf).metadata()).hasAlpha) {
            const { data } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
            let alphaUsed = false
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] !== 255) { alphaUsed = true; break }
            }
            if (alphaUsed) {
              console.warn(`[prebundle] 保留原图（含真实透明像素，量化会压掉 alpha）：${relative(out, p)}`)
              after += st.size
              writeFileSync(cached, raw)
              continue
            }
          }
        }

        // 小图/已优化过的图量化后可能反而变大，那就保留原文件。
        if (buf.length < st.size) {
          writeFileSync(p, buf)
          writeFileSync(cached, buf)
          after += buf.length
        } else {
          grew++
          after += st.size
          writeFileSync(cached, raw) // 缓存原图，下趟直接命中、不再白压一次
        }
      } catch (err) {
        // 单张图压不动不该打断整个打包（可能是异常色彩空间/损坏文件）。
        console.warn(`[prebundle] 跳过 ${relative(out, p)}：${err.message}`)
        after += st.size
      }
    }
  })
  await Promise.all(workers)

  const mb = (n) => `${(n / 1048576).toFixed(1)}M`
  console.log(
    `[prebundle] 图片量化 ${images.length} 张：${mb(before)} → ${mb(after)}` +
      `（省 ${mb(before - after)}${cacheHits ? `，${cacheHits} 张命中缓存` : ''}` +
      `${grew ? `，${grew} 张压后变大已保留原图` : ''}）`
  )
}

console.log(`[prebundle] done → ${out}`)
