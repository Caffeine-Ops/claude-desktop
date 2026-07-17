import React, { useEffect, useRef, useState } from 'react'
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
  'python-runtime': 'compPythonTitle',
}

// idle 态邀请正文的 per-id 覆盖(仅 python):它的触发场景是「AI 正在做 PPT」,通用的
// compPromptBody(「这个功能需要 X」)说不清「本次不等你、系统 Python 照跑」这层诚实,
// 单独给一句。其余组件继续走通用键。
const BODY_KEY: Record<string, StringKey> = {
  'python-runtime': 'compPromptBodyPython',
}

// unavailable 态的手动安装引导链接（修复轮 Fix 1）。与 ComponentsSection.tsx 的 ROWS
// 硬映射保持一致的成因：markitdown 的 unavailable 是「pipx 探不到 python」，soffice 是
// 「detect-only 没探测到本机安装」。前端不 import main 侧 componentRegistry（同 ComponentsSection
// 头注释的既有理由），故在这里重复一份而非跨进程共享。kb-embed 是 hosted-files 策略，
// 永远不会落到 unavailable，不在此表——留空走下面的 compHowToInstall 兜底文案。
const GUIDE_URL: Record<string, string | undefined> = {
  'markitdown': 'https://www.python.org/downloads/',
  'soffice': 'https://www.libreoffice.org/download/download/',
}

/**
 * 渐进式非阻断弹窗，右下角浮出。四个渲染分支（修复轮 Fix 1 前是三支，unavailable 混在
 * 「初始」分支里点了没反应——soffice 是 detect-only、markitdown 缺 python 时都会落到
 * unavailable，后端对前者早退、对后者重试也注定同样失败，不能给一个亮着的主按钮）：
 *  1. idle/error   [现在下载/重试][暂不]（error 态额外显 errorMessage）
 *  2. installing   进度条/转圈 + [查看下载详情] + [收起]（终审 Important 2：embed 几百 MB、
 *                   markitdown 的 pipx 最长 5 分钟，这段时间不能没有关闭键——见下方分支内注释）
 *  3. unavailable  引导手动安装：guideUrl（可见 + 复制）+ [暂不]，无主安装按钮
 *  4. ready        一句「说清变了什么」+ 自动淡出；若用户已关掉弹窗 → toast 报喜
 * 常驻挂载：openFor==null 时渲染 null。
 */
