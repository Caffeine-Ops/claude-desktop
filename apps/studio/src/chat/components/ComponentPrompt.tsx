import React, { useEffect, useRef } from 'react'
import { initialComponentState, type ComponentTable } from '@desktop-shared/componentDownload'
import { useT, useTFormat, type StringKey } from '../i18n'
import { useComponentPromptStore } from '../stores/componentPrompt'
import { useComponentStore } from '../stores/components'
import { useSettingsStore } from '../stores/settings'
import { toast } from '../stores/toast'

// 组件 id → 标题 i18n 键（与 ComponentsSection 的映射一致，供弹窗文案插值）。
// 类型钉 StringKey（不是裸 string）：同 ComponentsSection.tsx 的 ROWS 约定，
// 让 t(TITLE_KEY[id]) 直接过 useT() 的 (key: StringKey) => string 签名，
// 不用在每处调用点补 as 断言。
const TITLE_KEY: Record<string, StringKey> = {
  'kb-embed': 'compEmbedTitle',
  'markitdown': 'compMarkitdownTitle',
  'soffice': 'compSofficeTitle',
}

/**
 * 渐进式非阻断弹窗，右下角浮出。四阶段：
 *  1. 初始   [现在下载][暂不]
 *  2. 下载中 进度条/转圈 + [查看下载详情]（跳组件中心）
 *  3. 成功   一句「说清变了什么」+ 自动淡出；若用户已关掉弹窗 → toast 报喜
 *  4. 失败/暂不 → 关掉，功能照旧静默降级
 * 常驻挂载：openFor==null 时渲染 null。
 */
export function ComponentPrompt(): React.JSX.Element | null {
  const t = useT()
  const tFormat = useTFormat()
  const openFor = useComponentPromptStore((s) => s.openFor)
  const close = useComponentPromptStore((s) => s.close)
  const init = useComponentStore((s) => s.init)
  // 订阅 table 本身而非 stateOf 函数：函数引用恒定，选它等于没订阅会变的东西，进度推送来了
  // 弹窗不会重渲染、进度条不动（同 ComponentsSection 的注释）。
  const table = useComponentStore((s) => s.table)
  // 「查看下载详情」的开法核实结论（Task 9 Before You Begin 要求现场核实）：
  // useSettingsStore 实际只有布尔 `open` 态 + 无参 `openSettings()`（apps/studio/src/chat/
  // stores/settings.ts），不是 brief 假设的 `open(categoryId?)`。SettingsView.tsx 的
  // activeCategory 是 SettingsBody 组件内的 local useState（该文件头注释明written「Active
  // category lives inside the view as local state because nothing outside it cares」），
  // 外部没有任何入口可以定位分类。故按 brief 允许的降级路径处理：只调用 openSettings() 打开
  // 设置页首屏，不定位到「组件」分类，用户需要自己点开左侧 rail 的「组件 / 扩展」。不改
  // SettingsView 的分类状态架构（超出本任务范围）。
  const openSettingsPage = useSettingsStore((s) => s.openSettings)

  // 订阅整表（弹窗独立订阅一次，保证即便组件中心没开也能拿进度）。
  useEffect(() => init(), [init])

  // 「用户走开也知道装好了」——本组件常挂 App 根，是唯一always-on 的整表观察点，故把这个
  // 兜底放这。观察任一组件 installing→ready 的跃迁：若此刻弹窗没在展示该组件（用户点了叉、
  // 或压根是从组件中心触发的），就用角落 toast 报喜；弹窗正展示它时不发，避免和弹窗自己的
  // 成功话重复。prevRef 存上一帧整表用于做边沿判断（只在跃迁那一下发一次，不是每次推送都发）。
  const prevRef = useRef<ComponentTable>({})
  useEffect(() => {
    const prev = prevRef.current
    for (const [id, st] of Object.entries(table)) {
      const titleKey = TITLE_KEY[id]
      if (prev[id]?.status === 'installing' && st.status === 'ready' && openFor !== id && titleKey) {
        toast(tFormat('compPromptToast', { title: t(titleKey) }), 'ok')
      }
    }
    prevRef.current = table
  }, [table, openFor, t, tFormat])

  const state = openFor ? (table[openFor] ?? initialComponentState(openFor)) : null
  const titleKey = openFor ? TITLE_KEY[openFor] : undefined
  const title = titleKey ? t(titleKey) : ''

  // 成功后：短暂展示成功话再自动关；若此刻弹窗已被用户关掉（openFor 变 null 由 close 触发），
  // 则在 KbToolbar/触发点侧用 toast 兜底（此处只管弹窗还开着的情形）。
  const doneShownRef = useRef(false)
  useEffect(() => {
    if (state?.status === 'ready' && openFor && !doneShownRef.current) {
      doneShownRef.current = true
      const id = window.setTimeout(() => { close(); doneShownRef.current = false }, 3000)
      return () => window.clearTimeout(id)
    }
    if (!openFor) doneShownRef.current = false
  }, [state?.status, openFor, close])

  if (!openFor || !state) return null

  const start = (): void => { void window.chatApi.startComponentInstall(openFor) }
  const goDetails = (): void => { openSettingsPage(); /* 保留弹窗，用户可在两处看进度 */ }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[55] w-[340px]" data-slot="component-prompt">
      <div className="pointer-events-auto space-y-3 rounded-xl border border-border bg-card p-4 shadow-xl">
        {state.status === 'ready' ? (
          <p className="text-[12.5px] text-emerald-700 dark:text-emerald-300">{tFormat('compPromptDone', { title })}</p>
        ) : state.status === 'installing' ? (
          <>
            <p className="text-[12.5px] font-medium text-foreground">{title}</p>
            {state.percent != null ? (
              <div className="relative h-1.5 w-full rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]" style={{ width: `${state.percent}%` }} />
              </div>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
                {t('compInstalling')}
              </span>
            )}
            <button type="button" onClick={goDetails}
              className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {t('compPromptDetails')}
            </button>
          </>
        ) : (
          <>
            <p className="text-[12.5px] font-medium text-foreground">{t('compPromptTitle')}</p>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">{tFormat('compPromptBody', { title })}</p>
            {state.status === 'error' && state.errorMessage && (
              <p className="text-[11px] text-destructive">{state.errorMessage}</p>
            )}
            <div className="flex items-center gap-2">
              <button type="button" onClick={start}
                className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground hover:bg-accent/90">
                {t('compPromptNow')}
              </button>
              <button type="button" onClick={close}
                className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground hover:bg-muted/60">
                {t('compPromptLater')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
