import { describe, it, expect } from 'bun:test'

import {
  buildTranscriptMarkdown,
  toolCallSummary,
  transcriptFilename,
  type TranscriptMessage
} from './exportTranscript'

const AT = new Date('2026-09-28T10:30:00Z')

function md(messages: readonly TranscriptMessage[], title = '标题'): string {
  return buildTranscriptMarkdown(messages, { title, exportedAt: AT })
}

describe('buildTranscriptMarkdown — 头部', () => {
  it('第一行是会话标题的一级标题，紧跟导出日期署名行', () => {
    const out = md([{ role: 'user', content: [{ type: 'text', text: '在吗' }] }], '登录页报错文案')
    const lines = out.split('\n')
    expect(lines[0]).toBe('# 登录页报错文案')
    expect(lines[2]).toBe('> 导出于 2026-09-28 · Claude Desktop')
  })

  it('标题为空时用兜底名，不产生空的一级标题', () => {
    const out = md([{ role: 'user', content: [{ type: 'text', text: '在吗' }] }], '   ')
    expect(out.split('\n')[0]).toBe('# 未命名对话')
  })
})

describe('buildTranscriptMarkdown — 说话人与正文', () => {
  it('用户消息标「我」、助手消息标「Claude」，正文原样保留', () => {
    const out = md([
      { role: 'user', content: [{ type: 'text', text: '提示太技术了' }] },
      { role: 'assistant', content: [{ type: 'text', text: '我改成人话版本。' }] }
    ])
    expect(out).toContain('## 我\n\n提示太技术了')
    expect(out).toContain('## Claude\n\n我改成人话版本。')
  })

  it('content 是裸字符串（不是块数组）时也能渲染', () => {
    expect(md([{ role: 'user', content: '裸字符串' }])).toContain('## 我\n\n裸字符串')
  })

  it('同一条消息里的多个文本块之间留空行', () => {
    const out = md([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' }
        ]
      }
    ])
    expect(out).toContain('第一段\n\n第二段')
  })

  it('system 消息整条不进导出（用户从没看过它）', () => {
    const out = md([
      { role: 'system', content: [{ type: 'text', text: '你是一个助手' }] },
      { role: 'user', content: [{ type: 'text', text: '你好' }] }
    ])
    expect(out).not.toContain('你是一个助手')
    expect(out).toContain('## 我')
  })

  it('末尾只有一个换行，不留多余空行', () => {
    const out = md([{ role: 'user', content: [{ type: 'text', text: '就一句' }] }])
    expect(out.endsWith('就一句\n')).toBe(true)
  })
})

describe('buildTranscriptMarkdown — 思考块', () => {
  it('思考过程整块丢弃', () => {
    const out = md([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '让我想想用户到底要什么' },
          { type: 'text', text: '这样改' }
        ]
      }
    ])
    expect(out).not.toContain('让我想想')
    expect(out).toContain('这样改')
  })

  it('一条消息只剩思考时整条跳过，不留空的「## Claude」', () => {
    const out = md([
      { role: 'user', content: [{ type: 'text', text: '问题' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '嗯……' }] }
    ])
    expect(out).not.toContain('## Claude')
  })

  it('空白正文（含零宽空格占位符）不算内容', () => {
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: '​' }] }])
    expect(out).not.toContain('## Claude')
  })
})

describe('buildTranscriptMarkdown — 空会话', () => {
  it('没有任何可导出消息时只给头部，不抛错', () => {
    const out = md([])
    expect(out).toContain('# 标题')
    expect(out).not.toContain('##')
  })
})

