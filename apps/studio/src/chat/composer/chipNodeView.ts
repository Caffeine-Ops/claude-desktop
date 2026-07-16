import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'

import { fileTypeIconPaths, type IconPath } from '../components/chat/FileTypeIcon'
import { findSkillChipSpec } from './skillChipRegistry'
import { autoOpenPreviewPanel, previewPanelKind } from '../runtime/imageAttachmentAdapter'

/**
 * NodeView for the `slash` / `mention` atom nodes. Renders the same pill
 * the old React `<Chip>` drew (SVG icon + rounded background + CSS-var
 * palette), but as plain imperative DOM — ProseMirror NodeViews live
 * outside React, and keeping them React-free sidesteps the monorepo's
 * dual `@types/react` (18/19) cross-talk entirely (no `createRoot` into
 * a PM-owned DOM node).
 *
 * The leading `/` or `@` is stripped from the visible label — the icon
 * stands in for it — but the node's `value` attr still carries the raw
 * `/cmd` / `@path`, which is what `serializeDoc` emits to fusion-code.
 *
 * Because the underlying nodes are `atom: true`, the browser treats the
 * pill as a single indivisible glyph: caret stops at its boundaries,
 * backspace removes it whole. No selection-snapping or pixel measuring
 * (the old `findAtomicTokenContaining` / overlay caret) is needed.
 */

/** Generic "skill/command" glyph — same sparkle the composer's 技能 toolbar
 * button draws, so an unregistered slash chip and the entry point that
 * inserts registered ones read as the same visual language. */
const SPARKLE_ICON_PATHS = [
  'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  'M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4Z'
]
/** × glyph shown in place of the icon on hover — the click target that
 * deletes the chip. */
const CLOSE_ICON_PATHS = ['M18 6 6 18M6 6l12 12']
const NS = 'http://www.w3.org/2000/svg'

function buildStrokeIcon(paths: readonly string[], size: number, strokeWidth: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', strokeWidth)
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

/**
 * Coloured Icons8 glyph builder, shared by file mentions and registered
 * slash skills. Each path carries its own `fill`, so this is a
 * self-coloured 48×48 SVG (no stroke, no accent tint) that looks the
 * same on any surface. File mentions pass the per-extension table.
 */
function buildColorIcon(paths: readonly IconPath[], size = 14): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  for (const spec of paths) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', spec.d)
    p.setAttribute('fill', spec.fill)
    svg.appendChild(p)
  }
  return svg
}

/**
 * Registered-skill bitmap icon (public/skill-icons/ 切片，来源见
 * skillChipRegistry 头注释)。React 面走 SkillChipIcon 组件；本文件是
 * ProseMirror 的 imperative DOM，这里保持同参数的孪生实现——
 * draggable=false 尤其关键：chip 本身在 contenteditable 里，裸 img 默认
 * 可拖出幽灵图、还会跟 PM 的 atom 拖拽打架。
 */
function buildImgIcon(src: string, size = 14): HTMLImageElement {
  const img = document.createElement('img')
  img.src = src
  img.width = size
  img.height = size
  img.alt = ''
  img.setAttribute('aria-hidden', 'true')
  img.draggable = false
  img.style.display = 'block'
  img.style.objectFit = 'contain'
  img.style.userSelect = 'none'
  return img
}

/**
 * NodeView factory shared by both atom types. `variant` selects the
 * palette + icon; the raw value comes from `node.attrs.value`.
 */
