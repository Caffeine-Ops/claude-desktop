import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

/**
 * 文件占位 pill（2026-07-16，ScenarioRail 推荐 prompt 的「【PPT 文件】」
 * 槽位；同日二版——初版是 inline decoration 给原文上色，用户反馈「太丑还
 * 能选中」，改成 replace+widget 双 decoration：原文在视图里隐藏，原位画一
 * 颗与技能 chip 同款的、contenteditable=false 的 pill）。
 *
 * 占位识别（用户拍板）：以「文件」结尾的【】段（`【…文件】`）才是文件槽
 * ——「【说明要改什么…】」这类填空不匹配。
 *
 * 文案纪律（用户拍板 2026-07-16）：占位文字只写文件本体（「PPT 文件」），
 * **不带动作词**——不写「拖入」（误导：pill 的交互是点击）、不写「点击
 * 此处选择…」（啰嗦）；pill 也不挂 title 提示，虚线框 + 回形针 + hover
 * 反馈已表达可点。
 *
 * 仍然不动共享 schema：doc 里始终是普通文本，serializeDoc 原样输出——
 * 用户不点、直接发送时模型收到「【PPT 文件】」原文，语义自明。
 * pill 是 widget DOM，点击（mousedown，防焦点跳动）直接回调组件层打开
 * 文件选择器；选中后组件把占位区间 replaceWith 成 mention chip。
 *
 * 每次 doc 变更全量重扫：composer 是短文本，成本可忽略。widget 提供稳定
 * key（位置+文本），PM 据此跨事务复用 DOM，不闪。
 */

const PLACEHOLDER_RE = /【[^【】]{0,24}文件】/g

export const filePlaceholderKey = new PluginKey<DecorationSet>('filePlaceholder')

/**
 * 占位描述 → 文件选择器的 accept 过滤（用户要求 2026-07-16：「PPT 文件」
 * 槽只能选 ppt）。按描述里的类型关键词映射；命不中任何关键词（如泛泛的
 * 「资料文件」）返回 undefined = 不限制。原生对话框会将不匹配项置灰——
 * 这是引导不是安检，用户经「所有格式」强选的文件照样接受，不做二次校验。
 */
const ACCEPT_BY_KEYWORD: readonly [RegExp, string][] = [
  [/ppt|幻灯片|演示/i, '.ppt,.pptx'],
  [/excel|xlsx?|csv|表格|明细|台账/i, '.xls,.xlsx,.csv'],
  [/word|docx?(?![a-z])|文档/i, '.doc,.docx'],
  [/pdf/i, '.pdf'],
  [/markdown|(?<![a-z])md(?![a-z])/i, '.md,.markdown'],
  [/图片|image|截图|照片/i, 'image/*'],
  [/视频|video/i, 'video/*'],
  [/音频|audio|录音/i, 'audio/*']
]

export function acceptForPlaceholder(placeholderText: string): string | undefined {
  for (const [re, accept] of ACCEPT_BY_KEYWORD) {
    if (re.test(placeholderText)) return accept
  }
  return undefined
}

const NS = 'http://www.w3.org/2000/svg'

/** 回形针 stroke 图标——「这里挂一个文件」的通用隐喻。 */
function buildClipIcon(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  const p = document.createElementNS(NS, 'path')
  p.setAttribute(
    'd',
    'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'
  )
  svg.appendChild(p)
  return svg
}

/**
 * 占位 pill：外观参数对齐 chipNodeView 的技能 chip（同 padding/字号/圆角/
 * -2px 基线校准），差异化标记「这是个待填槽」——虚线边框 + 品牌绿文字。
 * contenteditable=false + user-select:none：不可选中、不可编辑，浏览器把
 * 它当一整个不可分割的块。
 */
