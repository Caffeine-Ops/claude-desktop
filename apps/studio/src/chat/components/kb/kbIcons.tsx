import React from 'react'

/** 管理页内联 SVG 图标集（无图标库，见 proposalIcons.tsx 惯例）。默认 size 由 className 控制。 */
type IconProps = { className?: string }
const S = (p: IconProps & { children: React.ReactNode }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" className={p.className}>{p.children}</svg>
)

export const kbIcons = {
  folder: (p: IconProps) => <S {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></S>,
  doc: (p: IconProps) => <S {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></S>,
  import: (p: IconProps) => <S {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></S>,
  trash: (p: IconProps) => <S {...p}><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><path d="M9 7V4h6v3" /></S>,
  edit: (p: IconProps) => <S {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></S>,
  move: (p: IconProps) => <S {...p}><path d="M5 9l-3 3 3 3" /><path d="M9 5l3-3 3 3" /><path d="M15 19l-3 3-3-3" /><path d="M19 9l3 3-3 3" /><path d="M2 12h20M12 2v20" /></S>,
  refresh: (p: IconProps) => <S {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></S>,
  open: (p: IconProps) => <S {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></S>,
  retry: (p: IconProps) => <S {...p}><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3L3 8" /><path d="M3 3v5h5" /></S>,
  alert: (p: IconProps) => <S {...p}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></S>,
  check: (p: IconProps) => <S {...p}><path d="M20 6 9 17l-5-5" /></S>
}
