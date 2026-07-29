import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'

import { usePptSkillStore } from '../../stores/pptSkill'

/**
 * ppt-creator skill 的下载进度层（2026-07-29）。
 *
 * 这个 skill 不再随安装包发布（99MB / 12167 个文件），首次点「制作PPT」时
 * 才下载。三段工作共用这一个层，因为对用户来说它们是同一件事「正在准备」：
 *
 *   ① 下载 49MB   ② 解压 12167 个文件   ③ 首次建 Python 环境（最慢，可能几分钟）
 *
 * ③ 尤其要在这里体现：它原本是进会话后由 AI 跑第一个命令时才触发的，用户会
 * 在毫无提示的情况下干等几分钟（见 pptSkillInstaller 的注释）。
 *
 * **只挡 PPT 入口，不挡应用**：这一层是 portal 到 body 的覆盖层，关掉它下载
 * 继续在后台跑，用户可以先去做别的事。
 *
 * portal 出去的子树脱离 `.chat-app` 豁免，裸交互元素会被 canvas 的全局
 * reset 填成描边卡片——所以按钮都带 `data-slot`（2026-07-04 的教训）。
 */

/** 阶段 → 主标题。文案是给普通用户看的大白话，不出现「解压/venv」这类术语。 */
const PHASE_TITLE: Record<string, string> = {
  checking: '正在检查 PPT 组件…',
  downloading: '正在下载 PPT 组件…',
  extracting: '正在安装 PPT 组件…',
  'preparing-python': '正在准备运行环境…',
  ready: 'PPT 组件已就绪',
  error: 'PPT 组件准备失败'
}

/** 阶段 → 副标题（说明为什么要等、还要等什么）。 */
const PHASE_HINT: Record<string, string> = {
  checking: '正在获取最新版本信息',
  downloading: '首次使用需要下载一次，之后不再需要',
  extracting: '文件较多，请稍候',
  'preparing-python': '首次准备需要几分钟，之后每次都是秒开',
  ready: '现在可以开始制作 PPT 了',
  error: ''
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

export function PptSkillGate(): React.JSX.Element | null {
  const overlayOpen = usePptSkillStore((s) => s.overlayOpen)
  const status = usePptSkillStore((s) => s.status)
  const closeOverlay = usePptSkillStore((s) => s.closeOverlay)

  if (!overlayOpen || !status) return null

  const phase = status.phase
  const isError = phase === 'error'
  // 跨进程来的数据做一次兜底：dev 下 main 与 renderer 的热重载节奏不同步时，
  // 可能收到还没有这两个字段的旧结构，直接 .length 会让整个进度层白屏。
  const logTail = status.logTail ?? []
  // 下载阶段按字节算、解压按文件数算；总量未知（0）时退化成不确定进度条，
  // 而不是显示 NaN% 或假装 0%。
  const pct =
    status.total > 0 ? Math.min(100, Math.round((status.done / status.total) * 100)) : null
  const detail =
    phase === 'downloading' && status.total > 0
      ? `${formatBytes(status.done)} / ${formatBytes(status.total)}`
      : phase === 'extracting' && status.total > 0
        ? `${status.done} / ${status.total} 个文件`
        : ''

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/80 backdrop-blur-sm"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="w-[380px] rounded-2xl border border-border bg-card p-6 shadow-2xl"
        >
          <div className="text-[15px] font-semibold text-foreground">
            {PHASE_TITLE[phase] ?? '正在准备…'}
          </div>

          {isError ? (
            <p className="mt-2 text-[13px] leading-relaxed text-destructive">
              {status.error ?? '未知错误'}
            </p>
          ) : (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              {/* 实时动作优先于静态提示：建 venv 那几分钟里，「正在获取 numpy…」
                  比「首次准备需要几分钟」有用得多——用户能看出它在推进而不是卡死。 */}
              {status.detail || PHASE_HINT[phase] || ''}
            </p>
          )}

          {!isError && phase !== 'ready' && (
            <div className="mt-4">
              {/* 进度条：总量已知走确定进度，未知则一条循环滑块——不要用假的
                  百分比糊弄，用户等几分钟时最恨看到进度条卡在某个数字上。 */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
                {pct !== null ? (
                  <motion.div
                    className="h-full rounded-full bg-brand"
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  />
                ) : (
                  <motion.div
                    className="h-full w-1/3 rounded-full bg-brand"
                    animate={{ x: ['-100%', '300%'] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
              </div>
              <div className="mt-2 flex items-center justify-between text-[12px] text-muted-foreground/70">
                <span>{detail}</span>
                {pct !== null && <span>{pct}%</span>}
              </div>
            </div>
          )}

          {logTail.length > 0 && (
            <details className="mt-3 group">
              <summary
                data-slot="ppt-skill-log-toggle"
                className="cursor-pointer select-none list-none text-[12px] text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                <span className="inline-flex items-center gap-1">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-transform group-open:rotate-90"
                    aria-hidden
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  查看详细过程
                </span>
              </summary>
              {/* 原始输出：pip 的失败信息千奇百怪，映射表不可能穷举，出问题时
                  这几行原文才是能拿去搜索的东西。等宽字体 + 横向滚动，长路径
                  不换行撑破弹窗（宽内容自己滚，弹窗本身不横向滚）。 */}
              <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-foreground/[0.04] p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                {logTail.join('\n')}
              </pre>
            </details>
          )}

          <div className="mt-5 flex justify-end gap-2">
            {isError && (
              <button
                type="button"
                data-slot="ppt-skill-retry"
                onClick={() => {
                  void window.chatApi?.ensurePptSkill?.(true).then((s) => {
                    if (s) usePptSkillStore.getState().setStatus(s)
                  })
                }}
                className="rounded-lg bg-foreground px-3.5 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
              >
                重试
              </button>
            )}
            <button
              type="button"
              data-slot="ppt-skill-dismiss"
              onClick={closeOverlay}
              className="rounded-lg bg-foreground/[0.06] px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.12]"
            >
              {/* 关掉不取消下载——它在 main 的子进程里继续跑。文案要说清这点，
                  否则用户会以为点了就白下了，从而不敢关。 */}
              {isError ? '关闭' : '后台继续'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}
