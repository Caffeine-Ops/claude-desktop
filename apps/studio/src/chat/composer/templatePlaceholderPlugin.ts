import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

/**
 * 模版占位 pill（2026-07-22，ScenarioRail「选用现成模版」推荐 prompt 的
 * 「【选择模版】」槽位）——同 `filePlaceholderPlugin.ts` 的 replace+widget
 * 双 decoration 手法，独立的 PluginKey/正则/pill，两套占位互不干扰。
 *
 * 占位识别：以「模版」结尾的【】段（`【…模版】`）才是模版槽。
 *
 * 点击后不是打开原生文件对话框，是打开 `TemplateGalleryPopover`（带缩略图
 * 预览的内置模版下拉），选中后组件把占位区间 replaceWith 成 mention chip
 * ——mention 的 value 直接是模版目录的绝对路径（不带 `@` 前缀，理由见
 * ProseMirrorComposerInput.tsx 里 onTemplatePicked 的注释）。
 */

const PLACEHOLDER_RE = /【[^【】]{0,24}模版】/g

export const templatePlaceholderKey = new PluginKey<DecorationSet>('templatePlaceholder')

const NS = 'http://www.w3.org/2000/svg'

/** 2x2 网格描边图标——「这里选一套模版」的通用隐喻，与文件槽的回形针区分开。 */
function buildGridIcon(): SVGSVGElement {
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
  for (const d of [
    'M3 3h8v8H3z',
    'M13 3h8v8h-8z',
    'M3 13h8v8H3z',
    'M13 13h8v8h-8z'
  ]) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

/**
 * 占位 pill：外观参数与 `filePlaceholderPlugin.buildPill` 完全对齐（同
 * padding/字号/圆角/虚线边框/-2px 基线校准），仅图标与本文件独立。
 */
function buildPill(placeholderText: string, onClick: (anchor: DOMRect) => void): HTMLElement {
  const dom = document.createElement('span')
  dom.contentEditable = 'false'
  Object.assign(dom.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 10px',
    margin: '0 4px',
    border: '1px dashed hsl(var(--brand) / 0.55)',
    borderRadius: '8px',
    background: 'hsl(var(--brand) / 0.07)',
    color: 'hsl(var(--brand))',
    fontWeight: '500',
    fontSize: '13px',
    lineHeight: '1.35',
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
  dom.appendChild(buildGridIcon())
  const label = document.createElement('span')
  label.textContent = placeholderText.replace(/^【|】$/g, '')
  dom.appendChild(label)
  const hint = document.createElement('span')
  hint.textContent = '点击选择'
  Object.assign(hint.style, {
    fontSize: '11px',
    opacity: '0.62',
    borderLeft: '1px solid hsl(var(--brand) / 0.35)',
    paddingLeft: '5px'
  } satisfies Partial<CSSStyleDeclaration>)
  dom.appendChild(hint)
  dom.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick(dom.getBoundingClientRect())
  })
  return dom
}

export function createTemplatePlaceholderPlugin(
  onPickTemplate: (from: number, to: number, placeholderText: string, anchor: DOMRect) => void
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
        decos.push(Decoration.inline(from, to, { style: 'display: none' }))
        decos.push(
          Decoration.widget(
            from,
            () => buildPill(matched, (anchor) => onPickTemplate(from, to, matched, anchor)),
            {
              side: 1,
              key: `tplph:${from}:${matched}`
            }
          )
        )
      }
    })
    return DecorationSet.create(doc, decos)
  }

  return new Plugin<DecorationSet>({
    key: templatePlaceholderKey,
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
