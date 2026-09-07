import { describe, expect, test } from 'bun:test'

import {
  collectGeneratedImagePaths,
  collectSessionOutputCandidates
} from './sessionImages'

/* ── 夹具：拼一条最小化的会话消息（形状对齐 stores/chat 的 message） ── */

type Part =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call'
      toolName: string
      args: unknown
      result?: unknown
      endedAt?: number
    }

function msg(
  content: readonly Part[],
  opts: { running?: boolean } = {}
): unknown {
  return {
    role: 'assistant',
    status: { type: opts.running ? 'running' : 'complete' },
    content
  }
}

/** settled 的 imagegen Bash 调用：stdout 每行 `Wrote /abs/x.png`。 */
function imagegenCall(paths: readonly string[], settled = true): Part {
  return {
    type: 'tool-call',
    toolName: 'Bash',
    args: {
      command:
        'python3 ~/.claude/skills/imagegen/scripts/image_gen.py generate --prompt "a cat" --out /tmp'
    },
    result: paths.map((p) => `Wrote ${p}`).join('\n'),
    ...(settled ? { endedAt: 1 } : {})
  }
}

/** gpt-image-2 skill 的调用：stdout 是裸路径行。 */
function gptImage2Call(paths: readonly string[]): Part {
  return {
    type: 'tool-call',
    toolName: 'Bash',
    args: {
      command: 'node ~/.claude/skills/gpt-image-2/scripts/generate.js --prompt "x"'
    },
    result: paths.join('\n'),
    endedAt: 1
  }
}

const PROSE_RE =
  /(?:~\/|\/)[^\s"'`«»<>|()[\]{}]*\.(?:pptx?|pdf|docx?|xlsx?|csv|png|jpe?g|webp)\b/gi

/* ─────────────────────── collectGeneratedImagePaths ─────────────────────── */

describe('collectGeneratedImagePaths', () => {
  test('settled imagegen Bash 调用的 stdout 路径会被收进来', () => {
    const messages = [msg([imagegenCall(['/out/a.png'])])]
    expect(collectGeneratedImagePaths(messages)).toEqual(['/out/a.png'])
  })

  test('gpt-image-2 skill 的裸路径 stdout 同样识别', () => {
    const messages = [msg([gptImage2Call(['/out/b.webp'])])]
    expect(collectGeneratedImagePaths(messages)).toEqual(['/out/b.webp'])
  })

  test('历史恢复的调用（有 result 但没 endedAt）同样算已完成——重启后图库不能空', () => {
    // endedAt 是渲染层运行时才盖的戳，main 侧回放 JSONL 历史不带它；
    // 只认 endedAt 会让切回/重启后的会话一张图都扫不到（2026-09-07 真机复现）。
    const call = imagegenCall(['/out/restored.png'], false)
    const messages = [msg([call])]
    expect(collectGeneratedImagePaths(messages)).toEqual(['/out/restored.png'])
  })

  test('还在跑（result 尚未返回）的调用不算，哪怕 stdout 字段里有半截内容', () => {
    const messages = [
      msg(
        [
          {
            type: 'tool-call',
            toolName: 'Bash',
            args: { command: 'python3 image_gen.py generate --prompt "x"' }
          }
        ],
        { running: true }
      )
    ]
    expect(collectGeneratedImagePaths(messages)).toEqual([])
  })

  test('正文里嘴上提到的图片路径不算生成图（图库只收 AI 生成的）', () => {
    const messages = [
      msg([{ type: 'text', text: '你上传的 /Users/me/photo.png 我看过了' }])
    ]
    expect(collectGeneratedImagePaths(messages)).toEqual([])
  })

  test('非 imagegen 的 Bash 调用与非 Bash 工具一律忽略', () => {
    const messages = [
      msg([
        {
          type: 'tool-call',
          toolName: 'Bash',
          args: { command: 'ls /out' },
          result: '/out/a.png',
          endedAt: 1
        },
        {
          type: 'tool-call',
          toolName: 'Read',
          args: { file_path: '/out/b.png' },
          result: 'binary',
          endedAt: 1
        }
      ])
    ]
    expect(collectGeneratedImagePaths(messages)).toEqual([])
  })

  test('同一路径出现两次只保留一份', () => {
    const messages = [
      msg([imagegenCall(['/out/a.png'])]),
      msg([imagegenCall(['/out/a.png'])])
    ]
    expect(collectGeneratedImagePaths(messages)).toEqual(['/out/a.png'])
  })

  test('最新在前：后出现的图排前面（同一批次内也按落盘顺序倒过来）', () => {
    const messages = [
      msg([imagegenCall(['/out/1.png', '/out/2.png'])]),
      msg([{ type: 'text', text: '再来一张' }]),
      msg([imagegenCall(['/out/3.png'])])
    ]
    expect(collectGeneratedImagePaths(messages)).toEqual([
      '/out/3.png',
      '/out/2.png',
      '/out/1.png'
    ])
  })

  test('content 不是数组的消息（用户消息/系统消息）直接跳过，不抛错', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'system' },
      msg([imagegenCall(['/out/a.png'])])
    ]
    expect(collectGeneratedImagePaths(messages)).toEqual(['/out/a.png'])
  })
})

