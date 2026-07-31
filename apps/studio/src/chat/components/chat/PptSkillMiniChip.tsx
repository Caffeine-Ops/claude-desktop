import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'

import { cn } from '@/src/lib/utils'
import { isPptSkillBusy } from '@desktop-shared/pptSkillStatus'
import { usePptSkillStore } from '../../stores/pptSkill'

/**
 * PptSkillGate 点「后台继续」之后的去处（2026-07-31，补 docs/ui-prototype-
 * ppt-skill-gate.html 提出但一直没实现的「拟新增 PptSkillMiniChip」）。
 *
 * 关掉全屏进度层不等于下载停了——main 里的子进程照跑，`usePptSkillStore`
 * 的 status 订阅也照收推送（见 stores/pptSkill.ts:50-55）。之前 overlayOpen
 * 一关，用户就彻底看不到任何进度提示，唯一线索是「点『制作PPT』时突然又
 * 弹出一次进度层」——像是重新触发而不是接着之前的进度走。这一层把订阅到的
 * status 显式渲染出来，点它随时能展开回 PptSkillGate 的全屏层
 * （openOverlay，见 stores/pptSkill.ts:20）。
 *
 * 只在 `isPptSkillBusy` 时显示：ready 会被 hydratePptSkill 自动收起 overlay
 * （不需要再单独提醒「已就绪」），error 状态下 PptSkillGate 的关闭按钮走的
 * 是「关闭」文案而非「后台继续」——用户已经明确选择结束这次尝试，不需要一
 * 个常驻的失败胶囊追着他，下次点 PPT 入口会重新触发 ensurePptSkillReady。
 */

const CHIP_TEXT: Record<string, string> = {
  checking: '正在检查 PPT 组件',
  downloading: '正在下载 PPT 组件',
  extracting: '正在安装 PPT 组件',
  'preparing-python': '正在准备运行环境'
}

const RING_C = 2 * Math.PI * 7 // r=7 的周长

export function PptSkillMiniChip(): React.JSX.Element | null {
  const overlayOpen = usePptSkillStore((s) => s.overlayOpen)
  const status = usePptSkillStore((s) => s.status)
  const openOverlay = usePptSkillStore((s) => s.openOverlay)

  const visible = !overlayOpen && !!status && isPptSkillBusy(status)

  return createPortal(
    <AnimatePresence>
      {visible && status && (
        <motion.button
          type="button"
          data-slot="ppt-skill-mini-chip"
          onClick={openOverlay}
          title="展开查看进度"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-5 right-5 z-[9999] flex items-center gap-2.5 rounded-full border border-border bg-card px-3.5 py-2.5 text-[12px] font-medium text-foreground shadow-[0_24px_80px_rgba(0,0,0,0.35)] transition-colors hover:bg-foreground/[0.04]"
        >
          {status.total > 0 ? (
            <svg width="18" height="18" viewBox="0 0 18 18" className="flex-none" aria-hidden="true">
              <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2.4" className="stroke-foreground/10" />
              <circle
                cx="9"
                cy="9"
                r="7"
                fill="none"
                strokeWidth="2.4"
                strokeLinecap="round"
                transform="rotate(-90 9 9)"
                className="stroke-brand transition-[stroke-dashoffset] duration-300 ease-out"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - Math.min(1, status.done / status.total))}
              />
            </svg>
          ) : (
            <span className="relative size-[18px] flex-none">
              <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand" />
            </span>
          )}
          <span>{CHIP_TEXT[status.phase] ?? '正在准备…'}</span>
          {status.total > 0 && (
            <span className={cn('text-muted-foreground/70')}>
              {Math.round(Math.min(1, status.done / status.total) * 100)}%
            </span>
          )}
        </motion.button>
      )}
    </AnimatePresence>,
    document.body
  )
}
