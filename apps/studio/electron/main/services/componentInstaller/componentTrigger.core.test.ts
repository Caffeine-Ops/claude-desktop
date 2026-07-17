import { describe, expect, test } from 'bun:test'
import { matchesPptPythonTrigger } from './componentTrigger.core'

describe('matchesPptPythonTrigger', () => {
  test('Skill 工具且 skill 含 ppt-master → 命中(含插件前缀形态)', () => {
    expect(matchesPptPythonTrigger('Skill', { skill: 'ppt-master' })).toBe(true)
    expect(matchesPptPythonTrigger('Skill', { skill: 'my-plugin:ppt-master' })).toBe(true)
  })
  test('Bash 工具且 command 含 ensure-python.sh → 命中(技能真正要 python 的那一刻)', () => {
    expect(matchesPptPythonTrigger('Bash', { command: 'source /x/skills/ppt-master/bin/ensure-python.sh' })).toBe(true)
  })
  test('不相干工具/参数/畸形输入 → 不命中且不抛', () => {
    expect(matchesPptPythonTrigger('Skill', { skill: 'draw' })).toBe(false)
    expect(matchesPptPythonTrigger('Bash', { command: 'ls -la' })).toBe(false)
    expect(matchesPptPythonTrigger('Read', { file_path: '/ppt-master' })).toBe(false)
    expect(matchesPptPythonTrigger('Skill', null)).toBe(false)
    expect(matchesPptPythonTrigger('Skill', undefined)).toBe(false)
    expect(matchesPptPythonTrigger('Skill', { skill: 42 })).toBe(false)
    expect(matchesPptPythonTrigger('Bash', 'not-an-object')).toBe(false)
  })
})
