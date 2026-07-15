import React, { useEffect, useState } from 'react'

import { useT } from '../../i18n'
import type { KbSyncStatus } from '@desktop-shared/kbSyncStatus'
import type { KbModelDownloadState } from '@desktop-shared/kbModelDownload'
import { Section } from './SettingsView'

type KbPathState = Awaited<ReturnType<typeof window.chatApi.getKbPath>>

/**
 * KnowledgeBaseSection
 * --------------------
 * 设置页「知识库」分区：本地目录 / 远程服务器 两种资料来源二选一，供「写方案」
 * 检索。数据流对齐 GeneralSection——mount 拉一次 `getKbPath()`，任何写操作
 * （切源/选目录/保存远程地址）后主动 refresh()，另外订阅 `onKbSyncStatus` 拿
 * 同步进度的实时推送（success 后也 refresh 一次，因为 lastSync 变了）。
 *
 * `mode` 是"当前实际生效"的来源（由 state.remote 是否存在派生，来自持久化配置）；
 * `uiTab` 是"当前展开哪块面板"的纯 UI 选择，二者初始同步、之后可能短暂分叉——
 * 点「远程服务器」单选行只是切到远程面板去填地址，并不立即写配置（不然一次误点
 * 就把已经工作的本地 kbRoot 挤掉、且 baseUrl 还是空的）；真正提交发生在填完地址
 * 点「保存并同步」（applyRemote）那一刻。点「本地目录」则没有这个空值问题——
 * switchToLocal() 直接把 remote 置空，可以立即提交。
 */
