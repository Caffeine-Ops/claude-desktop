/**
 * 可执行文件完整性走查（Mach-O / PE）。
 *
 * 出身：本文件的逻辑逐条平移自 `scripts/verify-fusion-bin.mjs`，那个脚本原本是
 * **打包前**的闸门。CLI 二进制改成按需下载之后，同一套检查需要在三个地方跑，
 * 所以抽成纯函数：
 *   ① `scripts/verify-fusion-bin.mjs` —— 保持原行为（打包前校验 fusion-bin/）
 *   ② 发布脚本算 sha256 **之前** —— 防止把一份截断产物哈希后发布出去。这是唯一
 *      能挡住这种情况的地方：那一刻还没有可信的 sha 基准，sha 正是那时算出来的。
 *   ③ 下载 worker 原子 rename **之前** —— 保护「已经发出去的坏产物」的最后一道。
 *
 * 为什么下载侧有了 sha256 还要这个：sha256 只能证明「拿到的和发布的逐字节相同」，
 * 证明不了「发布出去的那份本身就是好的」。而截断二进制极其阴险——`file` 仍报
 * Mach-O、仍是 +x、从 shell 直接跑甚至能 exit 0，只有被另一个已签名进程 spawn
 * 时才报 `spawn Unknown system error -88`(EBADEXEC)，而且**曾经就这样发到用户手里**
 * （errors/2026-05-23-fusion-code-cli截断致spawn-88.md）。
 *
 * 另外补了一条原脚本没有的检查：**架构断言**。darwin-x64 产物的 sha256 完全正确，
 * 装到 arm64 机器上仍然 `spawn Exec format error`——这是 sha256 的天然盲区，而清单
 * 按平台分键这件事本身可能出错（发布脚本传错 --platform）。读头几个字节就能挡住。
 *
 * 解析函数接受 Buffer 而不是路径，为的是能用手搓的最小 header 做单元测试
 * （项目没有 E2E，这是本子系统唯一能自动化的质量门）。
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'

export type IntegrityResult = { ok: true; detail: string } | { ok: false; reason: string }

/** 期望的架构。给 undefined 表示不校验架构（只查完整性）。 */
export type ExpectArch = 'arm64' | 'x64'

// ── Mach-O ────────────────────────────────────────────────────────────

const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM_64 = 0xcffaedfe // 字节序反转（arm64/x64 宿主上不该出现，防御性保留）
const LC_CODE_SIGNATURE = 0x1d
const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

/** mach_header_64 是 32 字节；load commands 紧随其后。 */
export const MACHO_HEADER_BYTES = 32

/**
 * 走查 Mach-O：magic → 架构 → 每条 LC_CODE_SIGNATURE 的 (dataoff+datasize) 是否
 * 越过文件尾。head 是前 32 字节，cmds 是随后的 sizeofcmds 字节。
 */
