import React, { useEffect, useState } from 'react'
import { initialComponentState } from '@desktop-shared/componentDownload'
import { useKbStore } from '../../stores/kb'
import { useComponentStore } from '../../stores/components'
import { useComponentPromptStore, promptComponent } from '../../stores/componentPrompt'
import { useT, useTFormat } from '../../i18n'
import { kbIcons } from './kbIcons'
import { KbToolingCard } from './KbToolingCard'

/**
 * 顶部工具栏：同步本地文件夹（增量刷新）、空库时的批量迁移入口、构建进度、工具缺失提示。
 * 「导入/拖拽」单文件进货已按用户要求下线（2026-07-07）：本地文件夹是唯一真相，进货只走
 * 迁移/同步；单独导入的文件不在本地源里，下次同步会被当孤儿删掉，是个坑。
 */
export function KbToolbar({ readOnly }: {
  readOnly: boolean
}): React.JSX.Element {
  const t = useT()
  const tFormat = useTFormat()
  const build = useKbStore((s) => s.build)
  const refresh = useKbStore((s) => s.refresh)
  const total = useKbStore((s) => s.total)
  const [busy, setBusy] = useState(false)
  const init = useComponentStore((s) => s.init)
  // 订阅 table 本身再派生：写 useComponentStore((s) => s.stateOf('kb-embed')) 会每次新建对象、
  // Object.is 恒 false，无关更新也重渲染；写 (s) => s.stateOf 则函数引用恒定、等于没订阅，
  // 进度推送来了不重渲染。选 table 是唯一两头都对的写法。
  const table = useComponentStore((s) => s.table)
  const embed = table['kb-embed'] ?? initialComponentState('kb-embed')
  const markitdown = table['markitdown'] ?? initialComponentState('markitdown')
  useEffect(() => init(), [init])
  const promptDismissed = useComponentPromptStore((s) => s.isDismissed)

  const migrate = async (): Promise<void> => {
    if (busy) return
    // 功能门：导入/同步要用 markitdown 转格式。缺它时**第一次**点先弹提示（这是有天然弹窗
    // 时机的用户动作）；用户点了[暂不]之后再点，就照旧跑——缺 markitdown 本来就有静默三级
    // 降级（markitdown → 丢内嵌图重试 → soffice 纯文本兜底），拦着不让导入会让功能比「没这
    // 个组件」时更糟，违反「增强层永不拖累基础层」。dismissed 让[暂不]真的等于「优雅降级」，
    // 也堵死「点同步→弹窗→暂不→再点同步→又弹窗」的死循环。
    if (markitdown.status !== 'ready' && !promptDismissed('markitdown')) {
      promptComponent('markitdown')
      return
    }
    setBusy(true)
    try {
      const r = await window.chatApi.kbMigrateFromFolder()
      if (r) { await refresh(); alert(tFormat('kbMigrateDone', { n: r.imported })) }
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err))
    } finally { setBusy(false) }
  }

  // 增量同步本地源文件夹（「刷新」）：把库对齐成本地当前状态（增/删/改），只重转变动件。
  // 有删除时先弹确认——把要删的文件摊给用户看，堵住「改名把扩展名也改了（.docx→.doc）→
  // 扫描跳过 → 删旧不补新」的静默丢文件事故（用户报的 bug）。预览不写盘，确认后才真同步。
  const sync = async (): Promise<void> => {
    if (busy) return
    // 功能门：见 migrate 同名注释——只拦第一次，之后照旧走既有的静默降级。
    if (markitdown.status !== 'ready' && !promptDismissed('markitdown')) {
      promptComponent('markitdown')
      return
    }
    setBusy(true)
    try {
      const preview = await window.chatApi.kbSyncPreview()
      if (preview && preview.deleted > 0) {
        const shown = preview.toDelete.slice(0, 10).map((p) => '• ' + p).join('\n')
        const more = preview.toDelete.length > 10 ? tFormat('kbSyncMore', { n: preview.toDelete.length - 10 }) : ''
        const ok = window.confirm(tFormat('kbSyncConfirm', {
          a: preview.added, u: preview.updated, d: preview.deleted, list: shown + more
        }))
        if (!ok) return // finally 会复位 busy；知识库未动
      }
      const r = await window.chatApi.kbSyncFromLocal()
      if (r) { await refresh(); alert(tFormat('kbSyncDone', { a: r.added, u: r.updated, d: r.deleted })) }
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err))
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-2 border-b border-border/50 px-4 py-2">
      <div className="flex items-center gap-2">
        {/* 只读库（远程托管，「本库由主编机管理」）整块隐藏写入口——与树分类图标/空态
            新建/文档行操作的 !readOnly 收敛一致。留 disabled 还会露一个灰按钮，
            与顶部只读横幅矛盾（横幅说别人管、按钮却在），所以直接不渲染。 */}
        {!readOnly && (
          <>
            <button type="button" disabled={busy} onClick={() => void sync()} title={t('kbSyncLocalHint')}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12px] font-medium hover:bg-muted/60 disabled:opacity-50">
              <kbIcons.refresh className="size-3.5" />{t('kbSyncLocal')}
            </button>
            {total === 0 && (
              <button type="button" disabled={busy} onClick={() => void migrate()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12px] font-medium hover:bg-muted/60 disabled:opacity-50">
                {t('kbMigrateCta')}
              </button>
            )}
          </>
        )}
        {/* 右侧状态区：建库中 / 模型下载中 / 缺模型引导互斥展示，同一时刻只顶一个最相关的
            （都带 ml-auto，叠加渲染会互相打架），优先级：正在建库 > 正在下模型 > 缺模型引导。 */}
        {build?.running ? (
          <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
            <kbIcons.refresh className="size-3.5 animate-spin" />
            {t('kbBuilding')}{build.phase ? ` ${build.phase.done}/${build.phase.total}` : ''}
          </span>
        ) : embed.status === 'installing' ? (
          <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
            <kbIcons.refresh className="size-3.5 animate-spin" />
            {t('kbModelDownloading')} {embed.percent ?? 0}%
          </span>
        ) : embed.status !== 'ready' && (
          <button
            type="button"
            onClick={() => promptComponent('kb-embed')}
            className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-muted-foreground/80 transition-colors hover:text-foreground"
          >
            {t('kbModelMissingHint')} · {t('kbModelDownload')}
          </button>
        )}
      </div>
      {/* 工具缺失只对可写机有意义（只读机不本地构建、装不装 markitdown 无所谓）。原来的一行红字
          报错已升级为带「一键安装」的引导卡片（KbToolingCard）：点按钮即由主进程装 markitdown，
          装完给三态反馈（就绪／需重启／缺前置引导手动装）。 */}
      {!readOnly && markitdown.status !== 'ready' && <KbToolingCard />}
    </div>
  )
}
