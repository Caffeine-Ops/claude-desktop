import type { SVGProps, ReactNode } from 'react'

/**
 * 「写方案」面板的内联 SVG 图标集。
 *
 * 取代原先用作功能图标的 emoji（✎ ▤ 📄 📕 📝 ⚙ 🔍 ▾ ↻ ⊕ ⊖ ↑↓×✓ ↺ ✕）——emoji 跨平台
 * 渲染不一致、不继承文字的颜色与字重，在标书工具里显得未完工（design-review F2）。这里
 * 沿用项目既有的内联 SVG 约定（viewBox 24、fill none、stroke=currentColor、strokeWidth≈1.7、
 * aria-hidden），不引第三方图标库——渲染层全程无图标依赖，加一个会破坏约定。
 *
 * 尺寸默认 `1em`：图标随按钮自身 font-size 缩放，与同一按钮里的文字天然等高；需要时用
 * width/height 或 className 覆盖。颜色走 currentColor，跟随 text-* 自动着色。
 */
type IconProps = SVGProps<SVGSVGElement>

function Base({ children, ...rest }: IconProps & { children: ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const PencilIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Base>
)

// 转圈 spinner：一段 3/4 圆弧，靠 Tailwind 的 animate-spin 旋转（调用处加 className）。
// 单色 currentColor + 起点略淡的整圈打底，转起来才有「头尾」的方向感，而非匀色圆环干转。
export const SpinnerIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" opacity={0.25} />
    <path d="M21 12a9 9 0 0 0-9-9" />
  </Base>
)

export const EyeIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
)

export const FileTextIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8" />
    <path d="M8 17h8" />
    <path d="M8 9h2" />
  </Base>
)

export const FileIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </Base>
)

export const FileCodeIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="m10 13-2 2 2 2" />
    <path d="m14 13 2 2-2 2" />
  </Base>
)

export const SlidersIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M4 6h10" />
    <path d="M18 6h2" />
    <path d="M4 12h2" />
    <path d="M10 12h10" />
    <path d="M4 18h8" />
    <path d="M16 18h4" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="14" cy="18" r="2" />
  </Base>
)

export const ChevronDownIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="m6 9 6 6 6-6" />
  </Base>
)

export const ChevronUpIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="m18 15-6-6-6 6" />
  </Base>
)

export const XIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Base>
)

export const SearchIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Base>
)

export const AlertTriangleIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Base>
)

export const RotateCwIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </Base>
)

export const RotateCcwIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </Base>
)

export const PlusIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Base>
)

export const MinusIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M5 12h14" />
  </Base>
)

export const CheckIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Base>
)

// 知识库行的语义前缀图标（书本）：产品 chips 裸露一行不解释自己是什么，
// 「知识库」标签 + 本图标先把语义立住（2026-07-06 面板重设计）。
export const BookIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
  </Base>
)

// Notion 式节手柄（⋮⋮ 六点）：编辑器通铺化后节级操作收进左 gutter 的手柄菜单，
// 这是唯一的 fill 图标——六个实心点靠 stroke 画不出来（2026-07-06 编辑器重设计）。
export const GripIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p} fill="currentColor" stroke="none">
    <circle cx="9" cy="6" r="1.6" />
    <circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" />
    <circle cx="15" cy="18" r="1.6" />
  </Base>
)

export const ArrowUpIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </Base>
)

export const ArrowDownIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M12 5v14" />
    <path d="m5 12 7 7 7-7" />
  </Base>
)

export const InfoIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </Base>
)

export const TrashIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </Base>
)

// 「换图」按钮用：一张图片（相框 + 山 + 太阳），暗示「替换这张图」。
export const ImageIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </Base>
)

// 「生成图片」按钮用：同款相框图片 + 右上角一个「+」，暗示「凭空生成/插入一张新图」，与
// ImageIcon（换图，暗示替换既有图）区分开。
export const ImagePlusIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <rect x="3" y="3" width="14" height="14" rx="2" />
    <circle cx="8" cy="8" r="1.3" />
    <path d="m16 12-4-4-6 6" />
    <path d="M19 15v6" />
    <path d="M22 18h-6" />
  </Base>
)

// 「上传图片」按钮用：托盘 + 向上箭头，通用的本地文件上传语义。
export const UploadIcon = (p: IconProps): React.JSX.Element => (
  <Base {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M17 8l-5-5-5 5" />
    <path d="M12 3v12" />
  </Base>
)