export function inspectMachO(
  head: Buffer,
  cmds: Buffer,
  fileSize: number,
  expectArch?: ExpectArch
): IntegrityResult {
  if (head.length < MACHO_HEADER_BYTES) {
    return { ok: false, reason: `文件太短，读不出 Mach-O 头（${head.length} 字节）` }
  }
  const magic = head.readUInt32LE(0)
  if (magic !== MH_MAGIC_64 && magic !== MH_CIGAM_64) {
    return { ok: false, reason: `不是 64 位 Mach-O（magic=0x${magic.toString(16)}）——文件损坏或架构不符` }
  }

  const cputype = head.readUInt32LE(4)
  if (expectArch) {
    const want = expectArch === 'arm64' ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64
    if (cputype !== want) {
      const got = cputype === CPU_TYPE_ARM64 ? 'arm64' : cputype === CPU_TYPE_X86_64 ? 'x64' : `0x${cputype.toString(16)}`
      // 这一条 sha256 永远抓不到：产物本身是完好的，只是发错了平台。
      return { ok: false, reason: `架构不符：期望 ${expectArch}，实际 ${got}（装上去会 spawn Exec format error）` }
    }
  }

  const ncmds = head.readUInt32LE(16)
  const sizeofcmds = head.readUInt32LE(20)
  if (cmds.length < sizeofcmds) {
    return { ok: false, reason: `load commands 被截断（声明 ${sizeofcmds} 字节，实际 ${cmds.length}）` }
  }

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
      if (dataoff + datasize > fileSize) {
        return {
          ok: false,
          reason:
            `文件被截断：LC_CODE_SIGNATURE 结束于 ${dataoff + datasize}，但文件只有 ${fileSize} 字节` +
            `（这种二进制 spawn 时报 macOS -88 / EBADEXEC）`
        }
      }
    }
    if (cmdsize === 0) break // 畸形，停下而不是死循环
    off += cmdsize
  }

  // bun --compile 会打 ad-hoc linker 签名，官方版有 Developer ID 签名——两态都该
  // 有签名段。没有本身可疑，但「未签名却完整」是另一个（可签名的）问题，不硬失败。
  return { ok: true, detail: sawSignature ? '签名段在界内' : '完整，但没有 LC_CODE_SIGNATURE' }
}

// ── PE（Windows）──────────────────────────────────────────────────────

const IMAGE_FILE_MACHINE_AMD64 = 0x8664
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64

/**
 * bun 把它的内嵌资产 trailer（JS bundle + 资源）接在**最后一个 PE section 之后**，
 * PE 走查完全看不见那一段。所以一次落在 trailer 区里的截断会让每个 section 都
 * 合法、文件却依然是致命的短。绝对下限是唯一能抓到它的东西。
 * 完整的 win32-x64 exe 与 mac 版同量级（~177MB+），120MB 是个宽松但足以拒掉
 * 30–90MB 半包的地板。
 */
export const WIN_MIN_BYTES = 120_000_000

/** DOS 头 0x40 字节；PE 签名 + COFF 头 24 字节；每个 section header 40 字节。 */
export const PE_DOS_BYTES = 0x40
export const PE_COFF_BYTES = 24
export const PE_SECTION_BYTES = 40

export function inspectPE(
  dos: Buffer,
  coff: Buffer,
  sections: Buffer,
  fileSize: number,
  expectArch?: ExpectArch
): IntegrityResult {
  if (dos.length < PE_DOS_BYTES) return { ok: false, reason: `文件太短，读不出 DOS 头（${dos.length} 字节）` }
  if (dos.readUInt16LE(0) !== 0x5a4d /* 'MZ' */) {
    return { ok: false, reason: '不是 PE 文件（缺 MZ 头）——文件损坏' }
  }
  if (coff.length < PE_COFF_BYTES) return { ok: false, reason: 'PE 签名/COFF 头被截断' }
  if (coff.readUInt32LE(0) !== 0x00004550 /* 'PE\0\0' */) {
    return { ok: false, reason: 'e_lfanew 处没有 PE 签名——文件损坏' }
  }

  const machine = coff.readUInt16LE(4)
  if (expectArch) {
    const want = expectArch === 'arm64' ? IMAGE_FILE_MACHINE_ARM64 : IMAGE_FILE_MACHINE_AMD64
    if (machine !== want) {
      const got =
        machine === IMAGE_FILE_MACHINE_ARM64 ? 'arm64' : machine === IMAGE_FILE_MACHINE_AMD64 ? 'x64' : `0x${machine.toString(16)}`
      return { ok: false, reason: `架构不符：期望 ${expectArch}，实际 ${got}` }
    }
  }

  const numSections = coff.readUInt16LE(6)
  if (sections.length < numSections * PE_SECTION_BYTES) {
    return { ok: false, reason: `section 表被截断（需 ${numSections * PE_SECTION_BYTES} 字节，实际 ${sections.length}）` }
  }
  for (let i = 0; i < numSections; i++) {
    const base = i * PE_SECTION_BYTES
    const sizeOfRawData = sections.readUInt32LE(base + 16)
    const pointerToRawData = sections.readUInt32LE(base + 20)
    if (pointerToRawData !== 0 && pointerToRawData + sizeOfRawData > fileSize) {
      return {
        ok: false,
        reason:
          `文件被截断：PE section #${i} 的原始数据结束于 ${pointerToRawData + sizeOfRawData}，` +
          `但文件只有 ${fileSize} 字节`
      }
    }
  }
  return { ok: true, detail: `${numSections} 个 section 均在界内` }
}