describe('toolCallSummary — 认识的工具翻成人话', () => {
  it('读写编辑类只报文件名，不报又长又没用的绝对路径', () => {
    expect(toolCallSummary('Read', { file_path: '/a/b/LoginScreen.tsx' })).toBe(
      '读取 `LoginScreen.tsx`'
    )
    expect(toolCallSummary('Write', { file_path: '/a/b/new.ts' })).toBe('写入 `new.ts`')
    expect(toolCallSummary('Edit', { file_path: '/a/b/engine.ts' })).toBe('编辑 `engine.ts`')
  })

  it('Bash 优先用人话描述，没有描述才退回原始命令', () => {
    expect(toolCallSummary('Bash', { command: 'git status', description: '查看工作区状态' })).toBe(
      '执行 查看工作区状态'
    )
    expect(toolCallSummary('Bash', { command: 'git status' })).toBe('执行 `git status`')
  })

  it('搜索类报出搜的是什么', () => {
    expect(toolCallSummary('Grep', { pattern: '登录失败' })).toBe('搜索 `登录失败`')
    expect(toolCallSummary('Glob', { pattern: '**/*.tsx' })).toBe('查找文件 `**/*.tsx`')
    expect(toolCallSummary('WebSearch', { query: 'electron 签名' })).toBe('联网搜索 `electron 签名`')
  })

  it('技能与子任务有各自的说法', () => {
    expect(toolCallSummary('Skill', { skill: 'writing' })).toBe('调用技能 `writing`')
    expect(toolCallSummary('TodoWrite', {})).toBe('更新任务清单')
  })

  it('不认识的工具兜底成工具名，绝不抛错', () => {
    expect(toolCallSummary('mcp__foo__bar', { whatever: 1 })).toBe('调用 mcp__foo__bar')
    expect(toolCallSummary('Read', undefined)).toBe('调用 Read')
    expect(toolCallSummary('Read', { file_path: 123 })).toBe('调用 Read')
  })

  it('超长的值截断，免得一行摘要糊满半页', () => {
    const long = 'x'.repeat(200)
    const out = toolCallSummary('Grep', { pattern: long })
    expect(out.length).toBeLessThan(80)
    expect(out.endsWith('…`')).toBe(true)
  })

  it('值里的换行压成空格，不让一行摘要裂成多行破坏 Markdown 引用块', () => {
    expect(toolCallSummary('Bash', { command: 'a\nb' })).toBe('执行 `a b`')
  })
})

describe('buildTranscriptMarkdown — 工具调用', () => {
  it('工具调用压成一行 Markdown 引用，跟正文视觉分开', () => {
    const out = md([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先看看。' },
          { type: 'tool-call', toolName: 'Read', args: { file_path: '/a/LoginScreen.tsx' } },
          { type: 'text', text: '问题找到了。' }
        ]
      }
    ])
    expect(out).toContain('我先看看。\n\n> 🔧 读取 `LoginScreen.tsx`\n\n问题找到了。')
  })

  it('连续多个工具调用合并进同一个引用块，不各自占一段', () => {
    const out = md([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'Grep', args: { pattern: '登录' } },
          { type: 'tool-call', toolName: 'Read', args: { file_path: '/a/b.ts' } }
        ]
      }
    ])
    expect(out).toContain('> 🔧 搜索 `登录`\n> 🔧 读取 `b.ts`')
  })

  it('只有工具调用没有正文的消息仍然保留（它说明 AI 确实干了活）', () => {
    const out = md([
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'TodoWrite', args: {} }] }
    ])
    expect(out).toContain('## Claude\n\n> 🔧 更新任务清单')
  })
})

describe('buildTranscriptMarkdown — 图片与附件', () => {
  it('图片留占位符（Markdown 是单个文本文件，装不了图）', () => {
    const out = md([
      {
        role: 'user',
        content: [
          { type: 'image', image: 'data:image/png;base64,AAAA' },
          { type: 'text', text: '这个报错什么意思' }
        ]
      }
    ])
    expect(out).toContain('［图片］')
    expect(out).not.toContain('base64')
  })

  it('附件报出文件名', () => {
    const out = md([
      { role: 'user', content: [{ type: 'file', filename: '合同.pdf', data: 'xxx' }] }
    ])
    expect(out).toContain('［附件：合同.pdf］')
  })

  it('附件没有文件名时不渲染成「［附件：undefined］」', () => {
    const out = md([{ role: 'user', content: [{ type: 'file', data: 'xxx' }] }])
    expect(out).toContain('［附件］')
    expect(out).not.toContain('undefined')
  })
})

