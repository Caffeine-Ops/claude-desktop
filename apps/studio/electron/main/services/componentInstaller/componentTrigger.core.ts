// 「AI 正要做 PPT」的 tool_use 侦听判据(P1c 触发器,纯函数供 bun test)。
// 为什么是这两个信号:做 PPT 没有界面按钮可挂功能门——是 AI 在会话里自主调用 ppt-master
// 技能(engine 的 tool_use 转发路所有工具调用必经,不像 canUseTool 会被预放行跳过)。
//  a) Skill + input.skill 含 'ppt-master':SDK 的技能调用形状(cli.js 铁证:工具名 'Skill'、
//     参数字段 skill: string);用 includes 而非 === 兼容将来可能的插件前缀(plugin:skill)。
//  b) Bash + command 含 'ensure-python.sh':技能引导文档让模型 source 这个脚本拿解释器,
//     是「真正要 python 的那一刻」,对 a 漏报(技能改名/直呼脚本)兜底。
// input 是未净化的 unknown(上游 block.input 形状不保证),所有取值都先窄化、绝不抛。
export function matchesPptPythonTrigger(toolName: string, input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const rec = input as Record<string, unknown>
  if (toolName === 'Skill') {
    return typeof rec.skill === 'string' && rec.skill.includes('ppt-master')
  }
  if (toolName === 'Bash') {
    return typeof rec.command === 'string' && rec.command.includes('ensure-python.sh')
  }
  return false
}