export function ComponentPrompt(): React.JSX.Element | null {
  const t = useT()
  const tFormat = useTFormat()
  const openFor = useComponentPromptStore((s) => s.openFor)
  const close = useComponentPromptStore((s) => s.close)
  const hide = useComponentPromptStore((s) => s.hide)
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

  // 成功后：短暂展示成功话再自动关；若此刻弹窗已被用户关掉（openFor 变 null 由 close/hide 触发），
  // 则在 KbToolbar/触发点侧用 toast 兜底（此处只管弹窗还开着的情形）。
  //
  // 用 hide() 不用 close()（复审判断，Fix 1 收尾）：这次自动收起不是「用户拒绝」，是「装好了，
  // 弹窗任务完成，自己收起」——语义上更贴近 hide。眼下功能门是 `status !== 'ready' && !dismissed`，
  // 此刻 status 已经是 ready，写不写 dismissed 对*这一次*门禁判断确实没差（hint 提到的这点成立）。
  // 但 dismissed 是会话级状态，不会随 ready 一起清零；而 ready 不是终态——`applyDetectedStatus`
  // 会在下次探测时把「磁盘上东西被删了」的组件从 ready 降回 idle（componentOrchestrator.ts 同名
  // 函数）。如果这里错误地 close()，dismissed[id] 会被永久置 true，之后哪怕组件真的掉回非
  // ready，功能门也会因为 dismissed 已经是 true 而不再提示——等于「装好一次」换来「以后被卸载
  // 也不会再提醒」，这正是 Fix 1 要堵的同一类「误标拒绝」后果。hide() 不写 dismissed，不会有
  // 这层副作用。
  const doneShownRef = useRef(false)
  useEffect(() => {
    if (state?.status === 'ready' && openFor && !doneShownRef.current) {
      doneShownRef.current = true
      const id = window.setTimeout(() => { hide(); doneShownRef.current = false }, 3000)
      return () => window.clearTimeout(id)
    }
    if (!openFor) doneShownRef.current = false
  }, [state?.status, openFor, hide])

  if (!openFor || !state) return null

  const start = (): void => { void window.chatApi.startComponentInstall(openFor) }
  const goDetails = (): void => { openSettingsPage(); /* 保留弹窗，用户可在两处看进度 */ }
  const guideUrl = GUIDE_URL[openFor]

  return (
    // bottom 偏移不是 bottom-4：Toaster.tsx（Task 8，不可改）常驻挂在同一角 bottom-4 right-4
    // z-[60]，从下往上堆叠 toast；而本弹窗「走开报喜」逻辑存在的意义恰恰是「弹窗正开着看 A、
    // 后台 B 装好了」——这正是两块面同屏的主场景，不是边角情形。留出约两条 toast 的净空
    // （单条 toast 实测约 40px 高 + gap-2 8px + Toaster 自己的 bottom-4 16px），弹窗坐在
    // toast 堆叠区上方，两者不再重叠（修复轮 Fix 2）。
    <div className="pointer-events-none fixed bottom-28 right-4 z-[55] w-[340px]" data-slot="component-prompt">
      <div className="pointer-events-auto space-y-3 rounded-xl border border-border bg-card p-4 shadow-xl">
        {state.status === 'ready' ? (
          <p className="text-[12.5px] text-emerald-700 dark:text-emerald-300">
            {/* embed 的成功话必须条件式（后台重建只在知识库已有资料时才跑），非 embed
                没有任何后台收尾，措辞不能提「后台」——两个键分岔，见 Fix 3 注释 */}
            {tFormat(openFor === 'kb-embed' ? 'compPromptDoneEmbed' : 'compPromptDone', { title })}
          </p>
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
            <div className="flex items-center gap-3">
              <button type="button" onClick={goDetails}
                className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                {t('compPromptDetails')}
              </button>
              {/* 关闭/收起键（终审 Important 2）：装几百 MB / pipx 最长 5 分钟，这段时间弹窗不该
                  钉死在屏幕上关不掉——自己的文案（compPromptBody）都写着「下载在后台进行，不打断
                  你」。用 hide() 不用 close()（复审 Minor，Fix 1）：安装正在跑，用户此刻只是不想
                  看进度条，不是在拒绝这个组件——close() 会把 openFor 写进 dismissed，而 dismissed
                  的语义是「用户说过[暂不]」，KbToolbar 的功能门据此本次会话内不再提示。故障剧本：
                  点[收起]（本意只是收起面板）→ 安装恰好失败（error）→ 用户点「同步」→ 因
                  promptDismissed('markitdown') 已是 true 而不再弹提示 → 静默降级，用户完全不知道
                  装失败了。hide() 只碰 openFor，不写 dismissed，不触碰后端：安装继续跑、广播照推。
                  装好那一刻 openFor 已是 null，正好落进上面「走开报喜」toast 兜底的 useEffect
                  （`openFor !== id` 成立）——两处逻辑本就是为此配套的，不是新增一条独立路径。 */}
              <button type="button" onClick={hide}
                className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                {t('compPromptHide')}
              </button>
            </div>
          </>
        ) : state.status === 'unavailable' ? (
          <UnavailablePanel title={title} guideUrl={guideUrl} onLater={close} />
        ) : (
          <>
            {/* error 态用自己的标题/正文（实机验证抓的缺口）：这支分支同时渲染 idle 和 error，
                原先两态共用邀请语气的 compPromptBody——「要现在下载吗？」贴着红字报错自相矛盾。
                按钮早已按态分岔（error 叫「重试」，Fix 4），文案跟上同一分岔。 */}
            <p className="text-[12.5px] font-medium text-foreground">
              {t(state.status === 'error' ? 'compPromptErrorTitle' : 'compPromptTitle')}
            </p>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              {tFormat(state.status === 'error' ? 'compPromptErrorBody' : (BODY_KEY[openFor] ?? 'compPromptBody'), { title })}
            </p>
            {state.status === 'error' && state.errorMessage && (
              <p className="text-[11px] text-destructive">{state.errorMessage}</p>
            )}
            <div className="flex items-center gap-2">
              <button type="button" onClick={start}
                className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground hover:bg-accent/90">
                {/* error 态叫「重试」而非「现在下载」，对齐 ComponentsSection.tsx 的 RowAction（Fix 4） */}
                {state.status === 'error' ? t('compRetry') : t('compPromptNow')}
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

/**
 * unavailable 分支（修复轮 Fix 1）：不给死按钮——soffice 是 detect-only，
 * `startComponentInstall` 对它早退什么都不发生；markitdown 缺 python 时重跑一次注定
 * 同样失败。改成可见的手动安装引导，语义对齐 ComponentsSection.tsx 的 RowAction：
 * 有 guideUrl 就摆出 `<code>` + 复制按钮（unavailable 态不带 errorMessage，链接本身
 * 就是全部的解释），没有则退化成一句「如何安装」占位文案（当前只有 kb-embed 会落进这个
 * 兜底，但它不会到 unavailable 态，纯类型兜底）。
 */
function UnavailablePanel({ title, guideUrl, onLater }: {
  title: string
  guideUrl: string | undefined
  onLater: () => void
}): React.JSX.Element {
  const t = useT()
  const tFormat = useTFormat()
  const [copied, setCopied] = useState(false)
  return (
    <>
      <p className="text-[12.5px] font-medium text-foreground">{title}</p>
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">{tFormat('compPromptUnavailableBody', { title })}</p>
      {guideUrl ? (
        <button type="button" title={guideUrl} onClick={() => {
          void navigator.clipboard?.writeText(guideUrl).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
        }}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-left hover:bg-muted/60">
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{guideUrl}</code>
          <span className="shrink-0 whitespace-nowrap text-[11.5px] font-medium text-foreground">
            {copied ? t('filesCopyNameCopied') : t('compCopyLink')}
          </span>
        </button>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">{t('compHowToInstall')}</p>
      )}
      <button type="button" onClick={onLater}
        className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground hover:bg-muted/60">
        {t('compPromptLater')}
      </button>
    </>
  )
}