describe('buildTranscriptMarkdown — 命令标记', () => {
  it('内部协议标记不能漏进导出文件，只留用户真正写的那句话', () => {
    const raw =
      '[[image-edit]]{"name":"a.png","path":"/a.png","edits":[{"x":1,"y":2,"note":"这里"}],"extra":"去掉水印"}'
    const out = md([{ role: 'user', content: [{ type: 'text', text: raw }] }])
    expect(out).not.toContain('[[image-edit]]')
    expect(out).not.toContain('"path"')
    expect(out).toContain('去掉水印')
  })

  it('协议消息被 SDK 按长度截断时也不漏 JSON 残片', () => {
    const out = md([
      { role: 'user', content: [{ type: 'text', text: '[[image-edit]]{"name":"a.png","ed' }] }
    ])
    expect(out).not.toContain('[[image-edit]]')
    expect(out).not.toContain('name')
  })
})

describe('transcriptFilename', () => {
  it('文件名＝标题 + 日期 + .md', () => {
    expect(transcriptFilename('登录页报错文案', AT)).toBe('登录页报错文案-2026-09-28.md')
  })

  it('剥掉文件系统不接受的字符，别让保存框报错', () => {
    expect(transcriptFilename('a/b:c*d?e"f<g>h|i\\j', AT)).toBe('a-b-c-d-e-f-g-h-i-j-2026-09-28.md')
  })

  it('换行与首尾空白不进文件名', () => {
    expect(transcriptFilename('  前\n后  ', AT)).toBe('前 后-2026-09-28.md')
  })

  it('超长标题截断，免得撞上文件名长度上限', () => {
    const name = transcriptFilename('标'.repeat(200), AT)
    expect(name.length).toBeLessThanOrEqual(60)
    expect(name.endsWith('-2026-09-28.md')).toBe(true)
  })

  it('标题为空或只剩非法字符时用兜底名', () => {
    expect(transcriptFilename('   ', AT)).toBe('未命名对话-2026-09-28.md')
    expect(transcriptFilename('///', AT)).toBe('未命名对话-2026-09-28.md')
  })
})

describe('buildTranscriptMarkdown — 正文标题层级', () => {
  it('正文里的一级标题降级，不与文档标题抢同一层（真机实锤：AI 回答自带「# 今日要闻简报」）', () => {
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: '# 今日要闻简报' }] }])
    expect(out).toContain('### 今日要闻简报')
    expect(out).not.toContain('\n# 今日要闻简报')
  })

  it('层级关系保住：原来的 h1/h2/h3 降完仍是三层，不压成一层', () => {
    const out = md([
      { role: 'assistant', content: [{ type: 'text', text: '# 甲\n\n## 乙\n\n### 丙' }] }
    ])
    expect(out).toContain('### 甲')
    expect(out).toContain('#### 乙')
    expect(out).toContain('##### 丙')
  })

  it('已经很深的标题封顶在六级（Markdown 没有七级）', () => {
    const out = md([
      { role: 'assistant', content: [{ type: 'text', text: '##### 五级\n\n###### 六级' }] }
    ])
    expect(out).toContain('###### 五级')
    expect(out).toContain('###### 六级')
    expect(out).not.toContain('#######')
  })

  it('代码块里的 # 是注释不是标题，一个字都不能动', () => {
    const src = ['```bash', '# 安装依赖', 'bun install', '```'].join('\n')
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: src }] }])
    expect(out).toContain('# 安装依赖')
    expect(out).not.toContain('### 安装依赖')
  })

  it('波浪号围栏的代码块同样豁免', () => {
    const src = ['~~~', '# 不是标题', '~~~'].join('\n')
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: src }] }])
    expect(out).toContain('# 不是标题')
  })

  it('`#` 后面没空格的不是标题（话题标签、C 预处理指令）', () => {
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: '#话题 与 #include' }] }])
    expect(out).toContain('#话题 与 #include')
  })
})

