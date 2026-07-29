import { describe, expect, test } from 'bun:test'
import {
  inspectMachO,
  inspectPE,
  peSectionTableOffset,
  MACHO_HEADER_BYTES,
  PE_COFF_BYTES,
  PE_DOS_BYTES,
  PE_SECTION_BYTES
} from './binaryIntegrity'

/**
 * 手搓最小 Mach-O / PE 头。
 *
 * 为什么值得这么造：这套走查唯一要抓的失败（截断下载）在真实世界里需要一个
 * 177MB 的坏文件才能复现，没法进测试。而头结构本身是纯算术，手搓 32~200 字节
 * 就能把每条分支都走到——包括「文件被截断」这条最重要的。
 */

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c
const MACHINE_AMD64 = 0x8664
const MACHINE_ARM64 = 0xaa64

function machoHead(o: { magic?: number; cputype?: number; ncmds: number; sizeofcmds: number }): Buffer {
  const b = Buffer.alloc(MACHO_HEADER_BYTES)
  b.writeUInt32LE(o.magic ?? 0xfeedfacf, 0)
  b.writeUInt32LE(o.cputype ?? CPU_TYPE_ARM64, 4)
  b.writeUInt32LE(o.ncmds, 16)
  b.writeUInt32LE(o.sizeofcmds, 20)
  return b
}

/** linkedit_data_command：cmd, cmdsize, dataoff, datasize。 */
function lcCodeSignature(dataoff: number, datasize: number): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(0x1d, 0)
  b.writeUInt32LE(16, 4)
  b.writeUInt32LE(dataoff, 8)
  b.writeUInt32LE(datasize, 12)
  return b
}

/** 一条无关的 load command（用来验证遍历会跳过它）。 */
function lcOther(cmdsize = 16): Buffer {
  const b = Buffer.alloc(cmdsize)
  b.writeUInt32LE(0x19 /* LC_SEGMENT_64 */, 0)
  b.writeUInt32LE(cmdsize, 4)
  return b
}

describe('inspectMachO', () => {
  test('签名段在界内 → ok', () => {
    const cmds = lcCodeSignature(900, 100)
    const r = inspectMachO(machoHead({ ncmds: 1, sizeofcmds: cmds.length }), cmds, 1000)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.detail).toContain('界内')
  })

  test('截断：签名段越过文件尾 → 失败并报出两个数字', () => {
    const cmds = lcCodeSignature(244_000_000, 530_512)
    const r = inspectMachO(machoHead({ ncmds: 1, sizeofcmds: cmds.length }), cmds, 5_000_000)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('截断')
      expect(r.reason).toContain('244530512')
      expect(r.reason).toContain('5000000')
    }
  })

  test('边界：dataoff+datasize 恰好等于文件大小 → ok（不是 off-by-one 的受害者）', () => {
    const cmds = lcCodeSignature(900, 100)
    const r = inspectMachO(machoHead({ ncmds: 1, sizeofcmds: cmds.length }), cmds, 1000)
    expect(r.ok).toBe(true)
  })

  test('magic 不对 → 失败', () => {
    const cmds = lcCodeSignature(0, 0)
    const r = inspectMachO(machoHead({ magic: 0xdeadbeef, ncmds: 1, sizeofcmds: cmds.length }), cmds, 1000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('Mach-O')
  })

  test('头太短 → 失败', () => {
    const r = inspectMachO(Buffer.alloc(8), Buffer.alloc(0), 1000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('太短')
  })

  test('架构断言：期望 arm64 拿到 x64 → 失败（sha256 抓不到的那一类）', () => {
    const cmds = lcCodeSignature(900, 100)
    const r = inspectMachO(machoHead({ cputype: CPU_TYPE_X86_64, ncmds: 1, sizeofcmds: cmds.length }), cmds, 1000, 'arm64')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('架构不符')
      expect(r.reason).toContain('Exec format error')
    }
  })

  test('架构断言：相符 → ok', () => {
    const cmds = lcCodeSignature(900, 100)
    const r = inspectMachO(machoHead({ cputype: CPU_TYPE_X86_64, ncmds: 1, sizeofcmds: cmds.length }), cmds, 1000, 'x64')
    expect(r.ok).toBe(true)
  })

  test('不给 expectArch 时不校验架构', () => {
    const cmds = lcCodeSignature(900, 100)
    const r = inspectMachO(machoHead({ cputype: CPU_TYPE_X86_64, ncmds: 1, sizeofcmds: cmds.length }), cmds, 1000)
    expect(r.ok).toBe(true)
  })

  test('没有签名段 → ok，但 detail 点出来（不硬失败：未签名却完整是另一个问题）', () => {
    const cmds = lcOther()
    const r = inspectMachO(machoHead({ ncmds: 1, sizeofcmds: cmds.length }), cmds, 1000)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.detail).toContain('没有 LC_CODE_SIGNATURE')
  })

  test('多条 load command，签名段在后面也能找到', () => {
    const cmds = Buffer.concat([lcOther(24), lcCodeSignature(2_000_000, 1)])
    const r = inspectMachO(machoHead({ ncmds: 2, sizeofcmds: cmds.length }), cmds, 1000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('截断')
  })

  test('cmds 短于声明的 sizeofcmds → 失败（load commands 本身被截断）', () => {
    const r = inspectMachO(machoHead({ ncmds: 1, sizeofcmds: 999 }), Buffer.alloc(16), 1000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('load commands')
  })

  test('cmdsize=0 的畸形头不会死循环', () => {
    const bad = Buffer.alloc(32) // cmd=0, cmdsize=0
    const r = inspectMachO(machoHead({ ncmds: 100, sizeofcmds: 32 }), bad, 1000)
    expect(r.ok).toBe(true) // 停下来而不是挂住，没找到签名段
  })
})

