import { describe, expect, it } from 'bun:test'

import type { TranscriptMessage } from './exportTranscript'
import { findInMessages, revealStepsNeeded, stepHit } from './threadFind'

/**
 * 对话内查找（⌘F）的检索逻辑。
 *
 * 搜的是**内存里的完整消息数组**，不是屏幕上的 DOM——长对话默认只挂载最近
 * 30 条（chat.ts 的 HISTORY_WINDOW_INITIAL），拿浏览器自带的整页查找只能搜
 * 到眼前那一屏，搜不到的用户会以为「没这句话」。
 */

const u = (text: string): TranscriptMessage => ({
  role: 'user',
  content: [{ type: 'text', text }]
})
const a = (text: string): TranscriptMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }]
})

describe('findInMessages — 基本检索', () => {
  it('命中的消息按它在数组里的下标返回——跳转要靠这个下标揭开历史窗口', () => {
    const hits = findInMessages([u('在吗'), a('在的'), u('部署脚本在哪')], '部署')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.messageIndex).toBe(2)
  })

  it('用户消息和 AI 回复都搜，并标出各自是谁说的', () => {
    const hits = findInMessages([u('部署脚本在哪'), a('部署脚本在 scripts/ 下')], '部署')
    expect(hits.map((h) => h.role)).toEqual(['user', 'assistant'])
  })

  it('多条命中按消息顺序返回，不是按相关度——⌘F 的「下一个」是往下走', () => {
    const hits = findInMessages([a('甲'), u('找我'), a('乙'), u('也找我')], '找我')
    expect(hits.map((h) => h.messageIndex)).toEqual([1, 3])
  })

  it('大小写不敏感', () => {
    expect(findInMessages([a('跑 Bun Test 看看')], 'bun test')).toHaveLength(1)
  })

  it('中文直接子串匹配，不需要分词', () => {
    expect(findInMessages([u('帮我整理今天的要闻简报')], '要闻')).toHaveLength(1)
  })

  it('content 是裸字符串（不是块数组）时同样能搜', () => {
    expect(findInMessages([{ role: 'user', content: '裸字符串里的部署脚本' }], '部署')).toHaveLength(1)
  })
})

describe('findInMessages — 一条消息里命中多次', () => {
  it('同一条消息算一项，用 count 记出现次数', () => {
    // 为什么按消息去重而不是逐个命中各算一项：定位只到消息级（不做字符级
    // 高亮），同一条消息里的第 2、3 次命中跳过去画面不会动，用户会以为
    // 「下一个」卡住了。计数因此按消息走——每次跳转都真的换一条。
    const hits = findInMessages([a('部署脚本、部署目录、部署日志')], '部署')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.count).toBe(3)
  })

  it('重叠的出现不重复计数（按不重叠的次数数）', () => {
    expect(findInMessages([a('aaaa')], 'aa')[0]!.count).toBe(2)
  })

  it('同一条消息的多个文本块合起来算一条', () => {
    const msg: TranscriptMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: '第一段提到部署' },
        { type: 'text', text: '第二段也提到部署' }
      ]
    }
    const hits = findInMessages([msg], '部署')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.count).toBe(2)
  })
})

describe('findInMessages — markdown 标记不能挡住命中', () => {
  it('加粗夹在词中间：屏幕上读作「部署脚本」，就该搜得到', () => {
    // 这是本功能最隐蔽的坑。AI 回复存的原文是 `**部署**脚本`，用户眼睛看到
    // 的是「部署脚本」——不剥标记就命中不了，表现成「明明屏幕上有这四个
    // 字却搜不到」，用户只会判定功能坏了。
    expect(findInMessages([a('在 scripts 下，**部署**脚本会先跑 typecheck')], '部署脚本')).toHaveLength(1)
  })

  it('行内代码包住的内容搜得到', () => {
    expect(findInMessages([a('跑 `bun run typecheck` 就行')], 'bun run typecheck')).toHaveLength(1)
  })

  it('链接的显示文字搜得到（url 不算，用户看不到它）', () => {
    const hits = findInMessages([a('详见 [部署文档](https://example.com/deploy)')], '部署文档')
    expect(hits).toHaveLength(1)
    expect(findInMessages([a('详见 [部署文档](https://example.com/deploy)')], 'example.com')).toHaveLength(0)
  })

  it('删除线不挡住命中', () => {
    expect(findInMessages([a('~~旧方案~~ 换成新方案')], '旧方案')).toHaveLength(1)
  })

  it('搜索词自己带 markdown 标记时也能对上（两边同样处理）', () => {
    // 用户常直接从屏幕上复制一段带格式的文字粘进搜索框。
    expect(findInMessages([a('**部署**脚本')], '**部署**脚本')).toHaveLength(1)
  })

  it('下划线不剥——foo_bar 这种标识符要能原样搜到', () => {
    // 刻意不把 `_` 当斜体标记剥掉：中文环境里用 `_` 做斜体极罕见，而它在
    // 代码标识符里到处都是，剥了会让 foo_bar 和 foobar 互相误命中。
    expect(findInMessages([a('改 snake_case 那个字段')], 'snake_case')).toHaveLength(1)
  })
})