export function KnowledgeBaseSection(): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<KbPathState | null>(null)
  const [urlDraft, setUrlDraft] = useState('')
  const [sync, setSync] = useState<KbSyncStatus>({ state: 'idle' })
  const [uiTab, setUiTab] = useState<'local' | 'remote'>('local')
  const [model, setModel] = useState<KbModelDownloadState | null>(null)

  // 三个独立 busy 标记而非共用一个：选目录、切本地、保存远程地址是三个互斥但各自
  // 独立触发的动作，共用一个 busy 会导致点了 A 按钮时 B 按钮的 disabled 态失真
  // （明明没在跑却灰着，或者反过来）。
  const [picking, setPicking] = useState(false)
  const [switchingLocal, setSwitchingLocal] = useState(false)
  const [applyingRemote, setApplyingRemote] = useState(false)
  const [syncNowBusy, setSyncNowBusy] = useState(false)

  const refresh = (): void => {
    void window.chatApi.getKbPath().then((s) => {
      setState(s)
      setUrlDraft(s.remote?.baseUrl ?? '')
      // 每次拉到新状态都把面板选择跟实际生效来源对齐——这是唯一会覆盖 uiTab 的
      // 地方，且只在 refresh 完成时发生（mount / 写操作之后 / sync 成功推送后），
      // 不会打断用户正在远程面板里敲地址的过程（那期间没有 refresh 被触发）。
      setUiTab(s.remote ? 'remote' : 'local')
    })
  }

  useEffect(() => {
    refresh()
    const off = window.chatApi.onKbSyncStatus((s) => {
      setSync(s)
      if (s.state === 'success') refresh() // 成功后 lastSync 变了，重拉一次
    })
    return off
  }, [])

  useEffect(() => {
    void window.chatApi.kbModelDownloadStatusGet().then(setModel)
    const off = window.chatApi.onKbModelDownload(setModel)
    return off
  }, [])

  const mode: 'local' | 'remote' = state?.remote ? 'remote' : 'local'

  const applyRemote = async (): Promise<void> => {
    const baseUrl = urlDraft.trim()
    if (!baseUrl || applyingRemote) return
    setApplyingRemote(true)
    try {
      await window.chatApi.setKbRemote({ baseUrl, kbId: 'default' }) // kbId 口子：UI 本期不暴露
      refresh()
    } catch (err) {
      console.error('[settings] setKbRemote failed', err)
    } finally {
      setApplyingRemote(false)
    }
  }

  const switchToLocal = async (): Promise<void> => {
    if (switchingLocal) return
    setUiTab('local') // 乐观切面板，refresh() 落地后会再确认一次
    // 已生效来源就是本地时短路（含「远程面板只是预览、从未提交」的情形）：
    // 点已选中项只收回面板，不重发 setKbRemote(null)+写盘+refresh——对齐远程
    // radio 纯 setUiTab 的零副作用行为。
    if (mode === 'local') return
    setSwitchingLocal(true)
    try {
      await window.chatApi.setKbRemote(null)
      refresh()
    } catch (err) {
      console.error('[settings] setKbRemote(null) failed', err)
    } finally {
      setSwitchingLocal(false)
    }
  }

  const pickLocal = async (): Promise<void> => {
    if (picking) return
    setPicking(true)
    try {
      const { path } = await window.chatApi.pickKbRoot()
      if (path) {
        await window.chatApi.setKbPath(path)
        refresh()
      }
    } catch (err) {
      console.error('[settings] pickKbRoot/setKbPath failed', err)
    } finally {
      setPicking(false)
    }
  }

  const syncNow = async (): Promise<void> => {
    if (syncNowBusy) return
    setSyncNowBusy(true)
    try {
      // 结果值（started/alreadyRunning/noRemote）只是"请求是否受理"，真正的
      // 进度/成败走 onKbSyncStatus 推送渲染，这里不用管返回值。
      await window.chatApi.kbSyncNow()
    } catch (err) {
      console.error('[settings] kbSyncNow failed', err)
    } finally {
      setSyncNowBusy(false)
    }
  }

  const isSyncing = sync.state === 'syncing'
  // 独立布尔而非直接内联 model?.phase === 'downloading'：下载/重试按钮所在的 JSX 分支已经
  // 靠外层三元把 phase 收窄成排除 'downloading' 后的联合类型，内联比较会被 TS 判定为
  // 不可能重叠（永远 false）而报编译错；提前算好的布尔不受该分支收窄影响，可安全传给 disabled。
  const modelDownloading = model?.phase === 'downloading'

  return (
    <section className="space-y-8">
      <h1 className="text-[20px] font-semibold text-foreground">
        {t('catKnowledgeBase')}
      </h1>

      {/* 管理页入口已移到聊天框底栏的「知识库」chip（Composer.tsx），
          与「选择工作目录」并排——比藏在设置里更好找。此处不再重复放按钮。 */}

      <Section title={t('kbModelTitle')} description={t('kbModelDesc')}>
        <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
          {model?.phase === 'ready' || model?.installed ? (
            <p className="text-[12px] text-emerald-600 dark:text-emerald-400">{t('kbModelInstalled')}</p>
          ) : model?.phase === 'downloading' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[12px] text-muted-foreground">
                <span>{t('kbModelDownloading')}{model.currentFile ? ` · ${model.currentFile}` : ''}</span>
                <span>{model.percent}%</span>
              </div>
              <div className="relative h-1.5 w-full rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]" style={{ width: `${model.percent}%` }} />
              </div>
              <button
                type="button"
                onClick={() => void window.chatApi.cancelKbModelDownload()}
                className="inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                {t('kbModelCancel')}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {model?.phase === 'error' && (
                <p className="text-[12px] text-destructive">{model.errorMessage || t('kbModelError')}</p>
              )}
              <button
                type="button"
                onClick={() => void window.chatApi.startKbModelDownload()}
                disabled={modelDownloading}
                className="inline-flex h-8 shrink-0 items-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {model?.phase === 'error' ? t('kbModelRetry') : t('kbModelDownload')}
              </button>
            </div>
          )}
        </div>
      </Section>

      <Section title={t('kbSourceTitle')} description={t('kbSourceDesc')}>
        <div className="space-y-2">
          <SourceOption
            active={uiTab === 'local'}
            disabled={switchingLocal}
            onClick={() => void switchToLocal()}
            label={t('kbSourceLocal')}
            description={t('kbSourceLocalDesc')}
          />
          <SourceOption
            active={uiTab === 'remote'}
            disabled={false}
            onClick={() => setUiTab('remote')}
            label={t('kbSourceRemote')}
            description={t('kbSourceRemoteDesc')}
          />
        </div>

        {uiTab === 'local' ? (
          <div className="mt-4 space-y-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[11.5px] text-foreground/90">
                {state?.kbRoot ?? '—'}
              </span>
              <button
                type="button"
                onClick={() => void pickLocal()}
                disabled={picking}
                className="inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('kbPickFolder')}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              {t('kbSourceLocalDesc')}
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
            <label className="block">
              <span className="mb-1.5 block text-[11px] text-muted-foreground">
                {t('kbRemoteUrl')}
              </span>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  placeholder="http://10.0.0.5:8080"
                  className="h-8 flex-1 rounded-md border border-border bg-card px-2.5 text-[12px] text-foreground outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() => void applyRemote()}
                  disabled={applyingRemote || !urlDraft.trim()}
                  className="inline-flex h-8 shrink-0 items-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('kbRemoteApply')}
                </button>
              </div>
            </label>

            {/* 状态行只有当远程真正生效（mode === 'remote'）才有意义展示——用户
                在本地模式下点开这个面板只是预览着填地址，还没有可汇报的同步状态。 */}
            {mode === 'remote' && (
              <>
                <SyncStatusRow sync={sync} lastSync={state?.lastSync ?? null} />
                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => void syncNow()}
                    disabled={syncNowBusy || isSyncing}
                    className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSyncing ? t('kbSyncing') : t('kbSyncNow')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </Section>
    </section>
  )
}

function SourceOption({
  active,
  disabled,
  onClick,
  label,
  description
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  label: string
  description: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={
        'group relative flex w-full flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition-all ' +
        (active
          ? 'border-accent/50 bg-accent/8 shadow-[inset_0_0_0_1px_hsl(var(--accent)/0.15)]'
          : 'border-border/60 bg-card/40 hover:border-accent/30 hover:bg-card/60') +
        ' disabled:cursor-not-allowed disabled:opacity-50'
      }
    >
      <div className="flex w-full items-center gap-2">
        <span
          className={
            'flex size-4 shrink-0 items-center justify-center rounded-full border ' +
            (active
              ? 'border-accent bg-accent text-accent-foreground'
              : 'border-border bg-background')
          }
        >
          {active && (
            <span className="block size-1.5 rounded-full bg-accent-foreground" />
          )}
        </span>
        <span className="text-[13px] font-medium text-foreground">{label}</span>
      </div>
      <p className="pl-6 text-[11.5px] text-muted-foreground/80">{description}</p>
    </button>
  )
}

function SyncStatusRow({
  sync,
  lastSync
}: {
  sync: KbSyncStatus
  lastSync: { atMs: number; builtAtMs: number } | null
}): React.JSX.Element {
  const t = useT()

  if (sync.state === 'syncing') {
    return (
      <p className="text-[11.5px] text-muted-foreground/80">
        {t('kbSyncing')} {sync.done}/{sync.total}
      </p>
    )
  }

  // idle / success / error 都落到下面统一的 lastSync 渲染——error 态额外在前面
  // 插一行失败原因，但不 return，让用户紧接着看到「上次同步时间」：手里镜像的
  // 内容还是那次同步落下的，用户需要知道现在数据有多旧才能判断能不能先将就用。
  const errorBanner =
    sync.state === 'error' ? (
      <p className="text-[11.5px] text-destructive">
        {t('kbSyncFailed')}: {sync.message}
      </p>
    ) : null

  // idle / success（success 已经触发过 refresh，lastSync 反映的是最新一次）——
  // 静息态统一走 lastSync，避免和 sync push 里的字段名对不上（success 变体没有
  // failedCount 之类，直接复用 getKbPath 的 lastSync 更省心）。
  if (!lastSync) {
    if (errorBanner) return errorBanner
    return (
      <p className="text-[11.5px] text-muted-foreground/70">{t('kbNeverSynced')}</p>
    )
  }

  return (
    <div className="space-y-0.5 text-[11.5px] text-muted-foreground/80">
      {errorBanner}
      <p>
        {t('kbLastSync')}: {new Date(lastSync.atMs).toLocaleString()}
      </p>
      <p>
        {t('kbVersion')}: {new Date(lastSync.builtAtMs).toLocaleString()}
      </p>
    </div>
  )
}