// ── PE ────────────────────────────────────────────────────────────────

function peDos(peOff: number, magic = 0x5a4d): Buffer {
  const b = Buffer.alloc(PE_DOS_BYTES)
  b.writeUInt16LE(magic, 0)
  b.writeUInt32LE(peOff, 0x3c)
  return b
}

function peCoff(o: { machine?: number; numSections: number; sizeOfOptionalHeader?: number; sig?: number }): Buffer {
  const b = Buffer.alloc(PE_COFF_BYTES)
  b.writeUInt32LE(o.sig ?? 0x00004550, 0)
  b.writeUInt16LE(o.machine ?? MACHINE_AMD64, 4)
  b.writeUInt16LE(o.numSections, 6)
  b.writeUInt16LE(o.sizeOfOptionalHeader ?? 240, 20)
  return b
}

function peSections(list: Array<{ ptr: number; size: number }>): Buffer {
  const b = Buffer.alloc(list.length * PE_SECTION_BYTES)
  list.forEach((s, i) => {
    b.writeUInt32LE(s.size, i * PE_SECTION_BYTES + 16)
    b.writeUInt32LE(s.ptr, i * PE_SECTION_BYTES + 20)
  })
  return b
}

describe('inspectPE', () => {
  test('所有 section 在界内 → ok', () => {
    const r = inspectPE(peDos(0x80), peCoff({ numSections: 2 }), peSections([{ ptr: 512, size: 400 }, { ptr: 1024, size: 500 }]), 2000)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.detail).toContain('2 个 section')
  })

  test('某个 section 越过文件尾 → 失败并指出是第几个', () => {
    const r = inspectPE(peDos(0x80), peCoff({ numSections: 2 }), peSections([{ ptr: 512, size: 400 }, { ptr: 1024, size: 99_000 }]), 2000)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('截断')
      expect(r.reason).toContain('#1')
    }
  })

  test('pointerToRawData=0 的 section 被跳过（bss 之类没有原始数据）', () => {
    const r = inspectPE(peDos(0x80), peCoff({ numSections: 1 }), peSections([{ ptr: 0, size: 999_999 }]), 100)
    expect(r.ok).toBe(true)
  })

  test('缺 MZ → 失败', () => {
    const r = inspectPE(peDos(0x80, 0x4242), peCoff({ numSections: 0 }), Buffer.alloc(0), 2000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('MZ')
  })

  test('PE 签名不对 → 失败', () => {
    const r = inspectPE(peDos(0x80), peCoff({ numSections: 0, sig: 0xdeadbeef }), Buffer.alloc(0), 2000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('PE 签名')
  })

  test('架构断言：期望 x64 拿到 arm64 → 失败', () => {
    const r = inspectPE(peDos(0x80), peCoff({ machine: MACHINE_ARM64, numSections: 0 }), Buffer.alloc(0), 2000, 'x64')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('架构不符')
  })

  test('section 表本身被截断 → 失败', () => {
    const r = inspectPE(peDos(0x80), peCoff({ numSections: 5 }), peSections([{ ptr: 512, size: 8 }]), 2000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('section 表')
  })
})

describe('peSectionTableOffset', () => {
  test('= e_lfanew + 24 + SizeOfOptionalHeader', () => {
    expect(peSectionTableOffset(peDos(0x100), peCoff({ numSections: 1, sizeOfOptionalHeader: 240 }))).toBe(0x100 + 24 + 240)
  })
})