/** COFF 头里 SizeOfOptionalHeader 的位置（section 表起点 = peOff + 24 + 它）。 */
export function peSectionTableOffset(dos: Buffer, coff: Buffer): number {
  return dos.readUInt32LE(0x3c) + PE_COFF_BYTES + coff.readUInt16LE(20)
}

// ── io 壳（被 scripts 与 main 侧 worker 调用；renderer 不 import 本文件）────

export interface InspectOptions {
  /** 是 Windows PE 还是 Mach-O。 */
  format: 'macho' | 'pe'
  expectArch?: ExpectArch
  /** PE 的绝对下限；给 0 可关掉（单测用）。默认 WIN_MIN_BYTES。 */
  minBytes?: number
}

/**
 * 读文件头做走查。只读前几十 KB，不碰整个 233MB——完整性靠结构自洽判断，
 * 不需要也不应该把文件读一遍（那是 sha256 的活）。
 */
export function inspectExecutable(path: string, opts: InspectOptions): IntegrityResult {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return { ok: false, reason: `文件不存在：${path}` }
  }

  if (opts.format === 'pe') {
    const floor = opts.minBytes ?? WIN_MIN_BYTES
    if (size < floor) {
      return {
        ok: false,
        reason:
          `文件只有 ${size} 字节（下限 ${floor}）——完整的 CLI 可执行文件应有 ~177MB。` +
          `下载不完整（截断的 .exe 能启动，但会以 exit 1 / "cli exited before first init" 死掉）`
      }
    }
  }

  const fd = openSync(path, 'r')
  try {
    if (opts.format === 'pe') {
      const dos = Buffer.alloc(PE_DOS_BYTES)
      readSync(fd, dos, 0, PE_DOS_BYTES, 0)
      if (dos.readUInt16LE(0) !== 0x5a4d) return { ok: false, reason: '不是 PE 文件（缺 MZ 头）——文件损坏' }
      const peOff = dos.readUInt32LE(0x3c)
      const coff = Buffer.alloc(PE_COFF_BYTES)
      readSync(fd, coff, 0, PE_COFF_BYTES, peOff)
      if (coff.readUInt32LE(0) !== 0x00004550) return { ok: false, reason: 'e_lfanew 处没有 PE 签名——文件损坏' }
      const numSections = coff.readUInt16LE(6)
      const sections = Buffer.alloc(numSections * PE_SECTION_BYTES)
      readSync(fd, sections, 0, sections.length, peSectionTableOffset(dos, coff))
      return inspectPE(dos, coff, sections, size, opts.expectArch)
    }

    const head = Buffer.alloc(MACHO_HEADER_BYTES)
    readSync(fd, head, 0, MACHO_HEADER_BYTES, 0)
    const magic = head.readUInt32LE(0)
    if (magic !== MH_MAGIC_64 && magic !== MH_CIGAM_64) {
      return { ok: false, reason: `不是 64 位 Mach-O（magic=0x${magic.toString(16)}）——文件损坏或架构不符` }
    }
    const sizeofcmds = head.readUInt32LE(20)
    const cmds = Buffer.alloc(sizeofcmds)
    readSync(fd, cmds, 0, sizeofcmds, MACHO_HEADER_BYTES)
    return inspectMachO(head, cmds, size, opts.expectArch)
  } finally {
    closeSync(fd)
  }
}
