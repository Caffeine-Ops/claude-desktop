import React, { useState } from 'react'
import { useKbStore } from '../../stores/kb'
import { useT } from '../../i18n'
import { kbIcons } from './kbIcons'
import type { KbToolingInstallResult } from '@desktop-shared/kbAdmin'

/**
 * 「未检测到 markitdown」引导卡片：替代原来的一行红字报错。给用户一个【一键安装】按钮
 * （主进程走 pipx/pip 装 markitdown，且补全 PATH 后当场探测/转换），装完按两态反馈：
 *  - ok            → 自动 refresh，markitdown 变 true 后本卡片整体卸载（由 KbToolbar 的 gate 决定）
 *  - unsupported   → 缺 Python/pipx 前置，引导手动装 Python，手动命令改推 pip（缺 pipx 时推 pipx 是死路）
 *  - 其余失败       → 引导手动装并可展开安装日志排查
 * 只读机不渲染本卡片（gate 在 KbToolbar，与工具缺失横幅同源）。
 */
export function KbToolingCard(): React.JSX.Element {
  const t = useT()
  const refresh = useKbStore((s) => s.refresh)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<KbToolingInstallResult | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [copied, setCopied] = useState(false)

  // 手动兜底命令：一般情形推荐 pipx；但「缺前置(unsupported)」恰恰是连 pipx 都没有，
  // 那时推 `pipx install …` 是死路（command not found），改推 pip——装好 Python 就自带 pip。
  const manualCmd = result?.unsupported
    ? 'python3 -m pip install --user markitdown'
    : 'pipx install markitdown'

  const install = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setResult(null)
    setShowLog(false)
    try {
      const r = await window.chatApi.kbInstallTooling()
      setResult(r)
      // 装好且补全 PATH 后即刻可用 → 重拉 tooling；markitdown 变 true 后 KbToolbar 不再渲染本卡片。
      if (r.ok) await refresh()
    } catch (err) {
      // IPC/主进程异常一律归「通用失败」——不能当成 unsupported 去让用户装本来就有的 Python（评审 #3）。
      setResult({
        ok: false, unsupported: false,
        tooling: { markitdown: false, soffice: false },
        log: String(err instanceof Error ? err.message : err)
      })
    } finally {
      setBusy(false)
    }
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

  // 失败反馈文案（ok 态不显示，卡片会随 refresh 卸载）。
  const feedbackText = ((): string | null => {
    if (!result || result.ok) return null
    return result.unsupported ? t('kbToolingUnsupported') : t('kbToolingFailed')
  })()

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
        <button type="button" disabled={busy} onClick={() => void install()}
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
          {result?.log && (
            <div>
              <button type="button" onClick={() => setShowLog((v) => !v)}
                className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline">
                {showLog ? '▾ ' : '▸ '}{t('kbToolingLog')}
              </button>
              {showLog && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-[10.5px] leading-relaxed text-muted-foreground">{result.log}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
