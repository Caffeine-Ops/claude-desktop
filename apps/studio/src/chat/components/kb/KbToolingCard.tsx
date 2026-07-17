import React, { useEffect, useState } from 'react'
import { initialComponentState } from '@desktop-shared/componentDownload'
import { useComponentStore } from '../../stores/components'
import { useT } from '../../i18n'
import { kbIcons } from './kbIcons'

/**
 * 「未检测到 markitdown」引导卡片：替代原来的一行红字报错。给用户一个【一键安装】按钮
 * （触发编排器 startComponentInstall('markitdown')，主进程走 pipx/pip 装 markitdown，
 * 装完 PATH 补全后当场探测/转换），进度/结果全部改读组件状态表（Task 5/7 的
 * useComponentStore），本卡片自身不再持安装结果：
 *  - installing    → 转圈禁用按钮
 *  - ready         → markitdown 变 ready 后 KbToolbar 的 gate 直接卸载本卡片
 *  - unavailable   → 缺 Python/pipx 前置，引导手动装 Python，手动命令改推 pip（缺 pipx 时推 pipx 是死路）
 *  - error         → 引导手动装并可展开安装日志（errorMessage）排查
 * 只读机不渲染本卡片（gate 在 KbToolbar，与工具缺失横幅同源）。
 */
export function KbToolingCard(): React.JSX.Element {
  const t = useT()
  const init = useComponentStore((s) => s.init)
  // 订阅 table 本身再派生，不写 (s) => s.stateOf('markitdown')：同 KbToolbar 的注释——
  // 后者要么函数引用恒定等于没订阅，要么每次新建对象致 getSnapshot 不稳定。
  const table = useComponentStore((s) => s.table)
  const md = table['markitdown'] ?? initialComponentState('markitdown')
  useEffect(() => init(), [init])
  const [showLog, setShowLog] = useState(false)
  const [copied, setCopied] = useState(false)
  const busy = md.status === 'installing'

  // 手动兜底命令：一般情形推荐 pipx；但「缺前置(unavailable)」恰恰是连 pipx 都没有，
  // 那时推 `pipx install …` 是死路（command not found），改推 pip——装好 Python 就自带 pip。
  const manualCmd = md.status === 'unavailable'
    ? 'python3 -m pip install --user markitdown'
    : 'pipx install markitdown'

  const install = (): void => {
    if (busy) return
    setShowLog(false)
    void window.chatApi.startComponentInstall('markitdown')
  }

  const copyCmd = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(manualCmd)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用则忽略——命令是可见文本，用户可手动选中复制。
    }
  }

  // 失败反馈文案（ready 态不显示，卡片会随组件表变 ready 而被 KbToolbar 的 gate 直接卸载）。
  const feedbackText = md.status === 'unavailable'
    ? t('kbToolingUnsupported')
    : md.status === 'error'
      ? t('kbToolingFailed')
      : null

  return (
    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <kbIcons.alert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-[12.5px] font-medium text-foreground">{t('kbToolingTitle')}</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t('kbToolingDesc')}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-6">
        <button type="button" disabled={busy} onClick={install}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-[12px] font-medium text-background hover:opacity-90 disabled:opacity-60">
          {busy
            ? <kbIcons.refresh className="size-3.5 animate-spin" />
            : <kbIcons.import className="size-3.5" />}
          {busy ? t('kbToolingInstalling') : t('kbToolingInstall')}
        </button>
        {!busy && (
          <button type="button" onClick={() => void copyCmd()} title={manualCmd}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11.5px] text-muted-foreground hover:bg-muted/60">
            <code className="font-mono text-[11px]">{manualCmd}</code>
            <span className="inline-flex items-center gap-1 text-[10.5px] opacity-70">
              {copied ? <kbIcons.check className="size-3" /> : null}{t('kbToolingManual')}
            </span>
          </button>
        )}
      </div>

      {feedbackText && (
        <div className="space-y-1 pl-6">
          <p className="text-[11px] leading-relaxed text-destructive">{feedbackText}</p>
          {md.errorMessage && (
            <div>
              <button type="button" onClick={() => setShowLog((v) => !v)}
                className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline">
                {showLog ? '▾ ' : '▸ '}{t('kbToolingLog')}
              </button>
              {showLog && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-[10.5px] leading-relaxed text-muted-foreground">{md.errorMessage}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
