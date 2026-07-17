import React, { useEffect, useState } from 'react'
import { initialComponentState } from '@desktop-shared/componentDownload'
import { useT, type StringKey } from '../../i18n'
import { useComponentStore } from '../../stores/components'
import { Section } from './SettingsView'

// 组件 id → i18n 键映射（前端不 import main 侧 registry，标题/描述走 i18n）。
// guideUrl（soffice）也在此硬映射，避免前端依赖 main 档案卡。
const ROWS: { id: string; titleKey: StringKey; descKey: StringKey; guideUrl?: string }[] = [
  { id: 'kb-embed', titleKey: 'compEmbedTitle', descKey: 'compEmbedDesc' },
  // markitdown 的 unavailable 成因是「缺 Python」（pipx 连 python 都探不到），guideUrl 指向 Python 官方下载页。
  { id: 'markitdown', titleKey: 'compMarkitdownTitle', descKey: 'compMarkitdownDesc', guideUrl: 'https://www.python.org/downloads/' },
  { id: 'soffice', titleKey: 'compSofficeTitle', descKey: 'compSofficeDesc', guideUrl: 'https://www.libreoffice.org/download/download/' },
  // python-runtime(P1c):hosted-files/archive 策略,状态机与 embed 同款。linux 等未支持平台
  // 上名册不注册此卡→整表无此格→本行兜底渲染成 idle 死按钮,但正式包只发 mac/win,不处理。
  { id: 'python-runtime', titleKey: 'compPythonTitle', descKey: 'compPythonDesc' },
]

export function ComponentsSection(): React.JSX.Element {
  const t = useT()
  const init = useComponentStore((s) => s.init)
  // 必须订阅 table 本身，不能选 stateOf 函数：函数引用恒定不变，选它等于没订阅任何会变的东西，
  // 后台推来新进度时组件不会重渲染、进度条永远不动。也别写 useComponentStore((s) => s.stateOf(id))
  // ——那样每次都新建对象、Object.is 恒 false，无关更新也触发重渲染。选 table、在外面派生最省。
  const table = useComponentStore((s) => s.table)
  // 首个快照是否已落地——未加载时 table 是空表，三行会统一兜底成 idle 渲染成「可下载」，
  // 而实际探测结论可能是「已装」，这是会误导用户的一闪（终审 Important 1，酌情处理：只在
  // 这里插一句加载态占位，不逐行做骨架屏，避免过度设计）。
  const loaded = useComponentStore((s) => s.loaded)
  // 订阅整表（组件卸载时退订）。
  useEffect(() => init(), [init])

  return (
    <section className="space-y-8">
      <h1 className="text-[20px] font-semibold text-foreground">{t('componentsTitle')}</h1>
      {/* Section 省略 title：紧跟在上面的 <h1>{componentsTitle}</h1> 之后再叠一遍同一句
          「组件 / 扩展」会重复（终审 Minor 5）。KnowledgeBaseSection 的 h1/Section 分别用
          catKnowledgeBase/kbSourceTitle 两个不同层级的键区分；这里没有对应的「子标题」概念
          （三行本就是同一个类目下的平铺列表），description 已经把这块内容交代清楚，直接省掉
          Section 的 title 最省事，不硬造一个没有信息量的新键。 */}
      <Section description={t('componentsDesc')}>
        {loaded ? (
          <div className="space-y-2">
            {ROWS.map((row) => (
              <ComponentRow key={row.id} row={row} state={table[row.id] ?? initialComponentState(row.id)} />
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t('componentsLoading')}</p>
        )}
      </Section>
    </section>
  )
}

function ComponentRow({ row, state }: {
  row: { id: string; titleKey: StringKey; descKey: StringKey; guideUrl?: string }
  state: import('@desktop-shared/componentDownload').ComponentState
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{t(row.titleKey)}</p>
        <p className="text-[11.5px] text-muted-foreground/80">{t(row.descKey)}</p>
        {state.status === 'error' && state.errorMessage && (
          <p className="mt-1 text-[11px] text-destructive">{state.errorMessage}</p>
        )}
      </div>
      <div className="shrink-0">
        <RowAction id={row.id} guideUrl={row.guideUrl} state={state} />
      </div>
    </div>
  )
}

function RowAction({ id, guideUrl, state }: {
  id: string
  guideUrl?: string
  state: import('@desktop-shared/componentDownload').ComponentState
}): React.JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const start = (): void => { void window.chatApi.startComponentInstall(id) }
  const cancel = (): void => { void window.chatApi.cancelComponentInstall(id) }

  if (state.status === 'ready') {
    return (
      <span className="text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
        ✓ {t('compReady')}
        {/* 「随包」来源注记(P1c):就绪是靠随包/dev 目录里的现成 runtime 判的(userData 无下载
            副本)时,补一个灰字标签——P1b 预留的 compBundled 死键就此转正。只有 python 的就绪
            探针会写 origin='bundled'(componentOrchestrator READY_PROBES)。 */}
        {state.origin === 'bundled' && (
          <span className="ml-1.5 font-normal text-muted-foreground/70">{t('compBundled')}</span>
        )}
      </span>
    )
  }
  if (state.status === 'installing') {
    return (
      <div className="flex items-center gap-2">
        {state.percent != null ? (
          <>
            <div className="relative h-1.5 w-28 rounded-full bg-muted">
              <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]" style={{ width: `${state.percent}%` }} />
            </div>
            <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{state.percent}%</span>
            <button type="button" onClick={cancel}
              className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground hover:bg-muted/60">
              {t('compCancel')}
            </button>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
            {t('compInstalling')}
          </span>
        )}
      </div>
    )
  }
  if (state.status === 'unavailable') {
    // 装不了（soffice / markitdown 缺 python 前置）：给可见的安装引导链接。
    // preload 未暴露任何「打开外部链接」的 IPC 方法（grep 过 electron/preload/index.ts 确认），
    // 所以这里退化成「点击复制安装页地址」而非真正跳转浏览器——但退化不等于装糊涂：链接本身
    // 用 <code> 摆在按钮里可见（不用 hover 也看得到复制的是什么），按钮文案明写「复制链接」这个
    // 动作，不再用「如何安装」当动作标签（评审 Important：原先静默复制、唯一线索是 hover
    // tooltip，全仓其它复制控件——AssistantMarkdown CopyButton / WorkspaceTreePanel
    // CopyNameButton / KbToolingCard 手动命令——无一例外都是「标签明写复制」或「内容可见摆出来」，
    // 这里补齐同一惯例）。复制成功后 1.5s 内文案闪一下「已复制」，沿用既有 filesCopyNameCopied。
    return guideUrl ? (
      <button type="button" title={guideUrl} onClick={() => {
        void navigator.clipboard?.writeText(guideUrl).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-[11.5px] text-foreground hover:bg-muted/60">
        <code className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">{guideUrl}</code>
        <span className="whitespace-nowrap text-[11.5px] font-medium">{copied ? t('filesCopyNameCopied') : t('compCopyLink')}</span>
      </button>
    ) : (
      <span className="text-[12px] text-muted-foreground">{t('compHowToInstall')}</span>
    )
  }
  // idle / error → 下载/安装 或 重试
  return (
    <button type="button" onClick={start}
      className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground hover:bg-accent/90">
      {state.status === 'error' ? t('compRetry') : (id === 'kb-embed' ? t('compDownload') : t('compInstall'))}
    </button>
  )
}
