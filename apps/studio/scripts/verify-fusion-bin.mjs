// Fail-fast check that the bundled CLI binary is INTACT before electron-builder
// copies it into the app. Run in the build:mac/win/linux chain right before
// packaging.
//
// Why this exists: the CLI is a single-file executable (~177MB on darwin-arm64)
// downloaded by CI into fusion-bin/. If that download is truncated — partial
// fetch, interrupted network, a half-written file left from a previous run —
// the Mach-O header still parses but its LC_CODE_SIGNATURE / __LINKEDIT segment
// points PAST the end of the (short) file. macOS then refuses to spawn it from
// another (signed) process with `spawn Unknown system error -88` (EBADEXEC), and
// the chat tab errors on every message. A truncated binary is otherwise
// invisible: `file` still says "Mach-O 64-bit executable arm64", it's +x, and
// running it straight from a shell can even exit 0. The ONLY reliable tell is
// that the code-signature segment lies outside the file.
//
// See errors/2026-05-23-fusion-code-cli截断致spawn-88.md.
//
// ── 2026-07-29: 走查逻辑已抽到 electron/shared/binaryIntegrity.ts ──
// CLI 二进制正在改成按需下载，同一套检查需要在三处跑（打包前 / 发布前 / 下载后），
// 所以本脚本退化成一个薄壳。**行为逐字不变**：同样的判据、同样的退出码、同样的
// 输出前缀。真正的逻辑连同它的成因注释都搬到了那个模块里，并在那里补了一条本脚本
// 没有的架构断言（发布侧才用得上）。

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectExecutable } from '../electron/shared/binaryIntegrity.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(__dirname, '..')

// Which binary to check depends on the platform we're packaging for. Default to
// the darwin/linux name; pass `win` to check the .exe.
const isWin = process.argv.includes('win')
const binPath = join(desktopRoot, 'fusion-bin', isWin ? 'fusion-code-cli.exe' : 'fusion-code-cli')

if (!existsSync(binPath)) {
  console.error(
    `[verify-fusion-bin] missing: ${binPath}\n` +
      `  CI downloads it via gh release; locally drop a complete copy there.`
  )
  process.exit(1)
}

// 打包前这一关刻意**不**校验架构：本地开发机上放哪个架构的副本是开发者自己的事，
// 而 CI 上架构由 runner 保证。架构断言留给发布脚本（那里 --platform 是人给的参数，
// 传错完全可能）。
const result = inspectExecutable(binPath, { format: isWin ? 'pe' : 'macho' })

if (!result.ok) {
  console.error(`[verify-fusion-bin] ${binPath}\n  ${result.reason}`)
  process.exit(1)
}

console.log(`[verify-fusion-bin] ok (${isWin ? 'win PE' : 'mach-o'}, ${result.detail})`)