describe('findInMessages — 不该搜的内容', () => {
  it('空搜索词 → 零命中（不是「全部命中」）', () => {
    expect(findInMessages([u('随便什么'), a('随便什么')], '')).toEqual([])
  })

  it('纯空白搜索词 → 零命中', () => {
    expect(findInMessages([u('随便什么')], '   \n ')).toEqual([])
  })

  it('system 消息不搜——用户从没看过它', () => {
    const sys: TranscriptMessage = {
      role: 'system',
      content: [{ type: 'text', text: '你是一个部署助手' }]
    }
    expect(findInMessages([sys], '部署')).toEqual([])
  })

  it('AI 的思考过程不搜（2026-10-09 用户拍板的检索范围）', () => {
    const msg: TranscriptMessage = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '我先想想部署这件事' },
        { type: 'text', text: '好的' }
      ]
    }
    expect(findInMessages([msg], '部署')).toEqual([])
  })

  it('工具调用与其输出不搜——一次 grep 的输出能把计数撑到几百，上下跳转就废了', () => {
    const msg: TranscriptMessage = {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolName: 'Bash', args: { command: './部署.sh' }, result: '部署完成' },
        { type: 'text', text: '跑完了' }
      ]
    }
    expect(findInMessages([msg], '部署')).toEqual([])
  })

  it('图片块不参与检索', () => {
    const msg: TranscriptMessage = {
      role: 'user',
      content: [{ type: 'image', image: '部署截图.png' }]
    }
    expect(findInMessages([msg], '部署')).toEqual([])
  })
})

describe('findInMessages — 协议标记消息按屏幕上的样子搜', () => {
  it('表格框选消息搜得到它的问题正文，搜不到内部 JSON 字段名', () => {
    // 这条消息在屏幕上渲染成卡片（文件名 + 问题），完整 TSV 和 JSON 字段
    // 用户根本看不见。检索跟着屏幕走，所以先过 stripMessageMarker。
    const raw =
      '[[sheet-selection]]{"name":"销售表.xlsx","path":"/p/销售表.xlsx",' +
      '"sheet":"Sheet1","range":"A1:C9","q":"这几列的增长率算一下"}\n' +
      'A1\tB1\tC1'
    expect(findInMessages([u(raw)], '增长率')).toHaveLength(1)
    expect(findInMessages([u(raw)], 'sheet-selection')).toEqual([])
  })
})

describe('stepHit — 「上一个 / 下一个」的环绕', () => {
  it('往下走到底再按，回到第一条——⌘F 的环绕语义', () => {
    expect(stepHit(2, 3, 1)).toBe(0)
  })

  it('往上走到头再按，跳到最后一条', () => {
    expect(stepHit(0, 3, -1)).toBe(2)
  })

  it('中间位置正常前后走', () => {
    expect(stepHit(1, 3, 1)).toBe(2)
    expect(stepHit(1, 3, -1)).toBe(0)
  })

  it('还没选中任何一条时，往下走选第一条', () => {
    expect(stepHit(-1, 3, 1)).toBe(0)
  })

  it('还没选中任何一条时，往上走选最后一条——想看最近的命中', () => {
    expect(stepHit(-1, 3, -1)).toBe(2)
  })

  it('零命中时没有「当前」，返回 -1 而不是 0（0 会被当成合法下标）', () => {
    expect(stepHit(-1, 0, 1)).toBe(-1)
    expect(stepHit(-1, 0, -1)).toBe(-1)
  })

  it('只有一条命中时怎么按都停在它身上', () => {
    expect(stepHit(0, 1, 1)).toBe(0)
    expect(stepHit(0, 1, -1)).toBe(0)
  })
})

describe('revealStepsNeeded — 跳过去之前要揭开几次历史窗口', () => {
  it('目标消息已经挂载时不用揭——0 次', () => {
    // historyWindowStart=30 表示前 30 条还没进 DOM，下标 >= 30 的已经在了。
    expect(revealStepsNeeded(30, 45, 80)).toBe(0)
  })

  it('正好卡在窗口起点上也算已挂载', () => {
    expect(revealStepsNeeded(30, 30, 80)).toBe(0)
  })

  it('目标在窗口之前，按步长向上取整', () => {
    // 差 30 条，一步揭 80 条 → 一次就够。
    expect(revealStepsNeeded(30, 0, 80)).toBe(1)
  })

  it('差得远时要揭好几次', () => {
    // 差 170 条，一步 80 → 170/80 = 2.125 → 3 次。
    expect(revealStepsNeeded(200, 30, 80)).toBe(3)
  })

  it('差距正好是步长整数倍时不多揭一次', () => {
    expect(revealStepsNeeded(160, 0, 80)).toBe(2)
  })

  it('窗口已经全开（start=0）时永远不用揭', () => {
    expect(revealStepsNeeded(0, 0, 80)).toBe(0)
  })
})
