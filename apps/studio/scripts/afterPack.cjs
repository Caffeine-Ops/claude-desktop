// electron-builder afterPack 钩子：按目标 CPU 架构剔除原生模块里不匹配的那一份。
//
// 为什么需要它（而不是往 build.files 里再加两条否定 glob）：
// files 的 glob 是静态字符串，拿不到「这一趟在为哪个 arch 打包」。平台能过滤
// （mac.files 里的 !**/onnxruntime-node/bin/**/win32/** 就是），架构不能。而
// onnxruntime-node 把三平台×两架构全放在同一个包里：
//
//   onnxruntime-node/bin/napi-v6/<darwin|win32|linux>/<arm64|x64>/
//
// 它的 postinstall 只下载**构建机自己**那一份。于是在 arm64 Mac 上执行
// `EB_MAC_ARCH_NAME=x64 bun run build:mac`，包里躺的是 darwin/arm64 —— 主二进制
// 是 x86_64，dylib 是 arm64。v0.0.42 的 Cowork-0.0.42-x64-mac.dmg 实测就是这样：
// 35M 纯死重量，且 Intel Mac 上 embedWorker 加载 native binding 必然失败，知识库
// 向量检索静默降级（kbSemanticSearch.ts 顶部注释描述的那条降级路径）。
//
// CI 在 macos-15-intel（真 x64 硬件，bun install 拉到的就是 x64）上跑时，这个
// 钩子对「本机构建产物」是一层「断言 + 省体积」；对本地跨架构打包
// （在 arm64 机器上打 x64 包）则是**硬失败**——宁可当场报错，也不要静默产出一个
// 装着错架构二进制的安装包。这条纪律和 dist:* vs build:* 的教训同源：打包链上的
// 问题一旦静默，拿到手的包看不出任何异常。
//
// 2026-07-30 发现的例外——darwin/x64 是上游永久性缺口，不是构建机问题：
// 直接拉 npm tarball 逐版本核对，onnxruntime-node 从 1.24.3（当前 @huggingface/
// transformers@4.2.0 精确锁定的版本）到最新 1.27.0，**从未**发布过 darwin/x64
// 预编译二进制（1.20.1 时还有，之后上游砍掉，大概率跟 Apple/GitHub 一起放弃了
// Intel macOS）。这意味着不管在哪台机器上构建、bun install 多少次，darwin/x64
// 永远不可能出现——硬失败在这个组合上只会永久卡死 release 流水线。见
// KNOWN_UPSTREAM_GAPS：这个组合走优雅降级而不是硬失败，代价是 KB 语义检索在
// Intel Mac 上永久走 BM25 关键词降级（kbSemanticSearch.ts 顶部注释描述的既有
// 降级路径——不管 embedWorker 是初始化时崩溃退出还是 pipeline() 加载原生绑定失败
// 被 init().catch 捕获成 stale，两条路径都会让 ready 停在 false，后续搜索请求走
// !ready 分支的 BM25 fallback，不影响其余功能）。其余任何平台/架构组合缺失，
// 仍然维持硬失败——那才是真正的构建机问题。
//
// 时机：afterPack 在文件落盘之后、代码签名之前触发，所以这里删文件不会破坏签名
// （electron-builder 随后才对整个 .app 重新签）。删的都是 app.asar.unpacked 下的
// 真实目录，asar header 不受影响；asarUnpack 出来的文件本就不参与 asar integrity
// 校验，也没有哈希需要同步。

// 已知的、上游不会再发布该架构原生二进制的组合（不是本机构建错误）。
// 键格式 '<platform>/<arch>'，值是给人看的说明。
const KNOWN_UPSTREAM_GAPS = new Map([
  ['darwin/x64', 'onnxruntime-node 自 1.24.3 起未发布 darwin/x64 预编译二进制（截至 1.27.0 仍未恢复）']
])

const { existsSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder 的 Arch enum（builder-util/out/arch）→ 原生模块目录名。
// enum 值是数字，钩子里拿到的 context.arch 就是它。
const ARCH_DIR_NAME = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal'
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

// tally 由每次 afterPack 调用自己创建：一趟构建可能打多个架构（electron-builder
// 会按 arch 逐次回调），计数器若挂在模块级会跨调用累加，汇总数字就不对了。
function dropDir(dir, why, tally) {
  const size = dirSize(dir)
  rmSync(dir, { recursive: true, force: true })
  tally.freed += size
  console.log(`[afterPack] 剔除 ${why} (${(size / 1048576).toFixed(1)}M)`)
}

/**
 * onnxruntime-node：单包内含全平台全架构，postinstall 只填构建机那一份。
 * 保留 <platform>/<arch>，其余全删；目标那份缺失则硬失败。
 */
function pruneOnnxRuntime(nodeModules, platform, arch, tally) {
  const binRoot = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v6')
  if (!existsSync(binRoot)) return // 依赖被整个排除掉了（或版本换了布局），不是本钩子的事

  const wantPlatformDir = join(binRoot, platform)
  const wantArchDir = join(wantPlatformDir, arch)

  if (!existsSync(wantArchDir)) {
    const gapKey = `${platform}/${arch}`
    const gapReason = KNOWN_UPSTREAM_GAPS.get(gapKey)
    if (gapReason) {
      // 已知永久缺口：不是本机构建出的错，硬失败只会永久卡死这个 arch 的 release。
      // 整包删掉（不只删 bin/），让 require('onnxruntime-node') 在目标机上干脆利落
      // 地 MODULE_NOT_FOUND——embedWorker 顶层 import 失败会让 utilityProcess 直接
      // 崩溃退出，父进程的 exit 监听器把 ready 复位为 false，落入既有 BM25 降级路径。
      console.log(`[afterPack] onnxruntime-node 无 ${gapKey} 原生二进制（${gapReason}），整体剔除，KB 语义检索在该架构永久降级为 BM25 关键词检索`)
      dropDir(join(nodeModules, 'onnxruntime-node'), 'onnxruntime-node（目标架构上游不发布，整包剔除）', tally)
      return
    }

    // 列出实际有什么，好让报错能直接指向原因（多半是「在 arm64 机器上打 x64」）。
    const present = []
    for (const os of readdirSync(binRoot)) {
      const osDir = join(binRoot, os)
      if (!statSync(osDir).isDirectory()) continue
      for (const a of readdirSync(osDir)) present.push(`${os}/${a}`)
    }
    throw new Error(
      `[afterPack] onnxruntime-node 缺少目标架构的原生二进制：需要 ${platform}/${arch}，` +
        `包里只有 [${present.join(', ') || '空'}]。\n` +
        `  原因：onnxruntime-node 的 postinstall 只下载构建机自己的架构，` +
        `跨架构打包会把错架构的 dylib 装进包里（35M 死重量 + 目标机上加载必失败）。\n` +
        `  解法：在目标架构的机器上构建，或走 CI（build.yml 的 x64 leg 跑在 macos-15-intel）。\n` +
        `  若确认本次产物不需要知识库向量检索，可临时从 dependencies 摘掉 @huggingface/transformers。`
    )
  }

  for (const os of readdirSync(binRoot)) {
    const osDir = join(binRoot, os)
    if (!statSync(osDir).isDirectory()) continue
    if (os !== platform) {
      dropDir(osDir, `onnxruntime ${os}/*（非目标平台）`, tally)
      continue
    }
    for (const a of readdirSync(osDir)) {
      const archDir = join(osDir, a)
      if (!statSync(archDir).isDirectory()) continue
      if (a !== arch) dropDir(archDir, `onnxruntime ${os}/${a}（非目标架构）`, tally)
    }
  }
}

/**
 * sharp / libvips：按 @img/<pkg>-<platform>-<arch> 分包，理论上 electron-builder 的
 * install-app-deps 会按 --arch 装对，实测 v0.0.42 的 x64 包里确实是 x64。这里只做
 * 兜底清扫：若两个架构的分包同时存在（bun 的 optionalDependencies 有时会都装上），
 * 删掉非目标那份。缺失不报错——sharp 只是 transformers 的图像分支，纯文本 embedding
 * 用不到，硬失败会误伤。
 */
function pruneSharp(nodeModules, platform, arch, tally) {
  const imgRoot = join(nodeModules, '@img')
  if (!existsSync(imgRoot)) return

  const suffix = `-${platform}-${arch}`
  for (const pkg of readdirSync(imgRoot)) {
    const pkgDir = join(imgRoot, pkg)
    if (!statSync(pkgDir).isDirectory()) continue
    // 只处理带平台后缀的分包（@img/colour 这种通用包没有后缀，跳过）。
    if (!/-(darwin|win32|linux|linuxmusl)-(x64|arm64|ia32|arm)$/.test(pkg)) continue
    if (!pkg.endsWith(suffix)) dropDir(pkgDir, `@img/${pkg}（非目标平台/架构）`, tally)
  }
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch, packager } = context
  const archName = ARCH_DIR_NAME[arch]
  if (!archName) throw new Error(`[afterPack] 未知的 Arch enum 值: ${arch}`)

  // universal 包同时含两套 slice，逐架构剔除会把另一半打掉——直接跳过。
  if (archName === 'universal') {
    console.log('[afterPack] universal 构建，跳过按架构剔除')
    return
  }

  // getResourcesDir 屏蔽了 mac(<app>/Contents/Resources) 与 win/linux(resources/) 的差异。
  const resourcesDir = packager.getResourcesDir(appOutDir)
  const nodeModules = join(resourcesDir, 'app.asar.unpacked', 'node_modules')
  if (!existsSync(nodeModules)) {
    console.log('[afterPack] 无 app.asar.unpacked/node_modules，跳过')
    return
  }

  console.log(`[afterPack] 目标 ${electronPlatformName}/${archName}，清理非匹配架构的原生模块…`)
  const tally = { freed: 0 }
  pruneOnnxRuntime(nodeModules, electronPlatformName, archName, tally)
  pruneSharp(nodeModules, electronPlatformName, archName, tally)

  console.log(
    tally.freed > 0
      ? `[afterPack] 共释放 ${(tally.freed / 1048576).toFixed(1)}M`
      : '[afterPack] 无需剔除（包里只有目标架构）'
  )
}
