import React from 'react'

import { useI18n } from '../../../i18n'
import { pick } from './helpers'

/* ───────────────────── shared sub-components ─────────────────── */

/** 截断态底部渐隐——同 ToolCallCard 的配方，让「下面还有」看得出来。 */
const CLAMP_MASK =
  '[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-28px),transparent_100%)]'

/**
 * 限高内容块 —— 到上限就截断 + 底部渐隐 + 「展开全部」，**绝不给自己开一条
 * 内部竖向滚动条**。工具卡片里一切需要限高的内容都走这里。
 *
 * 【为什么内嵌区不能用 overflow-y:auto】(2026-07-27 用户实锤 + CDP 实测)
 * 消息流里每多一个内部竖向滚动区，就多一个会「吃掉」滚轮的目标。Chromium 的
 * scroll latching 把一次连续滚动手势锁定在最先命中的容器上——即便它已经滚到
 * 边界，也不会在手势中途转交给外层，要等停手约 100ms 才重新选目标。触控板的
 * 惯性滚动是一整段长手势，于是用户把光标停在任意一张工具卡片上滑动时，整段
 * 惯性都锁在那张卡片内部，外层聊天视口纹丝不动——读作「滚动条滚不到底，只能
 * 点那个按钮」。（那个按钮走的是外层视口的 scrollTo，绕开全部嵌套容器，所以
 * 一按就到；这正是「按钮行、手滚不行」这个症状的分界。）
 *
 * 实测规模（一次普通的联网检索会话）：消息流里 69 个内部滚动区，内部可滚动
 * 总量 320836px，是外层视口自身可滚动量（5178px）的 62 倍——滚轮几乎必然落在
 * 某个内嵌区上，而不是落在外层。
 *
 * 横向滚动照留（overflow-x-auto）：只有 x 轴可滚的容器不参与竖向 latching，
 * 竖向滚轮会直接交给能竖向滚的祖先，不影响外层。y 轴用 hidden 而不是 visible
 * ——`overflow-x:auto` 配 `overflow-y:visible` 会被 CSS 强制改写成 auto，等于
 * 白改。
 *
 * 展开后不再限高，内容交由外层视口统一滚动：全流程只有一个滚动目标。
 */
export function ClampedBlock({
  max,
  children,
  className,
  innerClassName
}: {
  /** Tailwind 限高类，如 `max-h-80`。展开时整类摘掉。 */
  max: string
  children: React.ReactNode
  /** 外层（含「展开全部」按钮）的类。 */
  className?: string
  /** 内容层的类——原容器身上的布局类（`space-y-2` / `pr-1` / `px-1 py-1` …）搬到
   *  这里。放内容层而不是限高层是必须的：`space-y-*` 只作用于直接子元素，挂在
   *  限高层上就只能管到内容层这一个孩子，等于失效。 */
  innerClassName?: string
}): React.JSX.Element {
  const lang = useI18n((s) => s.lang)
  const clipRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [clamped, setClamped] = React.useState(false)

  React.useEffect(() => {
    // 展开态不重测：展开后两层高度相等，再测会把 clamped 抹成 false，「收起」
    // 按钮当场消失，用户就回不去了。
    if (expanded) return
    const clip = clipRef.current
    const content = contentRef.current
    if (!clip || !content) return
    const check = (): void => setClamped(content.offsetHeight > clip.clientHeight + 1)
    check()
    // 量的是【内容层】而不是限高层：限高层被 max-h 钉死，内容再怎么长它的盒子
    // 都纹丝不动，RO 一次都不会响；内容层高度自由，任何变化（流式补字、markdown
    // 图片落地、details 展开）都会改它的高度。
    //
    // 观察内容层这一个稳定节点，也顺带修掉「只快照一次 children」的漏洞——React
    // 重渲染会整片换掉子节点，对旧子节点的观察随之作废，而这一层始终是同一个
    // DOM 节点（2026-07-27 实测：179 个块里大量已溢出却一个「展开全部」都不
    // 出现，内容被截了还展不开，比改造前更糟）。
    const ro = new ResizeObserver(check)
    ro.observe(content)
    ro.observe(clip) // 视口/分栏 resize 改的是限高层的 clientHeight
    return () => ro.disconnect()
  }, [expanded])

  return (
    <div className={className}>
      <div
        ref={clipRef}
        className={
          'max-w-full overflow-x-auto overflow-y-hidden ' +
          (expanded ? '' : max + ' ') +
          (clamped && !expanded ? CLAMP_MASK : '')
        }
      >
        <div ref={contentRef} className={innerClassName}>
          {children}
        </div>
      </div>
      {clamped && (
        // data-slot 是逃逸 canvas 那套裸 button reset 的护身符：工具卡内容会被
        // portal 到全文弹窗里，那时子树脱离 .chat-app 豁免（见根 CLAUDE.md）。
        <button
          type="button"
          data-slot="clamp-toggle"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground/60 transition hover:text-muted-foreground"
        >
          <span aria-hidden className={'inline-block transition ' + (expanded ? 'rotate-90' : '')}>
            ▸
          </span>
          {expanded ? pick(lang, '收起', 'Collapse') : pick(lang, '展开全部', 'Expand all')}
        </button>
      )}
    </div>
  )
}

export function DiffView({
  oldText,
  newText
}: {
  oldText: string
  newText: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11.5px] leading-snug">
      {oldText && (
        <ClampedBlock max="max-h-40">
          <pre className="max-w-full whitespace-pre rounded-sm bg-red-500/10 px-2 py-1 text-red-400/90">
            {oldText.split('\n').map((line, i) => (
              <div key={i}>
                <span aria-hidden className="select-none opacity-60">
                  -{' '}
                </span>
                {line || '\u200b'}
              </div>
            ))}
          </pre>
        </ClampedBlock>
      )}
      {newText && (
        <ClampedBlock max="max-h-40">
          <pre className="max-w-full whitespace-pre rounded-sm bg-emerald-500/10 px-2 py-1 text-emerald-400/90">
            {newText.split('\n').map((line, i) => (
              <div key={i}>
                <span aria-hidden className="select-none opacity-60">
                  +{' '}
                </span>
                {line || '\u200b'}
              </div>
            ))}
          </pre>
        </ClampedBlock>
      )}
    </div>
  )
}

export function TodoStatusMark({ status }: { status: string }): React.JSX.Element {
  if (status === 'completed') {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-emerald-500"
        aria-hidden
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <span
        aria-hidden
        className="block size-[7px] rounded-full bg-accent"
      />
    )
  }
  return (
    <span
      aria-hidden
      className="block size-[7px] rounded-full border border-muted-foreground/40"
    />
  )
}