describe('toolCallSummary — 真机走查补漏的工具', () => {
  it('ToolSearch 报出在加载什么工具（真机里出现过裸「调用 ToolSearch」）', () => {
    expect(toolCallSummary('ToolSearch', { query: 'select:WebSearch,WebFetch' })).toBe(
      '加载工具 `select:WebSearch,WebFetch`'
    )
  })

  it('WebFetch 报出抓的网址', () => {
    expect(toolCallSummary('WebFetch', { url: 'https://example.com/a' })).toBe(
      '抓取网页 `https://example.com/a`'
    )
  })

  it('Task 系列报出干了什么', () => {
    expect(toolCallSummary('Task', { description: '排查登录失败' })).toBe('派出子任务 排查登录失败')
    expect(toolCallSummary('TaskCreate', { description: '写测试' })).toBe('派出子任务 写测试')
  })
})

/* ── 以下为 2026-09-28 代码审查后补的回归测试 ── */

describe('buildTranscriptMarkdown — 用户正文的展示层变换（审查①）', () => {
  it('文件提及压成文件名，不把用户的家目录绝对路径写进要分享的文档', () => {
    const out = md([
      {
        role: 'user',
        content: [{ type: 'text', text: '帮我改这个 @"/Users/kika/Desktop/季度汇报.pptx"' }]
      }
    ])
    expect(out).toContain('季度汇报.pptx')
    expect(out).not.toContain('/Users/kika')
  })

  it('开头的已知技能命令换成屏幕上那个友好名', () => {
    const out = md([
      {
        role: 'user',
        content: [{ type: 'text', text: '/cowork:ppt-creator 做一份武汉大学介绍' }]
      }
    ])
    expect(out).toContain('［制作PPT］')
    expect(out).toContain('做一份武汉大学介绍')
    expect(out).not.toContain('/cowork:ppt-creator')
  })

  it('命中命令正则但没登记在注册表里的，保持原样（与 UserMessage 同规则）', () => {
    // `/claude-desktop:ppt-creator` 形如命令却不在表里（真实键是 /cowork:ppt-creator）
    const raw = '/claude-desktop:ppt-creator 内容'
    const out = md([{ role: 'user', content: [{ type: 'text', text: raw }] }])
    expect(out).toContain(raw)
  })

  it('助手正文不做这层变换——屏幕上 AI 回答就是原样渲染的', () => {
    const out = md([
      { role: 'assistant', content: [{ type: 'text', text: '路径是 @"/Users/kika/a.txt"' }] }
    ])
    expect(out).toContain('@"/Users/kika/a.txt"')
  })
})

describe('demoteHeadings — 围栏闭合规则（审查②）', () => {
  it('嵌套围栏：外层四个反引号包住内层三个，里面的 # 一个字都不能动', () => {
    const src = ['````markdown', '```bash', '# 安装依赖', '```', '````'].join('\n')
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: src }] }])
    expect(out).toContain('# 安装依赖')
    expect(out).not.toContain('### 安装依赖')
  })

  it('带 info string 的行是开围栏不是闭围栏，不能把块提前关掉', () => {
    const src = ['```', '# 注释', '```js', '# 还在块里', '```'].join('\n')
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: src }] }])
    expect(out).toContain('# 注释')
    expect(out).toContain('# 还在块里')
    expect(out).not.toContain('### ')
  })

  it('闭合围栏比开启的长是允许的（CommonMark 只要求不短于）', () => {
    const src = ['```', '# 注释', '`````'].join('\n')
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: src }] }])
    expect(out).toContain('# 注释')
  })

  it('围栏正常闭合后，后面的标题照常降级', () => {
    const src = ['```', 'code', '```', '', '# 真标题'].join('\n')
    const out = md([{ role: 'assistant', content: [{ type: 'text', text: src }] }])
    expect(out).toContain('### 真标题')
  })
})