function buildPill(placeholderText: string, onClick: () => void): HTMLElement {
  const dom = document.createElement('span')
  dom.contentEditable = 'false'
  Object.assign(dom.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 10px',
    // 左右留白：pill 与前后正文（「修改【…】：」的汉字/冒号）贴着排太挤
    // （2026-07-16 用户反馈）。占位是 widget 不是文本，doc 里没有空格可
    // 依靠，间距只能由 pill 自己出。
    margin: '0 4px',
    border: '1px dashed hsl(var(--brand) / 0.55)',
    // 圆角跟随技能 chip（chipNodeView 2026-07-16 换「柔底无边」8px），
    // 维持头注释「同款 pill」的承诺。
    borderRadius: '8px',
    background: 'hsl(var(--brand) / 0.07)',
    color: 'hsl(var(--brand))',
    fontWeight: '500',
    fontSize: '13px',
    lineHeight: '1.35',
    // 同 chipNodeView 的基线校准值（13px pill 文字；该位移只依赖 pill 内部
    // 几何、与正文字号无关，推导见 chipNodeView 同位置注释）。
    verticalAlign: '-2px',
    userSelect: 'none',
    cursor: 'pointer',
    transition: 'background 0.15s ease, border-color 0.15s ease'
  } satisfies Partial<CSSStyleDeclaration>)
  dom.addEventListener('mouseenter', () => {
    dom.style.background = 'hsl(var(--brand) / 0.14)'
    dom.style.borderColor = 'hsl(var(--brand) / 0.8)'
  })
  dom.addEventListener('mouseleave', () => {
    dom.style.background = 'hsl(var(--brand) / 0.07)'
    dom.style.borderColor = 'hsl(var(--brand) / 0.55)'
  })
  dom.appendChild(buildClipIcon())
  const label = document.createElement('span')
  // pill 上显示【】里的描述文字（「PPT 文件」），括号本身不上屏。
  label.textContent = placeholderText.replace(/^【|】$/g, '')
  dom.appendChild(label)
  // 「点击选择」操作提示（用户要求 2026-07-16）：弱化小字缀在描述后，
  // 明示这颗 pill 是入口而不是普通标签。
  const hint = document.createElement('span')
  hint.textContent = '点击选择'
  Object.assign(hint.style, {
    fontSize: '11px',
    opacity: '0.62',
    // 与主文字之间一道细分隔，弱于文字本身。
    borderLeft: '1px solid hsl(var(--brand) / 0.35)',
    paddingLeft: '5px'
  } satisfies Partial<CSSStyleDeclaration>)
  dom.appendChild(hint)
  // mousedown 而非 click：在编辑器把焦点/选区挪走之前拦下（与 chip 的
  // 删除钮、建议菜单的选取同一约定）。
  dom.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return dom
}

export function createFilePlaceholderPlugin(
  onPickFile: (from: number, to: number, placeholderText: string) => void
): Plugin<DecorationSet> {
  const buildDecorations = (doc: PMNode): DecorationSet => {
    const decos: Decoration[] = []
    doc.descendants((node, pos) => {
      if (!node.isText) return
      const text = node.text ?? ''
      PLACEHOLDER_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = PLACEHOLDER_RE.exec(text))) {
        const from = pos + m.index
        const to = from + m[0].length
        const matched = m[0]
        // inline+display:none 把原文从视图里隐藏（PM 公开 API 没有
        // replace decoration），widget 在同一位置画 pill。两条共享一个
        // [from,to]——组件层求证占位区间时按 from<to 过滤出这条 inline。
        decos.push(Decoration.inline(from, to, { style: 'display: none' }))
        decos.push(
          Decoration.widget(from, () => buildPill(matched, () => onPickFile(from, to, matched)), {
            side: 1,
            // 稳定 key：同位置同文本的 widget 跨事务复用 DOM，避免重扫重建闪动。
            key: `fileph:${from}:${matched}`
          })
        )
      }
    })
    return DecorationSet.create(doc, decos)
  }

  return new Plugin<DecorationSet>({
    key: filePlaceholderKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc),
      apply: (tr, old, _oldState, newState) =>
        tr.docChanged ? buildDecorations(newState.doc) : old
    },
    props: {
      decorations(state) {
        return this.getState(state)
      }
    }
  })
}
