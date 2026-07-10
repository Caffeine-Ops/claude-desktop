import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider
} from '@/src/components/ui/tooltip'

// 写方案区统一的 hover 说明气泡。把「悬停某按钮就浮出一句说明」这件事收进一个薄封装，
// 让各按钮只需 <Tip label="…">{按钮}</Tip> 即可，而不必每处都手写三层 Tooltip/Trigger/Content。
//
// 机制：底层是 shadcn 的 radix Tooltip（src/components/ui/tooltip.tsx）——深色圆角气泡 + 小箭头
// + 淡入缩放动画，delayDuration=0（悬停即显），且跟随明暗主题。取代原先散落的原生 title=
// （原生黄条要停约 1s 才出、样式不可控）。
//
// TooltipTrigger asChild：不额外渲染 DOM，而是把触发行为「贴」到传入的那个按钮上，故按钮原有的
// className / onClick / disabled 等全部原样保留、布局不变。因此传入的 children 必须是【单个】能
// 转发 ref 与 props 的元素（原生 <button> 天然满足）。
//
// ⚠️ radix 限制：被 disabled 的按钮不派发指针事件，故禁用态不会弹气泡。写方案里凡「禁用时才解释
// 为什么不能点」的按钮（如生成中禁用），改用【始终成立】的说明文案（讲这个按钮是干嘛的），这样可
// 用态就能看到；禁用原因另有徽标/上下文承载。
//
// 用法：面板某个根节点包一层 <TooltipProvider>（radix 要求 Trigger 必须有 Provider 祖先；本区所有
// 触发器都是 ProposalDocPanel / 聊天审阅块两处根的后代，故各包一处即全覆盖），本文件把 Provider 一并
// 再导出，省得各处再从 ui/tooltip 引一遍。

export { TooltipProvider }

export function Tip({
  label,
  side = 'top',
  children
}: {
  label: React.ReactNode
  /** 气泡相对按钮的方向，默认在上方；空间不够时 radix 自动翻边。 */
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: React.ReactElement
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
