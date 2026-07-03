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

// ── Windows PE integrity: same fail-fast intent as the Mach-O branch below ──
// The .exe is the SAME kind of bun --compile single-file binary as the mac
// build — only the container is PE instead of Mach-O. The mac branch caught a
// truncated download via "code-signature segment ends past EOF" (error -88 at
// runtime, see the header note). On Windows a truncated bun-compiled exe does
// NOT get rejected by the kernel — it spawns, then the bun runtime can't read
// its embedded asset trailer and the process dies with `exit code 1` /
// "cli exited before first init" (the exact Windows-only failure we hit, the
// mirror of the mac -88 truncation bug). The old guard here was just
// `size < 10MB`, which a 30–90MB half-download sailed straight through. So we
// do the PE equivalent of the Mach-O check: walk every section header and
// assert its raw data lies INSIDE the file, plus an absolute floor for the
// part PE walking can't see.
if (isWin) {
  // Two complementary checks:
  //  (a) PE section walk — catches a truncation that lands mid-binary (a
  //      section's PointerToRawData + SizeOfRawData points past EOF), the
  //      direct analogue of the Mach-O LC_CODE_SIGNATURE bounds check.
  //  (b) Absolute size floor — bun appends its embedded asset trailer (the
  //      JS bundle + resources) AFTER the last PE section, so a download cut
  //      off inside that trailer leaves every PE section intact yet the file
  //      is still fatally short. PE walking is blind to the trailer; the floor
  //      is the only thing that catches a trailer-region truncation. The
  //      complete win32-x64 exe is ~177MB like its mac sibling; 120MB is a
  //      generous floor that still rejects the 30–90MB half-downloads.
  const WIN_MIN_BYTES = 120_000_000
  if (size < WIN_MIN_BYTES) {
    console.error(
      `[verify-fusion-bin] ${binPath} is only ${size} bytes (< ${WIN_MIN_BYTES}) — ` +
        `the bun-compiled fusion-code .exe should be ~177MB.\n` +
        `  The download is incomplete — re-download a full copy.\n` +
        `  (A truncated .exe spawns but exits with code 1 / "cli exited before first init" at runtime.)`
    )
    process.exit(1)
  }

  // ── PE section-bounds walk ──
  // DOS header @0 has 'MZ'; e_lfanew @0x3C points to the PE signature.
  // PE sig is "PE\0\0", then a 20-byte COFF header (NumberOfSections @+6,
  // SizeOfOptionalHeader @+16), then the optional header, then the section
  // table (40 bytes per IMAGE_SECTION_HEADER; SizeOfRawData @+16,
  // PointerToRawData @+20).
  const fd = openSync(binPath, 'r')
  try {
    const dos = Buffer.alloc(0x40)
    readSync(fd, dos, 0, 0x40, 0)
    if (dos.readUInt16LE(0) !== 0x5a4d /* 'MZ' */) {
      console.error(`[verify-fusion-bin] ${binPath} is not a PE file (no MZ header) — corrupt download`)
      process.exit(1)
    }
    const peOff = dos.readUInt32LE(0x3c)
    // Read the PE signature + COFF header (4 + 20 bytes).
    const coff = Buffer.alloc(24)
    readSync(fd, coff, 0, 24, peOff)
    if (coff.readUInt32LE(0) !== 0x00004550 /* 'PE\0\0' */) {
      console.error(`[verify-fusion-bin] ${binPath} has no PE signature at e_lfanew — corrupt download`)
      process.exit(1)
    }
    const numSections = coff.readUInt16LE(6)
    const sizeOfOptionalHeader = coff.readUInt16LE(20)
    const sectionTableOff = peOff + 24 + sizeOfOptionalHeader

    const sections = Buffer.alloc(numSections * 40)
    readSync(fd, sections, 0, sections.length, sectionTableOff)
    for (let i = 0; i < numSections; i++) {
      const base = i * 40
      const sizeOfRawData = sections.readUInt32LE(base + 16)
      const pointerToRawData = sections.readUInt32LE(base + 20)
      if (pointerToRawData !== 0 && pointerToRawData + sizeOfRawData > size) {
        console.error(
          `[verify-fusion-bin] TRUNCATED binary: ${binPath}\n` +
            `  PE section #${i} raw data ends at ${pointerToRawData + sizeOfRawData} but file is only ${size} bytes.\n` +
            `  The fusion-code CLI download is incomplete — re-download a full copy.`
        )
        process.exit(1)
      }
    }
  } finally {
    closeSync(fd)
  }

  console.log(`[verify-fusion-bin] ok (win PE, ${size} bytes, all sections within bounds)`)
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
