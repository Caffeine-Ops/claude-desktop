// Fail-fast check that the bundled fusion-code CLI binary is INTACT before
// electron-builder copies it into the app. Run in the build:mac/win/linux
// chain right before packaging.
//
// Why this exists: the CLI is a `bun build --compile` single-file executable
// (~177MB on darwin-arm64) downloaded by CI (`gh release download`) into
// fusion-bin/. If that download is truncated — partial fetch, interrupted
// network, a half-written file left from a previous run — the Mach-O header
// still parses but its LC_CODE_SIGNATURE / __LINKEDIT segment points PAST the
// end of the (short) file. macOS then refuses to spawn it from another
// (signed) process with `spawn Unknown system error -88` (EBADEXEC), and the
// chat tab errors on every message. A truncated binary is otherwise invisible:
// `file` still says "Mach-O 64-bit executable arm64", it's +x, and running it
// straight from a shell can even exit 0. The ONLY reliable tell is that the
// code-signature segment lies outside the file. We check exactly that.
//
// See errors/2026-05-23-fusion-code-cli截断致spawn-88.md.

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(__dirname, '..')

// Which binary to check depends on the platform we're packaging for. Default
// to the darwin/linux name; pass `win` to check the .exe.
const isWin = process.argv.includes('win')
const binPath = join(desktopRoot, 'fusion-bin', isWin ? 'fusion-code-cli.exe' : 'fusion-code-cli')

if (!existsSync(binPath)) {
  console.error(
    `[verify-fusion-bin] missing: ${binPath}\n` +
      `  CI downloads it via gh release; locally drop a complete copy there.`
  )
  process.exit(1)
}

const size = statSync(binPath).size

// Windows binaries are PE, not Mach-O — we can't do the segment check, so just
// guard against an obviously-truncated file (a real fusion-code .exe is tens
// of MB; anything under 10MB is a failed download).
if (isWin) {
  if (size < 10_000_000) {
    console.error(`[verify-fusion-bin] ${binPath} is only ${size} bytes — looks truncated`)
    process.exit(1)
  }
  console.log(`[verify-fusion-bin] ok (win, ${size} bytes)`)
  process.exit(0)
}

// ── Mach-O integrity: ensure the code-signature segment is INSIDE the file ──
// We parse just enough of the Mach-O header to find LC_CODE_SIGNATURE and
// confirm its (dataoff + datasize) does not exceed the actual file size. A
// truncated bun-compiled binary keeps the original header offsets (which point
// near ~177MB) while the file itself is short — that mismatch is the bug.

const LC_CODE_SIGNATURE = 0x1d
const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM_64 = 0xcffaedfe // byte-swapped (shouldn't happen on arm64/x64 hosts, but be safe)

const fd = openSync(binPath, 'r')
try {
  const head = Buffer.alloc(32)
  readSync(fd, head, 0, 32, 0)
  const magic = head.readUInt32LE(0)
  if (magic !== MH_MAGIC_64 && magic !== MH_CIGAM_64) {
    console.error(
      `[verify-fusion-bin] ${binPath} is not a 64-bit Mach-O (magic=0x${magic.toString(16)}) — corrupt or wrong arch`
    )
    process.exit(1)
  }
  const ncmds = head.readUInt32LE(16)
  const sizeofcmds = head.readUInt32LE(20)

  // Load commands start right after the 32-byte mach_header_64.
  const cmds = Buffer.alloc(sizeofcmds)
  readSync(fd, cmds, 0, sizeofcmds, 32)

  let off = 0
  let sawSignature = false
  for (let i = 0; i < ncmds && off + 8 <= sizeofcmds; i++) {
    const cmd = cmds.readUInt32LE(off)
    const cmdsize = cmds.readUInt32LE(off + 4)
    if (cmd === LC_CODE_SIGNATURE) {
      // linkedit_data_command: cmd, cmdsize, dataoff, datasize
      const dataoff = cmds.readUInt32LE(off + 8)
      const datasize = cmds.readUInt32LE(off + 12)
      sawSignature = true
      if (dataoff + datasize > size) {
        console.error(
          `[verify-fusion-bin] TRUNCATED binary: ${binPath}\n` +
            `  LC_CODE_SIGNATURE ends at ${dataoff + datasize} but file is only ${size} bytes.\n` +
            `  The fusion-code CLI download is incomplete — re-download a full copy.\n` +
            `  (A truncated binary spawns with macOS error -88 / EBADEXEC at runtime.)`
        )
        process.exit(1)
      }
    }
    if (cmdsize === 0) break // malformed; stop rather than loop forever
    off += cmdsize
  }

  if (!sawSignature) {
    // bun --compile emits an ad-hoc linker signature, so a missing one is
    // itself suspicious — warn but don't hard-fail (an unsigned-but-complete
    // binary is a different, signable problem).
    console.warn(`[verify-fusion-bin] warning: no LC_CODE_SIGNATURE in ${binPath}`)
  }
  console.log(`[verify-fusion-bin] ok (${size} bytes, signature within bounds)`)
} finally {
  closeSync(fd)
}