describe('toolCallSummary — 反引号转义（审查③）', () => {
  it('值里含反引号时不能裂成乱码，要用更长的分隔符包住', () => {
    const out = toolCallSummary('Bash', { command: 'echo `date`' })
    expect(out).not.toBe('执行 `echo `date``')
    expect(out).toContain('echo `date`')
    // 代码跨度的分隔符必须比值里最长的连续反引号更长
    expect(out.startsWith('执行 ``')).toBe(true)
  })

  it('不含反引号的值仍用最简单的单反引号', () => {
    expect(toolCallSummary('Grep', { pattern: 'abc' })).toBe('搜索 `abc`')
  })
})

describe('toolCallSummary — argsText 回退（审查④）', () => {
  it('args 是空对象但 argsText 有内容时，要拿 argsText 而不是退化成「调用 Bash」', () => {
    const out = md([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolName: 'Bash',
            args: {},
            argsText: '{"command":"git status"}'
          }
        ]
      }
    ])
    expect(out).toContain('执行 `git status`')
    expect(out).not.toContain('调用 Bash')
  })

  it('args 空、argsText 也解析不出来时才退化成工具名', () => {
    const out = md([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolName: 'Bash', args: {}, argsText: '{"comm' }]
      }
    ])
    expect(out).toContain('调用 Bash')
  })
})

/* ── 审查⑤：导出内容跟随界面语言（2026-09-28） ── */

describe('buildTranscriptMarkdown — 英文界面', () => {
  const en = (messages: readonly TranscriptMessage[], title = 'Title'): string =>
    buildTranscriptMarkdown(messages, { title, exportedAt: AT, lang: 'en' })

  it('署名行与说话人抬头走英文', () => {
    const out = en([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
    ])
    expect(out).toContain('> Exported 2026-09-28 · Claude Desktop')
    expect(out).toContain('## Me')
    expect(out).toContain('## Claude')
    expect(out).not.toContain('## 我')
    expect(out).not.toContain('导出于')
  })

  it('兜底标题走英文', () => {
    expect(en([{ role: 'user', content: [{ type: 'text', text: 'x' }] }], '  ').split('\n')[0]).toBe(
      '# Untitled chat'
    )
  })

  it('图片与附件占位走英文', () => {
    const out = en([
      {
        role: 'user',
        content: [
          { type: 'image', image: 'x' },
          { type: 'file', filename: 'a.pdf' }
        ]
      }
    ])
    expect(out).toContain('[Image]')
    expect(out).toContain('[Attachment: a.pdf]')
  })

  it('工具摘要走英文', () => {
    const out = en([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'Read', args: { file_path: '/a/b.ts' } },
          { type: 'tool-call', toolName: 'TodoWrite', args: {} },
          { type: 'tool-call', toolName: 'mcp__x__y', args: {} }
        ]
      }
    ])
    expect(out).toContain('Read `b.ts`')
    expect(out).toContain('Updated todo list')
    expect(out).toContain('Called mcp__x__y')
  })

  it('不传 lang 时保持中文（既有调用方不受影响）', () => {
    const out = md([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])
    expect(out).toContain('## 我')
    expect(out).toContain('导出于')
  })
})

describe('transcriptFilename — 英文界面', () => {
  it('兜底文件名走英文', () => {
    expect(transcriptFilename('   ', AT, 'en')).toBe('Untitled chat-2026-09-28.md')
  })

  it('不传语言时仍是中文兜底', () => {
    expect(transcriptFilename('   ', AT)).toBe('未命名对话-2026-09-28.md')
  })
})

describe('toolCallSummary — 英文界面', () => {
  it('动词与兜底都走英文', () => {
    expect(toolCallSummary('Bash', { command: 'ls' }, 'en')).toBe('Ran `ls`')
    expect(toolCallSummary('Bash', { command: 'ls', description: 'list files' }, 'en')).toBe(
      'Ran list files'
    )
    expect(toolCallSummary('WebSearch', { query: 'q' }, 'en')).toBe('Web search `q`')
    expect(toolCallSummary('Read', undefined, 'en')).toBe('Called Read')
  })

  it('不传语言时仍是中文', () => {
    expect(toolCallSummary('Bash', { command: 'ls' })).toBe('执行 `ls`')
  })
})
