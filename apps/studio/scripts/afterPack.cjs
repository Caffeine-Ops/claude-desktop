// electron-builder afterPack 钩子：打包落盘之后、代码签名之前跑一趟断言。
//
// 目前只有一件事：确认 Chromium 的 locale 文件还在（见下面 assertLocalesSurvived 的
// 长注释——2026-08-04 事故驱动加的硬断言，别删）。
//
// ── 2026-09-24：本钩子原来的主业「按目标 CPU 架构剔除原生模块」已整体删除 ──
// 那套逻辑（pruneOnnxRuntime + pruneSharp，约 160 行）服务的是知识库向量检索：
// onnxruntime-node 把三平台×两架构的原生二进制全塞在同一个包里、postinstall 只下载
// 构建机自己那一份，于是在 arm64 机器上打 x64 包会把 arm64 的 dylib 原样装进 x64 包
// （v0.0.42 实测：35M 死重量 + Intel Mac 上加载必失败）；build.files 的 glob 只能按
// 平台过滤、拿不到 arch，才需要一个能读 context.arch 的钩子来做这件事。
//
// 整条向量化栈（onnxruntime-node + @huggingface/transformers + embedWorker + vectors.bin）
// 已于 2026-09-24 删除，包里再没有原生模块需要按架构裁剪，这套逻辑连同它的 KNOWN_
// UPSTREAM_GAPS（darwin/x64 上游永久缺口的降级豁免）一起退役。
//
// 若将来又引入按平台/架构分包的原生依赖，需要的是同一套形状：读 context.arch → 映射
// 成原生模块的目录名 → 保留目标那份、删其余、目标缺失则硬失败（跨架构打包必须当场
// 报错，绝不静默产出装着错架构二进制的包——同 dist:* vs build:* 那条纪律）。git 历史
// 里有完整实现可捞。
//
// 时机：afterPack 在文件落盘之后、代码签名之前触发。

const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

/**
 * locale 存活断言（2026-08-04 加，事故驱动）。
 *
 * 背景：build.electronLanguages 的裁剪是**精确文件名匹配**（app-builder-lib 的
 * removeUnusedLanguagesIfNeeded：`wantedLanguages.includes(basename(file, ext))`，
 * 命不中就 rm），而 locale 名在两边拼法不同——mac 是下划线的 .lproj
 * （en.lproj / zh_CN.lproj），win/linux 是连字符的 .pak（en-US.pak / zh-CN.pak，
 * 且没有裸 en.pak）。0.0.44~0.0.45 把 mac 的拼法放在顶层通吃三平台，Windows 包的
 * locales/ 于是被清成 0 个文件，且整条构建链零报错。
 *
 * 后果不是「界面变英文」这么温和：Chromium 渲染 `<input type=file>` 这类需要本地化
 * 字符串的原生控件时，取不到 pak 会让**渲染进程直接崩溃**（render-process-gone
 * reason=crashed exitCode=-36861，electron/electron#45251）。首页 HomeHero 就挂着一个
 * 隐藏 file input，实际表现是 Windows 用户装完打不开、永远停在闪屏。
 *
 * 时机是对的：app-builder-lib 的调用顺序是 framework.beforeCopyExtraFiles（在那里
 * 裁 locale）→ emitAfterPack（本钩子），所以这里读到的就是裁剪后的最终结果。
 * 断言故意放在所有提前 return 之前——universal 包、没有 app.asar.unpacked 的包，
 * 一样要查。
 */
function assertLocalesSurvived(appOutDir, platformName, packager) {
  // 每个平台的：locale 目录、文件扩展名、必须活下来的兜底 locale。
  // 兜底选 en-US / en 是因为它是 Chromium 找不到系统语言时的最终 fallback——
  // 它没了，非中文系统上全线崩，不是「少一种翻译」。
  const checks =
    platformName === 'darwin'
      ? [
          { dir: packager.getResourcesDir(appOutDir), ext: '.lproj', required: 'en.lproj' },
          typeof packager.getMacOsElectronFrameworkResourcesDir === 'function'
            ? {
                dir: packager.getMacOsElectronFrameworkResourcesDir(appOutDir),
                ext: '.lproj',
                required: 'en.lproj'
              }
            : null
        ].filter(Boolean)
      : [
          {
            dir: join(packager.getResourcesDir(appOutDir), '..', 'locales'),
            ext: '.pak',
            required: 'en-US.pak'
          }
        ]

  for (const { dir, ext, required } of checks) {
    if (!existsSync(dir)) {
      throw new Error(
        `[afterPack] locale 目录不存在：${dir}\n` +
          `  多半是 build.electronLanguages 写错了拼法（mac 用 en_GB/zh_CN 的下划线 .lproj，` +
          `win/linux 用 en-US/zh-CN 的连字符 .pak）。`
      )
    }
    const found = readdirSync(dir).filter((f) => f.endsWith(ext))
    if (!found.includes(required)) {
      throw new Error(
        `[afterPack] ${platformName} 包缺少兜底 locale ${required}（目录 ${dir} 里现有 ` +
          `[${found.join(', ') || '空'}]）。\n` +
          `  原因：build.${platformName === 'win32' ? 'win' : platformName === 'darwin' ? 'mac' : 'linux'}` +
          `.electronLanguages 的写法与该平台的实际文件名对不上，裁剪是精确匹配、命不中即删。\n` +
          `  正确拼法：mac = ["en","en_GB","zh_CN","zh_TW"]（.lproj，下划线）；` +
          `win/linux = ["en-US","en-GB","zh-CN","zh-TW"]（.pak，连字符，无裸 en）。\n` +
          `  为什么必须硬失败：locales 空的包在 Windows 上一渲染 <input type=file> 就让渲染进程` +
          `崩溃（exitCode=-36861），装完直接打不开，且构建链全程零报错——见 2026-08-04 事故。`
      )
    }
    console.log(`[afterPack] locale 校验通过：${dir} 保留 ${found.length} 个（含 ${required}）`)
  }
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  assertLocalesSurvived(appOutDir, electronPlatformName, packager)
}