export function createChipNodeView(variant: 'slash' | 'mention') {
  return (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    const raw = (node.attrs.value as string) ?? ''

    // A known slash skill (e.g. `/ppt-master`) swaps the glyph for its
    // coloured Icons8 icon and gives the pill a friendly label. Everything
    // else — and all mentions — keeps the neutral sparkle/file glyph.
    // Lookup is by the verbatim `value`, so this is purely visual;
    // serialization is untouched.
    const skill = variant === 'slash' ? findSkillChipSpec(raw) : null

    const dom = document.createElement('span')
    dom.setAttribute(variant === 'slash' ? 'data-pm-slash' : 'data-pm-mention', node.attrs.value as string)

    // Unified soft-fill chrome for BOTH variants（「柔底无边」，2026-07-16
    // 选定，六方案对比稿见 docs/ui-prototype-composer-chip-styles.html 的
    // 方案 B）：前景色低透明度柔底 + 8px 圆角，无可见描边。双档底色住在
    // styles/index.css 的 --composer-chip-bg(-hover) 变量里——inline style
    // 吃不到 .dark 选择器，暗色要换白系透明度，档位切换只能交给 CSS 变量。
    // 边框保留 1px transparent 而非删掉：下方 -2px 基线校准依赖当前盒子
    // 几何，抽掉 1px 边会动 chip 高度、校准作废。更早的历史：描边胶囊版
    // 之前，slash chip 还按技能分过「accent-tint pill vs 渐变卡」两种画法，
    // 已收敛成单一样式 + hover 删除钮（见 iconSlot）。
    Object.assign(dom.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '3px 9px 3px 7px',
      border: '1px solid transparent',
      borderRadius: '8px',
      background: 'var(--composer-chip-bg)',
      color: 'hsl(var(--foreground))',
      fontWeight: '500',
      fontSize: '13px',
      lineHeight: '1.35',
      // -2px（不是 middle）：让 chip 内 13px 文字的基线与编辑器正文的基线
      // 重合（2026-07-16 用户反馈「文字没有在一条基线上」）。middle 对齐
      // 的是 x-height 中点，两种字号的 descent/半 leading 差让 chip 文字
      // 视觉上低 ~1px；真机 CDP 逐值实测 -2px 时基线差 0.08px≈0（当时正
      // 文 15px）。这个值补偿的是「chip 报告基线（=图标槽底）与 label 文
      // 字基线」之间的 chip 内部差——vertical-align 长度值是相对父基线的
      // 位移，故只依赖 chip 内部参数组（13px 字号/1.35 行高/3px 竖 padding/
      // 14px 槽/1px 边），正文字号变化不影响（同日正文 15→14px 加粗即按
      // 此推理未重测）。改 chip 内部任何一项都要重新实测校准。
      verticalAlign: '-2px',
      userSelect: 'none',
      transition: 'background 0.15s ease'
    } satisfies Partial<CSSStyleDeclaration>)

    // 文件 mention 混排在正文任意位置，与相邻文字之间常无空格字符（占位
    // 槽 replaceWith、模板紧贴中文），chip 会贴着字——水平 margin 给出与
    // 技能 chip 一致的呼吸间距（2026-07-16 用户反馈）。4px 与
    // filePlaceholderPlugin 占位 pill 的 margin 配对：点占位选完文件
    // replaceWith 成本 chip 的瞬间，两者外沿几何一致、正文不跳位。
    // slash chip 不加：它恒在行首 + 尾随空格，再加 margin 反而行首缩进。
    if (variant === 'mention') {
      dom.style.margin = '0 4px'
    }

    // Icon slot: holds the real glyph by default, swaps to a × delete
    // button on hover. A registered skill shows its coloured Icons8 glyph
    // (kept as its own multi-fill SVG, untouched by hover); a file
    // mention shows its per-extension coloured glyph; a plain/unknown
    // slash command shows the neutral sparkle.
    const iconSlot = document.createElement('span')
    Object.assign(iconSlot.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: '0',
      // 槽尺寸定死为 resting icon 的最大规格（14px）：hover 换入的 × 只有
      // 12px，槽若随内容收缩，chip 宽度会在 enter/leave 间跳 2px——右侧正
      // 文被推移；更糟的是指针停在 chip 右缘时「变窄→指针落到 chip 外→
      // mouseleave 恢复→又落回 chip 内→mouseenter」无限振荡（2026-07-16
      // 用户报「hover 页面抖动」）。固定槽，换图标只在槽内居中。
      width: '14px',
      height: '14px',
      // × 叠放层的定位锚（见下 closeWrap）。
      position: 'relative'
    } satisfies Partial<CSSStyleDeclaration>)

    const buildRestingIcon = (): SVGSVGElement | HTMLImageElement => {
      if (skill) return buildImgIcon(skill.image)
      if (variant === 'mention') return buildColorIcon(fileTypeIconPaths(raw.replace(/^@"?|"$/g, '')))
      return buildStrokeIcon(SPARKLE_ICON_PATHS, 13, '1.9')
    }
    // Hover 换 × 不做 DOM 交换，两层常驻、只切 visibility——为的是钉死
    // baseline：chip 是 inline-flex，行内基线取第一个 flex item（本槽）内容
    // 的基线；resting 的 14px img 底边==槽底，若 hover 把它换成 12px × 居中
    // （底边比槽底高 1px），chip 基线上移 → 行内按 vertical-align:-2px 重
    // 对齐时整个 chip 下沉、行盒被撑高 ~0.7px、下方内容整体下推——真机
    // CDP 实测 y 457.97→458.70、行高 25.55→26.27，就是「hover 晃动」的垂直
    // 分量（水平分量由上面的定宽槽解决）。给槽加 overflow:hidden 走「合成
    // 基线」在 Chromium 上实测无效（槽被 blockify 成 flex item 后仍取内容
    // 基线）。故改叠放：resting 图标永远留在正常流提供恒定基线（visibility
    // 不影响布局树），× 绝对定位叠上（不参与尺寸/基线），布局物理恒定。
    const restingIcon = buildRestingIcon()
    const closeWrap = document.createElement('span')
    Object.assign(closeWrap.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      visibility: 'hidden',
      color: 'hsl(var(--muted-foreground))'
    } satisfies Partial<CSSStyleDeclaration>)
    closeWrap.appendChild(buildStrokeIcon(CLOSE_ICON_PATHS, 12, '2'))
    iconSlot.append(restingIcon, closeWrap)
    dom.appendChild(iconSlot)

    // Strip the leading `/` or `@` — the icon replaces it visually. A
    // registered skill supplies its own friendly label instead. A file
    // mention shows just the BASENAME（2026-07-16 用户拍板：拖拽内联的
    // 绝对路径整条铺在 chip 上太长）——序列化仍是 `value` 里的完整
    // `@"path"`（serializeDoc 只读 attrs，不读 DOM），发送内容不变；完整
    // 路径挪到 hover title 供确认。
    const label = document.createElement('span')
    if (variant === 'mention') {
      const path = raw.replace(/^@"?|"$/g, '')
      const base = path.slice(path.lastIndexOf('/') + 1)
      label.textContent = base || path
      dom.title = path

      // 点 chip 主体重开右侧预览面板（用户要求 2026-07-16）：表格/图片这
      // 类右栏认的文件（previewPanelKind 单一真源）点击走「上传即预览」
      // 同一条 openPreview/openEditor 分流——面板被关掉后随时点 chip 重开。
      // 只挂在可预览类型上（其它文件点击无意义，不给 pointer 误导）；
      // mousedown 用于拦住编辑器抢焦点，实际动作在 mousedown 里直接做
      // （与 × 删除钮同约定）。× 在 iconSlot 上已 stopPropagation，二者
      // 不冲突。
      if (previewPanelKind(base) !== null) {
        dom.style.cursor = 'pointer'
        dom.addEventListener('mousedown', (e) => {
          if (iconSlot.contains(e.target as Node)) return // × 区让给删除
          e.preventDefault()
          e.stopPropagation()
          autoOpenPreviewPanel(base, path)
        })
      }
    } else {
      label.textContent = skill?.label ?? raw.slice(1)
    }
    dom.appendChild(label)

    // Delete-on-hover: mouseenter swaps the icon slot for a × (click
    // removes this atom node from the doc); mouseleave restores the
    // resting icon. The click handler is only meaningful while hovering
    // (`hovering` guard) — desktop pointer events always fire
    // mouseenter→click→mouseleave in that order, so this is a belt-and-
    // braces guard, not load-bearing.
    let hovering = false
    dom.addEventListener('mouseenter', () => {
      hovering = true
      dom.style.background = 'var(--composer-chip-bg-hover)'
      restingIcon.style.visibility = 'hidden'
      closeWrap.style.visibility = 'visible'
      iconSlot.style.cursor = 'pointer'
    })
    dom.addEventListener('mouseleave', () => {
      hovering = false
      dom.style.background = 'var(--composer-chip-bg)'
      restingIcon.style.visibility = ''
      closeWrap.style.visibility = 'hidden'
      iconSlot.style.cursor = ''
    })
    iconSlot.addEventListener('mousedown', (e) => {
      if (!hovering) return
      // mousedown (not click): fires before the editor would otherwise
      // move focus/selection on click, matching insertSuggestion's own
      // mousedown-based picks elsewhere in the composer.
      e.preventDefault()
      e.stopPropagation()
      const pos = getPos()
      if (pos === undefined) return
      const tr = view.state.tr.delete(pos, pos + node.nodeSize)
      view.dispatch(tr.scrollIntoView())
      view.focus()
    })

    return {
      dom,
      // Atom nodes have no editable content; returning no contentDOM
      // tells PM this is a leaf rendered entirely by us.
      ignoreMutation: () => true,
      // Same type + same value → confirm and keep this DOM. A DIFFERENT
      // value must return false so PM destroys & recreates the NodeView:
      // returning true for any same-type node（旧实现，2026-07-16 修）let
      // `resetWithSlashCommand` 的整段替换走进「同位置同类型」的 update
      // 路径——DOM 保留旧技能的图标/标签/data-pm-slash，而 doc/store 已是
      // 新技能，ScenarioRail（订 composer.text）随之显示与可见 chip 错位的
      // 推荐行。真机 CDP 实锤：store=spreadsheets、DOM chip=ppt-master。
      update: (updated) =>
        updated.type === node.type && (updated.attrs.value as string) === raw
    }
  }
}
