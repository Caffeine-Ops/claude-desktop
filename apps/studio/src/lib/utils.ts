import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn/ui 的标准 cn()：clsx 组合条件类名 + tailwind-merge 去重冲突
 * utility（后写的赢）。所有 src/components/ui/ 下的组件都依赖它。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
