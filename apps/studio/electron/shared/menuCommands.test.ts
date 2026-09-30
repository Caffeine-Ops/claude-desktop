import { describe, expect, it } from 'bun:test'

import {
  MENU_COMMANDS,
  RESERVED_ACCELERATORS,
  menuCommandsIn
} from './menuCommands'

/**
 * 这张表是「菜单项 + 加速键」的单一事实源，**本文件是它唯一的硬防线**。
 *
 * 为什么值得测一张看起来一目了然的常量表：快捷键冲突是**静默失效**的
 * ——两个菜单项抢同一个键，Electron 不报错、不警告，只是其中一个永远
 * 不触发；跨平台前缀写错（'Cmd+N' 而非 'CmdOrCtrl+N'）同样静默，mac
 * 全好而 Windows 整条不响应。和 electronLanguages 那次「列错名字 =
 * 静默删光」是同一类事故：人眼扫不出来，断言能。
 */

describe('MENU_COMMANDS — 冲突防线', () => {
  it('同一个加速键不会挂给两个动作', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const cmd of MENU_COMMANDS) {
      const prev = seen.get(cmd.accelerator)
      if (prev) clashes.push(`${cmd.accelerator}: ${prev} / ${cmd.action}`)
      else seen.set(cmd.accelerator, cmd.action)
    }
    expect(clashes).toEqual([])
  })

  it('同一个动作不会出现两次', () => {
    const actions = MENU_COMMANDS.map((c) => c.action)
    expect(new Set(actions).size).toBe(actions.length)
  })

  it('加速键不与已被占用的键冲突（⌘, / ⌘W / DevTools…）', () => {
    const taken = MENU_COMMANDS.filter((c) =>
      RESERVED_ACCELERATORS.includes(c.accelerator)
    ).map((c) => `${c.action} → ${c.accelerator}`)
    expect(taken).toEqual([])
  })
})

describe('MENU_COMMANDS — 跨平台纪律', () => {
  it('加速键一律用 CmdOrCtrl 前缀，不写死 Cmd/Ctrl', () => {
    // 写死 'Cmd+' 在 Windows 上整条静默失效，写死 'Ctrl+' 则 mac 失效。
    // Electron 的 CmdOrCtrl 是唯一能同时活在三平台的写法。
    const hardcoded = MENU_COMMANDS.filter(
      (c) => /\bCmd\+/.test(c.accelerator) || /\bCtrl\+/.test(c.accelerator)
    ).map((c) => `${c.action} → ${c.accelerator}`)
    expect(hardcoded).toEqual([])
  })

  it('每条命令都有非空文案（菜单项没有标签等于看不见）', () => {
    const blank = MENU_COMMANDS.filter((c) => c.label.trim() === '').map((c) => c.action)
    expect(blank).toEqual([])
  })
})

describe('MENU_COMMANDS — 分组内的视觉分隔', () => {
  it('每组的第一条不标 separatorBefore（组首画分隔线会多出一条空线）', () => {
    for (const group of ['file', 'view'] as const) {
      const first = menuCommandsIn(group)[0]
      expect(first?.separatorBefore ?? false).toBe(false)
    }
  })

  it('「导出对话」前有分隔线——它作用于当前会话，与上面的导航项不同类', () => {
    const exportCmd = MENU_COMMANDS.find((c) => c.action === 'export-transcript')
    expect(exportCmd?.separatorBefore).toBe(true)
  })
})

describe('menuCommandsIn', () => {
  it('只返回该组的命令', () => {
    const file = menuCommandsIn('file')
    expect(file.length).toBeGreaterThan(0)
    expect(file.every((c) => c.group === 'file')).toBe(true)
  })

  it('保持表里的声明顺序（菜单项顺序即用户看到的顺序）', () => {
    const view = menuCommandsIn('view')
    const declared = MENU_COMMANDS.filter((c) => c.group === 'view').map((c) => c.action)
    expect(view.map((c) => c.action)).toEqual(declared)
  })

  it('两个组都非空——任一组空掉说明整组菜单没挂上', () => {
    expect(menuCommandsIn('file').length).toBeGreaterThan(0)
    expect(menuCommandsIn('view').length).toBeGreaterThan(0)
  })
})