/* ───────────────────── collectSessionOutputCandidates ───────────────────── */

describe('collectSessionOutputCandidates（OutputsPanel 的候选扫描，行为对齐旧实现）', () => {
  test('已完成消息正文里的成果路径按出现顺序收集', () => {
    const messages = [
      msg([{ type: 'text', text: '做好了：/out/deck.pptx 和 /out/data.xlsx' }])
    ]
    expect(collectSessionOutputCandidates(messages, PROSE_RE)).toEqual([
      '/out/deck.pptx',
      '/out/data.xlsx'
    ])
  })

  test('正在流式输出的消息正文不扫（路径可能还没写完）', () => {
    const messages = [
      msg([{ type: 'text', text: '写到 /out/deck.pptx' }], { running: true })
    ]
    expect(collectSessionOutputCandidates(messages, PROSE_RE)).toEqual([])
  })

  test('正文路径与生成图交错时保持首次出现的顺序，且跨来源去重', () => {
    const messages = [
      msg([
        { type: 'text', text: '先出图' },
        imagegenCall(['/out/a.png']),
        { type: 'text', text: '图在 /out/a.png，文档在 /out/doc.docx' }
      ])
    ]
    expect(collectSessionOutputCandidates(messages, PROSE_RE)).toEqual([
      '/out/a.png',
      '/out/doc.docx'
    ])
  })

  test('超过 40 条时保留最新的 40 条——丢最旧的，不能丢刚生成的', () => {
    // 旧实现 slice(0, 40) 留的是最早出现的 40 条：长会话里最新一张图反而
    // 进不了图库和成果弹层（2026-09-07 code review 抓到）。
    const many = Array.from({ length: 45 }, (_, i) => `/out/f${i}.pdf`)
    const messages = [msg([{ type: 'text', text: many.join(' ') }])]
    const got = collectSessionOutputCandidates(messages, PROSE_RE)
    expect(got.length).toBe(40)
    expect(got[0]).toBe('/out/f5.pdf')
    expect(got[39]).toBe('/out/f44.pdf')
  })
})

/* ─────────────────────── collectSessionOutputs（一次扫描两份结果） ─────────────────────── */

describe('collectSessionOutputs', () => {
  test('一趟扫描同时给出候选列表与生成图集合，且与两个单独函数结果一致', async () => {
    const { collectSessionOutputs } = await import('./sessionImages')
    const messages = [
      msg([
        { type: 'text', text: '文档在 /out/doc.docx' },
        imagegenCall(['/out/a.png'])
      ])
    ]
    const both = collectSessionOutputs(messages, PROSE_RE)
    expect(both.candidates).toEqual(collectSessionOutputCandidates(messages, PROSE_RE))
    expect([...both.generated]).toEqual(collectGeneratedImagePaths(messages).reverse())
    expect(both.generated.has('/out/doc.docx')).toBe(false)
  })
})

describe('collectSessionOutputs.emissions（同路径被工具输出了几次）', () => {
  test('同一路径被两次 settled 调用输出 → 计数 2；只在正文提到的路径计 0', async () => {
    const { collectSessionOutputs } = await import('./sessionImages')
    const messages = [
      msg([imagegenCall(['/out/image_1.png'])]),
      msg([{ type: 'text', text: '图在 /out/image_1.png，文档 /out/doc.docx' }]),
      msg([imagegenCall(['/out/image_1.png'])])
    ]
    const r = collectSessionOutputs(messages, PROSE_RE)
    expect(r.emissions.get('/out/image_1.png')).toBe(2)
    expect(r.emissions.get('/out/doc.docx') ?? 0).toBe(0)
  })
})
