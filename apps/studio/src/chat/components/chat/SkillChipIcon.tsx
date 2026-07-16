import { cn } from '@/src/lib/utils'

/**
 * SkillChipIcon — 技能 chip 的彩色位图图标（public/skill-icons/ 切片，
 * 来源与切图规矩见 skillChipRegistry 头注释）。
 *
 * 所有渲染注册技能图标的 React 面共用这一个组件（空态 ScenarioRail、
 * `/` 建议菜单、技能选择器、消息气泡 chip、标题栏会话图标），替代原先
 * 五处各自手写的 Icons8 `<svg><path/></svg>` 内联——图标来源换成位图后，
 * `draggable=false`（chip 在可拖拽的 composer 里，裸 img 默认可拖出幽灵
 * 图）与 `object-contain`（切片留白已统一但宽高比略有差异）必须处处一致，
 * 收拢成组件写一次。ProseMirror 的 chipNodeView 是 imperative DOM，不走
 * React，那边有对应的 buildImgIcon（保持与本组件同参数）。
 */
export function SkillChipIcon({
  src,
  size,
  className
}: {
  src: string
  /** 渲染像素尺寸（宽=高）。切片是 256×256 透明底 PNG，高分屏无虞。 */
  size: number
  className?: string
}): React.JSX.Element {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 静态小图标，无需 next/image 优化管线
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('shrink-0 select-none object-contain', className)}
    />
  )
}
